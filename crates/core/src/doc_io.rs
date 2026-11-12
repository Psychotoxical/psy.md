//! Decoding and encoding of Markdown files.
//!
//! Text handed to the frontend always uses `\n` line breaks and never carries a
//! byte order mark. The original BOM and line ending style are reported so a
//! save can restore them. Files that are not valid UTF-8 are rejected instead
//! of being decoded lossily, so a later save can never replace bytes with
//! U+FFFD.

use std::hash::{DefaultHasher, Hasher};

/// Largest file psy.md opens. Bigger files are reported, not loaded.
pub const MAX_DOC_BYTES: u64 = 32 * 1024 * 1024;

const UTF8_BOM: &[u8] = &[0xEF, 0xBB, 0xBF];

/// Line ending style used when writing a file.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Eol {
    Lf,
    Crlf,
}

/// Identity of a file's exact bytes. Two tokens are equal only if the bytes
/// were (with overwhelming probability) identical.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct Token(String);

impl Token {
    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// Rebuilds a token received from the frontend.
    pub fn from_string(s: String) -> Self {
        Token(s)
    }

    /// Byte length of the content the token was made from.
    pub fn byte_len(&self) -> u64 {
        self.0
            .split_once('-')
            .and_then(|(n, _)| n.parse().ok())
            .unwrap_or(0)
    }
}

/// Encodings that are recognized but not supported.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EncodingKind {
    Utf16Le,
    Utf16Be,
    /// Not valid UTF-8; `offset` is the first invalid byte.
    Unknown {
        offset: usize,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, thiserror::Error)]
pub enum DecodeError {
    #[error("unsupported encoding: {0:?}")]
    UnsupportedEncoding(EncodingKind),
}

/// A successfully decoded file.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Decoded {
    /// Content with `\n` line breaks and without BOM.
    pub text: String,
    pub bom: bool,
    /// Dominant line ending; used when saving.
    pub eol: Eol,
    /// True when the file mixed CRLF, LF or lone CR line breaks.
    pub mixed_eol: bool,
    pub token: Token,
}

/// Computes the identity token of raw file bytes.
pub fn token_of(bytes: &[u8]) -> Token {
    let mut h = DefaultHasher::new();
    h.write(bytes);
    Token(format!("{}-{:016x}", bytes.len(), h.finish()))
}

/// Decodes raw file bytes.
pub fn decode(bytes: &[u8]) -> Result<Decoded, DecodeError> {
    let token = token_of(bytes);
    if bytes.starts_with(&[0xFF, 0xFE]) {
        return Err(DecodeError::UnsupportedEncoding(EncodingKind::Utf16Le));
    }
    if bytes.starts_with(&[0xFE, 0xFF]) {
        return Err(DecodeError::UnsupportedEncoding(EncodingKind::Utf16Be));
    }
    let (bom, body) = match bytes.strip_prefix(UTF8_BOM) {
        Some(rest) => (true, rest),
        None => (false, bytes),
    };
    let text = std::str::from_utf8(body).map_err(|e| {
        let offset = e.valid_up_to() + if bom { UTF8_BOM.len() } else { 0 };
        DecodeError::UnsupportedEncoding(EncodingKind::Unknown { offset })
    })?;

    let (crlf, lf, cr) = count_line_endings(text.as_bytes());
    let kinds = [crlf, lf, cr].iter().filter(|&&n| n > 0).count();
    let eol = if crlf > lf + cr { Eol::Crlf } else { Eol::Lf };
    let text = if crlf + cr == 0 {
        text.to_owned()
    } else {
        normalize_line_endings(text)
    };
    Ok(Decoded {
        text,
        bom,
        eol,
        mixed_eol: kinds > 1,
        token,
    })
}

/// Encodes editor text (`\n` line breaks) back into file bytes.
pub fn encode(text: &str, bom: bool, eol: Eol) -> Vec<u8> {
    let mut out = Vec::with_capacity(text.len() + 3 + text.len() / 32);
    if bom {
        out.extend_from_slice(UTF8_BOM);
    }
    let normalized;
    let text = if text.contains('\r') {
        normalized = normalize_line_endings(text);
        normalized.as_str()
    } else {
        text
    };
    match eol {
        Eol::Lf => out.extend_from_slice(text.as_bytes()),
        Eol::Crlf => {
            for (i, part) in text.split('\n').enumerate() {
                if i > 0 {
                    out.extend_from_slice(b"\r\n");
                }
                out.extend_from_slice(part.as_bytes());
            }
        }
    }
    out
}

