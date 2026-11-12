//! Turns renderer output into inert HTML.
//!
//! Documents are untrusted. Only a fixed set of passive tags and attributes
//! survives; scripts, styles, frames, forms, media and SVG are removed. Link
//! targets are limited to web, mail and relative URLs. Image sources are
//! resolved here: local images inside the allowed folders become scoped asset
//! URLs, everything else becomes a `psymd-blocked:` placeholder the frontend
//! turns into an explanation.

use std::borrow::Cow;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

use percent_encoding::{AsciiSet, NON_ALPHANUMERIC, percent_decode_str, utf8_percent_encode};

/// Same set as JavaScript's `encodeURIComponent`.
const COMPONENT: &AsciiSet = &NON_ALPHANUMERIC
    .remove(b'-')
    .remove(b'_')
    .remove(b'.')
    .remove(b'!')
    .remove(b'~')
    .remove(b'*')
    .remove(b'\'')
    .remove(b'(')
    .remove(b')');

use crate::render::{ASSET_BASE, RenderCtx};

/// Prefix of every document id, so document ids never collide with the UI.
pub const ID_PREFIX: &str = "h-";

const TAGS: &[&str] = &[
    "a",
    "abbr",
    "b",
    "blockquote",
    "br",
    "caption",
    "cite",
    "code",
    "col",
    "colgroup",
    "dd",
    "del",
    "details",
    "dfn",
    "div",
    "dl",
    "dt",
    "em",
    "figcaption",
    "figure",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "hr",
    "i",
    "img",
    "input",
    "ins",
    "kbd",
    "li",
    "mark",
    "ol",
    "p",
    "pre",
    "q",
    "rp",
    "rt",
    "ruby",
    "s",
    "samp",
    "section",
    "small",
    "span",
    "strike",
    "strong",
    "sub",
    "summary",
    "sup",
    "table",
    "tbody",
    "td",
    "tfoot",
    "th",
    "thead",
    "tr",
    "tt",
    "u",
    "ul",
    "var",
];

/// Elements that keep their source position.
const BLOCK_TAGS: &[&str] = &[
    "p",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "ul",
    "ol",
    "li",
    "pre",
    "blockquote",
    "table",
    "thead",
    "tbody",
    "tr",
    "hr",
    "div",
    "section",
    "details",
    "dl",
    "dt",
    "dd",
    "figure",
];

const IMAGE_DATA_PREFIXES: &[&str] = &[
    "data:image/png",
    "data:image/jpeg",
    "data:image/jpg",
    "data:image/gif",
    "data:image/webp",
    "data:image/avif",
    "data:image/bmp",
];

pub(crate) fn clean(html: &str, ctx: &RenderCtx) -> String {
    builder(ctx).clean(html).to_string()
}

fn builder(ctx: &RenderCtx) -> ammonia::Builder<'static> {
    let ctx = ctx.clone();
    let mut b = ammonia::Builder::empty();
    b.tags(TAGS.iter().copied().collect())
        .clean_content_tags(HashSet::from(["script", "style", "template"]))
        .generic_attributes(HashSet::from([
            "data-sourcepos",
            "id",
            "title",
            "lang",
            "dir",
        ]))
        .generic_attribute_prefixes(HashSet::from(["data-footnote"]))
        .tag_attributes(HashMap::from([
            ("a", HashSet::from(["href", "class"])),
            ("img", HashSet::from(["src", "alt", "width", "height"])),
            ("input", HashSet::from(["checked", "class"])),
            ("ol", HashSet::from(["start", "reversed", "class"])),
            ("ul", HashSet::from(["class"])),
            ("li", HashSet::from(["class"])),
            ("code", HashSet::from(["class"])),
            ("section", HashSet::from(["class"])),
            ("sup", HashSet::from(["class"])),
            ("td", HashSet::from(["align", "colspan", "rowspan"])),
            ("th", HashSet::from(["align", "colspan", "rowspan"])),
            ("details", HashSet::from(["open"])),
        ]))
        .tag_attribute_values(HashMap::from([(
            "input",
            HashMap::from([("type", HashSet::from(["checkbox"]))]),
        )]))
        .set_tag_attribute_value("input", "type", "checkbox")
        .set_tag_attribute_value("input", "disabled", "")
        .url_schemes(HashSet::from(["http", "https", "mailto", "file", "data"]))
        .url_relative(ammonia::UrlRelative::PassThrough)
        .link_rel(None)
        .strip_comments(true)
        .id_prefix(Some(ID_PREFIX))
        .attribute_filter(move |element, attribute, value| {
            filter_attribute(&ctx, element, attribute, value)
        });
    b
}

