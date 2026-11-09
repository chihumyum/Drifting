use super::{Pair, kv, patch};
use dr_shell::{
    Services, SettingsFile, ShellInfo, book::Book, pages::PageViewHost, v3::ModuleHost,
};
use dr_workspace::{
    Actor, Workspace, WsError,
    commands::v3::{
        module::{In, ModuleRead},
        types::ModuleSpec,
    },
};
use gpui::{TestAppContext, VisualTestContext, WeakEntity};
use serde_json::{Value, json};
use std::{
    rc::Rc,
    time::{Duration, Instant},
};

pub(crate) struct Fixture {
    _dir: tempfile::TempDir,
    pub ws: Workspace,
    pub target: In,
    module: ModuleSpec,
}
impl Fixture {
    pub fn new(kind: &str) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let store =
            dr_store::Library::open(dir.path(), dr_workspace::library_options("test")).unwrap();
        let seed = dr_testkit::seed::generate_v3(
            dr_testkit::seed::Preset::Tiny,
            dr_testkit::seed::DEFAULT_SEED,
        )
        .unwrap();
        let book = seed.books[0].book_id().to_string();
        seed.write_to(&store).unwrap();
        store.close().unwrap();
        let ws = Workspace::open_dir(dir.path(), "test").unwrap();
        let entries = ws
            .call(&Actor::User, "entry.list", json!({"book":book,"all":true}))
            .unwrap();
        let entry = entries["output"]
            .as_array()
            .unwrap()
            .iter()
            .find(|e| e["template"] == "tpl-chapter")
            .unwrap()["id"]
            .as_str()
            .unwrap()
            .to_owned();
        let module = json!({"id":"g1-records", "name":"Synthetic records", "kind":kind});
        ws.call(
            &Actor::User,
            "entry_template.put_module",
            json!({"book":book,"template":"tpl-chapter","module":module}),
        )
        .unwrap();
        Self {
            _dir: dir,
            ws,
            target: In {
                book,
                entry,
                module: "g1-records".into(),
            },
            module: serde_json::from_value(module).unwrap(),
        }
    }
    pub fn host(&self, cx: &mut TestAppContext) -> ModuleHost {
        cx.update(|cx| {
            dr_shell::init(
                ShellInfo {
                    app_name: "Drifting Next",
                    bundle_id: "cc.drifting.next.dev",
                    version: "test",
                    url_scheme: "drifting-next-dev",
                    forced_appearance: Some(dr_ui::Appearance::Light),
                },
                Services::default(),
                SettingsFile::in_memory(),
                cx,
            )
        });
        ModuleHost {
            page: PageViewHost {
                workspace: WeakEntity::new_invalid(),
                library: self.ws.clone(),
                book_id: self.target.book.clone(),
                book: Rc::new(Book::load(&self.ws, &self.target.book).unwrap()),
            },
            entry: self.target.entry.clone(),
            module: self.module.clone(),
        }
    }
    pub fn call(&self, name: &str, mut input: Value) -> Value {
        let map = input.as_object_mut().unwrap();
        map.insert("book".into(), json!(self.target.book));
        map.insert("entry".into(), json!(self.target.entry));
        map.insert("module".into(), json!(self.target.module));
        self.ws
            .call(&Actor::agent("g1-record-test", 1, "external"), name, input)
            .unwrap()["output"]
            .clone()
    }
    pub fn put_patch(&self, pair: Pair) {
        self.call(
            "module.put_patch",
            json!({"id":"g1-record","title":pair.0,"body":pair.1}),
        );
    }
    pub fn put_kv(&self, pair: Pair) {
        self.call(
            "module.put_kv",
            json!({"row":{"id":"g1-record","key":pair.0,"value":pair.1,"pos":"a0"}}),
        );
    }
    pub fn pair(&self, is_patch: bool) -> Pair {
        let data = self
            .ws
            .run::<ModuleRead>(&Actor::User, self.target.clone())
            .unwrap()
            .output;
        if is_patch {
            let p = data
                .patches
                .into_iter()
                .find(|p| p.id == "g1-record")
                .unwrap();
            (p.title.unwrap_or_default(), p.body)
        } else {
            let p = data.kv.into_iter().find(|p| p.id == "g1-record").unwrap();
            (p.key, p.value)
        }
    }
}
pub(crate) fn draw(cx: &mut VisualTestContext) {
    cx.run_until_parked();
    cx.update(|w, cx| {
        w.simulate_next_frame(cx);
        w.draw(cx).clear(cx);
    });
    cx.run_until_parked();
}
pub(crate) fn wait(cx: &mut VisualTestContext, done: impl Fn(&mut VisualTestContext) -> bool) {
    let until = Instant::now() + Duration::from_secs(10);
    loop {
        draw(cx);
        if done(cx) {
            return;
        }
        assert!(Instant::now() < until, "record control did not settle");
        std::thread::sleep(Duration::from_millis(2));
    }
}
pub(crate) fn pair(a: &str, b: &str) -> Pair {
    (a.into(), b.into())
}

