//! Scripted scenarios: a JSON file of steps, run in order, for acceptance
//! runs an Agent session (or CI) can repeat. A scenario either works on a
//! library offline (command calls only), or drives a development build of
//! the app through its debug bridge ([`crate::live`]).
//!
//! ```json
//! {
//!   "about": "Create a book and a chapter, then check the list",
//!   "steps": [
//!     { "call": "book.create", "input": { "name": "验收" }, "save": "book" },
//!     { "call": "chapter.create", "input": { "book": "${book.id}", "title": "第一章" },
//!       "save": "ch", "expect": { "/title": "第一章" } },
//!     { "call": "chapter.create", "input": { "book": "${book.id}", "title": "第一章" },
//!       "expect": { "/title": "第一章 2" } },
//!     { "call": "element.create", "input": { "book": "${book.id}", "name": "" },
//!       "expect_error": "invalid" },
//!     { "undo": true },
//!     { "call": "chapter.list", "input": { "book": "${book.id}" },
//!       "expect": { "/0/title": "第一章" } }
//!   ]
//! }
//! ```
//!
//! - A step is one of: `call` (an F3 command or query), `undo` / `redo` (the
//!   actor's last step; offline only), `app` (a debug-bridge method with
//!   `params`), `seed` (write a seed preset into the scenario's empty
//!   library), `legacy` (build a synthetic Drifting 0.1 library to import,
//!   `sample` or `sample-stale`; answers its data folder as `root`),
//!   `launch` (start the app: `{"book": id, "env": {…}, "settings": {…}}`,
//!   settings merged into the profile's `settings.json` first; answers
//!   `pid`, `profile`, `log` and `out`, the run's output folder, where
//!   files the app is to write can go).
//! - `save` keeps a step's output under a name; `${name.key.key}` in any
//!   string of a later step's input, params, launch or expectations is
//!   replaced by that part of it (a string that is only the reference
//!   becomes the value itself, of any JSON type). `[key=value]` picks the
//!   first array element whose `key` is `value`: `${books.[name=慢钟].id}`.
//! - `expect` maps JSON pointers into the output to the values they must
//!   have (`{"$sum": [a, b]}` adds numbers); `contains` maps pointers to
//!   text the string there must contain; `expect_error` names the error code
//!   the step must fail with. A pointer may hold `${…}` references and
//!   `[key=value]` segments (`/[name=沈知微]/aliases/0`).
//! - `actor` is `user` (default), `import` (offline only) or
//!   `agent:<session>/<turn>`.
//! - `pending` skips a step and says why (work another module has not
//!   landed yet); the run reports how many were skipped.
//! - `png` on an `app` step that answers a screenshot writes it to that
//!   file in the output folder. `note` says what a step is for.

use std::collections::BTreeMap;

use dr_workspace::{Actor, Workspace, registry};
use serde::Deserialize;
use serde_json::{Value, json};

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Scenario {
    #[serde(default)]
    pub about: String,
    pub steps: Vec<Step>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Step {
    #[serde(default)]
    pub call: Option<String>,
    #[serde(default)]
    pub undo: bool,
    #[serde(default)]
    pub redo: bool,
    #[serde(default)]
    pub app: Option<String>,
    #[serde(default)]
    pub seed: Option<String>,
    /// A synthetic Drifting 0.1 library to import (M10): `sample` (handed
    /// off) or `sample-stale` (without the handoff).
    #[serde(default)]
    pub legacy: Option<String>,
    #[serde(default)]
    pub launch: Option<Value>,
    #[serde(default)]
    pub input: Value,
    #[serde(default)]
    pub params: Value,
    #[serde(default)]
    pub actor: Option<String>,
    #[serde(default)]
    pub save: Option<String>,
    #[serde(default)]
    pub expect: BTreeMap<String, Value>,
    #[serde(default)]
    pub contains: BTreeMap<String, String>,
    #[serde(default)]
    pub expect_error: Option<String>,
    #[serde(default)]
    pub pending: Option<String>,
    #[serde(default)]
    pub png: Option<String>,
    /// What the step is for; not read.
    #[serde(default)]
    pub note: Option<String>,
}

impl Step {
    fn label(&self) -> String {
        if let Some(c) = &self.call {
            c.clone()
        } else if self.undo {
            "undo".into()
        } else if self.redo {
            "redo".into()
        } else if let Some(m) = &self.app {
            format!("app {m}")
        } else if let Some(p) = &self.seed {
            format!("seed {p}")
        } else if let Some(k) = &self.legacy {
            format!("legacy {k}")
        } else {
            "launch".into()
        }
    }

    /// Drives the app (or writes a seed into the scenario's own library).
    fn is_live(&self) -> bool {
        self.app.is_some() || self.launch.is_some() || self.seed.is_some() || self.legacy.is_some()
    }
}

/// What a step failed with.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StepError {
    pub code: String,
    pub message: String,
}

