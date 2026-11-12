//! Markdown to sanitized HTML, split into top-level blocks.
//!
//! Each top-level block is rendered and sanitized on its own and carries its
//! source line range, so the frontend can keep unchanged blocks in place,
//! map scroll positions between source and preview, and anchor the reading
//! position across updates.

use std::fmt;
use std::hash::{DefaultHasher, Hasher};
use std::path::PathBuf;
use std::sync::Mutex;

use comrak::adapters::{HeadingAdapter, HeadingMeta};
use comrak::nodes::{NodeValue, Sourcepos};
use comrak::options::Plugins;
use comrak::{Anchorizer, Arena, Options, format_html_with_plugins, parse_document};

use crate::sanitize;

/// What the renderer may resolve for one document.
#[derive(Clone, Debug, Default)]
pub struct RenderCtx {
    /// Folder of the document; relative image paths resolve against it.
    pub doc_dir: Option<PathBuf>,
    /// Canonical folders local images may come from (document folder plus
    /// folders the user granted).
    pub roots: Vec<PathBuf>,
    pub allow_external_images: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Block {
    pub html: String,
    /// Equal keys mean equal rendering apart from source line numbers.
    pub key: String,
    pub line_start: u32,
    pub line_end: u32,
}

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
pub struct Heading {
    pub level: u8,
    pub text: String,
    pub id: String,
    pub line: u32,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, serde::Serialize)]
pub struct RenderResult {
    pub blocks: Vec<Block>,
    pub headings: Vec<Heading>,
    pub has_mermaid: bool,
}

/// URL prefix under which the shell serves scoped local images.
#[cfg(windows)]
pub const ASSET_BASE: &str = "http://psymd-asset.localhost/";
#[cfg(not(windows))]
pub const ASSET_BASE: &str = "psymd-asset://localhost/";

pub fn render(text: &str, ctx: &RenderCtx) -> RenderResult {
    let options = options();
    let arena = Arena::new();
    let root = parse_document(&arena, text, &options);

    let has_mermaid = root.descendants().any(|n| match &n.data().value {
        NodeValue::CodeBlock(cb) => cb.info.split_whitespace().next() == Some("mermaid"),
        _ => false,
    });

    let collector = HeadingCollector::default();
    let mut plugins = Plugins::default();
    plugins.render.heading_adapter = Some(&collector);

    let mut blocks = Vec::new();
    let mut push = |raw: &str, start: usize, end: usize| {
        let html = sanitize::clean(raw, ctx);
        if !html.trim().is_empty() {
            blocks.push(Block {
                key: block_key(&html),
                html,
                line_start: start as u32,
                line_end: end as u32,
            });
        }
    };

    // comrak moves footnote definitions to the end; each would otherwise get
    // its own list and restart the numbering, so they become one block.
    let mut footnotes = String::new();
    let mut footnote_lines: Option<(usize, usize)> = None;
    // A raw HTML block that opens a container (`<details>`, `<div>`) without
    // closing it owns the Markdown that follows until the closing block; the
    // pieces are sanitized together so the content stays inside.
    let mut open: Option<(String, usize, usize, i32)> = None;
    let mut raw = String::new();
    for child in root.children() {
        raw.clear();
        if format_html_with_plugins(child, &options, &mut raw, &plugins).is_err() {
            continue;
        }
        let sp = child.data().sourcepos;
        if matches!(child.data().value, NodeValue::FootnoteDefinition(_)) {
            if let (Some(a), Some(b)) = (raw.find("<li"), raw.rfind("</li>")) {
                footnotes.push_str(&raw[a..b + 5]);
                footnotes.push('\n');
            }
            let (start, _) = footnote_lines.unwrap_or((sp.start.line, 0));
            footnote_lines = Some((start, sp.end.line));
            continue;
        }
        let balance = match &child.data().value {
            NodeValue::HtmlBlock(b) => container_balance(&b.literal),
            _ => 0,
        };
        match open.as_mut() {
            Some((html, _, end, depth)) => {
                html.push_str(&raw);
                *end = sp.end.line;
                *depth += balance;
                if *depth <= 0 {
                    let (html, start, end, _) = open.take().unwrap_or_default();
                    push(&html, start, end);
                }
            }
            None if balance > 0 => open = Some((raw.clone(), sp.start.line, sp.end.line, balance)),
            None => push(&raw, sp.start.line, sp.end.line),
        }
    }
    if let Some((html, start, end, _)) = open {
        push(&html, start, end);
    }
    if let Some((start, end)) = footnote_lines {
        let html = format!(
            "<section class=\"footnotes\" data-footnotes=\"\" data-sourcepos=\"{start}:1-{end}:1\"><ol>\n{footnotes}</ol></section>"
        );
        push(&html, start, end);
    }

    let headings = collector.0.into_inner().map(|s| s.list).unwrap_or_default();
    RenderResult {
        blocks,
        headings,
        has_mermaid,
    }
}

