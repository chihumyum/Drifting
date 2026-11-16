use dr_export::book_file::{export_book, import_book};
use dr_testkit::seed::{DEFAULT_SEED, Preset, digest_v3, generate_v3};
use dr_workspace::Workspace;

#[test]
fn v3_archive_carries_the_seed_twice_without_mutating_source() {
    let dir = tempfile::tempdir().unwrap();
    let store = dr_store::Library::open(
        dir.path().join("library"),
        dr_workspace::library_options("test"),
    )
    .unwrap();
    let seed = generate_v3(Preset::Tiny, DEFAULT_SEED).unwrap();
    let book = seed.books[0].book_id().to_string();
    seed.write_to(&store).unwrap();
    store.close().unwrap();
    let ws = Workspace::open_dir(dir.path().join("library"), "test").unwrap();
    let before = digest_v3(ws.library(), &book).unwrap();
    let version = ws.observe(&format!("book:{book}")).unwrap().version;
    let file = dir.path().join("synthetic.driftingproject");
    let exported = export_book(&ws, &book, &file, &|_| {}).unwrap();
    let a = import_book(&ws, &file, &|_| {}).unwrap();
    let b = import_book(&ws, &file, &|_| {}).unwrap();
    assert_ne!(a.book, book);
    assert_ne!(b.book, a.book);
    assert_eq!(a.documents, exported.documents);
    assert_eq!(digest_v3(ws.library(), &a.book).unwrap(), before);
    assert_eq!(digest_v3(ws.library(), &b.book).unwrap(), before);
    assert_eq!(
        ws.observe(&format!("book:{book}")).unwrap().version,
        version
    );
    let lists: Vec<_> = [&book, &a.book, &b.book]
        .into_iter()
        .map(|id| {
            (
                id.parse().unwrap(),
                ws.library()
                    .docs(Some(id), None)
                    .unwrap()
                    .into_iter()
                    .map(|d| d.doc_id.parse().unwrap())
                    .collect(),
            )
        })
        .collect();
    dr_model::v3::check_doc_ids_unique_across_books(&lists).unwrap();
    let source_docs = ws.library().docs(Some(&book), None).unwrap();
    ws.close();
    drop(ws);
    let store = dr_store::Library::open(
        dir.path().join("library"),
        dr_workspace::library_options("test"),
    )
    .unwrap();
    for doc in source_docs {
        store.purge_doc(&doc.doc_id).unwrap();
    }
    assert_eq!(digest_v3(&store, &a.book).unwrap(), before);
    assert_eq!(digest_v3(&store, &b.book).unwrap(), before);
    store.close().unwrap();
}

