//! `.driftingmodule` files and custom modules in book files
//! (`docs/rust-rewrite/custom-modules.md` §6, §10, §11, §12, §14).

use dr_export::module_file::{self, ModuleFileError};
use dr_store::Library;
use dr_testkit::samples::MODULE_FILES;
use dr_workspace::{Actor, Workspace, WorkspaceOptions, library_options};
use serde_json::{Value, json};

struct Env {
    dir: tempfile::TempDir,
    ws: Workspace,
}

impl Drop for Env {
    fn drop(&mut self) {
        self.ws.close();
    }
}

fn env() -> Env {
    let dir = tempfile::tempdir().unwrap();
    let lib = Library::open(dir.path().join("library"), library_options("0.2.0-test")).unwrap();
    let ws = Workspace::open(lib, WorkspaceOptions::default()).unwrap();
    Env { dir, ws }
}

fn out(ws: &Workspace, name: &str, input: Value) -> Value {
    ws.call(&Actor::User, name, input)
        .unwrap_or_else(|e| panic!("{name}: {e}"))["output"]
        .clone()
}

fn sample(stem: &str) -> &'static str {
    MODULE_FILES
        .iter()
        .find(|(s, _)| *s == stem)
        .map(|(_, raw)| *raw)
        .unwrap()
}

#[test]
fn every_sample_round_trips_byte_for_byte_and_import_always_adds_a_new_one() {
    let e = env();
    for (stem, raw) in MODULE_FILES {
        let created = out(
            &e.ws,
            "custom_module.create",
            json!({"value": serde_json::from_str::<Value>(raw).unwrap()}),
        );
        let id = created["id"].as_str().unwrap();
        let path = e.dir.path().join(module_file::module_filename(
            &created["name"].as_str().unwrap(),
        ));
        assert!(path.to_str().unwrap().ends_with(".driftingmodule"));
        let a = module_file::export_module(&e.ws, id, Some("林岬"), &path).unwrap();
        let first = std::fs::read(&path).unwrap();
        let b = module_file::export_module(&e.ws, id, Some("林岬"), &path).unwrap();
        assert_eq!(
            std::fs::read(&path).unwrap(),
            first,
            "{stem}: byte for byte"
        );
        assert_eq!(a, b);
        // The file passes the same validator the command line runs.
        let checked = module_file::validate_module_file(&path).unwrap();
        assert_eq!(checked.credit.unwrap().author, "林岬");
        // Signed out: no credit at all, whatever the module carried.
        module_file::export_module(&e.ws, id, None, &path).unwrap();
        let unsigned = module_file::validate_module_file(&path).unwrap();
        assert!(unsigned.credit.is_none(), "{stem}");
        let mut expected: Value = serde_json::from_str(raw).unwrap();
        expected.as_object_mut().unwrap().remove("credit");
        assert_eq!(serde_json::to_value(&unsigned).unwrap(), expected, "{stem}");
        // Import: always a new module.
        let i1 = module_file::import_module(&e.ws, &path).unwrap();
        let i2 = module_file::import_module(&e.ws, &path).unwrap();
        assert_ne!(i1.id, id);
        assert_ne!(i1.id, i2.id);
        assert_eq!(i1.origin, "file");
    }
    assert_eq!(
        out(&e.ws, "custom_module.list", json!({}))
            .as_array()
            .unwrap()
            .len(),
        MODULE_FILES.len() * 3
    );
}