fn filter_attribute<'u>(
    ctx: &RenderCtx,
    element: &str,
    attribute: &str,
    value: &'u str,
) -> Option<Cow<'u, str>> {
    match (element, attribute) {
        ("img", "src") => Some(Cow::Owned(rewrite_image(ctx, value)?)),
        ("a", "href") => {
            let lower = value.trim_start().to_ascii_lowercase();
            if lower.starts_with("data:") || is_internal_host(value) {
                None
            } else {
                Some(Cow::Borrowed(value))
            }
        }
        (_, "class") => filter_classes(value).map(Cow::Owned),
        // Scroll sync and anchors use block positions only; inline ones
        // would only enlarge the document.
        (_, "data-sourcepos") if !BLOCK_TAGS.contains(&element) => None,
        _ => Some(Cow::Borrowed(value)),
    }
}

/// Keeps only classes the renderer itself produces.
fn filter_classes(value: &str) -> Option<String> {
    let kept: Vec<&str> = value
        .split_ascii_whitespace()
        .filter(|c| {
            matches!(
                *c,
                "task-list-item"
                    | "contains-task-list"
                    | "task-list-item-checkbox"
                    | "footnotes"
                    | "footnote-ref"
                    | "footnote-backref"
            ) || c.strip_prefix("language-").is_some_and(|lang| {
                !lang.is_empty()
                    && lang
                        .chars()
                        .all(|ch| ch.is_ascii_alphanumeric() || "+#._-".contains(ch))
            })
        })
        .collect();
    if kept.is_empty() {
        None
    } else {
        Some(kept.join(" "))
    }
}

/// URLs aimed at the shell's own endpoints never come from a document.
fn is_internal_host(value: &str) -> bool {
    url::Url::parse(value).is_ok_and(|u| {
        u.host_str().is_some_and(|h| {
            let h = h.to_ascii_lowercase();
            h == "psymd-asset.localhost" || h == "ipc.localhost" || h == "tauri.localhost"
        })
    })
}

fn rewrite_image(ctx: &RenderCtx, value: &str) -> Option<String> {
    let trimmed = value.trim();
    let lower = trimmed.to_ascii_lowercase();
    if lower.starts_with("data:") {
        return IMAGE_DATA_PREFIXES
            .iter()
            .any(|p| lower.starts_with(p))
            .then(|| trimmed.to_owned());
    }
    if lower.starts_with("http://") || lower.starts_with("https://") {
        if is_internal_host(trimmed) {
            return None;
        }
        return Some(if ctx.allow_external_images {
            trimmed.to_owned()
        } else {
            blocked("external", trimmed, None)
        });
    }
    let Some(path) = local_path(ctx, trimmed, &lower) else {
        return Some(blocked("missing", trimmed, None));
    };
    match fs::canonicalize(&path) {
        Err(_) => Some(blocked("missing", trimmed, None)),
        Ok(real) if ctx.roots.iter().any(|r| real.starts_with(r)) => Some(asset_url(&real)),
        Ok(real) => Some(blocked("local", trimmed, real.parent())),
    }
}

fn local_path(ctx: &RenderCtx, value: &str, lower: &str) -> Option<PathBuf> {
    if lower.starts_with("file:") {
        return url::Url::parse(value).ok()?.to_file_path().ok();
    }
    let without_suffix = value.split(['?', '#']).next().unwrap_or_default();
    let decoded = percent_decode_str(without_suffix).decode_utf8().ok()?;
    let p = Path::new(decoded.as_ref());
    if p.is_absolute() {
        Some(p.to_path_buf())
    } else {
        Some(ctx.doc_dir.as_ref()?.join(p))
    }
}

/// Scoped URL for a canonical local file; the shell re-checks the scope.
pub fn asset_url(path: &Path) -> String {
    let display = display_path(path);
    format!("{ASSET_BASE}{}", utf8_percent_encode(&display, COMPONENT))
}

fn blocked(kind: &str, src: &str, dir: Option<&Path>) -> String {
    let mut url = format!(
        "psymd-blocked://{kind}/?src={}",
        utf8_percent_encode(src, COMPONENT)
    );
    if let Some(d) = dir {
        url.push_str("&dir=");
        url.push_str(&utf8_percent_encode(&display_path(d), COMPONENT).to_string());
    }
    url
}

/// Removes the `\\?\` prefix Windows adds to canonical paths.
pub fn display_path(path: &Path) -> String {
    let s = path.to_string_lossy();
    if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{rest}")
    } else if let Some(rest) = s.strip_prefix(r"\\?\") {
        rest.to_owned()
    } else {
        s.into_owned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn display_path_strips_verbatim_prefix() {
        assert_eq!(display_path(Path::new(r"\\?\C:\a\b.png")), r"C:\a\b.png");
        assert_eq!(
            display_path(Path::new(r"\\?\UNC\srv\share\x.png")),
            r"\\srv\share\x.png"
        );
        assert_eq!(display_path(Path::new("/tmp/x.png")), "/tmp/x.png");
    }

    #[test]
    fn classes_keep_only_known_tokens() {
        assert_eq!(
            filter_classes("language-rust evil").as_deref(),
            Some("language-rust")
        );
        assert_eq!(
            filter_classes("language-c++").as_deref(),
            Some("language-c++")
        );
        assert_eq!(filter_classes("language-\"x").as_deref(), None);
        assert_eq!(filter_classes("toolbar"), None);
    }
}