#[test]
fn v3_archive_keeps_retained_bodies_hidden_bindings_and_literal_ids() {
    use dr_doc::{prose::ProseDoc, v3::BookDocV3};
    use dr_model::{DocId, Origin, Timestamp, id::*, v3::*};

    let dir = tempfile::tempdir().unwrap();
    let store = dr_store::Library::open(
        dir.path().join("library"),
        dr_workspace::library_options("test"),
    )
    .unwrap();
    let mut seed = generate_v3(Preset::Tiny, DEFAULT_SEED).unwrap();
    let b = &mut seed.books[0];
    let book = b.book_id().to_string();
    let entry = b
        .book
        .view()
        .entries()
        .into_iter()
        .find(|e| {
            e.template
                .as_ref()
                .is_some_and(|t| t.as_str() == "tpl-chapter")
        })
        .unwrap();
    let target = b
        .book
        .view()
        .entries()
        .into_iter()
        .find(|e| e.id != entry.id && !e.is_level())
        .unwrap();
    let template = entry.template.clone().unwrap();
    let fields = ModuleId::parse("archive-fields").unwrap();
    let retained = ModuleId::parse("archive-retained").unwrap();
    let prose = b
        .prose
        .iter()
        .find(|p| matches!(p.doc_id(), DocId::Body(id) if id.entry() == &entry.id))
        .unwrap();
    let text = prose.view().text_in(0..prose.view().len() - 1).unwrap();
    let mut extra = ProseDoc::create(
        DocId::Body(BodyDocId::new(entry.id.clone(), retained.clone())),
        43210,
    )
    .unwrap();
    let anchor = extra.view().anchor(0..1).unwrap();
    extra
        .edit(Origin::User, |t| t.insert_paragraphs(0, &text))
        .0
        .unwrap();
    let template_id = DocId::Template(TemplateId::for_entry_module(
        b.book_id(),
        &template,
        &retained,
    ));
    let mut default = ProseDoc::create(template_id, 43211).unwrap();
    default
        .edit(Origin::User, |t| t.insert_paragraphs(0, &text))
        .0
        .unwrap();
    let timeline = b.book.view().timeline_views_raw()[0].id.clone();
    let pin = TimePinId::new_v7();
    let comment = CommentId::new_v7();
    b.book
        .edit(Origin::User, |t| {
            t.template(&template)?.put_module(&ModuleSpec::fields(
                fields.clone(),
                "Archive fields",
                [
                    ("reference", FieldType::EntityRef),
                    ("literal", FieldType::Text),
                ]
                .into_iter()
                .map(|(id, field_type)| FieldDef {
                    id: id.into(),
                    name: id.into(),
                    field_type,
                    options: vec![],
                    target_template: None,
                    default_value: None,
                    pos: None,
                })
                .collect(),
            ))?;
            t.template(&template)?.put_module(&ModuleSpec::prose(
                retained.clone(),
                "Retained",
                true,
                false,
            ))?;
            t.entries()
                .entry(&entry.id)?
                .title(target.id.as_str())?
                .set_field(
                    &fields,
                    "reference",
                    Some(&FieldValue::Text(target.id.to_string())),
                )?
                .set_field(
                    &fields,
                    "literal",
                    Some(&FieldValue::Text(target.id.to_string())),
                )?;
            t.timeline_view(&timeline)?.put_pin(&TimelinePin {
                id: pin.clone(),
                at: 7.0,
                label: target.id.to_string(),
                color: None,
                entry: Some(target.id.clone()),
            })?;
            t.comment(&comment)?
                .target(Some(&dr_model::shared::EntityRef::new(
                    dr_model::kind::EntityKind::Entry,
                    entry.id.as_str(),
                )))?
                .module(Some(&retained))?
                .anchor(Some(&anchor))?
                .quote(Some("\n"))?;
            t.entries()
                .entry(&target.id)?
                .deleted_at(Some(Timestamp(dr_testkit::seed::T0)))?;
            Ok(())
        })
        .0
        .unwrap();
    b.book
        .edit(Origin::User, |t| {
            t.template(&template)?.remove_module(&retained)?;
            t.template(&template)?.remove_module(&fields)?;
            Ok(())
        })
        .0
        .unwrap();
    b.prose.extend([extra, default]);
    seed.write_to(&store).unwrap();
    store.close().unwrap();
    let ws = Workspace::open_dir(dir.path().join("library"), "test").unwrap();
    let file = dir.path().join("retained.driftingproject");
    export_book(&ws, &book, &file, &|_| {}).unwrap();
    let imported = import_book(&ws, &file, &|_| {}).unwrap();
    let bytes = ws
        .library()
        .load_copy(&format!("book:{}", imported.book))
        .unwrap()
        .export(loro::ExportMode::Snapshot)
        .unwrap();
    let copy = BookDocV3::load(imported.book.parse().unwrap(), 9, &[bytes]).unwrap();
    let view = copy.view();
    let new_entry = view
        .entries_raw()
        .into_iter()
        .find(|e| e.title == target.id.as_str())
        .unwrap();
    let new_target = view
        .entries_raw()
        .into_iter()
        .find(|e| e.title == target.title)
        .unwrap();
    assert_ne!(new_entry.id, entry.id);
    assert_ne!(new_target.id, target.id);
    assert!(new_target.is_trashed());
    assert_eq!(
        new_entry.fields[&fields]["literal"],
        FieldValue::Text(target.id.to_string())
    );
    assert_eq!(
        new_entry.fields[&fields]["reference"],
        FieldValue::Text(new_target.id.to_string())
    );
    let pin = view
        .timeline_views_raw()
        .into_iter()
        .flat_map(|v| v.pins)
        .find(|p| p.label == target.id.as_str())
        .unwrap();
    assert_eq!(pin.entry, Some(new_target.id));
    for doc in [
        DocId::Body(BodyDocId::new(new_entry.id, retained.clone())),
        DocId::Template(TemplateId::for_entry_module(
            copy.book_id(),
            &template,
            &retained,
        )),
    ] {
        let source = ws
            .library()
            .load_copy(&doc.to_string())
            .unwrap()
            .export(loro::ExportMode::Snapshot)
            .unwrap();
        let prose = ProseDoc::load(doc, 10, &[source]).unwrap();
        assert_eq!(
            prose.view().text_in(0..prose.view().len() - 1).unwrap(),
            text
        );
        if matches!(prose.doc_id(), DocId::Body(_)) {
            let comment = view
                .comments()
                .into_iter()
                .find(|c| c.target_module.as_ref() == Some(&retained))
                .unwrap();
            let anchor = dr_doc::anchor::Anchor::decode(comment.anchor.as_ref().unwrap()).unwrap();
            let resolved = prose.view().resolve(&anchor).unwrap();
            assert_eq!(prose.view().text_in(resolved.range).unwrap(), "\n");
        }
    }
    ws.close();
}

