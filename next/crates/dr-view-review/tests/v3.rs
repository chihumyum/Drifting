use dr_doc::prose::ProseDoc;
use dr_model::{
    DocId, Origin,
    book::EntityRef,
    id::{BodyDocId, CommentId, ModuleId},
    kind::{CommentKind, CommentStatus, EntityKind},
    v3::ModuleSpec,
};
use dr_view_review::{
    Filter,
    v3::{self, Place, Target},
};
use dr_workspace::{Actor, Workspace};
use serde_json::{Value, json};

struct Fixture {
    _dir: tempfile::TempDir,
    ws: Workspace,
    book: String,
    entry: String,
    first: String,
    second: String,
    floating: String,
    missing: String,
    quote: String,
}

fn call(ws: &Workspace, name: &str, input: Value) -> Value {
    ws.call(&Actor::User, name, input).unwrap()["output"].clone()
}

fn fixture() -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    let store =
        dr_store::Library::open(dir.path(), dr_workspace::library_options("0.2.0-dev")).unwrap();
    let mut seed = dr_testkit::seed::generate_v3(
        dr_testkit::seed::Preset::Tiny,
        dr_testkit::seed::DEFAULT_SEED,
    )
    .unwrap();
    let b = &mut seed.books[0];
    let original = b
        .book
        .view()
        .comments()
        .into_iter()
        .find(|c| c.anchor.is_some())
        .unwrap();
    let entry = original.target.as_ref().unwrap().id.clone();
    let source = b
        .prose
        .iter()
        .find(|p| p.doc_id() == &v3::prose_doc(&original).unwrap())
        .unwrap();
    let text = source.view().text_in(0..source.view().len() - 1).unwrap();
    let module = ModuleId::parse("second-body").unwrap();
    let mut prose = ProseDoc::create(
        DocId::Body(BodyDocId::new(entry.parse().unwrap(), module.clone())),
        12345,
    )
    .unwrap();
    prose
        .edit(Origin::User, |t| t.insert_paragraphs(0, &text))
        .0
        .unwrap();
    let quote = prose.view().text_in(0..4).unwrap();
    let anchor = prose.view().anchor(0..4).unwrap();
    let template = b
        .book
        .view()
        .entry(&entry.parse().unwrap())
        .unwrap()
        .template
        .unwrap();
    let second = CommentId::new_v7();
    let floating = CommentId::new_v7();
    let missing = CommentId::new_v7();
    b.book
        .edit(Origin::User, |t| {
            t.template(&template)?.put_module(&ModuleSpec::prose(
                module.clone(),
                "Second body",
                true,
                false,
            ))?;
            t.comment(&second)?
                .target(original.target.as_ref())?
                .module(Some(&module))?
                .body(&original.body)?
                .kind(&CommentKind::Todo)?
                .status(&CommentStatus::Resolved)?
                .anchor(Some(&anchor))?
                .quote(Some(&quote))?;
            t.comment(&floating)?
                .body(&original.body)?
                .kind(&CommentKind::Todo)?;
            t.comment(&missing)?
                .target(original.target.as_ref())?
                .module(Some(&ModuleId::parse("missing-body").unwrap()))?
                .body(&original.body)?
                .anchor(Some(&anchor))?
                .quote(Some(&quote))?;
            Ok(())
        })
        .0
        .unwrap();
    b.prose.push(prose);
    let book = b.book_id().to_string();
    seed.write_to(&store).unwrap();
    store.close().unwrap();
    let ws = Workspace::open_dir(dir.path(), "0.2.0-dev").unwrap();
    Fixture {
        _dir: dir,
        ws,
        book,
        entry,
        first: original.id.to_string(),
        second: second.to_string(),
        floating: floating.to_string(),
        missing: missing.to_string(),
        quote,
    }
}

fn ids(list: &v3::Listing) -> Vec<String> {
    list.open
        .iter()
        .chain(&list.resolved)
        .flat_map(|g| &g.items)
        .map(|i| i.comment.id.to_string())
        .collect()
}