impl StepError {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }
}

impl std::fmt::Display for StepError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

/// Where a scenario's steps go.
pub trait Backend {
    /// An F3 command or query; answers its output.
    fn call(&mut self, actor: Option<&str>, name: &str, input: Value) -> Result<Value, StepError>;
    fn undo(&mut self, actor: Option<&str>, redo: bool) -> Result<Value, StepError>;
    fn app(&mut self, method: &str, params: Value) -> Result<Value, StepError>;
    fn seed(&mut self, preset: &str) -> Result<Value, StepError>;
    /// Builds a synthetic 0.1 library outside the profile; answers its
    /// data folder (`root`), database and book.
    fn legacy(&mut self, kind: &str) -> Result<Value, StepError>;
    fn launch(&mut self, params: Value) -> Result<Value, StepError>;
    /// Writes a screenshot; answers where.
    fn save_png(&mut self, name: &str, png_base64: &str) -> Result<String, StepError>;
}

fn needs_app() -> StepError {
    StepError::new(
        "needs_app",
        "this step drives the app: run the scenario with --app <drifting built with --features debug-bridge>",
    )
}

/// A workspace over a library, offline.
pub struct Offline<'a>(pub &'a Workspace);

impl Backend for Offline<'_> {
    fn call(&mut self, actor: Option<&str>, name: &str, input: Value) -> Result<Value, StepError> {
        let actor = self::actor(actor).map_err(|e| StepError::new("bad_request", e))?;
        self.0
            .call(&actor, name, input)
            .map(|o| o["output"].clone())
            .map_err(|e| StepError::new(e.code(), e.to_string()))
    }

    fn undo(&mut self, actor: Option<&str>, redo: bool) -> Result<Value, StepError> {
        let actor = self::actor(actor).map_err(|e| StepError::new("bad_request", e))?;
        let r = if redo {
            self.0.redo(&actor)
        } else {
            self.0.undo(&actor)
        };
        r.map(|o| json!(o.map(|x| x.output)))
            .map_err(|e| StepError::new(e.code(), e.to_string()))
    }

    fn app(&mut self, _: &str, _: Value) -> Result<Value, StepError> {
        Err(needs_app())
    }

    fn seed(&mut self, _: &str) -> Result<Value, StepError> {
        Err(needs_app())
    }

    fn legacy(&mut self, _: &str) -> Result<Value, StepError> {
        Err(needs_app())
    }

    fn launch(&mut self, _: Value) -> Result<Value, StepError> {
        Err(needs_app())
    }

    fn save_png(&mut self, _: &str, _: &str) -> Result<String, StepError> {
        Err(needs_app())
    }
}

pub fn parse(text: &str) -> Result<Scenario, String> {
    let s: Scenario = serde_json::from_str(text).map_err(|e| format!("scenario: {e}"))?;
    for (i, step) in s.steps.iter().enumerate() {
        let kinds = usize::from(step.call.is_some())
            + usize::from(step.undo)
            + usize::from(step.redo)
            + usize::from(step.app.is_some())
            + usize::from(step.seed.is_some())
            + usize::from(step.legacy.is_some())
            + usize::from(step.launch.is_some());
        if kinds != 1 {
            return Err(format!(
                "step {i}: give exactly one of call, undo, redo, app, seed, legacy, launch"
            ));
        }
        if let Some(c) = &step.call
            && registry().get(c).is_none()
        {
            return Err(format!("step {i}: unknown command {c}"));
        }
        if let Some(p) = &step.seed
            && dr_testkit::seed::Preset::parse(p).is_none()
        {
            return Err(format!("step {i}: unknown seed {p}"));
        }
        if step.png.is_some() && step.app.is_none() {
            return Err(format!("step {i}: png goes with an app step"));
        }
    }
    Ok(s)
}

/// Whether the scenario only reads (every step a query): then it runs on a
/// copy of the library and needs no `--yes`.
pub fn is_read_only(s: &Scenario) -> bool {
    s.steps.iter().all(|st| {
        st.call
            .as_deref()
            .and_then(|c| registry().get(c))
            .is_some_and(|spec| spec.is_query())
    })
}

/// Whether the scenario drives the app (or seeds its own library): it runs
/// on a development profile of its own ([`crate::live`]).
pub fn is_live(s: &Scenario) -> bool {
    s.steps.iter().any(Step::is_live)
}

