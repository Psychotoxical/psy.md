//! Optional timing marks for performance measurement.
//!
//! When `PSYMD_PERF` names a file, each mark appends one line with the time
//! since process start and the wall-clock time in epoch milliseconds. Nothing
//! about document content is written.

use std::io::Write;
use std::sync::OnceLock;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

static START: OnceLock<Instant> = OnceLock::new();
static TARGET: OnceLock<Option<std::path::PathBuf>> = OnceLock::new();

pub fn init() {
    START.get_or_init(Instant::now);
    TARGET.get_or_init(|| std::env::var_os("PSYMD_PERF").map(Into::into));
}

pub fn mark(name: &str, detail: &str) {
    let Some(Some(path)) = TARGET.get() else {
        return;
    };
    let since = START
        .get()
        .map_or(0.0, |s| s.elapsed().as_secs_f64() * 1000.0);
    let epoch = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis());
    let name: String = name
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-')
        .take(40)
        .collect();
    let detail: String = detail
        .chars()
        .filter(|c| c.is_ascii_graphic())
        .take(80)
        .collect();
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
    {
        let _ = writeln!(f, "{name} t={since:.1} epoch={epoch} {detail}");
    }
}