/// Opened minus closed container tags in a raw HTML block.
fn container_balance(html: &str) -> i32 {
    const CONTAINERS: &[&str] = &[
        "details",
        "div",
        "section",
        "article",
        "aside",
        "blockquote",
        "figure",
        "dl",
        "ul",
        "ol",
        "table",
        "center",
    ];
    let mut depth = 0;
    let bytes = html.as_bytes();
    let mut i = 0;
    while let Some(off) = html[i..].find('<') {
        let start = i + off + 1;
        let closing = bytes.get(start) == Some(&b'/');
        let name_start = if closing { start + 1 } else { start };
        let name_end = html[name_start..]
            .find(|c: char| !c.is_ascii_alphanumeric())
            .map_or(html.len(), |n| name_start + n);
        let name = html[name_start..name_end].to_ascii_lowercase();
        let tag_end = html[name_end..]
            .find('>')
            .map_or(html.len(), |n| name_end + n);
        let self_closing = html[..tag_end].ends_with('/');
        if CONTAINERS.contains(&name.as_str()) && !self_closing {
            depth += if closing { -1 } else { 1 };
        }
        i = (tag_end + 1).min(html.len());
        if i >= html.len() {
            break;
        }
    }
    depth
}

fn options() -> Options<'static> {
    let mut o = Options::default();
    o.extension.strikethrough = true;
    o.extension.table = true;
    o.extension.autolink = true;
    o.extension.tasklist = true;
    o.extension.footnotes = true;
    // Raw HTML passes through comrak and is cleaned by the sanitizer.
    o.render.r#unsafe = true;
    o.render.sourcepos = true;
    o.render.tasklist_classes = true;
    o
}

/// Hash of the block HTML without source line numbers.
fn block_key(html: &str) -> String {
    const ATTR: &str = " data-sourcepos=\"";
    let mut h = DefaultHasher::new();
    let mut rest = html;
    while let Some(i) = rest.find(ATTR) {
        h.write(&rest.as_bytes()[..i]);
        let after = &rest[i + ATTR.len()..];
        rest = after.find('"').map_or("", |j| &after[j + 1..]);
    }
    h.write(rest.as_bytes());
    format!("{:016x}", h.finish())
}

#[derive(Default)]
struct HeadingState {
    anchorizer: Anchorizer,
    list: Vec<Heading>,
}

/// Renders headings with prefixed ids (and no anchor links) and records them
/// for the table of contents in document order.
#[derive(Default)]
struct HeadingCollector(Mutex<HeadingState>);

impl HeadingAdapter for HeadingCollector {
    fn enter(
        &self,
        output: &mut dyn fmt::Write,
        heading: &HeadingMeta,
        sourcepos: Option<Sourcepos>,
    ) -> fmt::Result {
        let mut state = self.0.lock().map_err(|_| fmt::Error)?;
        let id = format!(
            "{}{}",
            sanitize::ID_PREFIX,
            state.anchorizer.anchorize(&heading.content)
        );
        write!(output, "<h{} id=\"{}\"", heading.level, escape_attr(&id))?;
        if let Some(sp) = sourcepos {
            write!(output, " data-sourcepos=\"{sp}\"")?;
        }
        output.write_str(">")?;
        state.list.push(Heading {
            level: heading.level,
            text: heading.content.clone(),
            id,
            line: sourcepos.map_or(0, |s| s.start.line as u32),
        });
        Ok(())
    }

