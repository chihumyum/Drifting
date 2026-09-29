//! Synthetic-only ZIP packing probe; no filesystem reads/writes or save dialogs.
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use std::io::{self, BufRead};
fn main() {
    for line in io::stdin().lock().lines() {
        let input: Value = serde_json::from_str(&line.unwrap()).unwrap();
        let entries: Vec<drifting_core::archive::TextArchiveEntry> =
            serde_json::from_value(input["files"].clone()).unwrap();
        let bytes = drifting_core::archive::create_text_zip(&entries).unwrap();
        println!("{}", json!({"bytes": STANDARD.encode(&bytes)}));
    }
}