#[test]
fn v3_import_rolls_back_prose_if_the_book_genesis_is_damaged() {
    use loro::{
        ExportMode, LoroDoc, LoroValue, VersionVector,
        json::{JsonOpContent, MapOp},
    };
    use sha2::{Digest as _, Sha256};
    use std::io::{Read as _, Write as _};

    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("library");
    let store = dr_store::Library::open(&root, dr_workspace::library_options("test")).unwrap();
    let seed = generate_v3(Preset::Tiny, DEFAULT_SEED).unwrap();
    let book = seed.books[0].book_id().to_string();
    seed.write_to(&store).unwrap();
    store.close().unwrap();
    let ws = Workspace::open_dir(&root, "test").unwrap();
    let source = dir.path().join("source.driftingproject");
    let damaged = dir.path().join("damaged.driftingproject");
    export_book(&ws, &book, &source, &|_| {}).unwrap();
    let mut zip = zip::ZipArchive::new(std::fs::File::open(&source).unwrap()).unwrap();
    let mut files = std::collections::BTreeMap::<String, Vec<u8>>::new();
    for i in 0..zip.len() {
        let mut file = zip.by_index(i).unwrap();
        let name = file.name().unwrap().into_owned();
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes).unwrap();
        files.insert(name, bytes);
    }
    let mut manifest: serde_json::Value = serde_json::from_slice(&files["manifest.json"]).unwrap();
    assert_eq!(
        manifest["formatVersion"],
        dr_export::book_file::FORMAT_VERSION
    );
    let entry = manifest["documents"]
        .as_array_mut()
        .unwrap()
        .last_mut()
        .unwrap();
    let path = entry["path"].as_str().unwrap().to_owned();
    let doc = LoroDoc::new();
    doc.import(&files[&path]).unwrap();
    let mut changes = doc
        .export_json_updates_without_peer_compression(&VersionVector::default(), &doc.oplog_vv())
        .unwrap();
    let genesis = dr_doc::peer::genesis_peer(
        &format!("book:{book}"),
        dr_doc::schema::BOOK_GENESIS_VERSION,
    );
    let change = changes
        .changes
        .iter_mut()
        .find(|c| c.id.peer == genesis)
        .unwrap();
    let value = change
        .ops
        .iter_mut()
        .find_map(|op| match &mut op.content {
            JsonOpContent::Map(MapOp::Insert { key, value }) if key == "name" => Some(value),
            _ => None,
        })
        .unwrap();
    *value = LoroValue::from(book.clone());
    let changed = LoroDoc::new();
    changed.import_json_updates(changes).unwrap();
    let bytes = changed.export(ExportMode::Snapshot).unwrap();
    entry["sizeBytes"] = bytes.len().into();
    entry["sha256"] = format!("{:x}", Sha256::digest(&bytes)).into();
    files.insert(path, bytes);
    files.insert(
        "manifest.json".into(),
        serde_json::to_vec(&manifest).unwrap(),
    );
    let mut output = zip::ZipWriter::new(std::fs::File::create(&damaged).unwrap());
    for (name, bytes) in files {
        output
            .start_file(name, zip::write::SimpleFileOptions::default())
            .unwrap();
        output.write_all(&bytes).unwrap();
    }
    output.finish().unwrap();
    let before = ws.library().docs(None, None).unwrap();
    let progressed = std::cell::Cell::new(0);
    let error = import_book(&ws, &damaged, &|p| progressed.set(p.done)).unwrap_err();
    eprintln!("damaged genesis import: {error:?}");
    assert!(
        progressed.get() > 0,
        "failure followed successful prose writes"
    );
    assert_eq!(ws.library().docs(None, None).unwrap(), before);
    ws.close();
}