pub fn actor(s: Option<&str>) -> Result<Actor, String> {
    match s.unwrap_or("user") {
        "user" => Ok(Actor::User),
        "import" => Ok(Actor::Import),
        other => {
            let rest = other
                .strip_prefix("agent:")
                .ok_or_else(|| format!("unknown actor {other}"))?;
            let (session, turn) = rest
                .split_once('/')
                .ok_or("an agent actor is agent:<session>/<turn>")?;
            let turn: u32 = turn.parse().map_err(|_| "the turn is a number")?;
            Ok(Actor::agent(session, turn, "dr-cli"))
        }
    }
}

fn lookup<'a>(saved: &'a BTreeMap<String, Value>, path: &str) -> Option<&'a Value> {
    let mut parts = path.split('.');
    let mut v = saved.get(parts.next()?)?;
    for p in parts {
        v = if let Some(filter) = p.strip_prefix('[').and_then(|f| f.strip_suffix(']')) {
            let (key, want) = filter.split_once('=')?;
            v.as_array()?.iter().find(|x| match &x[key] {
                Value::String(s) => s == want,
                other => serde_json::from_str::<Value>(want).is_ok_and(|w| &w == other),
            })?
        } else {
            match v {
                Value::Array(a) => a.get(p.parse::<usize>().ok()?)?,
                _ => v.get(p)?,
            }
        };
    }
    Some(v)
}

/// Replace `${name.path}` references in every string of `v`.
pub fn substitute(v: &Value, saved: &BTreeMap<String, Value>) -> Result<Value, String> {
    Ok(match v {
        Value::String(s) => {
            if let Some(path) = s.strip_prefix("${").and_then(|r| r.strip_suffix('}'))
                && !path.contains("${")
            {
                return lookup(saved, path)
                    .cloned()
                    .ok_or_else(|| format!("nothing saved at {path}"));
            }
            let mut out = String::new();
            let mut rest = s.as_str();
            while let Some(at) = rest.find("${") {
                out.push_str(&rest[..at]);
                let end = rest[at..]
                    .find('}')
                    .ok_or_else(|| format!("unclosed reference in {s:?}"))?;
                let path = &rest[at + 2..at + end];
                match lookup(saved, path).ok_or_else(|| format!("nothing saved at {path}"))? {
                    Value::String(x) => out.push_str(x),
                    other => out.push_str(&other.to_string()),
                }
                rest = &rest[at + end + 1..];
            }
            out.push_str(rest);
            Value::String(out)
        }
        Value::Array(a) => Value::Array(
            a.iter()
                .map(|x| substitute(x, saved))
                .collect::<Result<_, _>>()?,
        ),
        Value::Object(m) => Value::Object(
            m.iter()
                .map(|(k, x)| Ok((k.clone(), substitute(x, saved)?)))
                .collect::<Result<_, String>>()?,
        ),
        other => other.clone(),
    })
}

/// An expectation's pointer with its `${…}` references filled in.
fn key_of(pointer: &str, saved: &BTreeMap<String, Value>) -> Result<String, String> {
    match substitute(&json!(pointer), saved)? {
        Value::String(s) => Ok(s),
        other => Ok(other.to_string()),
    }
}

/// A JSON pointer whose segments may also be `[key=value]`: the first array
/// element whose `key` is `value` (`/[name=沈知微]/aliases`).
fn at_pointer<'a>(v: &'a Value, pointer: &str) -> Option<&'a Value> {
    if !pointer.contains('[') {
        return v.pointer(pointer);
    }
    let mut v = v;
    for seg in pointer.split('/').skip(1) {
        let seg = seg.replace("~1", "/").replace("~0", "~");
        v = if let Some(filter) = seg.strip_prefix('[').and_then(|f| f.strip_suffix(']')) {
            let (key, want) = filter.split_once('=')?;
            v.as_array()?.iter().find(|x| match &x[key] {
                Value::String(s) => s == want,
                other => serde_json::from_str::<Value>(want).is_ok_and(|w| &w == other),
            })?
        } else {
            match v {
                Value::Array(a) => a.get(seg.parse::<usize>().ok()?)?,
                _ => v.get(seg.as_str())?,
            }
        };
    }
    Some(v)
}

/// `{"$sum": [a, b, …]}` is the sum of its numbers; anything else is itself.
fn evaluate(v: Value) -> Result<Value, String> {
    if let Some(terms) = v
        .as_object()
        .filter(|m| m.len() == 1)
        .and_then(|m| m.get("$sum"))
    {
        let mut total = 0i64;
        for t in terms.as_array().ok_or("$sum takes an array")? {
            total += t
                .as_i64()
                .ok_or_else(|| format!("$sum: {t} is not a whole number"))?;
        }
        return Ok(json!(total));
    }
    Ok(v)
}

