//! Resource bytes and workspace metadata share the canonical synthetic media fixture.
use dr_workspace::{Actor, Faults, Workspace, WorkspaceOptions, library_options};
use serde_json::{Value, json};
use std::sync::Arc;
struct Env {
    dir: tempfile::TempDir,
    ws: Workspace,
    faults: Arc<Faults>,
}
impl Drop for Env {
    fn drop(&mut self) {
        self.ws.close();
    }
}
impl Env {
    fn ws(&self) -> &Workspace {
        &self.ws
    }
    fn call(&self, name: &str, input: Value) -> Value {
        self.ws.call(&Actor::User, name, input).unwrap()
    }
    fn try_call(&self, name: &str, input: Value) -> dr_workspace::Result<Value> {
        self.ws.call(&Actor::User, name, input)
    }
    fn out(&self, name: &str, input: Value) -> Value {
        self.call(name, input)["output"].clone()
    }
}
fn env() -> Env {
    let dir = tempfile::tempdir().unwrap();
    let lib = dr_store::Library::open(dir.path(), library_options("v3-material-bytes")).unwrap();
    let faults = Arc::new(Faults::default());
    let ws = Workspace::open(
        lib,
        WorkspaceOptions {
            faults: Some(faults.clone()),
            ..WorkspaceOptions::default()
        },
    )
    .unwrap();
    Env { dir, ws, faults }
}
fn project(e: &Env) -> String {
    item(e.out(
        "project.create",
        json!({"name":"Synthetic material project"}),
    ))
}
fn item(v: Value) -> String {
    v["id"].as_str().unwrap().into()
}
fn raw(e: &Env, b: &str) -> Value {
    e.ws.observe(&format!("book:{b}")).unwrap().value
}
fn undo(e: &Env) {
    e.ws.undo(&Actor::User).unwrap().expect("undoable");
}

#[test]
fn v3_material_assets_and_failed_note_creation_respect_book_and_byte_boundaries() {
    use dr_store::asset::{SourceImport, Variant};
    let e = env();
    let b = project(&e);
    let other = project(&e);
    let source = e.dir.path().join("synthetic.png");
    std::fs::write(&source, dr_testkit::media::png(2, 2)).unwrap();
    let stored = e
        .ws()
        .library()
        .import_asset(&SourceImport {
            book_id: &b,
            asset_id: "synthetic-image",
            source: &source,
            mime: "image/png",
            ext: "png",
            dimensions: Some((2, 2)),
            limit: 1024 * 1024,
        })
        .unwrap();
    let args = json!({"book":b,"id":stored.asset_id,"kind":"image","mime":stored.mime,"size":stored.size,"sha256":stored.sha256,"width":2,"height":2});
    e.call("asset.put", args.clone());
    let mut wrong = args.clone();
    wrong["book"] = json!(other);
    assert!(e.try_call("asset.put", wrong).is_err());
    let pic = item(e.out(
        "material.create",
        json!({"book":b,"kind":"image","asset":stored.asset_id}),
    ));
    assert_eq!(
        e.out("asset.get", json!({"book":b,"id":stored.asset_id}))["size"],
        stored.size
    );
    let mark=item(e.out("comment.create",json!({"book":b,"target":{"kind":"material","id":pic},"body":"Synthetic region","region":{"x":0.1,"y":0.2,"w":0.3,"h":0.4}})));
    assert_eq!(raw(&e, &b)["comments"][&mark]["region"]["w"], 0.3);
    e.call("material.delete", json!({"book":b,"id":pic}));
    assert!(
        e.ws()
            .library()
            .asset(&stored.asset_id, Variant::Source)
            .unwrap()
            .is_some()
    );
    assert_eq!(
        std::fs::read(&stored.path).unwrap(),
        std::fs::read(&source).unwrap()
    );
    undo(&e);
    assert_eq!(raw(&e, &b)["comments"][&mark]["target"], pic);
    assert_eq!(raw(&e, &b)["comments"][&mark]["region"]["w"], 0.3);
    let other_note = item(e.out(
        "material.create",
        json!({"book":other,"kind":"text","text":"Synthetic other book"}),
    ));
    let other_doc = format!("material:{other_note}");
    let other_before = e.ws.observe(&other_doc).unwrap();
    let before = raw(&e, &b);
    e.faults.arm("after_prose");
    assert!(
        e.try_call(
            "material.create",
            json!({"book":b,"kind":"text","text":"Fault leaves no owner"})
        )
        .is_err()
    );
    assert_eq!(raw(&e, &b), before);
    e.call("book.trash", json!({"book":b}));
    e.call("book.purge", json!({"book":b}));
    assert_eq!(e.ws.observe(&other_doc).unwrap().value, other_before.value);
    assert_eq!(
        e.ws.observe(&other_doc).unwrap().version,
        other_before.version
    );
    assert!(!stored.path.exists());
    assert!(source.exists());
}
