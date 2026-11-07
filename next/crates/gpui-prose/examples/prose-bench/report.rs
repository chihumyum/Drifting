//! A minimal JSON writer and sample statistics for the evidence files.

use std::fmt::Write as _;

pub enum J {
    Bool(bool),
    Num(f64),
    Int(i64),
    Str(String),
    Arr(Vec<J>),
    Obj(Vec<(String, J)>),
}

impl J {
    pub fn obj(fields: Vec<(&str, J)>) -> J {
        J::Obj(fields.into_iter().map(|(k, v)| (k.to_owned(), v)).collect())
    }

    pub fn str(s: impl Into<String>) -> J {
        J::Str(s.into())
    }

    /// Milliseconds, rounded to 0.001.
    pub fn ms(value: f64) -> J {
        J::Num((value * 1000.0).round() / 1000.0)
    }

    pub fn samples(values: &[f64]) -> J {
        J::Arr(
            values
                .iter()
                .map(|v| J::Num((v * 100.0).round() / 100.0))
                .collect(),
        )
    }

    pub fn to_pretty(&self) -> String {
        let mut out = String::new();
        self.write(&mut out, 0);
        out.push('\n');
        out
    }

    fn write(&self, out: &mut String, indent: usize) {
        match self {
            J::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
            J::Num(n) if n.is_finite() => {
                if n.fract() == 0.0 && n.abs() < 1e15 {
                    let _ = write!(out, "{}", *n as i64);
                } else {
                    let _ = write!(out, "{n}");
                }
            }
            J::Num(_) => out.push_str("null"),
            J::Int(i) => {
                let _ = write!(out, "{i}");
            }
            J::Str(s) => write_str(out, s),
            J::Arr(items) => {
                let flat = items
                    .iter()
                    .all(|item| matches!(item, J::Num(_) | J::Int(_) | J::Bool(_)));
                if flat {
                    out.push('[');
                    for (ix, item) in items.iter().enumerate() {
                        if ix > 0 {
                            out.push_str(", ");
                        }
                        item.write(out, indent);
                    }
                    out.push(']');
                } else if items.is_empty() {
                    out.push_str("[]");
                } else {
                    out.push_str("[\n");
                    for (ix, item) in items.iter().enumerate() {
                        pad(out, indent + 1);
                        item.write(out, indent + 1);
                        if ix + 1 < items.len() {
                            out.push(',');
                        }
                        out.push('\n');
                    }
                    pad(out, indent);
                    out.push(']');
                }
            }
            J::Obj(fields) => {
                if fields.is_empty() {
                    out.push_str("{}");
                    return;
                }
                out.push_str("{\n");
                for (ix, (key, value)) in fields.iter().enumerate() {
                    pad(out, indent + 1);
                    write_str(out, key);
                    out.push_str(": ");
                    value.write(out, indent + 1);
                    if ix + 1 < fields.len() {
                        out.push(',');
                    }
                    out.push('\n');
                }
                pad(out, indent);
                out.push('}');
            }
        }
    }
}

fn pad(out: &mut String, indent: usize) {
    for _ in 0..indent {
        out.push_str("  ");
    }
}

fn write_str(out: &mut String, s: &str) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            c if (c as u32) < 0x20 => {
                let _ = write!(out, "\\u{:04x}", c as u32);
            }
            c => out.push(c),
        }
    }
    out.push('"');
}

/// Percentile by nearest rank (p in 0..=100).
pub fn percentile(samples: &[f64], p: f64) -> f64 {
    if samples.is_empty() {
        return f64::NAN;
    }
    let mut sorted = samples.to_vec();
    sorted.sort_by(f64::total_cmp);
    let rank = ((p / 100.0) * sorted.len() as f64).ceil() as usize;
    sorted[rank.clamp(1, sorted.len()) - 1]
}

pub fn mean(samples: &[f64]) -> f64 {
    samples.iter().sum::<f64>() / samples.len().max(1) as f64
}

pub fn max(samples: &[f64]) -> f64 {
    samples.iter().copied().fold(f64::NAN, f64::max)
}

/// A one-minute load average at or above this (on the 12-core measuring
/// machine) means other work was running: frame timing and tails are skewed.
pub const QUIET_LOAD_1M: f64 = 2.0;

/// How quiet the machine was, from load averages sampled around the run.
/// Evidence measured on a busy machine is marked `reference_only`: fine for
/// orders of magnitude, not for comparing builds or patches.
pub fn conditions(loads: &[f64]) -> J {
    let highest = max(loads);
    let busy = highest.is_nan() || highest >= QUIET_LOAD_1M;
    J::obj(vec![
        ("load_average_1m_max", J::Num(highest)),
        ("quiet_below_1m", J::Num(QUIET_LOAD_1M)),
        ("reference_only", J::Bool(busy)),
        (
            "note",
            J::str(if busy {
                "High load: other builds were running on this machine. For reference only; do not compare builds or patches with these numbers. Remeasure on an idle machine (f4-editor.md, remeasuring)."
            } else {
                "Quiet machine."
            }),
        ),
    ])
}

