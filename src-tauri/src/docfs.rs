//! File-system helpers behind the commands, free of Tauri types.

use std::fs;
use std::path::{Path, PathBuf};

use percent_encoding::percent_decode_str;
use psymd_core::doc_io::{Decoded, MAX_DOC_BYTES, decode};

use crate::error::{CmdError, too_large};

/// File extensions treated as Markdown for links and drag and drop.
pub const MARKDOWN_EXTENSIONS: &[&str] = &["md", "markdown", "mdown", "mkd", "mkdn", "mdwn", "txt"];

/// Reads and decodes a document, enforcing the size limit.
pub fn read_document(path: &Path) -> Result<Decoded, CmdError> {
    let meta = fs::metadata(path)?;
    if !meta.is_file() {
        return Err(CmdError::new("not-a-file"));
    }
    if meta.len() > MAX_DOC_BYTES {
        return Err(too_large(meta.len()));
    }
    let bytes = fs::read(path)?;
    Ok(decode(&bytes)?)
}

pub fn is_markdown_path(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| MARKDOWN_EXTENSIONS.contains(&e.to_ascii_lowercase().as_str()))
}

/// Resolves a link target from a document in `doc_dir` to an existing
/// Markdown file. `href` carries no `#fragment`.
pub fn resolve_markdown_link(doc_dir: &Path, href: &str) -> Result<PathBuf, CmdError> {
    let target = if href.to_ascii_lowercase().starts_with("file:") {
        url::Url::parse(href)
            .ok()
            .and_then(|u| u.to_file_path().ok())
            .ok_or_else(|| CmdError::new("not-found"))?
    } else {
        let path_part = href.split('?').next().unwrap_or_default();
        let decoded = percent_decode_str(path_part)
            .decode_utf8()
            .map_err(|_| CmdError::new("not-found"))?;
        doc_dir.join(decoded.as_ref())
    };
    if !is_markdown_path(&target) {
        return Err(CmdError::new("not-markdown"));
    }
    let real = fs::canonicalize(&target)?;
    if !real.is_file() {
        return Err(CmdError::new("not-found"));
    }
    Ok(real)
}

/// Only web and mail links leave the app.
pub fn external_url_allowed(url: &str) -> bool {
    let Ok(u) = url::Url::parse(url) else {
        return false;
    };
    match u.scheme() {
        "http" | "https" => u
            .host_str()
            .is_some_and(|h| !h.to_ascii_lowercase().ends_with(".localhost") && h != "localhost"),
        "mailto" => true,
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn read_document_decodes_and_reports_format() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("a.md");
        fs::write(&p, b"\xEF\xBB\xBF# T\r\n").unwrap();
        let doc = read_document(&p).unwrap();
        assert_eq!(doc.text, "# T\n");
        assert!(doc.bom);
    }

    #[test]
    fn open_rejects_files_over_limit() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("big.md");
        fs::File::create(&p)
            .unwrap()
            .set_len(psymd_core::doc_io::MAX_DOC_BYTES + 1)
            .unwrap();
        assert_eq!(read_document(&p).unwrap_err().code, "too-large");
    }

    #[test]
    fn read_document_maps_errors() {
        let d = tempfile::tempdir().unwrap();
        assert_eq!(
            read_document(&d.path().join("x.md")).unwrap_err().code,
            "not-found"
        );
        let p = d.path().join("u16.md");
        fs::write(&p, [0xFF, 0xFE, b'a', 0]).unwrap();
        let e = read_document(&p).unwrap_err();
        assert_eq!(e.code, "encoding");
        assert_eq!(e.detail.as_deref(), Some("UTF-16 LE"));
    }

    #[test]
    fn markdown_extensions() {
        assert!(is_markdown_path(Path::new("a/B.MD")));
        assert!(is_markdown_path(Path::new("notes.markdown")));
        assert!(!is_markdown_path(Path::new("run.exe")));
        assert!(!is_markdown_path(Path::new("noext")));
    }

    #[test]
    fn resolves_relative_markdown_links() {
        let d = tempfile::tempdir().unwrap();
        fs::create_dir(d.path().join("sub")).unwrap();
        fs::write(d.path().join("sub/Zweite Datei.md"), b"x").unwrap();
        fs::write(d.path().join("tool.exe"), b"x").unwrap();
        let p = resolve_markdown_link(d.path(), "sub/Zweite%20Datei.md").unwrap();
        assert!(p.ends_with("Zweite Datei.md"));
        assert_eq!(
            resolve_markdown_link(d.path(), "tool.exe")
                .unwrap_err()
                .code,
            "not-markdown"
        );
        assert_eq!(
            resolve_markdown_link(d.path(), "fehlt.md")
                .unwrap_err()
                .code,
            "not-found"
        );
    }

    #[test]
    fn external_urls_limited_to_web_and_mail() {
        assert!(external_url_allowed("https://example.com/a"));
        assert!(external_url_allowed("http://example.com"));
        assert!(external_url_allowed("mailto:a@example.com"));
        for bad in [
            "javascript:alert(1)",
            "file:///etc/passwd",
            "ms-settings:",
            "smb://host/share",
            "data:text/html,x",
            "not a url",
            "http://psymd-asset.localhost/x",
        ] {
            assert!(!external_url_allowed(bad), "{bad}");
        }
    }
}