fn check(
    i: usize,
    label: &str,
    out: &Value,
    step: &Step,
    saved: &BTreeMap<String, Value>,
) -> Result<(), String> {
    for (pointer, want) in &step.expect {
        let want = substitute(want, saved)
            .and_then(evaluate)
            .map_err(|e| format!("step {i} ({label}): {e}"))?;
        let pointer = &key_of(pointer, saved).map_err(|e| format!("step {i} ({label}): {e}"))?;
        let got = at_pointer(out, pointer).cloned().unwrap_or(Value::Null);
        if got != want {
            return Err(format!(
                "step {i} ({label}): expected {pointer} = {want}, got {got}"
            ));
        }
    }
    for (pointer, part) in &step.contains {
        let part = match substitute(&json!(part), saved)
            .map_err(|e| format!("step {i} ({label}): {e}"))?
        {
            Value::String(s) => s,
            other => other.to_string(),
        };
        let pointer = &key_of(pointer, saved).map_err(|e| format!("step {i} ({label}): {e}"))?;
        let got = at_pointer(out, pointer)
            .and_then(Value::as_str)
            .unwrap_or_default();
        if !got.contains(&part) {
            let shown: String = got.chars().take(120).collect();
            return Err(format!(
                "step {i} ({label}): expected {pointer} to contain {part:?}, it reads {shown:?}"
            ));
        }
    }
    Ok(())
}

/// Run every step; stop at the first that fails or whose expectation does
/// not hold. Returns one line per step, what was saved and how many steps
/// were pending.
pub fn run_on(backend: &mut dyn Backend, s: &Scenario) -> Result<Value, String> {
    let (report, failed) = run_report(backend, s);
    match failed {
        None => Ok(report),
        Some(e) => Err(e),
    }
}

/// [`run_on`], keeping what ran and was saved up to a failure: the report
/// (`about`, `steps`, `saved`, `pending`) and the failure, if any.
pub fn run_report(backend: &mut dyn Backend, s: &Scenario) -> (Value, Option<String>) {
    let mut saved: BTreeMap<String, Value> = BTreeMap::new();
    let mut lines = Vec::new();
    let mut pending = 0usize;
    let failed = steps(backend, s, &mut saved, &mut lines, &mut pending).err();
    (
        json!({ "about": s.about, "steps": lines, "saved": saved, "pending": pending }),
        failed,
    )
}

fn steps(
    backend: &mut dyn Backend,
    s: &Scenario,
    saved: &mut BTreeMap<String, Value>,
    lines: &mut Vec<String>,
    pending: &mut usize,
) -> Result<(), String> {
    for (i, step) in s.steps.iter().enumerate() {
        let label = step.label();
        if let Some(why) = &step.pending {
            lines.push(format!("{i:3} {label}: pending ({why})"));
            *pending += 1;
            continue;
        }
        let fill = |v: &Value| substitute(v, saved).map_err(|e| format!("step {i}: {e}"));
        let object = |v: Value| if v.is_null() { json!({}) } else { v };
        let actor = step.actor.as_deref();
        let result = if let Some(c) = &step.call {
            backend.call(actor, c, object(fill(&step.input)?))
        } else if step.undo || step.redo {
            backend.undo(actor, step.redo)
        } else if let Some(m) = &step.app {
            backend.app(m, object(fill(&step.params)?))
        } else if let Some(p) = &step.seed {
            backend.seed(p)
        } else if let Some(k) = &step.legacy {
            backend.legacy(k)
        } else {
            backend.launch(object(fill(step.launch.as_ref().unwrap_or(&Value::Null))?))
        };
        match (result, &step.expect_error) {
            (Ok(_), Some(code)) => {
                return Err(format!(
                    "step {i} ({label}): expected error {code}, it succeeded"
                ));
            }
            (Err(e), Some(code)) if e.code == *code => {
                lines.push(format!("{i:3} {label}: failed as expected ({code})"));
            }
            (Err(e), _) => return Err(format!("step {i} ({label}): {e}")),
            (Ok(mut out), None) => {
                if let Some(name) = &step.png {
                    let b64 = out["png"]
                        .as_str()
                        .ok_or_else(|| format!("step {i} ({label}): no screenshot in the answer"))?
                        .to_owned();
                    let at = backend
                        .save_png(name, &b64)
                        .map_err(|e| format!("step {i} ({label}): {e}"))?;
                    out["png"] = json!(at);
                }
                check(i, &label, &out, step, saved)?;
                let checked = !step.expect.is_empty() || !step.contains.is_empty();
                lines.push(format!(
                    "{i:3} {label}: ok{}{}",
                    if checked { ", as expected" } else { "" },
                    step.png
                        .as_ref()
                        .map(|_| format!(" → {}", out["png"].as_str().unwrap_or_default()))
                        .unwrap_or_default()
                ));
                if let Some(name) = &step.save {
                    saved.insert(name.clone(), out);
                }
            }
        }
    }
    Ok(())
}

