//! The command line's shape. Hand-parsed: a few subcommands and a handful
//! of flags do not need a parser dependency yet.

use std::path::PathBuf;

use crate::app::AppCall;

pub const USAGE: &str = "usage: cargo drifting workspace <subcommand>
       cargo drifting app <verb> (a running development build, through its debug bridge)

  describe [--json]                         the command registry (--json: with schemas)
  call <command> --library DIR [--input JSON] [--yes]
                                            run one command or query, as the author
  scenario <file.json | seed:P | seed-commands:P> --library DIR [--yes]
                                            run a scripted sequence of calls, or write a
                                            seed (P: tiny, lite, heavy, showcase)
  scenario <file.json> --app EXE [--profile P] [--out DIR] [--keep] [--yes]
                                            a scenario that drives the app (EXE built with
                                            --features debug-bridge) under a fresh profile
                                            (or P's, with --yes); screenshots and logs in DIR
  inspect --library DIR [--doc ID] [--json] what a library holds

Queries and read-only scenarios run on a copy of the library. Writing
commands need the app closed, back the library up first and only run with
--yes; without it they print what they would do.

";

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Command {
    Describe {
        json: bool,
    },
    Call {
        library: PathBuf,
        command: String,
        input: Option<String>,
        yes: bool,
    },
    Inspect {
        library: PathBuf,
        doc: Option<String>,
        json: bool,
    },
    Scenario {
        library: Option<PathBuf>,
        name: String,
        yes: bool,
        app: Option<PathBuf>,
        profile: Option<String>,
        out: Option<PathBuf>,
        keep: bool,
    },
    App(AppCall),
    Help,
}

#[derive(Default)]
struct Flags {
    library: Option<PathBuf>,
    input: Option<String>,
    params: Option<String>,
    doc: Option<String>,
    app: Option<PathBuf>,
    profile: Option<String>,
    instance: Option<String>,
    out: Option<PathBuf>,
    text: Option<String>,
    timeout_ms: Option<u64>,
    json: bool,
    yes: bool,
    keep: bool,
    positional: Vec<String>,
}

fn flags(args: &[String]) -> Result<Flags, String> {
    let mut f = Flags::default();
    let mut it = args.iter();
    while let Some(a) = it.next() {
        let mut value = |name: &str| {
            it.next()
                .cloned()
                .ok_or_else(|| format!("{name} needs a value"))
        };
        match a.as_str() {
            "--library" => f.library = Some(PathBuf::from(value("--library")?)),
            "--input" => f.input = Some(value("--input")?),
            "--doc" => f.doc = Some(value("--doc")?),
            "--params" => f.params = Some(value("--params")?),
            "--app" => f.app = Some(PathBuf::from(value("--app")?)),
            "--profile" => f.profile = Some(value("--profile")?),
            "--instance" => f.instance = Some(value("--instance")?),
            "--out" => f.out = Some(PathBuf::from(value("--out")?)),
            "--text" => f.text = Some(value("--text")?),
            "--timeout" => {
                let v = value("--timeout")?;
                f.timeout_ms = Some(
                    v.parse()
                        .map_err(|_| format!("--timeout {v}: milliseconds"))?,
                );
            }
            "--json" => f.json = true,
            "--yes" => f.yes = true,
            "--keep" => f.keep = true,
            s if s.starts_with('-') => return Err(format!("unknown option {s}")),
            s => f.positional.push(s.to_string()),
        }
    }
    Ok(f)
}

pub fn parse(args: &[String]) -> Result<Command, String> {
    match args.first().map(String::as_str) {
        None | Some("help" | "--help" | "-h") => return Ok(Command::Help),
        Some("workspace") => {}
        Some("app") => {
            let verb = args
                .get(1)
                .ok_or_else(|| format!("app needs a verb\n{}", crate::app::VERBS))?;
            let f = flags(args.get(2..).unwrap_or_default())?;
            return Ok(Command::App(AppCall {
                verb: verb.clone(),
                args: f.positional,
                params: f.params,
                input: f.input,
                profile: f.profile,
                instance: f.instance,
                text: f.text,
                timeout_ms: f.timeout_ms,
            }));
        }
        Some(other) => return Err(format!("unknown command {other}")),
    }
    let sub = args.get(1).map(String::as_str);
    let f = flags(args.get(2..).unwrap_or_default())?;
    let library = || {
        f.library
            .clone()
            .ok_or("--library DIR is required".to_string())
    };
    let one = |what: &str| -> Result<String, String> {
        match f.positional.as_slice() {
            [x] => Ok(x.clone()),
            [] => Err(format!("{what} is required")),
            _ => Err(format!("one {what} only")),
        }
    };
    Ok(match sub {
        Some("describe") => Command::Describe { json: f.json },
        Some("call") => Command::Call {
            library: library()?,
            command: one("a command name")?,
            input: f.input.clone(),
            yes: f.yes,
        },
        Some("inspect") => Command::Inspect {
            library: library()?,
            doc: f.doc.clone(),
            json: f.json,
        },
        Some("scenario") => Command::Scenario {
            library: f.library.clone(),
            name: one("a scenario name")?,
            yes: f.yes,
            app: f.app.clone(),
            profile: f.profile.clone(),
            out: f.out.clone(),
            keep: f.keep,
        },
        None | Some("help" | "--help") => Command::Help,
        Some(other) => return Err(format!("unknown subcommand workspace {other}")),
    })
}
