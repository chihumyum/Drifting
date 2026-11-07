//! On-glass latency under Instruments.
//!
//! `trace-typing` types into a chapter and drops an `os_signpost` event at
//! each keystroke (subsystem `cc.drifting.prose-bench`, category
//! `PointsOfInterest`, name `key`). `present` runs it under
//! `xcrun xctrace record --template "Metal System Trace"` twice (stock GPUI
//! timing, then present-now), exports the signposts and the display table
//! from each trace, and measures, per keystroke, the time to the first
//! surface of this process shown on the display after it.

use std::{
    ffi::{CString, c_char, c_void},
    path::{Path, PathBuf},
    process::Command,
    time::{Duration, Instant},
};

use gpui::{App, AsyncApp, EntityInputHandler, SharedString};

use crate::{
    platform,
    report::{self, J},
    shell::{self, Corpus},
};

// ----- os_signpost --------------------------------------------------------------

const OS_SIGNPOST_EVENT: u8 = 0;
const OS_SIGNPOST_ID_EXCLUSIVE: u64 = 0xEEEE_B0B5_B2B2_EEEE;

unsafe extern "C" {
    fn os_log_create(subsystem: *const c_char, category: *const c_char) -> *mut c_void;
    fn os_signpost_enabled(log: *mut c_void) -> bool;
    fn _os_signpost_emit_with_name_impl(
        dso: *const c_void,
        log: *mut c_void,
        kind: u8,
        spid: u64,
        name: *const c_char,
        format: *const c_char,
        buf: *mut u8,
        size: u32,
    );
    static __dso_handle: u8;
}

// os_log decodes names and formats relative to this section, as clang's
// os_signpost macros emit them.
#[unsafe(link_section = "__TEXT,__oslogstring,cstring_literals")]
static KEY_NAME: [u8; 4] = *b"key\0";
#[unsafe(link_section = "__TEXT,__oslogstring,cstring_literals")]
static EMPTY_FORMAT: [u8; 1] = *b"\0";

pub struct Signposts {
    log: *mut c_void,
}

impl Signposts {
    pub fn new() -> Signposts {
        let subsystem = CString::new("cc.drifting.prose-bench").unwrap();
        let category = CString::new("PointsOfInterest").unwrap();
        // SAFETY: os_log_create copies nothing we free; the handle is immortal.
        let log = unsafe { os_log_create(subsystem.as_ptr(), category.as_ptr()) };
        Signposts { log }
    }

    /// A `key` event, now.
    pub fn key(&self) {
        // SAFETY: the os_signpost_event_emit macro, spelled out: an empty
        // argument buffer (summary byte, argument count) and static strings in
        // the __oslogstring section of this image.
        unsafe {
            if !os_signpost_enabled(self.log) {
                return;
            }
            let mut buf = [0u8, 0u8];
            _os_signpost_emit_with_name_impl(
                std::ptr::addr_of!(__dso_handle).cast(),
                self.log,
                OS_SIGNPOST_EVENT,
                OS_SIGNPOST_ID_EXCLUSIVE,
                KEY_NAME.as_ptr().cast(),
                EMPTY_FORMAT.as_ptr().cast(),
                buf.as_mut_ptr(),
                buf.len() as u32,
            );
        }
    }
}

// ----- the traced process -------------------------------------------------------

