//! Launches that are not the app window.
//!
//! External Agents (Codex, Claude Code) start this executable as
//! `drifting --mcp --connection <connection file>`: the 0.1 client wrote that
//! command into their configs (`src-tauri/src/mcp_server.rs`, `describe` and
//! `run_stdio_cli`), with the absolute path of the executable, which the
//! hand-over keeps (`Drifting.app/Contents/MacOS/drifting`,
//! `<install folder>\drifting.exe`). So the new program must accept exactly
//! those arguments, and `main` must route them first: before crash reporting
//! (no crash-reporter process), logging, the single-instance lock (on Windows
//! it would forward them to the window and exit) and any window.
//!
//! The bridge itself is M32's; this only recognises the launch, with the 0.1
//! client's rules and usage text.

use std::path::PathBuf;

/// The 0.1 client's message for a malformed `--mcp` launch.
pub const MCP_USAGE: &str = "Usage: Drifting --mcp --connection <connection-file>";
/// The 0.1 client's prefix for every error of an `--mcp` launch on stderr;
/// the process then exits with status 1.
pub const MCP_ERROR_PREFIX: &str = "Drifting MCP: ";

#[derive(Debug, PartialEq, Eq)]
pub enum Launch {
    /// The app: windows, menus, deep links.
    App,
    /// The stdio bridge to a running Drifting: the connection file, or the
    /// usage error when the arguments are not exactly `--connection <file>`.
    Mcp(Result<PathBuf, &'static str>),
}

/// `args` without the program name.
pub fn parse(args: &[String]) -> Launch {
    match args {
        [mcp, ..] if mcp != "--mcp" => Launch::App,
        [] => Launch::App,
        [_, flag, file] if flag == "--connection" => Launch::Mcp(Ok(PathBuf::from(file))),
        _ => Launch::Mcp(Err(MCP_USAGE)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(values: &[&str]) -> Vec<String> {
        values.iter().map(|v| (*v).to_owned()).collect()
    }

    #[test]
    fn recognises_the_command_the_tauri_client_wrote_into_agent_configs() {
        assert_eq!(
            parse(&args(&[
                "--mcp",
                "--connection",
                "/data/mcp/connection-1.json"
            ])),
            Launch::Mcp(Ok(PathBuf::from("/data/mcp/connection-1.json")))
        );
    }

    #[test]
    fn a_malformed_mcp_launch_is_a_usage_error_not_a_window() {
        for bad in [
            &["--mcp"][..],
            &["--mcp", "--connection"],
            &["--mcp", "--other", "x"],
            &["--mcp", "--connection", "a", "b"],
        ] {
            assert_eq!(parse(&args(bad)), Launch::Mcp(Err(MCP_USAGE)), "{bad:?}");
        }
    }

    #[test]
    fn anything_else_starts_the_app() {
        assert_eq!(parse(&[]), Launch::App);
        assert_eq!(parse(&args(&["drifting-next-dev://open/a"])), Launch::App);
        // `--mcp` only counts as the first argument, as in the 0.1 client.
        assert_eq!(
            parse(&args(&["drifting://open/a", "--mcp", "--connection", "x"])),
            Launch::App
        );
    }
}