#[test]
fn sources_and_current_scope_keep_entry_and_module_identity() {
    let f = fixture();
    let before = f.ws.observe(&format!("book:{}", f.book)).unwrap().version;
    let snapshot = v3::load(&f.ws, &f.book).unwrap();
    let first = Target::Entry {
        id: f.entry.clone(),
        module: Some("mod-prose".into()),
    };
    let second = Target::Entry {
        id: f.entry.clone(),
        module: Some("second-body".into()),
    };
    let first_items = ids(&snapshot.listing(Filter::All, Some(&first)));
    assert!(first_items.contains(&f.first));
    assert!(!first_items.contains(&f.second));
    assert_eq!(
        ids(&snapshot.listing(Filter::All, Some(&second))).as_slice(),
        std::slice::from_ref(&f.second)
    );
    assert!(
        snapshot
            .listing(Filter::Comments, Some(&second))
            .resolved
            .is_empty()
    );
    let all = ids(&snapshot.listing(
        Filter::All,
        Some(&Target::Entry {
            id: f.entry.clone(),
            module: None,
        }),
    ));
    assert!(all.contains(&f.first) && all.contains(&f.second) && all.contains(&f.missing));
    let item = snapshot
        .items
        .iter()
        .find(|i| i.comment.id.as_str() == f.second)
        .unwrap();
    assert_eq!(item.place, Place::On(second));
    assert_eq!(item.module_name.as_deref(), Some("Second body"));
    assert!(!item.retained);
    assert_eq!(
        snapshot
            .items
            .iter()
            .find(|i| i.comment.id.as_str() == f.missing)
            .unwrap()
            .place,
        Place::Gone
    );
    assert_eq!(
        f.ws.observe(&format!("book:{}", f.book)).unwrap().version,
        before
    );
    f.ws.shutdown().unwrap();
}

#[test]
fn generic_associations_do_not_change_sources_or_duplicate_cards() {
    let f = fixture();
    let relation_type = dr_doc::book::generic_relation_type_id(&f.book.parse().unwrap());
    call(
        &f.ws,
        "entry_template.put_module",
        json!({"book":f.book,"template":"tpl-chapter",
        "module":{"id":"review-relations","kind":"relations","name":"Relations"}}),
    );
    let relation = call(
        &f.ws,
        "module.put_relation",
        json!({"book":f.book,"entry":f.entry,"module":"review-relations",
        "other":{"kind":"comment","id":f.floating},"incoming":true,"relation_type":relation_type}),
    );
    let scope = Target::Entry {
        id: f.entry.clone(),
        module: Some("second-body".into()),
    };
    let snapshot = v3::load(&f.ws, &f.book).unwrap();
    let listed = snapshot.listing(Filter::All, Some(&scope));
    assert_eq!(ids(&listed).iter().filter(|i| **i == f.floating).count(), 1);
    assert_eq!(listed.open.last().unwrap().place, Place::Floating);
    call(
        &f.ws,
        "module.remove_relation",
        json!({"book":f.book,"entry":f.entry,"module":"review-relations","id":relation["id"]}),
    );
    assert!(
        !ids(&v3::load(&f.ws, &f.book)
            .unwrap()
            .listing(Filter::All, Some(&scope)))
        .contains(&f.floating)
    );
    f.ws.shutdown().unwrap();
}