/// Types `keys` characters at 8 per second into the 20k-char chapter with a
/// solid caret (so the only frames are the keystrokes'), marking each key.
pub fn run_traced_typing(present_now: bool, keys: usize, report_path: Option<String>) {
    platform::NO_BLINK.store(true, std::sync::atomic::Ordering::Relaxed);
    platform::IMMEDIATE.store(present_now, std::sync::atomic::Ordering::Relaxed);
    gpui_platform::application().run(move |cx: &mut App| {
        let chapter = Corpus::chapter();
        let titles = vec![SharedString::from(chapter.titles[0].clone())];
        let (window, display) = shell::open_window(cx, titles, false, true, true);
        let report_path = report_path.clone();
        cx.spawn(async move |cx| {
            let _ = window.update(cx, |root, window, cx| {
                let editor = root.open(chapter.open(), window, cx);
                let focus = gpui::Focusable::focus_handle(editor.read(cx), cx);
                window.focus(&focus, cx);
                editor.update(cx, |editor, cx| {
                    let doc = &mut editor.book_mut().chapters[0].doc;
                    let lines = doc.visible_lines();
                    let mut at = 0;
                    for ix in lines / 2..lines {
                        let line = doc.line(ix);
                        if (60..400).contains(&line.chars) {
                            let chars = line.chars;
                            at = doc.line_start(ix) + chars / 2;
                            break;
                        }
                    }
                    editor.select(0, at..at, window, cx);
                });
            });
            sleep(cx, Duration::from_millis(1500)).await;
            let signposts = Signposts::new();
            let pool: Vec<char> = "春风又绿江南岸明月何时照我还人间四月芳菲尽山寺桃花始盛开"
                .chars()
                .collect();
            let t0 = Instant::now();
            let mut handler_ms = Vec::new();
            for i in 0..keys {
                let phase = Duration::from_micros(((i * 37) % 64) as u64 * 8_333 / 64);
                let slot = t0 + Duration::from_millis(125 * i as u64) + phase;
                let now = Instant::now();
                if slot > now {
                    sleep(cx, slot - now).await;
                }
                let text = pool[i % pool.len()].to_string();
                let start = Instant::now();
                let _ = window.update(cx, |root, window, cx| {
                    if let Some(editor) = root.editor.clone() {
                        signposts.key();
                        editor.update(cx, |editor, cx| {
                            editor.replace_text_in_range(None, &text, window, cx)
                        });
                    }
                });
                handler_ms.push(start.elapsed().as_secs_f64() * 1000.0);
            }
            sleep(cx, Duration::from_millis(500)).await;
            if let Some(path) = &report_path {
                let refresh = display.map_or(0.0, |d| d.2);
                let json = J::obj(vec![
                    ("keys", J::Int(keys as i64)),
                    ("refresh_hz", J::Num(refresh)),
                    ("handler", report::summary(&handler_ms)),
                ]);
                let _ = std::fs::write(path, json.to_pretty());
            }
            let _ = window.update(cx, |_, window, _| window.remove_window());
            cx.update(|cx| cx.quit());
        })
        .detach();
    });
}

async fn sleep(cx: &AsyncApp, duration: Duration) {
    cx.background_executor().timer(duration).await;
}

// ----- the driver -----------------------------------------------------------------

fn scratch_dir() -> PathBuf {
    let dir = std::env::temp_dir().join(format!("prose-bench-trace-{}", std::process::id()));
    let _ = std::fs::create_dir_all(&dir);
    dir
}

/// Records one traced typing run; returns the trace path.
fn record(dir: &Path, name: &str, present_now: bool, keys: usize) -> Option<(PathBuf, PathBuf)> {
    let exe = std::env::current_exe().ok()?;
    let trace = dir.join(format!("{name}.trace"));
    let report = dir.join(format!("{name}.json"));
    let mut cmd = Command::new("xcrun");
    cmd.args(["xctrace", "record", "--template", "Metal System Trace"])
        .args(["--instrument", "os_signpost"])
        .arg("--output")
        .arg(&trace)
        .args(["--no-prompt", "--launch", "--"])
        .arg(&exe)
        .arg("trace-typing")
        .args(["--keys", &keys.to_string()])
        .arg("--report")
        .arg(&report);
    if present_now {
        cmd.arg("--present-now");
    }
    let status = cmd.status().ok()?;
    if !status.success() && !trace.exists() {
        eprintln!("xctrace record failed ({status})");
        return None;
    }
    Some((trace, report))
}

fn export(trace: &Path, xpath: &str) -> Option<String> {
    let out = Command::new("xcrun")
        .args(["xctrace", "export", "--input"])
        .arg(trace)
        .args(["--xpath", xpath])
        .output()
        .ok()?;
    out.status
        .success()
        .then(|| String::from_utf8_lossy(&out.stdout).into_owned())
}

// ----- reading the exported tables ------------------------------------------------

/// One element of an `xctrace export` table, with its children.
#[derive(Clone, Debug, Default)]
struct Node {
    tag: String,
    id: Option<String>,
    reference: Option<String>,
    text: String,
    children: Vec<Node>,
}

