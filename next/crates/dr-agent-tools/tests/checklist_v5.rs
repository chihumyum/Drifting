//! The Agent writes checklist items through `module.set_prose` (task book
//! T7b): they project into comments like any other checklist item, the tick
//! is the comment's status, an item whose words change keeps its comment, and
//! every turn still leaves its checkpoint. Synthetic v3 seed; no model or
//! network.
use dr_agent_tools::{AgentTools, CallRequest};
use dr_doc::v3::novel::{MOD_PROSE, TPL_CHAPTER};
use dr_model::id::BookId;
use dr_testkit::seed::{self, Preset};
use dr_workspace::{Actor, Workspace};
use serde_json::{Value, json};

struct Fixture {
    ws: Workspace,
    tools: AgentTools,
    book: BookId,
    entry: String,
    _dir: tempfile::TempDir,
}

impl Fixture {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let ws = Workspace::open_dir(dir.path(), "t7b-checklist").unwrap();
        ws.set_auto_links(false);
        let seeded = seed::generate_v3(Preset::Tiny, seed::DEFAULT_SEED).unwrap();
        let book = seeded.books[0].book_id().clone();
        let entry = seeded.books[0]
            .book
            .view()
            .entries()
            .into_iter()
            .find(|e| {
                e.template
                    .as_ref()
                    .is_some_and(|t| t.as_str() == TPL_CHAPTER)
            })
            .unwrap()
            .id
            .to_string();
        seeded.write_to(ws.library()).unwrap();
        Self {
            ws,
            tools: AgentTools::new(),
            book,
            entry,
            _dir: dir,
        }
    }
    fn call(&self, turn: u32, name: &str, args: Value) -> Value {
        self.tools
            .invoke(
                &self.ws,
                &self.book,
                &Actor::agent("t7b-checklist", turn, name),
                CallRequest {
                    name: name.into(),
                    arguments: args.clone(),
                    revision: None,
                    edited_text: None,
                },
            )
            .unwrap_or_else(|e| panic!("{name} {args}: {e}"))["output"]
            .clone()
    }
    fn module(&self) -> Value {
        json!({"owner":self.entry,"module":MOD_PROSE})
    }
    /// The Agent reads the module, then writes `paragraphs` in the same turn.
    fn write(&self, turn: u32, paragraphs: Value) {
        self.call(turn, "module.read_prose", self.module());
        let mut args = self.module();
        args["paragraphs"] = paragraphs;
        self.call(turn, "module.set_prose", args);
    }
    fn read(&self, turn: u32) -> Vec<Value> {
        self.call(turn, "module.read_prose", self.module())["paragraphs"]
            .as_array()
            .unwrap()
            .clone()
    }
    /// The checklist comments on the chapter, as the author's list has them.
    fn tasks(&self) -> Vec<Value> {
        self.ws
            .call(
                &Actor::User,
                "comment.list",
                json!({"book":self.book,"target":{"kind":"entry","id":self.entry},"module":MOD_PROSE}),
            )
            .unwrap()["output"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|c| c["origin"] == "task")
            .cloned()
            .collect()
    }
    fn snapshots(&self) -> usize {
        self.ws
            .call(
                &Actor::User,
                "entry_snapshot.list",
                json!({"book":self.book,"entry":self.entry}),
            )
            .unwrap()["output"]
            .as_array()
            .unwrap()
            .len()
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        self.ws.close();
    }
}

fn by_body<'a>(rows: &'a [Value], body: &str) -> &'a Value {
    rows.iter()
        .find(|c| c["body"]["text"] == body)
        .unwrap_or_else(|| panic!("no checklist comment {body:?} in {rows:?}"))
}