#[test]
fn v3_failed_import_waits_for_its_holder_before_rollback() {
    use dr_store::{LocalChangeKind, Origin, StoreEvent};
    use std::sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
        mpsc,
    };
    use std::time::Duration;

    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("library");
    let store = dr_store::Library::open(&root, dr_workspace::library_options("test")).unwrap();
    let seed = generate_v3(Preset::Tiny, DEFAULT_SEED).unwrap();
    let book = seed.books[0].book_id().to_string();
    seed.write_to(&store).unwrap();
    store.close().unwrap();
    let faults = Arc::new(AtomicUsize::new(0));
    let armed = Arc::new(AtomicBool::new(false));
    let mut options = dr_workspace::library_options("test");
    options.append_faults = Some(faults.clone());
    let ws = Workspace::open(
        dr_store::Library::open(&root, options).unwrap(),
        Default::default(),
    )
    .unwrap();
    let file = dir.path().join("synthetic.driftingproject");
    export_book(&ws, &book, &file, &|_| {}).unwrap();
    let before = ws.library().docs(None, None).unwrap();
    let original = digest_v3(ws.library(), &book).unwrap();
    let (entered_tx, entered_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let release_rx = Mutex::new(release_rx);
    let (purged_tx, purged_rx) = mpsc::channel();
    let source_book = format!("book:{book}");
    let watching = armed.clone();
    let subscription = ws.library().subscribe(move |event| {
        match event {
            StoreEvent::Doc(ev)
                if watching.load(Ordering::SeqCst)
                    && ev.origin == Origin::Import
                    && ev.doc_id.starts_with("book:")
                    && ev.doc_id.as_ref() != source_book =>
            {
                // The injected append failed. Closing retries it and publishes
                // this event after commit, before releasing the holder's slot.
                // A channel gate fixes that ordering; no sleep or storage calls
                // are made from the holder callback.
                entered_tx.send(ev.doc_id.to_string()).unwrap();
                release_rx
                    .lock()
                    .unwrap()
                    .recv_timeout(Duration::from_secs(10))
                    .unwrap();
            }
            StoreEvent::Local(c)
                if watching.load(Ordering::SeqCst)
                    && c.table == "doc"
                    && c.kind == LocalChangeKind::Delete =>
            {
                let _ = purged_tx.send(c.key.clone());
            }
            _ => {}
        }
    });
    let worker_ws = ws.clone();
    let worker = std::thread::spawn(move || {
        let result = import_book(&worker_ws, &file, &|p| {
            if p.done + 1 == p.total {
                // Only the final book document remains. Its append fails
                // after the holder has been opened and registered for cleanup.
                armed.store(true, Ordering::SeqCst);
                faults.store(1, Ordering::SeqCst);
            }
        });
        result.unwrap_err()
    });
    let closing_doc = entered_rx.recv_timeout(Duration::from_secs(10)).unwrap();
    let overtook_close = purged_rx.recv_timeout(Duration::from_millis(500)).ok();
    // Always release and join before assertions, including on the old code.
    release_tx.send(()).unwrap();
    let error = worker.join().unwrap();
    let after = ws.library().docs(None, None).unwrap();
    let after_digest = digest_v3(ws.library(), &book).unwrap();
    drop(subscription);
    ws.close();
    drop(ws);
    let store = dr_store::Library::open(&root, dr_workspace::library_options("test")).unwrap();
    let reopened = store.docs(None, None).unwrap();
    store.close().unwrap();
    eprintln!("failed import {error:?}; held={closing_doc}; early purge={overtook_close:?}");
    assert_eq!(
        after, before,
        "failed import must leave no new book or prose"
    );
    assert_eq!(
        reopened, before,
        "closing/reopening cannot recreate rolled-back docs"
    );
    assert_eq!(after_digest, original, "the existing book is untouched");
    assert!(
        overtook_close.is_none(),
        "rollback started before the failed holder closed"
    );
}

#[test]
fn v3_import_reports_incomplete_cleanup_and_still_removes_other_documents() {
    use dr_export::book_file::BookFileError;
    use std::{
        cell::RefCell,
        sync::{
            Arc,
            atomic::{AtomicUsize, Ordering},
        },
    };

    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("library");
    let store = dr_store::Library::open(&root, dr_workspace::library_options("test")).unwrap();
    let seed = generate_v3(Preset::Tiny, DEFAULT_SEED).unwrap();
    let book = seed.books[0].book_id().to_string();
    seed.write_to(&store).unwrap();
    store.close().unwrap();
    let faults = Arc::new(AtomicUsize::new(0));
    let mut options = dr_workspace::library_options("test");
    options.append_faults = Some(faults.clone());
    let ws = Workspace::open(
        dr_store::Library::open(&root, options).unwrap(),
        Default::default(),
    )
    .unwrap();
    let file = dir.path().join("synthetic.driftingproject");
    export_book(&ws, &book, &file, &|_| {}).unwrap();
    let before = ws.library().docs(None, None).unwrap();
    let original = digest_v3(ws.library(), &book).unwrap();
    let held = RefCell::new(None);
    let error = import_book(&ws, &file, &|p| {
        if held.borrow().is_none() {
            let imported = ws
                .library()
                .docs(None, None)
                .unwrap()
                .into_iter()
                .find(|d| !before.iter().any(|old| old.doc_id == d.doc_id));
            if let Some(doc) = imported {
                // An independent reader retains an already imported prose
                // document. Import cannot close another caller's handle.
                *held.borrow_mut() = Some(
                    ws.library()
                        .open_doc(&doc.doc_id, dr_store::OpenDoc::Existing)
                        .unwrap(),
                );
            }
        }
        if p.done + 1 == p.total {
            faults.store(1, Ordering::SeqCst);
        }
    })
    .unwrap_err();
    let held = held.into_inner().expect("a prose document was imported");
    let held_id = held.doc_id().to_owned();
    match error {
        BookFileError::Rollback { import, cleanup } => {
            assert!(matches!(
                *import,
                BookFileError::Store(dr_store::StoreError::Io(_))
            ));
            assert!(matches!(cleanup, dr_store::StoreError::AlreadyOpen(ref id) if id == &held_id));
        }
        other => panic!("cleanup failure was hidden: {other:?}"),
    }
    let remaining = ws.library().docs(None, None).unwrap();
    assert_eq!(
        remaining
            .iter()
            .filter(|d| !before.iter().any(|old| old.doc_id == d.doc_id))
            .map(|d| d.doc_id.as_str())
            .collect::<Vec<_>>(),
        [&held_id],
        "a blocked document must not stop cleanup of the others"
    );
    assert_eq!(digest_v3(ws.library(), &book).unwrap(), original);
    held.close();
    ws.library().purge_doc(&held_id).unwrap();
    ws.library().forget_purged(&held_id).unwrap();
    assert_eq!(ws.library().docs(None, None).unwrap(), before);
    ws.close();
}

