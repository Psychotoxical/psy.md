//! `psymd-asset:` serves local images to the preview, but only from the
//! document folder and folders the user granted.

use std::path::Path;

use percent_encoding::percent_decode_str;
use psymd_core::scope::{ScopeError, resolve_in_scope};
use tauri::http::{Request, Response, StatusCode, header};
use tauri::{Manager, Runtime, UriSchemeContext, UriSchemeResponder};

use crate::state::AppState;

pub const SCHEME: &str = "psymd-asset";

pub fn handle<R: Runtime>(
    ctx: UriSchemeContext<'_, R>,
    request: Request<Vec<u8>>,
    responder: UriSchemeResponder,
) {
    let roots = ctx.app_handle().state::<AppState>().roots();
    let raw = request.uri().path().to_owned();
    tauri::async_runtime::spawn_blocking(move || responder.respond(serve(&raw, &roots)));
}

fn serve(raw_path: &str, roots: &[std::path::PathBuf]) -> Response<Vec<u8>> {
    let Ok(decoded) = percent_decode_str(raw_path.trim_start_matches('/')).decode_utf8() else {
        return status(StatusCode::BAD_REQUEST);
    };
    match resolve_in_scope(Path::new(decoded.as_ref()), roots) {
        Ok((real, mime)) => match std::fs::read(&real) {
            Ok(bytes) => Response::builder()
                .status(StatusCode::OK)
                .header(header::CONTENT_TYPE, mime)
                .header(header::CACHE_CONTROL, "no-cache")
                .header("X-Content-Type-Options", "nosniff")
                .header(
                    header::CONTENT_SECURITY_POLICY,
                    "default-src 'none'; style-src 'unsafe-inline'",
                )
                .body(bytes)
                .unwrap_or_else(|_| status(StatusCode::INTERNAL_SERVER_ERROR)),
            Err(_) => status(StatusCode::NOT_FOUND),
        },
        Err(ScopeError::NotFound) => status(StatusCode::NOT_FOUND),
        Err(ScopeError::TooLarge) => status(StatusCode::PAYLOAD_TOO_LARGE),
        Err(ScopeError::OutsideScope | ScopeError::NotAnImage) => status(StatusCode::FORBIDDEN),
    }
}

fn status(code: StatusCode) -> Response<Vec<u8>> {
    let mut r = Response::new(Vec::new());
    *r.status_mut() = code;
    r
}