#[test]
fn trash_and_removed_modules_preserve_comments_and_exact_originals() {
    let f = fixture();
    let original = v3::original(&f.ws, &f.book, &f.second).unwrap().unwrap();
    assert_eq!(original.text, f.quote);
    assert_eq!(original.changed, Some(false));
    let before_docs = f.ws.library().docs(Some(&f.book), None).unwrap().len();
    assert_eq!(
        v3::original(&f.ws, &f.book, &f.missing)
            .unwrap()
            .unwrap()
            .changed,
        Some(true)
    );
    assert_eq!(
        f.ws.library().docs(Some(&f.book), None).unwrap().len(),
        before_docs
    );
    call(
        &f.ws,
        "entry_template.remove_module",
        json!({"book":f.book,"template":"tpl-chapter","module":"second-body"}),
    );
    let snapshot = v3::load(&f.ws, &f.book).unwrap();
    let item = snapshot
        .items
        .iter()
        .find(|i| i.comment.id.as_str() == f.second)
        .unwrap();
    assert!(item.retained);
    assert!(
        matches!(item.place, Place::On(Target::Entry { ref module, .. }) if module.as_deref() == Some("second-body"))
    );
    assert_eq!(
        v3::original(&f.ws, &f.book, &f.second).unwrap(),
        Some(original.clone())
    );
    let parent = call(&f.ws, "entry.get", json!({"book":f.book,"id":f.entry}))["parent"].clone();
    assert!(parent.is_string());
    call(&f.ws, "entry.trash", json!({"book":f.book,"id":parent}));
    let snapshot = v3::load(&f.ws, &f.book).unwrap();
    assert_eq!(
        snapshot
            .items
            .iter()
            .find(|i| i.comment.id.as_str() == f.second)
            .unwrap()
            .place,
        Place::Gone
    );
    assert_eq!(
        v3::original(&f.ws, &f.book, &f.second).unwrap(),
        Some(original)
    );
    call(&f.ws, "entry.restore", json!({"book":f.book,"id":parent}));
    assert!(matches!(
        v3::load(&f.ws, &f.book)
            .unwrap()
            .items
            .iter()
            .find(|i| i.comment.id.as_str() == f.second)
            .unwrap()
            .place,
        Place::On(_)
    ));
    let other = call(
        &f.ws,
        "book.create",
        json!({"name":"Synthetic compatibility"}),
    );
    assert!(v3::load(&f.ws, other["id"].as_str().unwrap()).is_err());
    assert!(
        f.ws.call(&Actor::User, "comment.list", json!({"book":other["id"]}))
            .is_ok()
    );
    f.ws.shutdown().unwrap();
}

#[test]
fn material_and_unscoped_sources_never_choose_an_entry_body() {
    let mut seed = dr_testkit::seed::generate_v3(
        dr_testkit::seed::Preset::Tiny,
        dr_testkit::seed::DEFAULT_SEED,
    )
    .unwrap();
    let book = &mut seed.books[0].book;
    let mut comment = book.view().comments().remove(0);
    let material = book.view().materials().remove(0);
    comment.target = Some(EntityRef::new(EntityKind::Material, material.id.as_str()));
    comment.target_module = None;
    assert_eq!(v3::prose_doc(&comment), Some(DocId::Material(material.id)));
    comment.target = Some(EntityRef::new(EntityKind::Entry, "entry"));
    assert_eq!(v3::prose_doc(&comment), None, "no default module guessed");
    comment.target = None;
    assert_eq!(v3::prose_doc(&comment), None);
}