#[test]
fn changing_v3_book_does_not_publish_an_incomplete_file() {
    let dir = tempfile::tempdir().unwrap();
    let store = dr_store::Library::open(
        dir.path().join("library"),
        dr_workspace::library_options("test"),
    )
    .unwrap();
    let seed = generate_v3(Preset::Tiny, DEFAULT_SEED).unwrap();
    let book = seed.books[0].book_id().to_string();
    let entry = seed.books[0].book.view().entries()[0].id.to_string();
    seed.write_to(&store).unwrap();
    store.close().unwrap();
    let ws = Workspace::open_dir(dir.path().join("library"), "test").unwrap();
    let file = dir.path().join("incomplete.driftingproject");
    let changed = std::cell::Cell::new(false);
    let result = export_book(&ws, &book, &file, &|_| {
        if !changed.replace(true) {
            ws.call(
                &dr_workspace::Actor::User,
                "entry.update",
                serde_json::json!({"book":book,"id":entry,"title":book}),
            )
            .unwrap();
        }
    });
    assert!(matches!(
        result,
        Err(dr_export::book_file::BookFileError::Workspace(
            dr_workspace::WsError::Conflict(_)
        ))
    ));
    assert!(!file.exists());
    assert!(
        !std::fs::read_dir(dir.path()).unwrap().any(|p| p
            .unwrap()
            .file_name()
            .to_string_lossy()
            .ends_with(".part"))
    );
    ws.close();
}