/// Run an offline scenario on `ws`.
pub fn run(ws: &Workspace, s: &Scenario) -> Result<Value, String> {
    run_on(&mut Offline(ws), s)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pointers_pick_array_elements_by_a_field() {
        let out = json!([
            { "name": "甲", "aliases": ["a"] },
            { "name": "沈知微", "aliases": ["知微", "阿微"], "n": 2 }
        ]);
        assert_eq!(
            at_pointer(&out, "/[name=沈知微]/aliases/1"),
            Some(&json!("阿微"))
        );
        assert_eq!(at_pointer(&out, "/[n=2]/name"), Some(&json!("沈知微")));
        assert_eq!(at_pointer(&out, "/[name=乙]/aliases"), None);
        assert_eq!(at_pointer(&out, "/0/name"), Some(&json!("甲")));
        assert_eq!(at_pointer(&out, ""), Some(&out));
        let saved = BTreeMap::from([("el".to_owned(), json!({ "id": "沈知微" }))]);
        assert_eq!(
            key_of("/[name=${el.id}]/n", &saved).unwrap(),
            "/[name=沈知微]/n"
        );
    }

    #[test]
    fn a_legacy_step_is_one_kind_of_step() {
        let s = parse(r#"{ "steps": [ { "legacy": "sample", "save": "old" } ] }"#).unwrap();
        assert!(is_live(&s));
        assert!(parse(r#"{ "steps": [ { "legacy": "sample", "seed": "tiny" } ] }"#).is_err());
    }

    #[test]
    fn references_are_replaced() {
        let saved: BTreeMap<String, Value> = [
            (
                "b".to_string(),
                json!({ "id": "x1", "n": 3, "list": [{"id": "y"}] }),
            ),
            (
                "books".to_string(),
                json!([{ "name": "甲", "id": "a" }, { "name": "慢钟", "id": "m" }]),
            ),
        ]
        .into();
        let v = json!({ "book": "${b.id}", "n": "${b.n}", "t": "in ${b.id} / ${b.list.0.id}" });
        assert_eq!(
            substitute(&v, &saved).unwrap(),
            json!({ "book": "x1", "n": 3, "t": "in x1 / y" })
        );
        assert_eq!(
            substitute(&json!("${books.[name=慢钟].id}"), &saved).unwrap(),
            json!("m")
        );
        assert!(substitute(&json!("${books.[name=无].id}"), &saved).is_err());
        assert!(substitute(&json!("${c.id}"), &saved).is_err());
        assert_eq!(
            evaluate(substitute(&json!({"$sum": ["${b.n}", 4]}), &saved).unwrap()).unwrap(),
            json!(7)
        );
    }

    #[test]
    fn steps_are_checked_before_running() {
        assert!(parse(r#"{"steps": [{"call": "no.such"}]}"#).is_err());
        assert!(parse(r#"{"steps": [{"call": "book.list", "undo": true}]}"#).is_err());
        assert!(parse(r#"{"steps": [{"seed": "huge"}]}"#).is_err());
        assert!(parse(r#"{"steps": [{"call": "book.list", "png": "a.png"}]}"#).is_err());
        let s = parse(r#"{"steps": [{"call": "book.list"}, {"call": "chapter.list", "input": {"book": "b"}}]}"#)
            .unwrap();
        assert!(is_read_only(&s) && !is_live(&s));
        let s = parse(r#"{"steps": [{"call": "book.create", "input": {"name": "x"}}]}"#).unwrap();
        assert!(!is_read_only(&s));
        let s = parse(r#"{"steps": [{"seed": "tiny"}, {"app": "state.get", "pending": "F6"}]}"#)
            .unwrap();
        assert!(is_live(&s) && !is_read_only(&s));
        assert!(matches!(
            actor(Some("agent:s1/2")).unwrap(),
            Actor::Agent { turn: 2, .. }
        ));
        assert!(actor(Some("someone")).is_err());
    }
}