/// A minimal reader for the XML `xctrace export` writes: elements,
/// attributes, text, self-closing tags. Enough for its tables, no more.
fn parse_xml(input: &str) -> Vec<Node> {
    fn attr(tag: &str, name: &str) -> Option<String> {
        let key = format!(" {name}=");
        let at = tag.find(&key)? + key.len();
        let quote = tag[at..].chars().next()?;
        let rest = &tag[at + 1..];
        let end = rest.find(quote)?;
        Some(unescape(&rest[..end]))
    }
    fn unescape(s: &str) -> String {
        s.replace("&lt;", "<")
            .replace("&gt;", ">")
            .replace("&quot;", "\"")
            .replace("&apos;", "'")
            .replace("&amp;", "&")
    }
    let mut stack: Vec<Node> = vec![Node::default()];
    let mut rest = input;
    while let Some(open) = rest.find('<') {
        let text = &rest[..open];
        if !text.trim().is_empty()
            && let Some(top) = stack.last_mut()
        {
            top.text.push_str(&unescape(text));
        }
        let Some(close) = rest[open..].find('>') else {
            break;
        };
        let tag = &rest[open + 1..open + close];
        rest = &rest[open + close + 1..];
        if tag.starts_with('?') || tag.starts_with('!') {
            continue;
        }
        if let Some(name) = tag.strip_prefix('/') {
            if stack.len() > 1 {
                let node = stack.pop().unwrap();
                debug_assert_eq!(node.tag, name.trim());
                stack.last_mut().unwrap().children.push(node);
            }
            continue;
        }
        let self_closing = tag.ends_with('/');
        let body = tag.trim_end_matches('/');
        let name = body.split_whitespace().next().unwrap_or("").to_owned();
        let node = Node {
            tag: name,
            id: attr(body, "id"),
            reference: attr(body, "ref"),
            ..Node::default()
        };
        if self_closing {
            stack.last_mut().unwrap().children.push(node);
        } else {
            stack.push(node);
        }
    }
    while stack.len() > 1 {
        let node = stack.pop().unwrap();
        stack.last_mut().unwrap().children.push(node);
    }
    stack.pop().map(|root| root.children).unwrap_or_default()
}

/// The rows of a table, each as its columns with `ref`s resolved.
fn table_rows(xml: &str) -> Vec<Vec<Node>> {
    fn collect<'a>(node: &'a Node, ids: &mut std::collections::HashMap<String, &'a Node>) {
        if let Some(id) = &node.id {
            ids.insert(id.clone(), node);
        }
        for child in &node.children {
            collect(child, ids);
        }
    }
    fn rows<'a>(node: &'a Node, out: &mut Vec<&'a Node>) {
        if node.tag == "row" {
            out.push(node);
        } else {
            for child in &node.children {
                rows(child, out);
            }
        }
    }
    let roots = parse_xml(xml);
    let mut ids = std::collections::HashMap::new();
    let mut found = Vec::new();
    for root in &roots {
        collect(root, &mut ids);
        rows(root, &mut found);
    }
    found
        .into_iter()
        .map(|row| {
            row.children
                .iter()
                .map(|cell| match &cell.reference {
                    Some(r) => ids.get(r).map_or_else(Node::default, |n| (*n).clone()),
                    None => cell.clone(),
                })
                .collect()
        })
        .collect()
}

fn table(trace: &Path, schema: &str) -> Vec<Vec<Node>> {
    let xpath = format!("/trace-toc/run[@number=\"1\"]/data/table[@schema=\"{schema}\"]");
    export(trace, &xpath).map_or_else(Vec::new, |xml| table_rows(&xml))
}

fn first_column_ns(rows: &[Vec<Node>]) -> Vec<u64> {
    let mut out: Vec<u64> = rows
        .iter()
        .filter_map(|row| row.first()?.text.trim().parse().ok())
        .collect();
    out.sort_unstable();
    out
}

fn first_at_or_after(sorted: &[u64], t: u64) -> Option<u64> {
    let ix = sorted.partition_point(|&x| x < t);
    sorted.get(ix).copied()
}

/// Per keystroke: key → present request, key → on glass, present → on glass (ms).
struct Latencies {
    to_present: Vec<f64>,
    to_glass: Vec<f64>,
    present_to_glass: Vec<f64>,
    unmatched: usize,
}

fn latencies(trace: &Path) -> Latencies {
    let signposts = table(trace, "os-signpost");
    let mut keys: Vec<u64> = signposts
        .iter()
        .filter(|row| row.get(6).is_some_and(|name| name.text.trim() == "key"))
        .filter_map(|row| row.first()?.text.trim().parse().ok())
        .collect();
    keys.sort_unstable();
    let presents = first_column_ns(&table(trace, "ca-client-present-request"));
    let glass = first_column_ns(&table(trace, "metal-object-dependency-chain-display"));
    let ms = |ns: u64| ns as f64 / 1e6;
    let mut out = Latencies {
        to_present: Vec::new(),
        to_glass: Vec::new(),
        present_to_glass: Vec::new(),
        unmatched: 0,
    };
    for (ix, &key) in keys.iter().enumerate() {
        let next_key = keys.get(ix + 1).copied().unwrap_or(u64::MAX);
        match first_at_or_after(&presents, key)
            .and_then(|p| Some((p, first_at_or_after(&glass, p)?)))
        {
            Some((p, g)) if p < next_key => {
                out.to_present.push(ms(p - key));
                out.to_glass.push(ms(g - key));
                out.present_to_glass.push(ms(g - p));
            }
            _ => out.unmatched += 1,
        }
    }
    out
}