#[test]
fn v5_showcase_archive_roundtrips_asset_folders_media_fields_file_links_and_comments() {
    use dr_doc::{
        prose::{EmbedKind, ProseDoc},
        v3::{BookDocV3, novel::*},
    };
    use dr_model::{
        DocId, Origin, Timestamp, id::*, kind::*, pos::PosKey, shared::EntityRef, v3::*,
    };
    use dr_testkit::seed::{TPL_SHOWCASE_GALLERY, write_book_files_v3, write_book_v3};
    use dr_workspace::Actor;
    use serde_json::json;
    use std::collections::BTreeSet;

    let dir = tempfile::tempdir().unwrap();
    let store = dr_store::Library::open(
        dir.path().join("library"),
        dr_workspace::library_options("test"),
    )
    .unwrap();
    let mut seed = generate_v3(Preset::Showcase, DEFAULT_SEED).unwrap();
    let b = &mut seed.books[0];
    let book = b.book_id().to_string();

    let view = b.book.view();
    let unused_asset = view
        .assets()
        .into_iter()
        .find(|a| a.name == "海边参考.png")
        .unwrap()
        .id;
    let map_asset = view
        .assets()
        .into_iter()
        .find(|a| a.name == "东岸全图.png")
        .unwrap()
        .id;
    let plan_asset = view
        .assets()
        .into_iter()
        .find(|a| a.name == "钟楼平面.png")
        .unwrap()
        .id;
    let scrap_folder = view
        .asset_folders_raw()
        .into_iter()
        .find(|f| f.name == "废稿")
        .unwrap()
        .id;
    let character = view
        .entries()
        .into_iter()
        .find(|e| {
            e.template
                .as_ref()
                .is_some_and(|t| t.as_str() == TPL_CHARACTER)
        })
        .unwrap();
    let chapter = view
        .entries()
        .into_iter()
        .find(|e| {
            e.template
                .as_ref()
                .is_some_and(|t| t.as_str() == TPL_CHAPTER)
        })
        .unwrap();
    let gallery = view
        .entries()
        .into_iter()
        .find(|e| {
            e.template
                .as_ref()
                .is_some_and(|t| t.as_str() == TPL_SHOWCASE_GALLERY)
        })
        .unwrap();
    let patch = view.patches().into_iter().next().unwrap();

    let sub_scrap = AssetFolderId::new_v7();
    let plot_mod = ModuleId::parse("mod-plot-archive").unwrap();
    let patch_comment = CommentId::new_v7();
    let plot_comment = CommentId::new_v7();
    let table_embed = EmbedId::new_v7();
    let default_row = PlotRowId::default_for_entry(&chapter.id, &plot_mod, 1);
    let default_col = PlotColId::default_for_entry(&chapter.id, &plot_mod, 1);

    let fmod = ModuleId::parse(MOD_FIELDS).unwrap();
    let prose_mod = ModuleId::parse(MOD_PROSE).unwrap();
    let patches_mod = ModuleId::parse(MOD_PATCHES).unwrap();
    let tpl_chapter = EntryTemplateId::parse(TPL_CHAPTER).unwrap();
    let mut chapter_tpl = view.template(&tpl_chapter).unwrap();
    let ch_fields = chapter_tpl
        .modules
        .iter_mut()
        .find(|m| m.id == fmod)
        .unwrap();
    ch_fields.config.defs.push(FieldDef {
        id: "cover_ref".into(),
        name: "封面参考".into(),
        field_type: FieldType::Image,
        options: Vec::new(),
        target_template: None,
        default_value: Some(FieldValue::Text(plan_asset.to_string())),
        pos: None,
    });
    chapter_tpl
        .modules
        .push(ModuleSpec::plot_grid(plot_mod.clone(), "情节格", 2, 2));

    b.book
        .edit(Origin::User, |t| {
            t.template(&tpl_chapter)?.set_full(&chapter_tpl)?;
            t.entries().entry(&character.id)?.set_field(
                &fmod,
                "portrait",
                Some(&FieldValue::Text(unused_asset.to_string())),
            )?;
            t.entries().entry(&chapter.id)?.set_field(
                &fmod,
                "cover_ref",
                Some(&FieldValue::Text(plan_asset.to_string())),
            )?;
            t.asset_folder(&sub_scrap)?
                .name("废稿子夹")?
                .parent(Some(&scrap_folder))?
                .pos(Some(&PosKey::first()))?
                .deleted_at(Some(Timestamp(dr_testkit::seed::T0)))?
                .trashed_with(Some(&scrap_folder))?;
            let g = t.plot_grid(&chapter.id, &plot_mod)?;
            g.row(&default_row, PosKey::first().as_str(), "第一行")?;
            g.col(&default_col, PosKey::first().as_str(), "第一列")?;
            g.cell(&default_row, &default_col, Some("钟声响起"))?;
            t.comment(&patch_comment)?
                .origin(&CommentOrigin::Manual)?
                .target(Some(&EntityRef::new(
                    EntityKind::Entry,
                    patch.entry.as_str(),
                )))?
                .module(Some(&patches_mod))?
                .part(Some(&CommentPart::Patch {
                    patch: patch.id.clone(),
                }))?
                .body("核对这条补丁的时间顺序")?
                .status(&CommentStatus::Open)?;
            t.comment(&plot_comment)?
                .origin(&CommentOrigin::Manual)?
                .target(Some(&EntityRef::new(
                    EntityKind::Entry,
                    chapter.id.as_str(),
                )))?
                .module(Some(&plot_mod))?
                .part(Some(&CommentPart::PlotCell {
                    row: default_row.clone(),
                    col: default_col.clone(),
                }))?
                .body("这一格和东岸全图一致")?
                .status(&CommentStatus::Open)?;
            Ok(())
        })
        .0
        .unwrap();

    let chapter_doc_id = DocId::Body(BodyDocId::new(chapter.id.clone(), prose_mod.clone()));
    let ch_prose = b
        .prose
        .iter_mut()
        .find(|p| p.doc_id() == &chapter_doc_id)
        .unwrap();
    let asset_link = EntityLinkV3 {
        target: map_asset.to_string(),
        kind: EntityKind::Asset,
        module: None,
        block: None,
        end_block: None,
    };
    ch_prose
        .edit(Origin::User, |t| {
            // Position 0 holds a U+FFFC embed placeholder; position 2 is the
            // start of the next paragraph.
            let tw = t.insert_embed(2, &table_embed, &EmbedKind::Table)?;
            tw.add_row("r1", &PosKey::first())?;
            tw.add_col("c1", &PosKey::first())?;
            tw.set_cell("r1", "c1", "附图：东岸全图")?;
            t.link_table_cell_entity_v3(&table_embed, "r1", "c1", 3..7, &asset_link)?;
            t.insert_text(4, "参见东岸全图")?;
            t.link_entity_v3(6..10, &asset_link)?;
            Ok(())
        })
        .0
        .unwrap();

    write_book_v3(&store, b).unwrap();
    write_book_files_v3(&store, b).unwrap();
    store.close().unwrap();

    let ws = Workspace::open_dir(dir.path().join("library"), "test").unwrap();
    let before = digest_v3(ws.library(), &book).unwrap();
    let file = dir.path().join("showcase.driftingproject");
    export_book(&ws, &book, &file, &|_| {}).unwrap();

    // Verify exported manifest uses format version 5.
    {
        let mut zip = zip::ZipArchive::new(std::fs::File::open(&file).unwrap()).unwrap();
        let mut raw = String::new();
        use std::io::Read as _;
        zip.by_name("manifest.json")
            .unwrap()
            .read_to_string(&mut raw)
            .unwrap();
        let manifest: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(manifest["formatVersion"], 5);
    }

    let imp_a = import_book(&ws, &file, &|_| {}).unwrap();
    let imp_b = import_book(&ws, &file, &|_| {}).unwrap();
    assert_ne!(imp_a.book, book);
    assert_ne!(imp_b.book, book);
    assert_ne!(imp_a.book, imp_b.book);
    assert_eq!(digest_v3(ws.library(), &imp_a.book).unwrap(), before);
    assert_eq!(digest_v3(ws.library(), &imp_b.book).unwrap(), before);

    // Every asset variant travelled into the imported book under fresh IDs.
    let src_variants = ws.library().assets_of_book(&book).unwrap();
    let imp_variants = ws.library().assets_of_book(&imp_a.book).unwrap();
    assert_eq!(imp_variants.len(), src_variants.len());
    let src_asset_ids: BTreeSet<_> = src_variants.iter().map(|v| &v.asset_id).collect();
    for v in &imp_variants {
        assert!(!src_asset_ids.contains(&v.asset_id));
        assert!(v.path.exists());
    }

    let snap = ws
        .library()
        .load_copy(&format!("book:{}", imp_a.book))
        .unwrap()
        .export(loro::ExportMode::Snapshot)
        .unwrap();
    let imported_doc = BookDocV3::load(imp_a.book.parse().unwrap(), 11, &[snap]).unwrap();
    let iv = imported_doc.view();

    let src_folder_ids: BTreeSet<_> = b
        .book
        .view()
        .asset_folders_raw()
        .into_iter()
        .map(|f| f.id)
        .collect();
    for f in iv.asset_folders_raw() {
        assert!(!src_folder_ids.contains(&f.id));
    }

    let new_unused = iv
        .assets()
        .into_iter()
        .find(|a| a.name == "海边参考.png")
        .unwrap()
        .id;
    let new_map = iv
        .assets()
        .into_iter()
        .find(|a| a.name == "东岸全图.png")
        .unwrap()
        .id;
    let new_notebook = iv
        .assets()
        .into_iter()
        .find(|a| a.name == "潮汐笔记.pdf")
        .unwrap()
        .id;
    let new_plan = iv
        .assets()
        .into_iter()
        .find(|a| a.name == "钟楼平面.png")
        .unwrap()
        .id;
    let new_gallery = iv
        .entries()
        .into_iter()
        .find(|e| e.title == gallery.title)
        .unwrap();
    let new_character = iv
        .entries()
        .into_iter()
        .find(|e| e.title == character.title)
        .unwrap();
    let new_chapter = iv
        .entries()
        .into_iter()
        .find(|e| e.title == chapter.title)
        .unwrap();

    // Media module items rewrote to new AssetIds and are not marked missing.
    let media_out = ws
        .call(
            &Actor::User,
            "module.read",
            json!({"book": imp_a.book, "entry": new_gallery.id, "module": MOD_MEDIA}),
        )
        .unwrap()["output"]
        .clone();
    let media_items = media_out["media"].as_array().unwrap();
    assert_eq!(media_items.len(), 2);
    assert_eq!(media_items[0]["asset"], new_map.as_str());
    assert_eq!(media_items[0].get("missing"), None);
    assert_eq!(media_items[1]["asset"], new_notebook.as_str());
    assert_eq!(media_items[1].get("missing"), None);

    // Image fields and template default_value rewrote to new AssetIds.
    let char_fields = ws
        .call(
            &Actor::User,
            "module.read",
            json!({"book": imp_a.book, "entry": new_character.id, "module": MOD_FIELDS}),
        )
        .unwrap()["output"]
        .clone();
    assert_eq!(char_fields["fields"]["portrait"], new_unused.as_str());
    assert_eq!(char_fields["missing_files"], json!([]));

    let ch_fields_out = ws
        .call(
            &Actor::User,
            "module.read",
            json!({"book": imp_a.book, "entry": new_chapter.id, "module": MOD_FIELDS}),
        )
        .unwrap()["output"]
        .clone();
    assert_eq!(ch_fields_out["fields"]["cover_ref"], new_plan.as_str());
    assert_eq!(ch_fields_out["missing_files"], json!([]));
    let imp_tpl_ch = iv.template(&tpl_chapter).unwrap();
    let cover_def = imp_tpl_ch
        .modules
        .iter()
        .find(|m| m.id == fmod)
        .unwrap()
        .config
        .defs
        .iter()
        .find(|d| d.id == "cover_ref")
        .unwrap();
    assert_eq!(
        cover_def.default_value,
        Some(FieldValue::Text(new_plan.to_string()))
    );

    // Prose file links (body paragraph and table cell) rewrote to new AssetId.
    let new_ch_doc_id = DocId::Body(BodyDocId::new(new_chapter.id.clone(), prose_mod.clone()));
    let new_ch_bytes = ws
        .library()
        .load_copy(&new_ch_doc_id.to_string())
        .unwrap()
        .export(loro::ExportMode::Snapshot)
        .unwrap();
    let new_ch_prose = ProseDoc::load(new_ch_doc_id, 12, &[new_ch_bytes]).unwrap();
    let body_asset_links: Vec<_> = new_ch_prose
        .view()
        .entity_links_v3()
        .into_iter()
        .filter(|(_, l)| l.kind == EntityKind::Asset)
        .collect();
    assert_eq!(body_asset_links.len(), 1);
    assert_eq!(body_asset_links[0].1.target, new_map.as_str());
    let cell_links = new_ch_prose
        .view()
        .table_cell_entity_links_v3(&table_embed, "r1", "c1")
        .unwrap();
    assert_eq!(cell_links.len(), 1);
    assert_eq!(cell_links[0].1.kind, EntityKind::Asset);
    assert_eq!(cell_links[0].1.target, new_map.as_str());

    // Comments on media, patches, plot cells, embeds and asset regions resolve cleanly.
    let listed = ws
        .call(&Actor::User, "comment.list", json!({"book": imp_a.book}))
        .unwrap()["output"]
        .as_array()
        .unwrap()
        .clone();
    for body in [
        "灯塔应该在北岬，不在这里",
        "这张潮汐表和第四章对不上",
        "这块礁石可以写进第七章",
        "平面图的门开错了方向",
        "核对这条补丁的时间顺序",
        "这一格和东岸全图一致",
    ] {
        let c = listed
            .iter()
            .find(|c| c["body"]["text"].as_str() == Some(body))
            .unwrap_or_else(|| panic!("missing imported comment: {body}"));
        assert_eq!(
            c["unlocated"], false,
            "imported comment became unlocated: {c}"
        );
    }

    // Restoring trashed folder 「废稿」 brings back both 「旧草图.png」 and 「废稿子夹」.
    let new_scrap = iv
        .asset_folders_raw()
        .into_iter()
        .find(|f| f.name == "废稿")
        .unwrap();
    assert!(new_scrap.is_trashed());
    ws.call(
        &Actor::User,
        "asset_folder.restore",
        json!({"book": imp_a.book, "id": new_scrap.id}),
    )
    .unwrap();
    let restored_snap = ws
        .library()
        .load_copy(&format!("book:{}", imp_a.book))
        .unwrap()
        .export(loro::ExportMode::Snapshot)
        .unwrap();
    let restored_doc = BookDocV3::load(imp_a.book.parse().unwrap(), 13, &[restored_snap]).unwrap();
    let rv = restored_doc.view();
    assert!(
        rv.assets()
            .iter()
            .any(|a| a.name == "旧草图.png" && a.trashed_with.is_none()),
        "restoring 废稿 must restore 旧草图.png"
    );
    assert!(
        rv.asset_folders()
            .iter()
            .any(|f| f.name == "废稿子夹" && f.trashed_with.is_none()),
        "restoring 废稿 must restore 废稿子夹"
    );

    ws.close();
}