#[test]
fn writes_after_the_complete_read_are_refused_without_partial_changes() {
    for is_patch in [true, false] {
        let f = Fixture::new(if is_patch { "patches" } else { "kv" });
        let original = pair("old key", "old value");
        if is_patch {
            f.put_patch(original.clone())
        } else {
            f.put_kv(original.clone())
        }
        let edited = pair("author key", "old value");
        let prepared = if is_patch {
            patch(
                &f.ws,
                f.target.clone(),
                "g1-record".into(),
                original,
                edited,
                false,
            )
            .unwrap()
        } else {
            kv(
                &f.ws,
                f.target.clone(),
                "g1-record".into(),
                Some(original),
                edited,
                false,
            )
            .unwrap()
        };
        let remote = pair("old key", "external value");
        if is_patch {
            f.put_patch(remote.clone())
        } else {
            f.put_kv(remote.clone())
        }
        assert!(matches!(prepared.commit(&f.ws), Err(WsError::Conflict(_))));
        assert_eq!(f.pair(is_patch), remote);
    }
}

#[test]
fn typing_during_a_save_cannot_authorize_an_unseen_merged_value() {
    for is_patch in [true, false] {
        let f = Fixture::new(if is_patch { "patches" } else { "kv" });
        let base = pair("old key", "old value");
        let sent = pair("author key", "old value");
        let current = pair("author key", "old value plus new typing");
        let remote = pair("old key", "external value");
        if is_patch {
            f.put_patch(remote);
        } else {
            f.put_kv(remote);
        }
        let saved = if is_patch {
            patch(
                &f.ws,
                f.target.clone(),
                "g1-record".into(),
                base,
                sent.clone(),
                false,
            )
        } else {
            kv(
                &f.ws,
                f.target.clone(),
                "g1-record".into(),
                Some(base),
                sent.clone(),
                false,
            )
        }
        .unwrap()
        .commit(&f.ws)
        .unwrap();
        let baseline = super::acknowledged_base(&sent, saved.clone(), &current);
        let next = if is_patch {
            patch(
                &f.ws,
                f.target.clone(),
                "g1-record".into(),
                baseline,
                current,
                false,
            )
        } else {
            kv(
                &f.ws,
                f.target.clone(),
                "g1-record".into(),
                Some(baseline),
                current,
                false,
            )
        };
        assert!(matches!(next, Err(WsError::Conflict(_))));
        assert_eq!(f.pair(is_patch), saved);
    }
}

#[test]
fn editing_a_record_keeps_its_siblings_and_retained_module_data() {
    for is_patch in [true, false] {
        let kind = if is_patch { "patches" } else { "kv" };
        let f = Fixture::new(kind);
        let original = pair("old key", "old value");
        if is_patch {
            f.put_patch(original.clone());
            f.call(
                "module.put_patch",
                json!({"id":"g1-sibling","title":"sibling","body":"kept"}),
            );
        } else {
            f.put_kv(original.clone());
            f.call(
                "module.put_kv",
                json!({"row":{"id":"g1-sibling","key":"sibling","value":"kept","pos":"a1"}}),
            );
        }
        f.ws.call(&Actor::User,"entry_template.put_module",json!({"book":f.target.book,"template":"tpl-chapter","module":{"id":"g1-retained","name":"Retained","kind":kind}})).unwrap();
        let mut hidden = f.target.clone();
        hidden.module = "g1-retained".into();
        let mut input = json!({"book":hidden.book,"entry":hidden.entry,"module":hidden.module});
        if is_patch {
            input["id"] = json!("g1-hidden");
            input["title"] = json!("hidden");
            input["body"] = json!("retained body");
        } else {
            input["row"] =
                json!({"id":"g1-hidden","key":"hidden","value":"retained value","pos":"a0"});
        }
        f.ws.call(
            &Actor::User,
            if is_patch {
                "module.put_patch"
            } else {
                "module.put_kv"
            },
            input,
        )
        .unwrap();
        f.ws.call(
            &Actor::User,
            "entry_template.remove_module",
            json!({"book":hidden.book,"template":"tpl-chapter","module":hidden.module}),
        )
        .unwrap();
        let read = |target: In| {
            f.ws.call(
                &Actor::User,
                "module.read",
                serde_json::to_value(target).unwrap(),
            )
            .unwrap()["output"]
                .clone()
        };
        let retained = read(hidden.clone());
        assert_eq!(retained["module"]["retained"], true);
        let before = read(f.target.clone());
        let edited = pair("author key", "old value");
        let prepared = if is_patch {
            patch(
                &f.ws,
                f.target.clone(),
                "g1-record".into(),
                original,
                edited,
                false,
            )
            .unwrap()
        } else {
            kv(
                &f.ws,
                f.target.clone(),
                "g1-record".into(),
                Some(original),
                edited,
                false,
            )
            .unwrap()
        };
        prepared.commit(&f.ws).unwrap();
        let after = read(f.target.clone());
        let collection = if is_patch { "patches" } else { "kv" };
        let sibling = |value: Value| {
            value[collection]
                .as_array()
                .unwrap()
                .iter()
                .find(|p| p["id"] == "g1-sibling")
                .unwrap()
                .clone()
        };
        assert_eq!(sibling(before), sibling(after));
        assert_eq!(read(hidden), retained);
    }
}
