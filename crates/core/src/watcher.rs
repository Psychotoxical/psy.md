//! Watches one document for external changes.
//!
//! The parent directory is watched (not the file), because editors and other writers
//! often save by writing a temporary file and renaming it over the original,
//! which ends a watch held on the file itself. Events are coalesced: a check
//! runs once the directory has been quiet for [`DEBOUNCE`], and at the latest
//! [`MAX_WAIT`] after the first event of a burst, so a long stream of writes
//! still produces regular updates. A file that turns up empty is re-read after
//! [`EMPTY_SETTLE`] before the empty state is reported, and a file that
//! vanishes is re-checked a few times before it is reported missing.

use std::ffi::OsString;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};

use crate::doc_io::{DecodeError, Decoded, EncodingKind, MAX_DOC_BYTES, Token, decode, token_of};

pub const DEBOUNCE: Duration = Duration::from_millis(75);
pub const MAX_WAIT: Duration = Duration::from_millis(400);
pub const EMPTY_SETTLE: Duration = Duration::from_millis(350);
const MISSING_RECHECKS: [Duration; 3] = [
    Duration::from_millis(100),
    Duration::from_millis(300),
    Duration::from_millis(1000),
];
const MISSING_POLL: Duration = Duration::from_secs(2);
const IO_RETRY: Duration = Duration::from_millis(120);
const IO_RETRIES: u32 = 6;

/// Why a changed file could not be shown.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ReadProblem {
    Encoding(EncodingKind),
    TooLarge {
        size: u64,
    },
    Io {
        kind: io::ErrorKind,
        message: String,
    },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum WatchEvent {
    Changed { seq: u64, decoded: Decoded },
    Missing { seq: u64 },
    ReadError { seq: u64, problem: ReadProblem },
}

impl WatchEvent {
    pub fn seq(&self) -> u64 {
        match self {
            WatchEvent::Changed { seq, .. }
            | WatchEvent::Missing { seq }
            | WatchEvent::ReadError { seq, .. } => *seq,
        }
    }
}

enum Msg {
    Fs(notify::Result<notify::Event>),
    Known(Token),
    Stop,
}

/// Stops watching when dropped.
pub struct DocWatcher {
    tx: Sender<Msg>,
    thread: Option<JoinHandle<()>>,
    _fs: RecommendedWatcher,
}

impl DocWatcher {
    /// Starts watching `path`. `known` is the token of the content already
    /// shown; identical content is never reported.
    pub fn start(
        path: PathBuf,
        known: Option<Token>,
        sink: impl Fn(WatchEvent) + Send + 'static,
    ) -> io::Result<Self> {
        let dir = match path.parent() {
            Some(p) if !p.as_os_str().is_empty() => p.to_path_buf(),
            _ => PathBuf::from("."),
        };
        let name = path
            .file_name()
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "path has no file name"))?
            .to_os_string();
        let (tx, rx) = mpsc::channel();
        let fs_tx = tx.clone();
        let mut fs_watcher = notify::recommended_watcher(move |res| {
            let _ = fs_tx.send(Msg::Fs(res));
        })
        .map_err(io::Error::other)?;
        fs_watcher
            .watch(&dir, RecursiveMode::NonRecursive)
            .map_err(io::Error::other)?;

        let known_len = known.as_ref().map_or(0, Token::byte_len);
        let worker = Worker {
            path,
            name: fold_name(&name),
            known,
            known_len,
            presence: Presence::Present,
            burst: None,
            empty_since: None,
            io_failures: 0,
            retry_at: None,
            seq: 0,
        };
        let thread = std::thread::Builder::new()
            .name("psymd-watch".into())
            .spawn(move || worker.run(rx, sink))?;
        Ok(DocWatcher {
            tx,
            thread: Some(thread),
            _fs: fs_watcher,
        })
    }

    /// Records content written by psy.md itself so it is not reported back.
    pub fn set_known(&self, token: Token) {
        let _ = self.tx.send(Msg::Known(token));
    }
}

