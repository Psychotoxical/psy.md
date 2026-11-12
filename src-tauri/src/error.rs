//! Errors returned to the frontend as stable codes; the frontend translates
//! them. Messages from the OS may be attached as `detail`.

use std::io;

use psymd_core::doc_io::{DecodeError, EncodingKind, MAX_DOC_BYTES};
use psymd_core::save::SaveError;
use psymd_core::watcher::ReadProblem;
use serde::Serialize;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CmdError {
    pub code: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    /// For conflicts: token of the content now on disk.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current: Option<String>,
}

impl CmdError {
    pub fn new(code: &'static str) -> Self {
        CmdError {
            code,
            detail: None,
            current: None,
        }
    }

    pub fn with_detail(code: &'static str, detail: impl Into<String>) -> Self {
        CmdError {
            code,
            detail: Some(detail.into()),
            current: None,
        }
    }
}

impl From<io::Error> for CmdError {
    fn from(e: io::Error) -> Self {
        match e.kind() {
            io::ErrorKind::NotFound => CmdError::new("not-found"),
            io::ErrorKind::PermissionDenied => CmdError::new("permission"),
            _ => CmdError::with_detail("io", e.to_string()),
        }
    }
}

impl From<DecodeError> for CmdError {
    fn from(e: DecodeError) -> Self {
        let DecodeError::UnsupportedEncoding(kind) = e;
        encoding_error(kind)
    }
}

pub fn encoding_error(kind: EncodingKind) -> CmdError {
    match kind {
        EncodingKind::Utf16Le => CmdError::with_detail("encoding", "UTF-16 LE"),
        EncodingKind::Utf16Be => CmdError::with_detail("encoding", "UTF-16 BE"),
        EncodingKind::Unknown { offset } => {
            CmdError::with_detail("encoding", format!("byte {offset}"))
        }
    }
}

pub fn too_large(size: u64) -> CmdError {
    CmdError::with_detail(
        "too-large",
        format!(
            "{} MB > {} MB",
            size.div_ceil(1024 * 1024),
            MAX_DOC_BYTES / (1024 * 1024)
        ),
    )
}

impl From<SaveError> for CmdError {
    fn from(e: SaveError) -> Self {
        match e {
            SaveError::Conflict { current } => CmdError {
                code: "conflict",
                detail: None,
                current: current.map(|t| t.as_str().to_owned()),
            },
            SaveError::ReadOnly => CmdError::new("read-only"),
            SaveError::Locked => CmdError::new("locked"),
            SaveError::Io { kind, message } => match kind {
                io::ErrorKind::PermissionDenied => CmdError::new("permission"),
                io::ErrorKind::NotFound => CmdError::new("not-found"),
                _ => CmdError::with_detail("io", message),
            },
        }
    }
}

impl From<ReadProblem> for CmdError {
    fn from(p: ReadProblem) -> Self {
        match p {
            ReadProblem::Encoding(kind) => encoding_error(kind),
            ReadProblem::TooLarge { size } => too_large(size),
            ReadProblem::Io { kind, message } => CmdError::from(io::Error::new(kind, message)),
        }
    }
}