#[gpui::test]
fn panel_follows_module_scope_jumps_directly_and_refreshes_entry_changes(
    cx: &mut gpui::TestAppContext,
) {
    use gpui::{Context, IntoElement, ParentElement, Render, Styled, Window, div};
    use std::{
        cell::RefCell,
        rc::Rc,
        time::{Duration, Instant},
    };
    struct Root {
        book: String,
        target: Target,
        opened: Rc<RefCell<Vec<Target>>>,
    }
    impl Render for Root {
        fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
            let opened = self.opened.clone();
            div().size_full().child(dr_view_review::v3_panel::panel(
                "v3-review-test",
                &self.book,
                Some(self.target.clone()),
                dr_i18n::Locale::En,
                dr_i18n::Platform::Mac,
                Rc::new(move |t, _, _| opened.borrow_mut().push(t)),
                Rc::new(|_| Some(dr_ui::sand::Kind::Element)),
                cx,
            ))
        }
    }
    fn wait(
        cx: &mut gpui::VisualTestContext,
        mut done: impl FnMut(&mut gpui::VisualTestContext) -> bool,
    ) {
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            cx.executor().advance_clock(Duration::from_millis(30));
            cx.run_until_parked();
            cx.update(|window, cx| window.draw(cx).clear(cx));
            if done(cx) {
                break;
            }
            assert!(Instant::now() < deadline, "v3 review did not load");
            std::thread::sleep(Duration::from_millis(5));
        }
    }
    let f = fixture();
    cx.executor().allow_parking();
    cx.update(|cx| dr_view_review::init(Some(f.ws.clone()), cx));
    let target = Target::Entry {
        id: f.entry.clone(),
        module: Some("second-body".into()),
    };
    let opened = Rc::new(RefCell::new(Vec::new()));
    let (root, cx) = cx.add_window_view(|_, _| Root {
        book: f.book.clone(),
        target: target.clone(),
        opened: opened.clone(),
    });
    let view = cx.update(|window, cx| {
        window.draw(cx).clear(cx);
        dr_view_review::view("v3-review-test", cx).unwrap()
    });
    wait(cx, |cx| {
        view.read_with(cx, |v, _| v.listing().resolved_count > 0)
    });
    view.update(cx, |v, cx| v.set_current_only(true, cx));
    assert_eq!(
        view.read_with(cx, |v, _| v.listing().resolved[0].items[0].id.clone()),
        f.second
    );
    let title = view.read_with(cx, |v, _| v.source_summary(&f.second).unwrap().0);
    assert!(title.contains("Second body"));
    cx.update(|window, cx| view.update(cx, |v, cx| v.jump(&f.second, window, cx)));
    assert_eq!(opened.borrow().as_slice(), &[target]);
    root.update(cx, |r, cx| {
        r.target = Target::Entry {
            id: f.entry.clone(),
            module: Some("mod-prose".into()),
        };
        cx.notify();
    });
    wait(cx, |cx| {
        view.read_with(cx, |v, _| {
            let list = v.listing();
            let ids: Vec<_> = list
                .open
                .iter()
                .chain(&list.resolved)
                .flat_map(|g| &g.items)
                .map(|i| i.id.as_str())
                .collect();
            ids.contains(&f.first.as_str()) && !ids.contains(&f.second.as_str())
        })
    });
    call(&f.ws, "entry.trash", json!({"book":f.book,"id":f.entry}));
    wait(cx, |cx| {
        view.read_with(cx, |v, _| {
            v.listing()
                .open
                .iter()
                .chain(&v.listing().resolved)
                .any(|g| {
                    g.place == dr_view_review::Place::Gone
                        && g.items.iter().any(|i| i.id == f.first)
                })
        })
    });
    let count = opened.borrow().len();
    cx.update(|window, cx| view.update(cx, |v, cx| v.jump(&f.first, window, cx)));
    assert_eq!(
        opened.borrow().len(),
        count,
        "a hidden source cannot be opened"
    );
    cx.update(|_, cx| dr_view_review::release(cx));
    assert!(
        cx.update(|_, cx| dr_view_review::view("v3-review-test", cx))
            .is_none()
    );
    f.ws.close();
}

#[test]
fn stable_create_anchors_follow_prefixes_and_partial_deletion_but_refuse_foreign_or_gone_text() {
    use dr_workspace::dto::AnchorBytes;
    let f = fixture();
    let doc = format!("body:{}/second-body", f.entry);
    let session = f.ws.prose_session(&doc).unwrap();
    let anchor = AnchorBytes::from(&session.reader().view().anchor(0..4).unwrap().encode());
    let input = json!({"book":f.book,"target":{"kind":"entry","id":f.entry},
        "module":"second-body","anchor":anchor,"body":f.quote});
    let before = f.ws.observe(&format!("book:{}", f.book)).unwrap().version;
    let mut both = input.clone();
    both["range"] = json!([0, 4]);
    assert!(f.ws.call(&Actor::User, "comment.create", both).is_err());
    let mut malformed = input.clone();
    malformed["anchor"]["start"] = json!("bad");
    assert!(
        f.ws.call(&Actor::User, "comment.create", malformed)
            .is_err()
    );
    let original_doc = format!("body:{}/mod-prose", f.entry);
    let other = f.ws.prose_session(&original_doc).unwrap();
    let mut foreign = input.clone();
    foreign["anchor"] = json!(AnchorBytes::from(
        &other.reader().view().anchor(0..4).unwrap().encode()
    ));
    assert!(f.ws.call(&Actor::User, "comment.create", foreign).is_err());
    assert_eq!(
        f.ws.observe(&format!("book:{}", f.book)).unwrap().version,
        before
    );
    let prefix = format!("{} ", f.quote);
    let offset = prefix.chars().count();
    session.edit(move |t| t.insert_text(0, &prefix)).unwrap();
    let made = call(&f.ws, "comment.create", input.clone());
    let comments = v3::load(&f.ws, &f.book).unwrap();
    let made = comments
        .items
        .iter()
        .find(|c| c.comment.id.as_str() == made["id"].as_str().unwrap())
        .unwrap();
    assert_eq!(made.comment.quote.as_deref(), Some(f.quote.as_str()));
    assert_eq!(
        made.comment.target_module.as_ref().unwrap().as_str(),
        "second-body"
    );
    session.edit(move |t| t.delete(offset..offset + 1)).unwrap();
    let partial = call(&f.ws, "comment.create", input.clone());
    let comments = v3::load(&f.ws, &f.book).unwrap();
    let partial = comments
        .items
        .iter()
        .find(|c| c.comment.id.as_str() == partial["id"].as_str().unwrap())
        .unwrap();
    let remainder: String = f.quote.chars().skip(1).collect();
    assert_eq!(partial.comment.quote.as_deref(), Some(remainder.as_str()));
    let end = session.reader().view().len() - 1;
    session.edit(move |t| t.delete(0..end)).unwrap();
    let before = f.ws.observe(&format!("book:{}", f.book)).unwrap().version;
    assert!(f.ws.call(&Actor::User, "comment.create", input).is_err());
    assert_eq!(
        f.ws.observe(&format!("book:{}", f.book)).unwrap().version,
        before
    );
    f.ws.close();
}