impl Drop for DocWatcher {
    fn drop(&mut self) {
        let _ = self.tx.send(Msg::Stop);
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

#[derive(Clone, Copy)]
enum Presence {
    Present,
    /// Not found; re-checking before reporting it missing.
    Grace {
        attempt: usize,
        at: Instant,
    },
    /// Reported missing; a slow poll backs up the directory watch.
    Missing {
        poll_at: Instant,
    },
}

struct Burst {
    first: Instant,
    last: Instant,
}

impl Burst {
    fn deadline(&self) -> Instant {
        (self.last + DEBOUNCE).min(self.first + MAX_WAIT)
    }
}

struct Worker {
    path: PathBuf,
    name: OsString,
    known: Option<Token>,
    known_len: u64,
    presence: Presence,
    burst: Option<Burst>,
    empty_since: Option<Instant>,
    io_failures: u32,
    retry_at: Option<Instant>,
    seq: u64,
}

impl Worker {
    fn run(mut self, rx: Receiver<Msg>, sink: impl Fn(WatchEvent)) {
        loop {
            let msg = match self.next_wake() {
                Some(at) => rx.recv_timeout(at.saturating_duration_since(Instant::now())),
                None => rx.recv().map_err(|_| RecvTimeoutError::Disconnected),
            };
            let now = Instant::now();
            match msg {
                Ok(Msg::Stop) | Err(RecvTimeoutError::Disconnected) => return,
                Ok(Msg::Known(token)) => {
                    self.known_len = token.byte_len();
                    self.known = Some(token);
                }
                Ok(Msg::Fs(Ok(event))) => {
                    if self.is_relevant(&event) {
                        self.note_event(now);
                    }
                }
                // Overflow or backend error: re-read to be safe.
                Ok(Msg::Fs(Err(_))) => self.note_event(now),
                Err(RecvTimeoutError::Timeout) => {}
            }
            if self.is_due(Instant::now()) {
                self.burst = None;
                self.retry_at = None;
                self.check(Instant::now(), &sink);
            }
        }
    }

    fn is_relevant(&self, event: &notify::Event) -> bool {
        if event.need_rescan() || event.paths.is_empty() {
            return true;
        }
        if matches!(event.kind, EventKind::Access(_)) {
            return false;
        }
        event
            .paths
            .iter()
            .any(|p| p.file_name().is_some_and(|n| fold_name(n) == self.name))
    }

    fn note_event(&mut self, now: Instant) {
        match &mut self.burst {
            Some(b) => b.last = now,
            None => {
                self.burst = Some(Burst {
                    first: now,
                    last: now,
                })
            }
        }
    }

    fn next_wake(&self) -> Option<Instant> {
        [
            self.burst.as_ref().map(Burst::deadline),
            self.empty_since.map(|t| t + EMPTY_SETTLE),
            self.retry_at,
            match self.presence {
                Presence::Present => None,
                Presence::Grace { at, .. } => Some(at),
                Presence::Missing { poll_at } => Some(poll_at),
            },
        ]
        .into_iter()
        .flatten()
        .min()
    }

    fn is_due(&self, now: Instant) -> bool {
        self.next_wake().is_some_and(|at| at <= now)
    }

    fn emit(&mut self, sink: &impl Fn(WatchEvent), make: impl FnOnce(u64) -> WatchEvent) {
        self.seq += 1;
        sink(make(self.seq));
    }

    fn check(&mut self, now: Instant, sink: &impl Fn(WatchEvent)) {
        match read_limited(&self.path) {
            Ok(bytes) => self.on_bytes(bytes, now, sink),
            Err(ReadOutcome::TooLarge(size)) => {
                self.presence = Presence::Present;
                self.empty_since = None;
                let token = Token::from_string(format!("{size}-too-large"));
                if self.known.as_ref() != Some(&token) {
                    self.known = Some(token);
                    self.known_len = size;
                    self.emit(sink, |seq| WatchEvent::ReadError {
                        seq,
                        problem: ReadProblem::TooLarge { size },
                    });
                }
            }
            Err(ReadOutcome::Io(e)) if e.kind() == io::ErrorKind::NotFound => {
                self.empty_since = None;
                self.on_not_found(now, sink);
            }
            Err(ReadOutcome::Io(e)) => {
                self.io_failures += 1;
                if self.io_failures <= IO_RETRIES {
                    self.retry_at = Some(now + IO_RETRY);
                } else {
                    self.io_failures = 0;
                    self.emit(sink, |seq| WatchEvent::ReadError {
                        seq,
                        problem: ReadProblem::Io {
                            kind: e.kind(),
                            message: e.to_string(),
                        },
                    });
                }
            }
        }
    }

    fn on_bytes(&mut self, bytes: Vec<u8>, now: Instant, sink: &impl Fn(WatchEvent)) {
        self.io_failures = 0;
        self.presence = Presence::Present;
        let token = token_of(&bytes);
        if self.known.as_ref() == Some(&token) {
            self.empty_since = None;
            return;
        }
        // A writer that truncates first leaves the file empty for a moment.
        if bytes.is_empty() && self.known_len > 0 {
            match self.empty_since {
                None => {
                    self.empty_since = Some(now);
                    return;
                }
                Some(since) if now < since + EMPTY_SETTLE => return,
                Some(_) => {}
            }
        }
        self.empty_since = None;
        self.known_len = bytes.len() as u64;
        self.known = Some(token);
        match decode(&bytes) {
            Ok(decoded) => self.emit(sink, |seq| WatchEvent::Changed { seq, decoded }),
            Err(DecodeError::UnsupportedEncoding(kind)) => {
                self.emit(sink, |seq| WatchEvent::ReadError {
                    seq,
                    problem: ReadProblem::Encoding(kind),
                })
            }
        }
    }

    fn on_not_found(&mut self, now: Instant, sink: &impl Fn(WatchEvent)) {
        self.presence = match self.presence {
            Presence::Present => Presence::Grace {
                attempt: 0,
                at: now + MISSING_RECHECKS[0],
            },
            Presence::Grace { attempt, .. } if attempt + 1 < MISSING_RECHECKS.len() => {
                Presence::Grace {
                    attempt: attempt + 1,
                    at: now + MISSING_RECHECKS[attempt + 1],
                }
            }
            Presence::Grace { .. } => {
                self.known = None;
                self.known_len = 0;
                self.emit(sink, |seq| WatchEvent::Missing { seq });
                Presence::Missing {
                    poll_at: now + MISSING_POLL,
                }
            }
            Presence::Missing { .. } => Presence::Missing {
                poll_at: now + MISSING_POLL,
            },
        };
    }
}

enum ReadOutcome {
    TooLarge(u64),
    Io(io::Error),
}

fn read_limited(path: &Path) -> Result<Vec<u8>, ReadOutcome> {
    let len = fs::metadata(path).map_err(ReadOutcome::Io)?.len();
    if len > MAX_DOC_BYTES {
        return Err(ReadOutcome::TooLarge(len));
    }
    fs::read(path).map_err(ReadOutcome::Io)
}

/// File names compare case-insensitively where the file system usually does.
fn fold_name(name: &std::ffi::OsStr) -> OsString {
    if cfg!(any(windows, target_os = "macos")) {
        OsString::from(name.to_string_lossy().to_lowercase())
    } else {
        name.to_os_string()
    }
}
