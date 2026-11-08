//! Three-way merges on plain dr-doc documents: the file's edit and
//! Drifting's are both kept, each where it was made; the same file read
//! twice changes the prose once; paragraphs keep their identity where the
//! file only edited them; refusals.

use dr_doc::prose::{EmbedKind, ProseDoc};
use dr_mirror::body::{self, Para};
use dr_mirror::merge::{Refusal, merge, merge_peer};
use dr_model::id::EmbedId;
use dr_model::prose::{Heading, InlineStyle};
use dr_model::{DocId, Origin};
use loro::LoroDoc;

fn doc(text: &str) -> (DocId, ProseDoc) {
    let id = DocId::parse("node:c1").unwrap();
    let mut p = ProseDoc::create(id.clone(), 7).unwrap();
    let (r, _) = p.edit(Origin::User, |t| t.insert_paragraphs(0, text).map(|_| ()));
    r.unwrap();
    (id, p)
}

fn loro_copy(p: &ProseDoc) -> LoroDoc {
    let d = LoroDoc::new();
    d.import(&p.export_snapshot().unwrap()).unwrap();
    d
}

fn paras(p: &ProseDoc) -> Vec<Para> {
    p.view().paragraphs().map(|x| Para::of(&x)).collect()
}

fn texts(p: &ProseDoc) -> Vec<String> {
    p.view().paragraphs().map(|x| x.text()).collect()
}

fn ids(p: &ProseDoc) -> Vec<String> {
    p.view()
        .paragraphs()
        .map(|x| x.stored_id.map(|i| i.to_string()).unwrap_or_default())
        .collect()
}

/// The file as Drifting writes it from `p`, then `edit` applied to it.
fn edited(p: &ProseDoc, edit: impl Fn(String) -> String) -> (String, Vec<body::FilePara>) {
    let written = body::render(&paras(p));
    let file = edit(written);
    let parsed = body::parse(&file);
    (file, parsed)
}

#[test]
fn both_sides_edits_of_one_paragraph_are_kept() {
    let (id, mut live) = doc("钟楼在镇口。\n她没回头。\n雨下了一夜。");
    let base = live.frontiers();
    let before_ids = ids(&live);
    // The file: a word in the middle of the first paragraph.
    let (file, parsed) = edited(&live, |s| s.replace("在镇口", "在镇口的石桥边"));
    // Drifting meanwhile: the start of the same paragraph, and a new one.
    let (r, _) = live.edit(Origin::User, |t| {
        t.insert_text(0, "那天，")?;
        t.insert_paragraphs(t.view().len() - 1, "\n尾声。")
            .map(|_| ())
    });
    r.unwrap();
    let copy = loro_copy(&live);
    let peer = merge_peer(&id, &base, file.as_bytes());
    let m = merge(&copy, &id, &base, &parsed, peer, None)
        .unwrap()
        .unwrap();
    assert!(!m.update.is_empty());
    live.import(&m.update, Origin::Mirror).unwrap();
    assert_eq!(
        texts(&live),
        [
            "那天，钟楼在镇口的石桥边。",
            "她没回头。",
            "雨下了一夜。",
            "尾声。"
        ]
    );
    assert_eq!(ids(&live)[..3], before_ids[..3], "edited, not replaced");
    // The same file over the same base again: the same change, taken once.
    let again = merge(&copy, &id, &base, &parsed, peer, None)
        .unwrap()
        .unwrap();
    let v = live.version();
    live.import(&again.update, Origin::Mirror).unwrap();
    assert_eq!(live.version(), v);
    assert_eq!(texts(&live).len(), 4);
}

#[test]
fn paragraphs_come_and_go_and_marks_follow_the_file() {
    let (id, mut live) = doc("一。\n二。\n三是第三段的开头。\n四。");
    let base = live.frontiers();
    let before = ids(&live);
    let (file, parsed) = edited(&live, |_| {
        "## 一。\n\n新的一段话在这里。\n\n三是第三段的**开头**，加了字。\n\n四。\n\n> 引一句。\n"
            .into()
    });
    let copy = loro_copy(&live);
    let m = merge(
        &copy,
        &id,
        &base,
        &parsed,
        merge_peer(&id, &base, file.as_bytes()),
        None,
    )
    .unwrap()
    .unwrap();
    live.import(&m.update, Origin::Mirror).unwrap();
    assert_eq!(
        texts(&live),
        [
            "一。",
            "新的一段话在这里。",
            "三是第三段的开头，加了字。",
            "四。",
            "引一句。"
        ]
    );
    let now = ids(&live);
    assert_eq!(now[0], before[0]);
    assert_eq!(now[2], before[2], "三 was edited");
    assert_eq!(now[3], before[3]);
    assert!(!before.contains(&now[1]), "a new paragraph has a new id");
    let ps: Vec<_> = live.view().paragraphs().collect();
    assert_eq!(ps[0].attrs.heading, Some(Heading::H2));
    assert!(ps[4].attrs.quote);
    let bold: String = ps[2]
        .runs
        .iter()
        .filter(|r| r.marks.bold)
        .map(|r| r.text.as_str())
        .collect();
    assert_eq!(bold, "开头");
    // Written out again, the file reads as the author left it.
    assert_eq!(
        body::render(&paras(&live)),
        "## 一。\n\n新的一段话在这里。\n\n三是第三段的**开头**，加了字。\n\n四。\n\n> 引一句。\n"
    );
}

