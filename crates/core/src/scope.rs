//! Decides which local files the preview may load.

use std::path::{Path, PathBuf};

/// Largest image served to the preview.
pub const MAX_IMAGE_BYTES: u64 = 25 * 1024 * 1024;

#[derive(Debug, PartialEq, Eq, thiserror::Error)]
pub enum ScopeError {
    #[error("not found")]
    NotFound,
    #[error("outside the allowed folders")]
    OutsideScope,
    #[error("not an image")]
    NotAnImage,
    #[error("image too large")]
    TooLarge,
}

/// MIME type for image file extensions the preview shows.
pub fn image_mime(path: &Path) -> Option<&'static str> {
    let ext = path.extension()?.to_str()?.to_ascii_lowercase();
    Some(match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        // Served only into <img>, where SVG cannot run scripts or load
        // other resources.
        "svg" => "image/svg+xml",
        _ => return None,
    })
}

/// Resolves `requested` (symlinks and `..` included) and checks that the real
/// file lies inside one of the canonical `roots`, is an image and is small
/// enough.
pub fn resolve_in_scope(
    requested: &Path,
    roots: &[PathBuf],
) -> Result<(PathBuf, &'static str), ScopeError> {
    let real = std::fs::canonicalize(requested).map_err(|_| ScopeError::NotFound)?;
    if !roots.iter().any(|r| real.starts_with(r)) {
        return Err(ScopeError::OutsideScope);
    }
    let mime = image_mime(&real).ok_or(ScopeError::NotAnImage)?;
    let meta = std::fs::metadata(&real).map_err(|_| ScopeError::NotFound)?;
    if !meta.is_file() {
        return Err(ScopeError::NotFound);
    }
    if meta.len() > MAX_IMAGE_BYTES {
        return Err(ScopeError::TooLarge);
    }
    Ok((real, mime))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn root(dir: &Path) -> Vec<PathBuf> {
        vec![fs::canonicalize(dir).unwrap()]
    }

    #[test]
    fn inside_root_ok() {
        let d = tempfile::tempdir().unwrap();
        fs::create_dir(d.path().join("img")).unwrap();
        fs::write(d.path().join("img/a.PNG"), b"x").unwrap();
        let (p, mime) = resolve_in_scope(&d.path().join("img/a.PNG"), &root(d.path())).unwrap();
        assert!(p.ends_with("a.PNG"));
        assert_eq!(mime, "image/png");
    }

    #[test]
    fn dotdot_traversal_rejected() {
        let d = tempfile::tempdir().unwrap();
        fs::create_dir(d.path().join("doc")).unwrap();
        fs::write(d.path().join("secret.png"), b"x").unwrap();
        let r = resolve_in_scope(
            &d.path().join("doc/../secret.png"),
            &root(&d.path().join("doc")),
        );
        assert_eq!(r, Err(ScopeError::OutsideScope));
    }

    #[test]
    fn symlink_escape_rejected() {
        let d = tempfile::tempdir().unwrap();
        fs::create_dir(d.path().join("doc")).unwrap();
        fs::write(d.path().join("secret.png"), b"x").unwrap();
        let link = d.path().join("doc/link.png");
        #[cfg(unix)]
        let made = std::os::unix::fs::symlink(d.path().join("secret.png"), &link).is_ok();
        #[cfg(windows)]
        let made = std::os::windows::fs::symlink_file(d.path().join("secret.png"), &link).is_ok();
        if !made {
            eprintln!("symlinks not available here; skipped");
            return;
        }
        assert_eq!(
            resolve_in_scope(&link, &root(&d.path().join("doc"))),
            Err(ScopeError::OutsideScope)
        );
    }

    #[test]
    fn non_image_rejected() {
        let d = tempfile::tempdir().unwrap();
        fs::write(d.path().join("notes.md"), b"x").unwrap();
        fs::write(d.path().join("tool.exe"), b"x").unwrap();
        for name in ["notes.md", "tool.exe"] {
            assert_eq!(
                resolve_in_scope(&d.path().join(name), &root(d.path())),
                Err(ScopeError::NotAnImage)
            );
        }
    }

    #[test]
    fn too_large_rejected() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("big.jpg");
        let f = fs::File::create(&p).unwrap();
        f.set_len(MAX_IMAGE_BYTES + 1).unwrap();
        assert_eq!(
            resolve_in_scope(&p, &root(d.path())),
            Err(ScopeError::TooLarge)
        );
    }

    #[test]
    fn missing_is_not_found() {
        let d = tempfile::tempdir().unwrap();
        assert_eq!(
            resolve_in_scope(&d.path().join("x.png"), &root(d.path())),
            Err(ScopeError::NotFound)
        );
    }

    #[test]
    fn granted_root_ok() {
        let d = tempfile::tempdir().unwrap();
        fs::create_dir(d.path().join("doc")).unwrap();
        fs::create_dir(d.path().join("assets")).unwrap();
        fs::write(d.path().join("assets/x.webp"), b"x").unwrap();
        let mut roots = root(&d.path().join("doc"));
        roots.push(fs::canonicalize(d.path().join("assets")).unwrap());
        assert!(resolve_in_scope(&d.path().join("assets/x.webp"), &roots).is_ok());
    }

    #[test]
    fn mime_table() {
        assert_eq!(image_mime(Path::new("a.svg")), Some("image/svg+xml"));
        assert_eq!(image_mime(Path::new("a.jpeg")), Some("image/jpeg"));
        assert_eq!(image_mime(Path::new("a.html")), None);
        assert_eq!(image_mime(Path::new("noext")), None);
    }
}