#[test]
fn archive_rekeys_relation_row_members_and_book_text_links() {
    use dr_workspace::Actor;
    use serde_json::json;

    let dir = tempfile::tempdir().unwrap();
    let ws = Workspace::open_dir(dir.path().join("source"), "test").unwrap();
    let call = |name: &str, args| ws.call(&Actor::User, name, args).unwrap()["output"].clone();
    let book = call("project.create", json!({"name":"Synthetic export"}))["id"].clone();
    let [a, b, c] = ["甲灯塔", "乙灯塔", "丙灯塔"]
        .map(|title| call("entry.create", json!({"book":book,"title":title}))["id"].clone());
    let mark = json!({"text":"甲灯塔","links":[{"start":0,"end":3,"entry":a}]});
    let row = call(
        "relation_row.create_pair",
        json!({
            "book":book,"left":a,"right":b,
            "new_type":{"name":"渡口相望","direction":"symmetric","description":mark},
        }),
    );
    call(
        "relation_row.add_entry",
        json!({"book":book,"id":row["id"],"side":"right","entry":c}),
    );
    call("comment.create", json!({"book":book,"body":mark}));
    let file = dir.path().join("rd.driftingproject");
    let book_id = book.as_str().unwrap();
    let at = ws.observe(&format!("book:{book_id}")).unwrap().version;
    export_book(&ws, book_id, &file, &|_| {}).unwrap();
    let imported = import_book(&ws, &file, &|_| {}).unwrap().book;
    let entries = call("entry.list", json!({"book":imported,"all":true}));
    let id = |title: &str| {
        entries
            .as_array()
            .unwrap()
            .iter()
            .find(|e| e["title"] == title)
            .unwrap()["id"]
            .as_str()
            .unwrap()
    };
    let [na, nb, nc] = ["甲灯塔", "乙灯塔", "丙灯塔"].map(id);
    assert_ne!(na, a.as_str().unwrap());
    let relations = call("relation_type.list", json!({"book":imported}));
    let relation = &relations[0];
    assert_eq!(relation["name"], "渡口相望");
    assert_eq!(relation["direction"], "symmetric");
    assert_eq!(relation["pair_count"], 2);
    assert_eq!(relation["rows"][0]["left"], json!([na]));
    let mut right = [nb, nc];
    right.sort_unstable();
    assert_eq!(relation["rows"][0]["right"], json!(right));
    let linked = json!({"text":"甲灯塔","links":[{"start":0,"end":3,"entry":na}]});
    assert_eq!(relation["description"], linked);
    let comments = call("comment.list", json!({"book":imported}));
    assert_eq!(comments[0]["body"], linked);
    assert_eq!(ws.observe(&format!("book:{book_id}")).unwrap().version, at);
    ws.shutdown().unwrap();
}
