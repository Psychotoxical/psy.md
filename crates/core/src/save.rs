//! Safe saving: conflict check against the expected disk state, then an atomic
//! replace through a temporary file in the same directory.

use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use crate::doc_io::{Token, token_of};

#[derive(Debug, PartialEq, Eq, thiserror::Error)]
pub enum SaveError {
    /// The file on disk is not the version the caller based its edits on.
    #[error("the file changed on disk")]
    Conflict { current: Option<Token> },
    #[error("the file is read-only")]
    ReadOnly,
    #[error("the file is locked by another program")]
    Locked,
    #[error("{message}")]
    Io {
        kind: std::io::ErrorKind,
        message: String,
    },
}

/// Saves `bytes` to `path`.
///
/// `expected` is the token of the disk content the caller's text is based on,
/// or `None` for a file the caller believes does not exist yet. Unless `force`
/// is set, a mismatch with the current disk content returns
/// [`SaveError::Conflict`] and leaves the file untouched.
pub fn save(
    path: &Path,
    bytes: &[u8],
    expected: Option<&Token>,
    force: bool,
) -> Result<Token, SaveError> {
    let target = resolve_target(path)?;
    let existing = match fs::metadata(&target) {
        Ok(m) => Some(m),
        Err(e) if e.kind() == io::ErrorKind::NotFound => None,
        Err(e) => return Err(io_err(e)),
    };

    if !force {
        let current = match existing {
            Some(_) => Some(token_of(&fs::read(&target).map_err(io_err)?)),
            None => None,
        };
        match (expected, current) {
            (Some(e), Some(c)) if *e != c => return Err(SaveError::Conflict { current: Some(c) }),
            (None, Some(c)) => return Err(SaveError::Conflict { current: Some(c) }),
            _ => {}
        }
    }
    if existing
        .as_ref()
        .is_some_and(|m| m.permissions().readonly())
    {
        return Err(SaveError::ReadOnly);
    }

    let dir = target.parent().unwrap_or(Path::new("."));
    let tmp = temp_path(dir, &target);
    let result = write_temp(&tmp, bytes, existing.map(|m| m.permissions()))
        .and_then(|()| rename_with_retry(&tmp, &target));
    if let Err(e) = result {
        let _ = fs::remove_file(&tmp);
        return Err(if is_lock_error(&e) {
            SaveError::Locked
        } else {
            io_err(e)
        });
    }
    sync_dir(dir);
    Ok(token_of(bytes))
}

/// Follows symlinks so the link itself survives and the real file is replaced.
fn resolve_target(path: &Path) -> Result<PathBuf, SaveError> {
    match fs::canonicalize(path) {
        Ok(p) => Ok(p),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(path.to_path_buf()),
        Err(e) => Err(io_err(e)),
    }
}

fn temp_path(dir: &Path, target: &Path) -> PathBuf {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let name = target
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    dir.join(format!(".{name}.psymd-{}-{n}.tmp", std::process::id()))
}

fn write_temp(tmp: &Path, bytes: &[u8], perms: Option<fs::Permissions>) -> io::Result<()> {
    let mut f = OpenOptions::new().write(true).create_new(true).open(tmp)?;
    f.write_all(bytes)?;
    f.sync_all()?;
    drop(f);
    if let Some(p) = perms {
        fs::set_permissions(tmp, p)?;
    }
    Ok(())
}

/// Windows refuses the replace while another process holds the file without
/// delete sharing (virus scanners, sync clients); those holds are usually short.
fn rename_with_retry(from: &Path, to: &Path) -> io::Result<()> {
    let mut delay = Duration::from_millis(25);
    for attempt in 0..4 {
        match fs::rename(from, to) {
            Ok(()) => return Ok(()),
            Err(e) if attempt < 3 && is_lock_error(&e) => {
                std::thread::sleep(delay);
                delay *= 3;
            }
            Err(e) => return Err(e),
        }
    }
    unreachable!("loop returns on the last attempt")
}

fn is_lock_error(e: &io::Error) -> bool {
    cfg!(windows)
        && (e.kind() == io::ErrorKind::PermissionDenied
            // ERROR_SHARING_VIOLATION, ERROR_LOCK_VIOLATION
            || matches!(e.raw_os_error(), Some(32) | Some(33)))
}

#[cfg(unix)]
fn sync_dir(dir: &Path) {
    if let Ok(d) = fs::File::open(dir) {
        let _ = d.sync_all();
    }
}

