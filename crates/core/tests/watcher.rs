//! Real-filesystem scenarios for the document watcher.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{Receiver, channel};
use std::thread::sleep;
use std::time::{Duration, Instant};

use psymd_core::doc_io::token_of;
use psymd_core::watcher::{DocWatcher, WatchEvent};

const WAIT: Duration = Duration::from_secs(4);

struct Fixture {
    _dir: tempfile::TempDir,
    path: PathBuf,
    rx: Receiver<WatchEvent>,
    watcher: DocWatcher,
}

fn setup(initial: &[u8]) -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("doc.md");
    fs::write(&path, initial).unwrap();
    let (tx, rx) = channel();
    let watcher = DocWatcher::start(path.clone(), Some(token_of(initial)), move |e| {
        let _ = tx.send(e);
    })
    .unwrap();
    // Let the OS watch settle before the scenario starts.
    sleep(Duration::from_millis(150));
    Fixture {
        _dir: dir,
        path,
        rx,
        watcher,
    }
}

fn next(rx: &Receiver<WatchEvent>) -> WatchEvent {
    rx.recv_timeout(WAIT).expect("expected a watch event")
}

/// Collects events until `quiet` passes without a new one.
fn drain(rx: &Receiver<WatchEvent>, quiet: Duration) -> Vec<WatchEvent> {
    let mut v = Vec::new();
    while let Ok(e) = rx.recv_timeout(quiet) {
        v.push(e);
    }
    v
}

fn text(e: &WatchEvent) -> &str {
    match e {
        WatchEvent::Changed { decoded, .. } => &decoded.text,
        other => panic!("expected Changed, got {other:?}"),
    }
}

fn replace_atomically(path: &Path, bytes: &[u8]) {
    let tmp = path.with_file_name("doc.md.tmp-writer");
    fs::write(&tmp, bytes).unwrap();
    fs::rename(&tmp, path).unwrap();
}

#[test]
fn overwrite_emits_changed() {
    let f = setup(b"v1");
    fs::write(&f.path, b"v2").unwrap();
    assert_eq!(text(&next(&f.rx)), "v2");
}

#[test]
fn atomic_rename_emits_changed_once() {
    let f = setup(b"v1");
    replace_atomically(&f.path, b"# neu\n");
    assert_eq!(text(&next(&f.rx)), "# neu\n");
    assert!(drain(&f.rx, Duration::from_millis(800)).is_empty());
}

#[test]
fn burst_writes_end_on_final_content() {
    let f = setup(b"start");
    for i in 0..25 {
        fs::write(&f.path, format!("zeile {i}\n").repeat(i + 1)).unwrap();
        sleep(Duration::from_millis(20));
    }
    let events = drain(&f.rx, Duration::from_millis(1200));
    assert!(!events.is_empty());
    assert!(events.len() <= 6, "too many updates: {}", events.len());
    assert_eq!(text(events.last().unwrap()), "zeile 24\n".repeat(25));
}

#[test]
fn identical_content_emits_nothing() {
    let f = setup(b"same");
    fs::write(&f.path, b"same").unwrap();
    replace_atomically(&f.path, b"same");
    assert!(drain(&f.rx, Duration::from_millis(1000)).is_empty());
}

#[test]
fn own_save_is_suppressed() {
    let f = setup(b"old");
    f.watcher.set_known(token_of(b"mine"));
    fs::write(&f.path, b"mine").unwrap();
    assert!(drain(&f.rx, Duration::from_millis(1000)).is_empty());
}

#[test]
fn truncate_then_write_never_emits_empty() {
    let f = setup(b"content");
    fs::write(&f.path, b"").unwrap();
    sleep(Duration::from_millis(60));
    fs::write(&f.path, b"content 2").unwrap();
    let events = drain(&f.rx, Duration::from_millis(1200));
    assert!(events.iter().all(|e| !text(e).is_empty()), "{events:?}");
    assert_eq!(text(events.last().unwrap()), "content 2");
}

#[test]
fn permanent_empty_emits_empty_after_stabilization() {
    let f = setup(b"content");
    let start = Instant::now();
    fs::write(&f.path, b"").unwrap();
    assert_eq!(text(&next(&f.rx)), "");
    assert!(start.elapsed() >= Duration::from_millis(300));
}

#[test]
fn delete_emits_missing() {
    let f = setup(b"x");
    fs::remove_file(&f.path).unwrap();
    assert!(matches!(next(&f.rx), WatchEvent::Missing { .. }));
    assert!(drain(&f.rx, Duration::from_millis(500)).is_empty());
}

#[test]
fn delete_then_recreate_emits_changed_not_missing() {
    let f = setup(b"x");
    fs::remove_file(&f.path).unwrap();
    sleep(Duration::from_millis(40));
    fs::write(&f.path, b"y").unwrap();
    let events = drain(&f.rx, Duration::from_millis(1500));
    assert_eq!(events.len(), 1, "{events:?}");
    assert_eq!(text(&events[0]), "y");
}

#[test]
fn rename_away_emits_missing() {
    let f = setup(b"x");
    fs::rename(&f.path, f.path.with_file_name("anders.md")).unwrap();
    assert!(matches!(next(&f.rx), WatchEvent::Missing { .. }));
}

#[test]
fn reappear_after_missing_emits_changed() {
    let f = setup(b"x");
    fs::remove_file(&f.path).unwrap();
    assert!(matches!(next(&f.rx), WatchEvent::Missing { .. }));
    fs::write(&f.path, b"x").unwrap();
    assert_eq!(text(&next(&f.rx)), "x");
}

#[test]
fn invalid_utf8_emits_read_error() {
    let f = setup(b"ok");
    fs::write(&f.path, [b'G', b'r', 0xFC, b'n']).unwrap();
    assert!(matches!(next(&f.rx), WatchEvent::ReadError { .. }));
}

#[test]
fn sequence_numbers_increase() {
    let f = setup(b"a");
    fs::write(&f.path, b"b").unwrap();
    let first = next(&f.rx);
    sleep(Duration::from_millis(200));
    fs::write(&f.path, b"c").unwrap();
    let second = next(&f.rx);
    assert!(second.seq() > first.seq());
}