pub fn run_present(out: Option<String>, keys: usize) {
    let dir = scratch_dir();
    let mut runs = Vec::new();
    for (name, present_now) in [("stock", false), ("present_now", true)] {
        let load = platform::load_average();
        let Some((trace, report_path)) = record(&dir, name, present_now, keys) else {
            eprintln!("could not record the {name} run");
            return;
        };
        let lat = latencies(&trace);
        let refresh = std::fs::read_to_string(&report_path)
            .ok()
            .and_then(|s| {
                let at = s.find("\"refresh_hz\": ")? + 14;
                s[at..]
                    .split(|c: char| !c.is_ascii_digit() && c != '.')
                    .next()?
                    .parse::<f64>()
                    .ok()
            })
            .unwrap_or(0.0);
        eprintln!(
            "{name}: {} keys matched, p95 key→glass {:.1} ms",
            lat.to_glass.len(),
            report::percentile(&lat.to_glass, 95.0)
        );
        runs.push((name, lat, refresh, load));
        let _ = std::fs::remove_dir_all(&trace);
        let _ = std::fs::remove_file(&report_path);
    }
    let _ = std::fs::remove_dir_all(&dir);
    let refresh = runs.first().map_or(0.0, |r| r.2);
    let mut fields = vec![
        ("schema", J::str("drifting.f4.present/1")),
        ("generated_at", J::str(crate::bench::today())),
        ("source_fingerprint", J::str(report::source_fingerprint())),
        ("machine", crate::bench::machine_json()),
        ("build", crate::bench::build_json()),
        (
            "display",
            J::obj(vec![
                ("builtin", J::Bool(true)),
                ("refresh_hz", J::Num(refresh)),
            ]),
        ),
        (
            "method",
            J::str(
                "xcrun xctrace record --template \"Metal System Trace\" --instrument os_signpost --launch, around the 20k-char chapter in a visible window on the built-in display with a solid caret (the only frames are the keystrokes'). Each keystroke drops an os_signpost event right before the insertText-equivalent call (replace_text_in_range), 8 keys/s spread over a 120 Hz frame. key→present: to the next ca-client-present-request of this process (CAMetalLayer present). key→glass: to the next block of the Metal dependency chain's display lane (metal-object-dependency-chain-display in-time; equals Core Animation's DrawableLifetime end for that drawable and precedes the drawable's presented handler by ~0.3 ms), i.e. when the frame with the new character is on the display. Includes everything after the input-method call: GPUI's wait for a frame, drawing, Metal, WindowServer compositing and the panel's refresh. Excludes AppKit's event dispatch before insertText (usually under 1 ms).",
            ),
        ),
        ("keys", J::Int(keys as i64)),
        (
            "corpus",
            J::Obj(vec![{
                let corpus = Corpus::chapter();
                let (k, v) = crate::bench::corpus_json("chapter", shell::CHAPTER_SEED, &corpus);
                (k.to_owned(), v)
            }]),
        ),
    ];
    let mut pass = None;
    for (name, lat, _, load) in &runs {
        let p95 = report::percentile(&lat.to_glass, 95.0);
        if *name == "stock" {
            pass = Some(p95);
        }
        fields.push((
            name,
            J::obj(vec![
                ("load_average_1m_before", J::Num(*load)),
                ("matched", J::Int(lat.to_glass.len() as i64)),
                ("unmatched", J::Int(lat.unmatched as i64)),
                ("key_to_present", report::summary(&lat.to_present)),
                ("key_to_glass", report::summary(&lat.to_glass)),
                ("present_to_glass", report::summary(&lat.present_to_glass)),
                ("key_to_glass_samples_ms", J::samples(&lat.to_glass)),
            ]),
        ));
    }
    fields.push(("budget_p95_ms", J::Num(16.0)));
    fields.push((
        "pass_stock",
        J::Bool(pass.is_some_and(|p| p.is_finite() && p <= 16.0)),
    ));
    let text = J::obj(fields).to_pretty();
    match out {
        Some(path) => std::fs::write(path, text).expect("write the evidence file"),
        None => print!("{text}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_xctrace_rows_with_refs() {
        let xml = r#"<?xml version="1.0"?><trace-query-result><node><schema name="x"/>
<row><event-time id="1" fmt="00:01">100</event-time><thread id="2" fmt="t"><tid id="3">7</tid></thread><signpost-name id="4" fmt="key">key</signpost-name></row>
<row><event-time id="5" fmt="00:02">250</event-time><thread ref="2"/><signpost-name ref="4"/></row>
</node></trace-query-result>"#;
        let rows = table_rows(xml);
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[1][0].text, "250");
        assert_eq!(rows[1][2].text, "key");
        assert_eq!(rows[1][1].children[0].text, "7");
        assert_eq!(first_at_or_after(&[1, 5, 9], 5), Some(5));
        assert_eq!(first_at_or_after(&[1, 5, 9], 10), None);
    }
}