#[test]
fn agent_checklist_lines_project_as_comments_follow_their_lines_and_keep_checkpoints() {
    let f = Fixture::new();
    assert!(f.tasks().is_empty());
    assert_eq!(f.snapshots(), 0);

    // Turn 1: what the chapter has, plus two checklist items, one ticked.
    let mut paragraphs = f.read(1);
    let kept = paragraphs.len();
    paragraphs.push(json!({"list":"task","text":"核对城门巡夜时间"}));
    paragraphs.push(json!({"list":"task","checked":true,"text":"补写钟楼回声"}));
    f.write(1, Value::Array(paragraphs));
    let tasks = f.tasks();
    assert_eq!(tasks.len(), 2, "{tasks:?}");
    let open = by_body(&tasks, "核对城门巡夜时间").clone();
    let done = by_body(&tasks, "补写钟楼回声").clone();
    assert_eq!(open["status"], "open");
    assert_eq!(done["status"], "resolved");
    assert_eq!(
        f.snapshots(),
        1,
        "the turn's first write leaves a checkpoint"
    );

    // The Agent reads which lines are checklist items and which are ticked.
    let read = f.read(1);
    assert_eq!(read.len(), kept + 2);
    assert_eq!(read[kept]["list"], "task");
    assert_eq!(read[kept]["checked"], false);
    assert_eq!(read[kept + 1]["checked"], true);
    let item = read[kept]["block_id"].clone();

    // Turn 2: an item's words change: same line, same comment, new words.
    let mut paragraphs = f.read(2);
    paragraphs[kept]["text"] = json!("核对城门换岗时间");
    f.write(2, Value::Array(paragraphs));
    let tasks = f.tasks();
    assert_eq!(tasks.len(), 2);
    let renamed = by_body(&tasks, "核对城门换岗时间");
    assert_eq!(renamed["id"], open["id"]);
    assert_eq!(renamed["status"], "open");
    assert_eq!(f.read(2)[kept]["block_id"], item);
    assert_eq!(f.read(2)[kept]["list"], "task");
    assert_eq!(f.snapshots(), 2);

    // Turn 3: only another paragraph changes: the comments stay as they are.
    let before = f.tasks();
    let mut paragraphs = f.read(3);
    let first = paragraphs
        .iter()
        .position(|p| p.get("list").is_none() && !p["text"].as_str().unwrap().is_empty())
        .unwrap();
    let text = paragraphs[first]["text"].as_str().unwrap().to_owned();
    paragraphs[first]["text"] = json!(format!("{text}又一句"));
    f.write(3, Value::Array(paragraphs));
    assert_eq!(f.tasks(), before);
    assert_eq!(f.read(3)[kept]["block_id"], item);
    assert_eq!(f.snapshots(), 3);

    // Turn 4: ticking the item is resolving its comment.
    let mut paragraphs = f.read(4);
    paragraphs[kept]["checked"] = json!(true);
    f.write(4, Value::Array(paragraphs));
    let ticked = by_body(&f.tasks(), "核对城门换岗时间").clone();
    assert_eq!(ticked["id"], open["id"]);
    assert_eq!(ticked["status"], "resolved");
    let shape = f.call(
        4,
        "prose.shape",
        json!({"doc":format!("body:{}/{}", f.entry, MOD_PROSE)}),
    );
    assert_eq!(
        (shape["tasks"].clone(), shape["done"].clone()),
        (json!(2), json!(2))
    );
    // And clearing the tick reopens it, in the same turn.
    let mut paragraphs = f.read(4);
    paragraphs[kept]["checked"] = json!(false);
    f.write(4, Value::Array(paragraphs));
    assert_eq!(by_body(&f.tasks(), "核对城门换岗时间")["status"], "open");
    assert_eq!(f.snapshots(), 4);

    // Turn 5: the line goes, its comment with it; the other stays.
    let mut paragraphs = f.read(5);
    paragraphs.remove(kept);
    f.write(5, Value::Array(paragraphs));
    let tasks = f.tasks();
    assert_eq!(tasks.len(), 1, "{tasks:?}");
    assert_eq!(tasks[0]["id"], done["id"]);
    assert_eq!(tasks[0]["status"], "resolved");
    assert_eq!(f.snapshots(), 5);
}

#[test]
fn the_set_prose_tool_says_how_checklist_items_are_written() {
    let catalog = AgentTools::new();
    let f = Fixture::new();
    let catalog = catalog.catalog_for_book(&f.ws, &f.book).unwrap();
    let set = catalog.descriptor("module.set_prose").unwrap();
    let schema = serde_json::to_string(&set.input_schema).unwrap();
    for word in ["\"list\"", "\"list_level\"", "\"checked\"", "\"task\""] {
        assert!(schema.contains(word), "{word} in {schema}");
    }
    let description = set.description.to_lowercase();
    assert!(description.contains("checklist"), "{description}");
    assert!(description.contains("resolve"), "{description}");
}
