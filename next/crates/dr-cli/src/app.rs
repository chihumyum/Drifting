//! `cargo drifting app …`: one call to a running development build's debug
//! bridge.
//!
//! The build is found by its development profile, the way `cargo xtask dev`
//! names it: `--profile <name>`, else `DRIFTING_PROFILE`, else the checkout's
//! (the linked worktree's name, plus `--instance <name>`).

use std::path::PathBuf;
use std::time::Duration;

use base64::Engine as _;
use dr_debug_protocol::{Client, Paths, place};
use serde_json::{Value, json};

/// What `app` was asked to do.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AppCall {
    pub verb: String,
    pub args: Vec<String>,
    pub params: Option<String>,
    pub input: Option<String>,
    pub profile: Option<String>,
    pub instance: Option<String>,
    pub text: Option<String>,
    pub timeout_ms: Option<u64>,
}

pub const VERBS: &str = "  app info | state | methods | actions | focus | quit | shelf
  app book <name or id>                 open a book, as the bookshelf does
  app call <command> [--input JSON]     an F3 command or query, as the author, in the app
  app dispatch <action> [--params JSON] a GPUI action, as its shortcut would
  app type <text>                       type into the focused text field
  app key <keys…>                       press keys (secondary-z, enter, escape, …)
  app click <x> <y>                     click at a window position
  app open <chapter title | page key | link>
  app text [page key]                   the paragraphs the page shows
  app wait [--text S] [--timeout MS]    until the book and the pages on screen are read
  app screenshot <file.png>             the window, drawn inside the app
  app raw <method> [--params JSON]      any bridge method
    [--profile P | --instance I]        which development build (default: this checkout's)";

/// The development profile a call goes to.
pub fn profile(explicit: Option<&str>, instance: Option<&str>) -> Option<String> {
    if let Some(p) = explicit {
        return Some(p.to_owned());
    }
    if instance.is_none()
        && let Ok(p) = std::env::var(dr_platform::identity::PROFILE_ENV)
        && !p.trim().is_empty()
    {
        return Some(p);
    }
    let here = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    place::checkout_profile(&here, instance)
}

fn json_arg(name: &str, s: &Option<String>) -> Result<Value, String> {
    match s {
        Some(t) => serde_json::from_str(t).map_err(|e| format!("{name} is not JSON: {e}")),
        None => Ok(json!({})),
    }
}

fn one<'a>(args: &'a [String], what: &str) -> Result<&'a str, String> {
    match args {
        [x] => Ok(x),
        [] => Err(format!("{what} is required")),
        _ => Err(format!("one {what} only")),
    }
}

/// The method and params a verb stands for, and where a screenshot goes.
pub fn request(a: &AppCall) -> Result<(String, Value, Option<PathBuf>), String> {
    let simple = |m: &str| Ok((m.to_owned(), json!({}), None));
    match a.verb.as_str() {
        "info" => simple("app.info"),
        "state" => simple("state.get"),
        "methods" => simple("methods"),
        "actions" => simple("action.list"),
        "focus" => simple("window.focus"),
        "quit" => simple("app.quit"),
        "shelf" => simple("shelf.show"),
        "book" => Ok((
            "book.open".into(),
            json!({ "name": a.args.join(" ") }),
            None,
        )),
        "call" => Ok((
            "command.call".into(),
            json!({ "name": one(&a.args, "a command name")?, "input": json_arg("--input", &a.input)? }),
            None,
        )),
        "dispatch" => {
            let mut p = json!({ "name": one(&a.args, "an action name")? });
            if a.params.is_some() {
                p["params"] = json_arg("--params", &a.params)?;
            }
            Ok(("action.dispatch".into(), p, None))
        }
        "type" => Ok((
            "input.type".into(),
            json!({ "text": a.args.join(" ") }),
            None,
        )),
        "key" => Ok((
            "input.key".into(),
            json!({ "keys": a.args.join(" ") }),
            None,
        )),
        "click" => match a.args.as_slice() {
            [x, y] => {
                let n = |s: &str| s.parse::<f64>().map_err(|_| format!("{s} is not a number"));
                Ok((
                    "input.click".into(),
                    json!({ "x": n(x)?, "y": n(y)? }),
                    None,
                ))
            }
            _ => Err("click <x> <y>".into()),
        },
        "open" => {
            let what = a.args.join(" ");
            let page_key = what == "book"
                || [
                    "chapter:",
                    "idea:",
                    "storyline:",
                    "element:",
                    "category:",
                    "material:",
                ]
                .iter()
                .any(|p| what.starts_with(p));
            let p = if page_key {
                json!({ "target": what })
            } else if what.contains("://") {
                json!({ "link": what })
            } else {
                json!({ "chapter": what })
            };
            Ok(("nav.open".into(), p, None))
        }
        "text" => Ok((
            "page.text".into(),
            match a.args.as_slice() {
                [] => json!({}),
                [k] => json!({ "target": k }),
                _ => return Err("text [page key]".into()),
            },
            None,
        )),
        "wait" => {
            let mut p = json!({ "until": "ready" });
            if let Some(t) = &a.text {
                p["text"] = json!(t);
            }
            if let Some(ms) = a.timeout_ms {
                p["timeout_ms"] = json!(ms);
            }
            Ok(("ui.wait".into(), p, None))
        }
        "screenshot" => Ok((
            "ui.screenshot".into(),
            json!({}),
            Some(PathBuf::from(one(&a.args, "a .png file")?)),
        )),
        "raw" => Ok((
            one(&a.args, "a method")?.to_owned(),
            json_arg("--params", &a.params)?,
            None,
        )),
        other => Err(format!("unknown app verb {other}\n{VERBS}")),
    }
}

