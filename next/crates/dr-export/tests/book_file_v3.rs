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
    let file = dir.path().join("synthetic.driftingbook");
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
        .find(|e| e.id != entry.id && e.is_leaf(&b.book.view().templates_map()))
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
                .target(Some(&dr_model::book::EntityRef::new(
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
    let file = dir.path().join("retained.driftingbook");
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
    let source = dir.path().join("source.driftingbook");
    let damaged = dir.path().join("damaged.driftingbook");
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
    assert_eq!(manifest["formatVersion"], 3);
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
    let genesis =
        dr_doc::peer::genesis_peer(&format!("book:{book}"), dr_doc::schema::GENESIS_VERSION_V3);
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
    assert!(import_book(&ws, &damaged, &|p| progressed.set(p.done)).is_err());
    assert!(
        progressed.get() > 0,
        "failure followed successful prose writes"
    );
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
    let file = dir.path().join("incomplete.driftingbook");
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
