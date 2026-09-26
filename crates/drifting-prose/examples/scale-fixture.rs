//! Install generated synthetic scale corpus in a freshly owned benchmark DB.
use base64::{engine::general_purpose::STANDARD, Engine};
use drifting_core::database::{DatabaseGateway, DatabaseValue as V};
use drifting_core::prose::ProseRepository;
use drifting_document::DocumentSession;
use serde_json::Value;
use std::path::PathBuf;

fn text(value: &str) -> V {
    V::Text(value.into())
}
fn main() -> Result<(), String> {
    let args: Vec<_> = std::env::args().collect();
    if args.len() != 5 {
        return Err("Expected corpus.json native|tauri case-id|all new-directory".into());
    }
    let corpus: Value =
        serde_json::from_slice(&std::fs::read(&args[1]).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
    if corpus["kind"] != "apple-editor-performance-corpus" {
        return Err("Not a synthetic scale corpus".into());
    }
    let directory = PathBuf::from(&args[4]);
    if directory.exists() {
        return Err("Refusing to adopt an existing benchmark directory".into());
    }
    std::fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
    let gateway = DatabaseGateway::new(directory)?;
    let native = match args[2].as_str() {
        "native" => true,
        "tauri" => false,
        _ => return Err("Invalid fixture host".into()),
    };
    let client = "apple-scale-fixture";
    gateway.open(
        if native {
            "native-lab.db"
        } else {
            "drifting-library.db"
        }
        .into(),
        client.into(),
        false,
    )?;
    let project = if native {
        "native-lab-fixture"
    } else {
        "apple-scale-project"
    };
    gateway.execute("INSERT INTO project(id,name,user_id,created_at,updated_at) VALUES (?,?,?,'synthetic','synthetic')".into(),vec![text(project),text(&format!("Synthetic {project}")),text(if native {"apple-native-lab"} else {"drifting-library.db"})],None,client.into())?;
    let mut installed = 0;
    for entry in corpus["cases"].as_array().ok_or("Missing cases")? {
        let id = entry["id"].as_str().ok_or("Missing case id")?;
        if native && id != args[3] {
            continue;
        }
        let bytes = STANDARD
            .decode(
                entry["updateBase64"]
                    .as_str()
                    .ok_or("Missing synthetic update")?,
            )
            .map_err(|e| e.to_string())?;
        let mut document = DocumentSession::new();
        document.apply_remote(&bytes, 1)?;
        if document.native_projection()?.text
            != entry["plainText"]
                .as_str()
                .ok_or("Missing synthetic text")?
        {
            return Err("Native corpus projection differs from source".into());
        }
        let node = if native {
            "native-lab-synthetic-prose".into()
        } else {
            format!("apple-scale-{id}")
        };
        gateway.execute("INSERT INTO book_node(id,title,project_id,kind,book_order,position_x,position_y,created_at,updated_at) VALUES (?,?,?,'chapter',?,0,0,'synthetic','synthetic')".into(),vec![text(&node),text(&format!("Synthetic {id}")),text(project),V::Integer(installed.to_string())],None,client.into())?;
        ProseRepository::new(&gateway, client).save_snapshot(
            &format!("node-content:{node}"),
            &bytes,
            "synthetic",
            None,
        )?;
        installed += 1;
    }
    if installed != if native { 1 } else { 3 } {
        return Err("Unexpected synthetic case count".into());
    }
    if !native {
        for index in 3..1000 {
            gateway.execute("INSERT INTO book_node(id,title,project_id,kind,book_order,position_x,position_y,created_at,updated_at) VALUES (?,?,'apple-scale-project','chapter',?,0,0,'synthetic','synthetic')".into(),vec![text(&format!("apple-scale-metadata-{index}")),text(&format!("Synthetic metadata {index:04}")),V::Integer(index.to_string())],None,client.into())?;
        }
    }
    gateway.close(client.into())?;
    println!("Installed {installed} generated prose cases");
    Ok(())
}
