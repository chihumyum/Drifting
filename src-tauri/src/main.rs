#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if let Some(result) = drifting_lib::run_mcp_stdio_cli() {
        if let Err(error) = result {
            eprintln!("Drifting MCP: {error}");
            std::process::exit(1);
        }
        return;
    }
    drifting_lib::run();
}