    fn exit(&self, output: &mut dyn fmt::Write, heading: &HeadingMeta) -> fmt::Result {
        write!(output, "</h{}>", heading.level)
    }
}

fn escape_attr(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('"', "&quot;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn html(md: &str) -> String {
        render(md, &RenderCtx::default())
            .blocks
            .iter()
            .map(|b| b.html.as_str())
            .collect()
    }

    fn ctx_for(dir: &std::path::Path) -> RenderCtx {
        let dir = fs::canonicalize(dir).unwrap();
        RenderCtx {
            doc_dir: Some(dir.clone()),
            roots: vec![dir],
            allow_external_images: false,
        }
    }

    fn img_src(h: &str) -> String {
        let i = h.find("src=\"").expect("img src") + 5;
        let j = h[i..].find('"').unwrap();
        h[i..i + j].replace("&amp;", "&")
    }

    #[test]
    fn gfm_table_tasklist_strike_autolink() {
        let h = html(
            "| a | b |\n|---|---|\n| 1 | 2 |\n\n- [x] done\n- [ ] open\n\n~~old~~ www.example.com\n",
        );
        assert!(h.contains("<table"));
        assert!(h.contains("<td"));
        assert!(h.contains(">old</del>"));
        assert!(h.contains("href=\"http://www.example.com\""));
        let inputs = h.matches("<input").count();
        assert_eq!(inputs, 2);
        assert!(h.contains("checked"));
        assert_eq!(h.matches("disabled").count(), 2);
    }

    #[test]
    fn blocks_have_line_ranges() {
        let r = render("# A\n\npara\nmore\n\n- x\n- y\n", &RenderCtx::default());
        let lines: Vec<(u32, u32)> = r
            .blocks
            .iter()
            .map(|b| (b.line_start, b.line_end))
            .collect();
        assert_eq!(lines, vec![(1, 1), (3, 4), (6, 7)]);
        assert!(r.blocks[1].html.contains("data-sourcepos=\"3:1-4:4\""));
    }

    #[test]
    fn headings_have_prefixed_unique_ids() {
        let r = render(
            "# Intro\n\n## Intro\n\n## Über uns\n",
            &RenderCtx::default(),
        );
        let ids: Vec<&str> = r.headings.iter().map(|h| h.id.as_str()).collect();
        assert_eq!(ids, vec!["h-intro", "h-intro-1", "h-über-uns"]);
        assert_eq!(r.headings[2].text, "Über uns");
        assert_eq!(r.headings[2].level, 2);
        assert_eq!(r.headings[2].line, 5);
        assert!(r.blocks[0].html.contains("id=\"h-intro\""));
        assert!(!r.blocks[0].html.contains("<a"), "no empty anchor links");
    }

    #[test]
    fn key_ignores_line_shift() {
        let a = render("para\n", &RenderCtx::default());
        let b = render("\n\n\npara\n", &RenderCtx::default());
        assert_eq!(a.blocks[0].key, b.blocks[0].key);
        assert_ne!(a.blocks[0].line_start, b.blocks[0].line_start);
        let c = render("para!\n", &RenderCtx::default());
        assert_ne!(a.blocks[0].key, c.blocks[0].key);
    }

    #[test]
    fn mermaid_block_flagged() {
        let r = render("```mermaid\ngraph TD;\nA-->B\n```\n", &RenderCtx::default());
        assert!(r.has_mermaid);
        assert!(r.blocks[0].html.contains("language-mermaid"));
        assert!(!render("```rust\nfn x(){}\n```\n", &RenderCtx::default()).has_mermaid);
    }

    #[test]
    fn sanitize_blocks_active_content() {
        let attacks = [
            "<script>alert(1)</script>",
            "<img src=x onerror=alert(1)>",
            "<a href=\"javascript:alert(1)\">x</a>",
            "[x](javascript:alert(1))",
            "[x](JaVaScRiPt:alert(1))",
            "[x](data:text/html,<script>alert(1)</script>)",
            "<iframe src=\"https://example.com\"></iframe>",
            "<object data=\"x.swf\"></object>",
            "<embed src=\"x.swf\">",
            "<p style=\"background:url(https://example.com/t.png)\">x</p>",
            "<svg><script>alert(1)</script></svg>",
            "<svg onload=alert(1)></svg>",
            "<math><mi xlink:href=\"javascript:alert(1)\">x</mi></math>",
            "<form action=\"https://example.com\"><button formaction=\"x\">go</button></form>",
            "<base href=\"https://example.com/\">",
            "<meta http-equiv=\"refresh\" content=\"0;url=https://example.com\">",
            "<link rel=\"stylesheet\" href=\"https://example.com/x.css\">",
            "<style>body{display:none}</style>",
            "<video src=\"https://example.com/v.mp4\" autoplay></video>",
            "<img srcset=\"https://example.com/a.png 1x\">",
            "<details ontoggle=alert(1) open>x</details>",
            "<a href=\"https://example.com\" target=\"_blank\">x</a>",
        ];
        for a in attacks {
            let h = html(a).to_lowercase();
            for bad in [
                "<script",
                "onerror",
                "onload",
                "ontoggle",
                "javascript:",
                "<iframe",
                "<object",
                "<embed",
                "style=",
                "<svg",
                "<math",
                "<form",
                "<button",
                "formaction",
                "<base",
                "<meta",
                "<link",
                "<style",
                "<video",
                "srcset",
                "target=",
                "data:text",
            ] {
                assert!(!h.contains(bad), "{a:?} produced {h:?}");
            }
        }
    }

    #[test]
    fn raw_safe_html_kept() {
        let h = html(
            "<details><summary>Mehr</summary>Text</details>\n\n<kbd>Ctrl</kbd> H<sub>2</sub>O x<sup>2</sup>\n",
        );
        for tag in ["<details>", "<summary>", "<kbd>", "<sub>", "<sup>"] {
            assert!(h.contains(tag), "{tag} missing in {h}");
        }
    }

    #[test]
    fn task_checkbox_disabled() {
        let h = html("<input type=\"text\" value=\"x\">\n");
        assert!(h.contains("type=\"checkbox\""), "{h}");
        assert!(h.contains("disabled"), "{h}");
        assert!(!h.contains("value="), "{h}");
    }

    #[test]
    fn local_image_rewritten_to_asset_url() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir(dir.path().join("img")).unwrap();
        fs::write(dir.path().join("img/a b.png"), b"png").unwrap();
        let r = render("![Bild](img/a%20b.png)\n", &ctx_for(dir.path()));
        let src = img_src(&r.blocks[0].html);
        assert!(src.starts_with(ASSET_BASE), "{src}");
        assert!(src.contains("a%20b.png"), "{src}");
    }

    #[test]
    fn image_outside_root_blocked_with_dir() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir_all(dir.path().join("doc")).unwrap();
        fs::create_dir_all(dir.path().join("other")).unwrap();
        fs::write(dir.path().join("other/b.png"), b"png").unwrap();
        let r = render("![x](../other/b.png)\n", &ctx_for(&dir.path().join("doc")));
        let src = img_src(&r.blocks[0].html);
        assert!(src.starts_with("psymd-blocked://local/"), "{src}");
        assert!(src.contains("dir="), "{src}");
    }

    #[test]
    fn missing_image_marked_missing() {
        let dir = tempfile::tempdir().unwrap();
        let r = render("![x](nope.png)\n", &ctx_for(dir.path()));
        assert!(img_src(&r.blocks[0].html).starts_with("psymd-blocked://missing/"));
    }

    #[test]
    fn external_image_blocked_unless_allowed() {
        let md = "![x](https://example.com/a.png)\n";
        let mut ctx = RenderCtx::default();
        let src = img_src(&render(md, &ctx).blocks[0].html);
        assert!(src.starts_with("psymd-blocked://external/"), "{src}");
        ctx.allow_external_images = true;
        assert_eq!(
            img_src(&render(md, &ctx).blocks[0].html),
            "https://example.com/a.png"
        );
    }

    #[test]
    fn data_image_allowed_but_not_data_svg_link() {
        let h = html("![p](data:image/png;base64,iVBORw0KGgo=)\n");
        assert!(img_src(&h).starts_with("data:image/png"));
        assert!(!html("[x](data:image/png;base64,AAAA)\n").contains("href="));
    }

    #[test]
    fn ids_and_classes_filtered() {
        let h = html("<div id=\"toolbar\" class=\"conflict-bar\">x</div>\n");
        assert!(h.contains("id=\"h-toolbar\""), "{h}");
        assert!(!h.contains("conflict-bar"), "{h}");
    }

    #[test]
    fn links_keep_relative_and_http() {
        let h = html("[a](other.md#x) [b](https://example.com/p?q=1) [m](mailto:a@example.com)\n");
        assert!(h.contains("href=\"other.md#x\""), "{h}");
        assert!(h.contains("href=\"https://example.com/p?q=1\""), "{h}");
        assert!(h.contains("href=\"mailto:a@example.com\""), "{h}");
    }

    #[test]
    fn footnotes_render_with_resolvable_ids() {
        let h = html("Text[^1]\n\n[^1]: Notiz\n");
        assert!(h.contains("href=\"#fn-1\""), "{h}");
        assert!(h.contains("id=\"h-fn-1\""), "{h}");
        assert!(h.contains("Notiz"), "{h}");
        assert_eq!(
            h.matches("<section").count(),
            h.matches("</section>").count()
        );
    }

    #[test]
    fn footnotes_share_one_numbered_list() {
        let r = render(
            "A[^1] B[^2]\n\n[^1]: Eins\n[^2]: Zwei\n",
            &RenderCtx::default(),
        );
        let last = &r.blocks.last().unwrap().html;
        assert_eq!(last.matches("<ol>").count(), 1, "{last}");
        assert!(last.contains("Eins") && last.contains("Zwei"), "{last}");
        assert_eq!(r.blocks.len(), 2);
    }

    #[test]
    fn empty_document_has_no_blocks() {
        assert!(render("", &RenderCtx::default()).blocks.is_empty());
    }
}

