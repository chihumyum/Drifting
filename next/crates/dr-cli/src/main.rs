//! `cargo drifting …`; see the library docs.

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    std::process::exit(dr_cli::run(&args));
}