#[test]
fn an_unchanged_file_changes_nothing_and_alignment_stays() {
    let (id, mut live) = doc("左。\n居中。");
    let (r, _) = live.edit(Origin::User, |t| {
        let mut a = t.view().paragraph_at(3).unwrap().attrs;
        a.align = dr_model::prose::Align::Center;
        t.set_block_attrs(3, &a)?;
        t.set_style(0..1, &InlineStyle::Bold)
    });
    r.unwrap();
    let base = live.frontiers();
    let (file, parsed) = edited(&live, |s| s);
    let m = merge(
        &loro_copy(&live),
        &id,
        &base,
        &parsed,
        merge_peer(&id, &base, file.as_bytes()),
        None,
    )
    .unwrap()
    .unwrap();
    assert!(m.update.is_empty());
    assert_eq!(m.frontiers, base);
    // An edit next to a centred paragraph leaves it centred.
    let (file, parsed) = edited(&live, |s| s.replacen("**左**。", "**左**边。", 1));
    assert!(file.contains("左**边"), "{file}");
    let m = merge(
        &loro_copy(&live),
        &id,
        &base,
        &parsed,
        merge_peer(&id, &base, file.as_bytes()),
        None,
    )
    .unwrap()
    .unwrap();
    live.import(&m.update, Origin::Mirror).unwrap();
    let ps: Vec<_> = live.view().paragraphs().collect();
    assert_eq!(ps[0].text(), "左边。");
    assert_eq!(ps[1].attrs.align, dr_model::prose::Align::Center);
}

#[test]
fn tables_stay_unless_their_line_is_gone() {
    let (id, mut live) = doc("前。\n后。");
    let table = EmbedId::parse("t1").unwrap();
    let (r, _) = live.edit(Origin::User, |t| {
        let at = t.view().paragraph_start(3);
        t.insert_embed(at, &table, &EmbedKind::Table).map(|_| ())
    });
    r.unwrap();
    let base = live.frontiers();
    let written = body::render(&paras(&live));
    assert_eq!(written, "前。\n\n<!-- drifting:embed t1 -->\n\n后。\n");
    // Moved to the end: never deleted (the text around it may be what
    // moves).
    let moved = "前。\n\n后。\n\n<!-- drifting:embed t1 -->\n";
    let m = merge(
        &loro_copy(&live),
        &id,
        &base,
        &body::parse(moved),
        merge_peer(&id, &base, moved.as_bytes()),
        None,
    )
    .unwrap()
    .unwrap();
    let mut copy = ProseDoc::load(id.clone(), 9, &[live.export_snapshot().unwrap()]).unwrap();
    copy.import(&m.update, Origin::Mirror).unwrap();
    let after = body::render(&paras(&copy));
    assert!(after == written || after == moved, "{after}");
    assert_eq!(copy.view().embed_refs().len(), 1);
    // Its line deleted: it goes.
    let gone = "前。\n\n后。\n";
    let m = merge(
        &loro_copy(&live),
        &id,
        &base,
        &body::parse(gone),
        merge_peer(&id, &base, gone.as_bytes()),
        None,
    )
    .unwrap()
    .unwrap();
    live.import(&m.update, Origin::Mirror).unwrap();
    assert_eq!(texts(&live), ["前。", "后。"]);
}

#[test]
fn an_empty_document_takes_the_file_and_refusals_say_why() {
    let id = DocId::parse("node:c2").unwrap();
    let mut live = ProseDoc::create(id.clone(), 7).unwrap();
    let base = live.frontiers();
    let text = "第一段。\n\n第二段。\n";
    let m = merge(
        &loro_copy(&live),
        &id,
        &base,
        &body::parse(text),
        merge_peer(&id, &base, text.as_bytes()),
        None,
    )
    .unwrap()
    .unwrap();
    live.import(&m.update, Origin::Mirror).unwrap();
    assert_eq!(texts(&live), ["第一段。", "第二段。"]);

    // Emptied.
    let base = live.frontiers();
    let r = merge(&loro_copy(&live), &id, &base, &body::parse(""), 3, None).unwrap();
    assert_eq!(r.unwrap_err(), Refusal::Emptied);
    // A base from another document's history.
    let (_, other) = doc("别的。");
    let r = merge(
        &loro_copy(&live),
        &id,
        &other.frontiers(),
        &body::parse("x"),
        3,
        None,
    )
    .unwrap();
    assert_eq!(r.unwrap_err(), Refusal::UnknownBase);
}
