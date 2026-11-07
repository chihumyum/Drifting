//! Scripted scenarios: a JSON file of command calls, run in order against
//! one workspace, for acceptance runs an Agent session (or CI) can repeat.
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
//! - `save` keeps a step's output under a name; `${name.key.key}` in any
//!   string of a later input is replaced by that part of it (a string that
//!   is only the reference becomes the value itself, of any JSON type).
//! - `expect` maps JSON pointers into the output to the values they must
//!   have; `expect_error` names the error code the call must fail with.
//! - `actor` is `user` (default), `import` or `agent:<session>/<turn>`.
//! - `{ "undo": true }` undoes the actor's last step, `{ "redo": true }`
//!   redoes it.

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
    pub input: Value,
    #[serde(default)]
    pub actor: Option<String>,
    #[serde(default)]
    pub save: Option<String>,
    #[serde(default)]
    pub expect: BTreeMap<String, Value>,
    #[serde(default)]
    pub expect_error: Option<String>,
}

pub fn parse(text: &str) -> Result<Scenario, String> {
    let s: Scenario = serde_json::from_str(text).map_err(|e| format!("scenario: {e}"))?;
    for (i, step) in s.steps.iter().enumerate() {
        let kinds =
            usize::from(step.call.is_some()) + usize::from(step.undo) + usize::from(step.redo);
        if kinds != 1 {
            return Err(format!("step {i}: give exactly one of call, undo, redo"));
        }
        if let Some(c) = &step.call
            && registry().get(c).is_none()
        {
            return Err(format!("step {i}: unknown command {c}"));
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
        v = match v {
            Value::Array(a) => a.get(p.parse::<usize>().ok()?)?,
            _ => v.get(p)?,
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

/// Run every step; stop at the first that fails or whose expectation does
/// not hold. Returns one line per step and what was saved.
pub fn run(ws: &Workspace, s: &Scenario) -> Result<Value, String> {
    let mut saved: BTreeMap<String, Value> = BTreeMap::new();
    let mut lines = Vec::new();
    for (i, step) in s.steps.iter().enumerate() {
        let actor = actor(step.actor.as_deref()).map_err(|e| format!("step {i}: {e}"))?;
        let (label, result) = if let Some(c) = &step.call {
            let input = substitute(&step.input, &saved).map_err(|e| format!("step {i}: {e}"))?;
            let input = if input.is_null() { json!({}) } else { input };
            (
                c.clone(),
                ws.call(&actor, c, input).map(|o| o["output"].clone()),
            )
        } else if step.undo {
            (
                "undo".into(),
                ws.undo(&actor).map(|o| json!(o.map(|x| x.output))),
            )
        } else {
            (
                "redo".into(),
                ws.redo(&actor).map(|o| json!(o.map(|x| x.output))),
            )
        };
        match (result, &step.expect_error) {
            (Ok(_), Some(code)) => {
                return Err(format!(
                    "step {i} ({label}): expected error {code}, it succeeded"
                ));
            }
            (Err(e), Some(code)) if e.code() == *code => {
                lines.push(format!("{i:3} {label}: failed as expected ({code})"));
            }
            (Err(e), _) => {
                return Err(format!("step {i} ({label}): {}: {e}", e.code()));
            }
            (Ok(out), None) => {
                for (pointer, want) in &step.expect {
                    let got = out.pointer(pointer).cloned().unwrap_or(Value::Null);
                    if &got != want {
                        return Err(format!(
                            "step {i} ({label}): expected {pointer} = {want}, got {got}"
                        ));
                    }
                }
                lines.push(format!(
                    "{i:3} {label}: ok{}",
                    if step.expect.is_empty() {
                        ""
                    } else {
                        ", as expected"
                    }
                ));
                if let Some(name) = &step.save {
                    saved.insert(name.clone(), out);
                }
            }
        }
    }
    Ok(json!({ "about": s.about, "steps": lines, "saved": saved }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn references_are_replaced() {
        let saved: BTreeMap<String, Value> = [(
            "b".to_string(),
            json!({ "id": "x1", "n": 3, "list": [{"id": "y"}] }),
        )]
        .into();
        let v = json!({ "book": "${b.id}", "n": "${b.n}", "t": "in ${b.id} / ${b.list.0.id}" });
        assert_eq!(
            substitute(&v, &saved).unwrap(),
            json!({ "book": "x1", "n": 3, "t": "in x1 / y" })
        );
        assert!(substitute(&json!("${c.id}"), &saved).is_err());
    }

    #[test]
    fn steps_are_checked_before_running() {
        assert!(parse(r#"{"steps": [{"call": "no.such"}]}"#).is_err());
        assert!(parse(r#"{"steps": [{"call": "book.list", "undo": true}]}"#).is_err());
        let s = parse(r#"{"steps": [{"call": "book.list"}, {"call": "chapter.list", "input": {"book": "b"}}]}"#)
            .unwrap();
        assert!(is_read_only(&s));
        let s = parse(r#"{"steps": [{"call": "book.create", "input": {"name": "x"}}]}"#).unwrap();
        assert!(!is_read_only(&s));
        assert!(matches!(
            actor(Some("agent:s1/2")).unwrap(),
            Actor::Agent { turn: 2, .. }
        ));
        assert!(actor(Some("someone")).is_err());
    }
}