#[test]
fn refused_files_write_nothing_and_say_why_the_way_the_command_line_does() {
    let e = env();
    let good: Value = serde_json::from_str(sample("foreshadowing")).unwrap();
    let mut colour = good.clone();
    colour["look"]["line"]["color"] = json!("#ff0000");
    let mut newer = good.clone();
    newer["formatVersion"] = json!(2);
    let mut by_id = good.clone();
    by_id["sample"]["items"][0]["back"] = json!(["0192f3a4-5b6c-7d8e-9f00-112233445566"]);
    let cases: Vec<(&str, Vec<u8>, fn(&ModuleFileError) -> bool)> = vec![
        ("colour", colour.to_string().into_bytes(), |e| {
            matches!(e, ModuleFileError::Damaged(_))
        }),
        ("newer", newer.to_string().into_bytes(), |e| {
            matches!(e, ModuleFileError::Newer)
        }),
        ("by-id", by_id.to_string().into_bytes(), |e| {
            matches!(e, ModuleFileError::Damaged(_))
        }),
        ("text", b"not a module".to_vec(), |e| {
            matches!(e, ModuleFileError::NotAModule)
        }),
        ("binary", vec![0xff, 0xfe, 0x00], |e| {
            matches!(e, ModuleFileError::NotAModule)
        }),
        (
            "template",
            br#"{"format": "drifting.project-template", "formatVersion": 1}"#.to_vec(),
            |e| matches!(e, ModuleFileError::NotAModule),
        ),
        ("huge", vec![b' '; 256 * 1024 + 1], |e| {
            matches!(e, ModuleFileError::TooLarge)
        }),
    ];
    for (stem, bytes, expect) in cases {
        let path = e.dir.path().join(format!("{stem}.driftingmodule"));
        std::fs::write(&path, &bytes).unwrap();
        let checked = module_file::validate_module_file(&path).unwrap_err();
        assert!(expect(&checked), "{stem}: {checked}");
        let imported = module_file::import_module(&e.ws, &path).unwrap_err();
        assert!(
            expect(&imported),
            "{stem}: import says {imported}, check says {checked}"
        );
    }
    assert_eq!(out(&e.ws, "custom_module.list", json!({})), json!([]));
}

#[test]
fn a_book_file_carries_copies_and_values_not_my_modules() {
    let e = env();
    let id = out(
        &e.ws,
        "custom_module.create",
        json!({"value": serde_json::from_str::<Value>(sample("foreshadowing")).unwrap()}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let book = out(&e.ws, "project.create", json!({"name": "带模块的书"}))["id"]
        .as_str()
        .unwrap()
        .to_owned();
    out(
        &e.ws,
        "entry_template.put",
        json!({"book": book, "template": {"id": "tpl-mod", "name": "有模块的", "modules": [
            {"id": "mod-c", "kind": "custom", "name": "伏笔", "config": {"module": id}}
        ]}}),
    );
    let entry = out(
        &e.ws,
        "entry.create",
        json!({"book": book, "title": "第一章", "template": "tpl-mod"}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let other = out(
        &e.ws,
        "entry.create",
        json!({"book": book, "title": "第十二章", "template": "tpl-mod"}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let t = json!({"book": book, "entry": entry, "module": "mod-c"});
    let mut add = t.clone();
    add["list"] = json!("items");
    let item = out(&e.ws, "module.add_custom_item", add)["item"]
        .as_str()
        .unwrap()
        .to_owned();
    for (block, value) in [
        ("line", json!("墙上的旧照片少了一个人")),
        ("back", json!([other])),
    ] {
        let mut set = t.clone();
        set["path"] = json!([{"list": "items", "item": item}]);
        set["block"] = json!(block);
        set["value"] = value;
        out(&e.ws, "module.set_custom_value", set);
    }
    let path = e.dir.path().join("book.driftingproject");
    dr_export::book_file::export_book(&e.ws, &book, &path, &|_| {}).unwrap();

    // Into a library that has no modules of its own.
    let theirs = env();
    let summary = dr_export::book_file::import_book(&theirs.ws, &path, &|_| {}).unwrap();
    assert_eq!(out(&theirs.ws, "custom_module.list", json!({})), json!([]));
    let entries = out(
        &theirs.ws,
        "entry.list",
        json!({"book": summary.book, "all": true}),
    );
    let find = |title: &str| {
        entries
            .as_array()
            .unwrap()
            .iter()
            .find(|e| e["title"] == title)
            .unwrap()["id"]
            .as_str()
            .unwrap()
            .to_owned()
    };
    let (new_entry, new_other) = (find("第一章"), find("第十二章"));
    assert_ne!(new_entry, entry, "the book file gives entries new ids");
    let read = out(
        &theirs.ws,
        "module.read_custom",
        json!({"book": summary.book, "entry": new_entry, "module": "mod-c"}),
    );
    assert_eq!(read["copy"]["id"], id);
    assert_eq!(
        read["copy"]["follows"], false,
        "came with someone else's book"
    );
    let items = read["values"]["items"]["value"].as_array().unwrap();
    assert_eq!(items[0]["id"], item);
    assert_eq!(
        items[0]["values"]["line"]["value"],
        "墙上的旧照片少了一个人"
    );
    assert_eq!(
        items[0]["values"]["back"]["value"],
        json!([new_other]),
        "an entry block's value follows the entry's new id"
    );
    // My modules' documents are not part of any book file.
    assert!(
        theirs
            .ws
            .library()
            .docs(None, Some("module"))
            .unwrap()
            .is_empty()
    );
}