fn count_line_endings(b: &[u8]) -> (usize, usize, usize) {
    let (mut crlf, mut lf, mut cr) = (0, 0, 0);
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'\r' if b.get(i + 1) == Some(&b'\n') => {
                crlf += 1;
                i += 1;
            }
            b'\r' => cr += 1,
            b'\n' => lf += 1,
            _ => {}
        }
        i += 1;
    }
    (crlf, lf, cr)
}

fn normalize_line_endings(text: &str) -> String {
    text.replace("\r\n", "\n").replace('\r', "\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_utf8_without_bom() {
        let d = decode("# Überschrift\nÄpfel und Öl\n".as_bytes()).unwrap();
        assert_eq!(d.text, "# Überschrift\nÄpfel und Öl\n");
        assert!(!d.bom);
        assert_eq!(d.eol, Eol::Lf);
        assert!(!d.mixed_eol);
    }

    #[test]
    fn strips_and_reports_bom() {
        let mut bytes = UTF8_BOM.to_vec();
        bytes.extend_from_slice(b"text\n");
        let d = decode(&bytes).unwrap();
        assert!(d.bom);
        assert_eq!(d.text, "text\n");
    }

    #[test]
    fn detects_crlf_and_normalizes() {
        let d = decode(b"a\r\nb\r\n").unwrap();
        assert_eq!(d.eol, Eol::Crlf);
        assert_eq!(d.text, "a\nb\n");
        assert!(!d.mixed_eol);
    }

    #[test]
    fn mixed_line_endings_pick_dominant() {
        let d = decode(b"a\r\nb\r\nc\nd\r\n").unwrap();
        assert_eq!(d.eol, Eol::Crlf);
        assert!(d.mixed_eol);
        assert_eq!(d.text, "a\nb\nc\nd\n");

        let d = decode(b"a\nb\nc\r\n").unwrap();
        assert_eq!(d.eol, Eol::Lf);
        assert!(d.mixed_eol);
    }

    #[test]
    fn lone_cr_counts_as_line_break() {
        let d = decode(b"a\rb\n").unwrap();
        assert_eq!(d.text, "a\nb\n");
        assert!(d.mixed_eol);
    }

    #[test]
    fn rejects_utf16_le_and_be_with_kind() {
        assert_eq!(
            decode(&[0xFF, 0xFE, b'a', 0]),
            Err(DecodeError::UnsupportedEncoding(EncodingKind::Utf16Le))
        );
        assert_eq!(
            decode(&[0xFE, 0xFF, 0, b'a']),
            Err(DecodeError::UnsupportedEncoding(EncodingKind::Utf16Be))
        );
    }

    #[test]
    fn rejects_invalid_utf8_without_lossy() {
        // "Gr" + Latin-1 "ü" (0xFC) + "n"
        assert_eq!(
            decode(&[b'G', b'r', 0xFC, b'n']),
            Err(DecodeError::UnsupportedEncoding(EncodingKind::Unknown {
                offset: 2
            }))
        );
    }

    #[test]
    fn encode_roundtrips_bom_and_crlf() {
        let original = "\u{FEFF}# Titel\r\n\r\nZeile mit ß\r\n".as_bytes();
        let d = decode(original).unwrap();
        assert_eq!(encode(&d.text, d.bom, d.eol), original);
    }

    #[test]
    fn encode_lf_keeps_text() {
        assert_eq!(encode("a\nb", false, Eol::Lf), b"a\nb");
        assert_eq!(encode("a\nb", false, Eol::Crlf), b"a\r\nb");
        assert_eq!(encode("a\r\nb", false, Eol::Crlf), b"a\r\nb");
    }

    #[test]
    fn token_changes_on_any_byte_change() {
        assert_eq!(token_of(b"abc"), token_of(b"abc"));
        assert_ne!(token_of(b"abc"), token_of(b"abd"));
        assert_ne!(token_of(b"abc"), token_of(b"abc\n"));
        assert_ne!(token_of(b""), token_of(b"\0"));
    }

    #[test]
    fn empty_file_decodes_to_empty_text() {
        let d = decode(b"").unwrap();
        assert_eq!(d.text, "");
        assert_eq!(d.eol, Eol::Lf);
    }
}