/// `{count, mean, p50, p95, p99, max}` in milliseconds.
pub fn summary(samples: &[f64]) -> J {
    J::obj(vec![
        ("count", J::Int(samples.len() as i64)),
        ("mean_ms", J::ms(mean(samples))),
        ("p50_ms", J::ms(percentile(samples, 50.0))),
        ("p95_ms", J::ms(percentile(samples, 95.0))),
        ("p99_ms", J::ms(percentile(samples, 99.0))),
        ("max_ms", J::ms(max(samples))),
    ])
}

/// FNV-1a 64 of gpui-prose's and this harness's sources, compiled in, so evidence can be
/// checked against the code that produced it without recording paths.
pub fn source_fingerprint() -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for source in all_sources() {
        for &b in source.as_bytes() {
            hash ^= u64::from(b);
            hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
        }
    }
    format!("{hash:016x}")
}

/// Every source file of gpui-prose, its two small crates and this harness,
/// compiled in.
pub fn all_sources() -> &'static [&'static str] {
    const SOURCES: &[&str] = &[
        include_str!("../../Cargo.toml"),
        include_str!("../../src/lib.rs"),
        include_str!("../../src/editor.rs"),
        include_str!("../../src/extension.rs"),
        include_str!("../../src/platform.rs"),
        include_str!("../../src/schema.rs"),
        include_str!("../../src/style.rs"),
        include_str!("../../src/text/mod.rs"),
        include_str!("../../src/text/anchor.rs"),
        include_str!("../../src/text/conformance.rs"),
        include_str!("../../src/text/drdoc_style.rs"),
        include_str!("../../src/text/index.rs"),
        include_str!("../../src/text/loro_source.rs"),
        include_str!("../../src/text/source.rs"),
        include_str!("../../src/text/blocks.rs"),
        include_str!("../../src/text/doc.rs"),
        include_str!("../../src/text/marks.rs"),
        include_str!("../../src/text/mirror.rs"),
        include_str!("../../src/text/segment.rs"),
        include_str!("../../src/text/undo.rs"),
        include_str!("../../src/text/units.rs"),
        include_str!("../../src/layout/mod.rs"),
        include_str!("../../src/layout/book.rs"),
        include_str!("../../src/layout/heights.rs"),
        include_str!("../../src/layout/linebreak.rs"),
        include_str!("../../src/layout/paragraph.rs"),
        include_str!("../../src/input/mod.rs"),
        include_str!("../../src/input/actions.rs"),
        include_str!("../../src/input/composition.rs"),
        include_str!("../../src/input/editing.rs"),
        include_str!("../../src/input/ime.rs"),
        include_str!("../../src/input/mouse.rs"),
        include_str!("../../src/input/movement.rs"),
        include_str!("../../src/input/selection.rs"),
        include_str!("../../src/render/mod.rs"),
        include_str!("../../src/render/cursor.rs"),
        include_str!("../../src/render/element.rs"),
        include_str!("../../src/render/frame.rs"),
        include_str!("../../src/render/items.rs"),
        include_str!("../../src/render/paint.rs"),
        include_str!("../../src/render/runs.rs"),
        include_str!("../../src/render/blocks.rs"),
        include_str!("../../src/render/decor.rs"),
        include_str!("../../src/render/motion.rs"),
        include_str!("../../src/render/sand.rs"),
        include_str!("../../src/render/state.rs"),
        include_str!("../../src/render/ticks.rs"),
        include_str!("../../src/render/tests.rs"),
        include_str!("decor.rs"),
        include_str!("main.rs"),
        include_str!("bench.rs"),
        include_str!("platform.rs"),
        include_str!("report.rs"),
        include_str!("shell.rs"),
        include_str!("synth.rs"),
        include_str!("trace.rs"),
        include_str!("../../src/text/tests.rs"),
        include_str!("../../../gpui-ime/Cargo.toml"),
        include_str!("../../../gpui-ime/src/lib.rs"),
        include_str!("../../../gpui-ime/src/line.rs"),
        include_str!("../../../gpui-ime/src/overlay.rs"),
        include_str!("../../../gpui-ime/src/units.rs"),
        include_str!("../../../prose-linebreak/Cargo.toml"),
        include_str!("../../../prose-linebreak/src/lib.rs"),
        include_str!("../../src/input/tests.rs"),
    ];
    SOURCES
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn percentiles() {
        let samples: Vec<f64> = (1..=100).map(f64::from).collect();
        assert_eq!(percentile(&samples, 50.0), 50.0);
        assert_eq!(percentile(&samples, 95.0), 95.0);
        assert_eq!(percentile(&samples, 100.0), 100.0);
    }

    #[test]
    fn json_shape() {
        let j = J::obj(vec![
            ("a", J::Int(1)),
            ("b", J::samples(&[1.234, 2.0])),
            ("c", J::str("x\"y")),
        ]);
        assert_eq!(
            j.to_pretty(),
            "{\n  \"a\": 1,\n  \"b\": [1.23, 2],\n  \"c\": \"x\\\"y\"\n}\n"
        );
    }
}