#[cfg(test)]
mod serialize_tests {
    use super::*;

    #[test]
    fn block_serializes_with_frontend_field_names() {
        let r = render("# A\n", &RenderCtx::default());
        let json = serde_json::to_value(&r.blocks[0]).unwrap();
        assert!(json.get("lineStart").is_some(), "{json}");
        assert!(json.get("lineEnd").is_some(), "{json}");
        let h = serde_json::to_value(&r.headings[0]).unwrap();
        for k in ["level", "text", "id", "line"] {
            assert!(h.get(k).is_some(), "{k} missing in {h}");
        }
    }
}

#[cfg(test)]
mod html_container_tests {
    use super::*;

    #[test]
    fn details_wraps_following_markdown() {
        let r = render(
            "<details>\n<summary>Mehr</summary>\n\nInnen **fett**.\n\n</details>\n\nDanach.\n",
            &RenderCtx::default(),
        );
        assert_eq!(r.blocks.len(), 2, "{:#?}", r.blocks);
        let first = &r.blocks[0].html;
        let inner = first.find("Innen").unwrap();
        assert!(first.find("</details>").unwrap() > inner, "{first}");
        assert_eq!(r.blocks[0].line_start, 1);
        assert_eq!(r.blocks[0].line_end, 6);
        assert!(r.blocks[1].html.contains("Danach"));
    }

    #[test]
    fn unclosed_container_groups_to_the_end() {
        let r = render("<div>\n\nA\n\nB\n", &RenderCtx::default());
        assert_eq!(r.blocks.len(), 1, "{:#?}", r.blocks);
    }

    #[test]
    fn closed_html_block_stays_alone() {
        let r = render("<div>x</div>\n\nA\n", &RenderCtx::default());
        assert_eq!(r.blocks.len(), 2);
    }
}

#[cfg(test)]
mod sourcepos_tests {
    use super::*;

    #[test]
    fn source_positions_only_on_blocks() {
        let r = render(
            "Text with **bold**, `code` and [a link](https://example.com).\n\n- item *em*\n",
            &RenderCtx::default(),
        );
        let html: String = r.blocks.iter().map(|b| b.html.as_str()).collect();
        assert_eq!(html.matches("data-sourcepos").count(), 3, "{html}");
        assert!(html.contains("<p data-sourcepos"), "{html}");
        assert!(html.contains("<li data-sourcepos"), "{html}");
        assert!(!html.contains("<strong data-sourcepos"), "{html}");
        assert!(!html.contains("<a data-sourcepos"), "{html}");
    }
}