pub fn execute(a: &AppCall) -> Result<String, String> {
    let (method, params, png) = request(a)?;
    let profile = profile(a.profile.as_deref(), a.instance.as_deref());
    let instance = place::instance_name(
        dr_platform::Identity::current().bundle_id,
        profile.as_deref(),
    );
    let paths = Paths::for_instance(&instance).map_err(|e| e.to_string())?;
    let mut client = Client::open(&paths).map_err(|e| format!("{instance}: {e}"))?;
    client.set_timeout(Some(Duration::from_millis(
        a.timeout_ms.unwrap_or(10_000).saturating_add(30_000),
    )));
    let out = client
        .call(&method, params)
        .map_err(|e| format!("{method}: {e}"))?;
    if let Some(path) = png {
        let b64 = out["png"].as_str().ok_or("no screenshot in the answer")?;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(b64)
            .map_err(|e| e.to_string())?;
        std::fs::write(&path, &bytes).map_err(|e| format!("{}: {e}", path.display()))?;
        return Ok(format!(
            "{} ({}×{}, {} KB)",
            path.display(),
            out["width"],
            out["height"],
            bytes.len() / 1024
        ));
    }
    serde_json::to_string_pretty(&out).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn call(verb: &str, args: &[&str]) -> AppCall {
        AppCall {
            verb: verb.into(),
            args: args.iter().map(|s| s.to_string()).collect(),
            params: None,
            input: None,
            profile: None,
            instance: None,
            text: None,
            timeout_ms: None,
        }
    }

    #[test]
    fn verbs_become_methods() {
        let r = |v, a: &[&str]| request(&call(v, a)).unwrap();
        assert_eq!(r("state", &[]).0, "state.get");
        assert_eq!(r("book", &["慢钟"]).1, json!({"name": "慢钟"}));
        assert_eq!(r("open", &["第一章"]).1, json!({"chapter": "第一章"}));
        assert_eq!(
            r("open", &["chapter:ab"]).1,
            json!({"target": "chapter:ab"})
        );
        assert_eq!(
            r("open", &["drifting-next-dev://open/b/chapters/x"]).1,
            json!({"link": "drifting-next-dev://open/b/chapters/x"})
        );
        assert_eq!(
            r("key", &["secondary-z", "enter"]).1,
            json!({"keys": "secondary-z enter"})
        );
        assert_eq!(r("type", &["灯塔", "亮了"]).1, json!({"text": "灯塔 亮了"}));
        assert_eq!(r("click", &["10", "20.5"]).1, json!({"x": 10.0, "y": 20.5}));
        assert_eq!(r("screenshot", &["a.png"]).2, Some(PathBuf::from("a.png")));
        assert!(request(&call("click", &["x"])).is_err());
        assert!(request(&call("fly", &[])).is_err());
        assert_eq!(profile(Some("p1"), None).as_deref(), Some("p1"));
    }
}