#[cfg(not(unix))]
fn sync_dir(_dir: &Path) {}

fn io_err(e: io::Error) -> SaveError {
    SaveError::Io {
        kind: e.kind(),
        message: e.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::doc_io::token_of;
    use std::fs;

    fn names(dir: &Path) -> Vec<String> {
        let mut v: Vec<String> = fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        v.sort();
        v
    }

    #[test]
    fn writes_new_file() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("neu.md");
        let t = save(&p, b"hallo", None, false).unwrap();
        assert_eq!(fs::read(&p).unwrap(), b"hallo");
        assert_eq!(t, token_of(b"hallo"));
    }

    #[test]
    fn replaces_existing_atomically_no_tmp_left() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("doc.md");
        fs::write(&p, b"old").unwrap();
        save(&p, b"new", Some(&token_of(b"old")), false).unwrap();
        assert_eq!(fs::read(&p).unwrap(), b"new");
        assert_eq!(names(dir.path()), vec!["doc.md"]);
    }

    #[test]
    fn save_detects_conflict_without_watcher_event() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("doc.md");
        fs::write(&p, b"v1").unwrap();
        let base = token_of(b"v1");
        fs::write(&p, b"v2 from elsewhere").unwrap();
        let err = save(&p, b"mine", Some(&base), false).unwrap_err();
        assert_eq!(
            err,
            SaveError::Conflict {
                current: Some(token_of(b"v2 from elsewhere"))
            }
        );
        assert_eq!(fs::read(&p).unwrap(), b"v2 from elsewhere");
    }

    #[test]
    fn force_overwrites_conflict() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("doc.md");
        fs::write(&p, b"theirs").unwrap();
        save(&p, b"mine", Some(&token_of(b"base")), true).unwrap();
        assert_eq!(fs::read(&p).unwrap(), b"mine");
    }

    #[test]
    fn existing_file_without_expected_is_conflict() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("doc.md");
        fs::write(&p, b"there").unwrap();
        assert!(matches!(
            save(&p, b"mine", None, false),
            Err(SaveError::Conflict { current: Some(_) })
        ));
    }

    #[test]
    fn missing_file_with_expected_token_is_recreated() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("weg.md");
        save(&p, b"wieder da", Some(&token_of(b"alt")), false).unwrap();
        assert_eq!(fs::read(&p).unwrap(), b"wieder da");
    }

    #[test]
    fn readonly_file_reports_readonly_and_keeps_content() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("ro.md");
        fs::write(&p, b"fest").unwrap();
        let mut perm = fs::metadata(&p).unwrap().permissions();
        perm.set_readonly(true);
        fs::set_permissions(&p, perm.clone()).unwrap();
        let r = save(&p, b"neu", Some(&token_of(b"fest")), false);
        assert_eq!(r, Err(SaveError::ReadOnly));
        assert_eq!(fs::read(&p).unwrap(), b"fest");
        assert_eq!(names(dir.path()), vec!["ro.md"]);
        #[allow(clippy::permissions_set_readonly_false)]
        perm.set_readonly(false);
        fs::set_permissions(&p, perm).unwrap();
    }

    #[test]
    fn writes_through_symlink_to_target() {
        let dir = tempfile::tempdir().unwrap();
        let real = dir.path().join("real.md");
        let link = dir.path().join("link.md");
        fs::write(&real, b"a").unwrap();
        #[cfg(unix)]
        let made = std::os::unix::fs::symlink(&real, &link).is_ok();
        #[cfg(windows)]
        let made = std::os::windows::fs::symlink_file(&real, &link).is_ok();
        if !made {
            eprintln!("symlinks not available here; skipped");
            return;
        }
        save(&link, b"b", Some(&token_of(b"a")), false).unwrap();
        assert_eq!(fs::read(&real).unwrap(), b"b");
        assert!(
            fs::symlink_metadata(&link)
                .unwrap()
                .file_type()
                .is_symlink()
        );
    }

    #[cfg(unix)]
    #[test]
    fn preserves_unix_permissions() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("x.md");
        fs::write(&p, b"a").unwrap();
        fs::set_permissions(&p, fs::Permissions::from_mode(0o640)).unwrap();
        save(&p, b"b", Some(&token_of(b"a")), false).unwrap();
        assert_eq!(
            fs::metadata(&p).unwrap().permissions().mode() & 0o777,
            0o640
        );
    }
}