#[test]
fn stable_anchor_creation_checks_the_observed_source_version_before_writing() {
    use dr_workspace::{WritePreconditions, dto::AnchorBytes};
    let f = fixture();
    let doc = format!("body:{}/second-body", f.entry);
    let book_doc = format!("book:{}", f.book);
    let session = f.ws.prose_session(&doc).unwrap();
    let anchor = AnchorBytes::from(&session.reader().view().anchor(0..4).unwrap().encode());
    let input = json!({"book":f.book,"target":{"kind":"entry","id":f.entry},
        "module":"second-body","anchor":anchor,"body":f.quote});
    let observed = [
        f.ws.observe(&book_doc).unwrap(),
        f.ws.observe(&doc).unwrap(),
    ];
    let prefix = f.quote.clone();
    session.edit(move |t| t.insert_text(0, &prefix)).unwrap();
    let before = f.ws.observe(&book_doc).unwrap().version;
    let comments = call(&f.ws, "comment.list", json!({"book":f.book}));
    let mut missing = WritePreconditions::from_observations([f.ws.observe(&book_doc).unwrap()]);
    missing.require_all = false;
    assert!(matches!(
        f.ws.call_guarded(&Actor::User, "comment.create", input.clone(), missing),
        Err(dr_workspace::WsError::Conflict(_))
    ));
    let error =
        f.ws.call_guarded(
            &Actor::User,
            "comment.create",
            input.clone(),
            WritePreconditions::from_observations(observed),
        )
        .unwrap_err();
    assert!(
        matches!(error, dr_workspace::WsError::Conflict(_)),
        "{error:?}"
    );
    assert_eq!(f.ws.observe(&book_doc).unwrap().version, before);
    assert_eq!(
        call(&f.ws, "comment.list", json!({"book":f.book})),
        comments
    );

    // A fresh source observation permits the same stable anchor. It still
    // quotes the selected text, not the newly inserted prefix.
    let observed = [
        f.ws.observe(&book_doc).unwrap(),
        f.ws.observe(&doc).unwrap(),
    ];
    let made =
        f.ws.call_guarded(
            &Actor::User,
            "comment.create",
            input,
            WritePreconditions::from_observations(observed),
        )
        .unwrap()["output"]["id"]
            .as_str()
            .unwrap()
            .to_owned();
    let after = v3::load(&f.ws, &f.book).unwrap();
    assert_eq!(
        after
            .items
            .iter()
            .find(|i| i.comment.id.as_str() == made)
            .unwrap()
            .comment
            .quote
            .as_deref(),
        Some(f.quote.as_str())
    );
    f.ws.close();
}
