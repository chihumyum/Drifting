use super::*;
use crate::prose::{EmbedKind, EmbedView, ProseDoc, ProseTxn};
use dr_model::Origin;
use dr_model::id::{AssetId, DocId, EmbedId};
use dr_model::pos::PosKey;
use dr_model::prose::{BlockAttrs, InlineStyle};

fn doc(id: &str, peer: u64) -> ProseDoc {
    ProseDoc::create(DocId::parse(id).unwrap(), peer).unwrap()
}
fn user<R>(d: &mut ProseDoc, f: impl FnOnce(&mut ProseTxn<'_>) -> Result<R>) -> R {
    d.edit(Origin::User, f).0.unwrap()
}
fn link(target: &str, module: Option<&str>) -> EntityLinkV3 {
    EntityLinkV3 {
        target: target.into(),
        kind: EntityKind::Entry,
        module: module.map(|m| ModuleId::parse(m).unwrap()),
        block: None,
        end_block: None,
        manual: false,
    }
}
fn other_entry() -> EntityLinkV3 {
    link("entry-b", None)
}
fn raw(extra: &str, module: &str) -> LoroValue {
    let prior = LoroValue::Map(
        vec![(
            "future".into(),
            LoroValue::Map(vec![("value".into(), extra.into())].into()),
        )]
        .into(),
    );
    encode_entity_link(&link("entry-a", Some(module)), Some(&prior)).unwrap()
}

#[test]
fn module_identity_survives_adjacent_runs_overlap_encoding_sync_and_reopen() {
    let mut a = doc("body:entry-source/prose", 1);
    let mut b = doc("body:entry-source/prose", 2);
    let mut first = link("entry-a", Some("one"));
    first.block = Some(BlockId::parse("3@71").unwrap());
    first.end_block = Some(BlockId::parse("9@71").unwrap());
    let second = link("entry-a", Some("two"));
    let other = other_entry();
    user(&mut a, |t| {
        t.insert_paragraphs(0, "甲乙😀丁\n戊己")?;
        t.link_entity_v3(0..2, &first)?;
        t.link_entity_v3(2..4, &second)?;
        t.link_entity_v3(5..7, &first)?;
        t.link_entity_v3(1..3, &other)?;
        t.set_style(1..2, &InlineStyle::Bold)
    });
    let expected = vec![
        (0..2, first.clone()),
        (1..3, other),
        (2..4, second),
        (5..7, first.clone()),
    ];
    assert_eq!(a.view().entity_links_v3(), expected);
    let encoded = encode_entity_link(&first, None).unwrap();
    let json = serde_json::to_vec(&encoded).unwrap();
    let decoded: LoroValue = serde_json::from_slice(&json).unwrap();
    assert_eq!(decode_entity_link("entry-a", &decoded), Some(first.clone()));
    assert_eq!(
        serde_json::from_value::<EntityLinkV3>(serde_json::to_value(&first).unwrap()).unwrap(),
        first
    );
    b.import(&a.export_updates_since(&b.version()).unwrap(), Origin::Sync)
        .unwrap();
    user(&mut a, |t| {
        t.link_entity_v3(0..2, &link("entry-a", Some("left")))
    });
    user(&mut b, |t| {
        t.link_entity_v3(5..7, &link("entry-a", Some("right")))
    });
    a.import(&b.export_updates_since(&a.version()).unwrap(), Origin::Sync)
        .unwrap();
    b.import(&a.export_updates_since(&b.version()).unwrap(), Origin::Sync)
        .unwrap();
    assert_eq!(a.view().entity_links_v3(), b.view().entity_links_v3());
    assert_eq!(
        a.view().entity_links_v3()[0]
            .1
            .module
            .as_ref()
            .unwrap()
            .as_str(),
        "left"
    );
    assert_eq!(
        a.view()
            .entity_links_v3()
            .last()
            .unwrap()
            .1
            .module
            .as_ref()
            .unwrap()
            .as_str(),
        "right"
    );
    let reopened = ProseDoc::load(a.doc_id().clone(), 3, &[a.export_snapshot().unwrap()]).unwrap();
    assert_eq!(
        reopened.view().entity_links_v3(),
        a.view().entity_links_v3()
    );
    assert!(
        a.inner
            .text
            .to_delta()
            .iter()
            .filter_map(|d| match d {
                TextDelta::Insert {
                    attributes: Some(attrs),
                    ..
                } => Some(attrs.keys()),
                _ => None,
            })
            .flatten()
            .filter(|k| k.starts_with("entity:"))
            .all(|k| k == "entity:entry-a" || k == "entity:entry-b")
    );
}

/// `kernel-v5.md` §16: a link picked with @ carries `manual` in its value
/// through sync, a copy and a paste, a snapshot and a reopen, and the
/// automatic rule's bare-entry test sees it as not bare (a version that does
/// not know the key keeps it with the value and leaves the link alone).
#[test]
fn a_manual_link_keeps_its_mark_through_sync_copy_paste_snapshot_and_older_writers() {
    let mut a = doc("body:entry-source/prose", 1);
    let mut b = doc("body:entry-source/prose", 2);
    let picked = EntityLinkV3 {
        manual: true,
        ..link("entry-a", None)
    };
    user(&mut a, |t| {
        t.insert_paragraphs(0, "甲乙丙丁")?;
        t.link_entity_v3(0..2, &picked)?;
        t.link_entity_v3(2..4, &link("entry-a", None))
    });
    assert_eq!(
        a.view().entity_links_v3(),
        vec![(0..2, picked.clone()), (2..4, link("entry-a", None))]
    );
    // The stored value: `manual: true`, not a bare `{kind: "entry"}`.
    let copied = a.view().copy_entity_links_v3(0..4).unwrap();
    let values: Vec<&LoroValue> = copied.marks().iter().map(|(_, _, v)| v).collect();
    let bare = |v: &LoroValue| matches!(v, LoroValue::Map(m) if m.len() == 1);
    assert!(!bare(values[0]) && bare(values[1]), "{values:?}");
    // Sync, snapshot and reopen.
    b.import(&a.export_updates_since(&b.version()).unwrap(), Origin::Sync)
        .unwrap();
    assert_eq!(b.view().entity_links_v3(), a.view().entity_links_v3());
    let reopened = ProseDoc::load(a.doc_id().clone(), 3, &[a.export_snapshot().unwrap()]).unwrap();
    assert_eq!(
        reopened.view().entity_links_v3(),
        a.view().entity_links_v3()
    );
    // Copy and paste the raw marks elsewhere.
    let mut c = doc("body:entry-other/prose", 4);
    user(&mut c, |t| {
        t.insert_text(0, "甲乙丙丁")?;
        t.apply_entity_links_v3(0, &copied)
    });
    assert_eq!(c.view().entity_links_v3(), a.view().entity_links_v3());
    // Writing the link over again keeps what the value says it is; an
    // automatic one written over a picked one is automatic.
    let previous = values[0].clone();
    let again = encode_entity_link(&picked, Some(&previous)).unwrap();
    assert_eq!(again, previous);
    let older = link("entry-a", None);
    let auto = encode_entity_link(&older, Some(&previous)).unwrap();
    assert_eq!(decode_entity_link("entry-a", &auto), Some(older));
    // The legacy reader of runs (the index's) says so too.
    let runs: Vec<bool> = a
        .view()
        .paragraphs()
        .flat_map(|p| p.runs)
        .flat_map(|r| r.marks.entities)
        .map(|l| l.manual)
        .collect();
    assert_eq!(runs, vec![true, false]);
}

/// What a link edit records and what its undo puts back (`prose.link`,
/// `prose.unlink` and `prose.restore_links`, `kernel-v5.md` §16): the stored
/// value of one target's link on every run of a range, raw, newlines
/// included, and each run written back exactly as it was.
#[test]
fn link_values_read_run_by_run_and_go_back_as_they_were() {
    let mut a = doc("body:entry-source/prose", 1);
    let auto = link("entry-a", None);
    let picked = EntityLinkV3 {
        manual: true,
        ..link("entry-a", None)
    };
    user(&mut a, |t| {
        t.insert_paragraphs(0, "甲乙丙丁\n戊己")?;
        t.link_entity_v3(0..2, &auto)?;
        t.link_entity_v3(2..3, &picked)?;
        t.link_entity_v3(0..7, &other_entry())?;
        // Another mark splitting a run does not split its value.
        t.set_style(1..2, &InlineStyle::Bold)
    });
    // Data a newer version wrote, across a newline.
    a.inner
        .text
        .mark(3..6, "entity:entry-a", raw("tail", "one"))
        .unwrap();
    a.inner.core.doc.commit();
    let before = a.inner.text.to_delta();
    let values = a.view().entity_link_values(0..7, "entry-a").unwrap();
    assert_eq!(
        values,
        vec![
            (0..2, Some(encode_entity_link(&auto, None).unwrap())),
            (2..3, Some(encode_entity_link(&picked, None).unwrap())),
            (3..6, Some(raw("tail", "one"))),
            (6..7, None),
        ]
    );
    assert_eq!(
        a.view().entity_link_values(1..7, "entry-c").unwrap(),
        vec![(1..7, None)]
    );
    assert!(
        a.view()
            .entity_link_values(2..2, "entry-a")
            .unwrap()
            .is_empty()
    );
    assert!(a.view().entity_link_values(0..100, "entry-a").is_err());

    // Taken off, then put back run by run: as it was, other links and
    // styles untouched.
    user(&mut a, |t| t.unlink_entity(0..7, "entry-a"));
    assert_ne!(a.inner.text.to_delta(), before);
    user(&mut a, |t| {
        for (range, value) in &values {
            t.put_entity_link_value(range.clone(), "entry-a", value.as_ref())?;
        }
        Ok(())
    });
    assert_eq!(a.inner.text.to_delta(), before);
    // A run put back over another value replaces it whole.
    user(&mut a, |t| {
        t.put_entity_link_value(0..3, "entry-a", values[0].1.as_ref())
    });
    assert_eq!(
        a.view().entity_link_values(0..3, "entry-a").unwrap(),
        vec![(0..3, values[0].1.clone())]
    );

    // Refused before anything is written: not a link's map, no target, a
    // range past the end.
    let version = a.version();
    for (range, target, value) in [
        (0..2, "entry-a", Some(LoroValue::from("future-encoding"))),
        (0..2, "", None),
        (0..100, "entry-a", None),
    ] {
        assert!(
            a.edit(Origin::User, |t| t.put_entity_link_value(
                range,
                target,
                value.as_ref()
            ))
            .0
            .is_err()
        );
    }
    assert_eq!(a.version(), version);
}

#[test]
fn updating_a_link_preserves_segment_metadata_and_rejects_all_invalid_input_before_writing() {
    let mut a = doc("body:entry-source/prose", 1);
    user(&mut a, |t| t.insert_text(0, "甲乙丙丁"));
    a.inner
        .text
        .mark(0..2, "entity:entry-a", raw("left", "one"))
        .unwrap();
    a.inner
        .text
        .mark(2..4, "entity:entry-a", raw("right", "two"))
        .unwrap();
    a.inner.core.doc.commit();
    user(&mut a, |t| {
        t.link_entity_v3(0..4, &link("entry-a", Some("three")))
    });
    let marks = a.view().copy_entity_links_v3(0..4).unwrap();
    assert_eq!(marks.marks()[0].2, raw("left", "three"));
    assert_eq!(marks.marks()[1].2, raw("right", "three"));
    assert_eq!(
        a.view().entity_links_v3(),
        vec![(0..4, link("entry-a", Some("three")))]
    );
    a.inner
        .text
        .mark(2..4, "entity:entry-a", "future-encoding")
        .unwrap();
    a.inner.core.doc.commit();
    let before = a.inner.core.doc.get_deep_value();
    let version = a.version();
    let rejected = a.edit(Origin::User, |t| {
        t.link_entity_v3(0..4, &link("entry-a", Some("four")))
    });
    assert!(rejected.0.is_err());
    assert!(rejected.1.is_none());
    for bad in [
        EntityLinkV3 {
            kind: EntityKind::Element,
            ..link("entry-a", None)
        },
        EntityLinkV3 {
            kind: EntityKind::Material,
            ..link("material-a", None)
        },
        EntityLinkV3 {
            kind: EntityKind::Material,
            ..link("material-a", Some("module"))
        },
        link("", None),
    ] {
        assert!(
            a.edit(Origin::User, |t| t.link_entity_v3(0..2, &bad))
                .0
                .is_err()
        );
        assert!(encode_entity_link(&bad, None).is_err());
    }
    assert!(
        a.edit(Origin::User, |t| t.link_entity_v3(0..100, &other_entry()))
            .0
            .is_err()
    );
    assert_eq!(a.version(), version);
    assert_eq!(a.inner.core.doc.get_deep_value(), before);
    for value in [
        LoroValue::Map(vec![("kind".into(), "future-kind".into())].into()),
        LoroValue::Map(vec![("kind".into(), "entry".into()), ("module".into(), 7.into())].into()),
        LoroValue::Map(
            vec![
                ("kind".into(), "material".into()),
                ("module".into(), "no".into()),
            ]
            .into(),
        ),
    ] {
        assert!(decode_entity_link("entry-a", &value).is_none());
    }
}

#[test]
fn clipboard_marks_keep_opaque_values_and_only_replace_the_copied_range() {
    let mut source = doc("body:source/prose", 1);
    user(&mut source, |t| {
        t.insert_paragraphs(0, "甲😀乙\n丙丁")?;
        t.link_entity_v3(1..6, &link("entry-a", Some("body-two")))
    });
    source
        .inner
        .text
        .mark(
            2..3,
            "entity:future",
            LoroValue::Map(
                vec![
                    ("kind".into(), "future-kind".into()),
                    ("bytes".into(), LoroValue::Binary(vec![0, 255, 1].into())),
                ]
                .into(),
            ),
        )
        .unwrap();
    source.inner.core.doc.commit();
    let clip = source.view().copy_entity_links_v3(1..6).unwrap();
    let rebuilt = EntityLinkMarksV3::from_marks(clip.len(), clip.marks().to_vec()).unwrap();
    assert_eq!(clip, rebuilt);
    let mut target = doc("body:target/prose", 2);
    user(&mut target, |t| {
        t.insert_paragraphs(0, "前😀乙\n丙丁后")?;
        t.link_entity_v3(0..8, &link("previous", None))?;
        t.set_style(0..8, &InlineStyle::Bold)?;
        t.apply_entity_links_v3(1, &rebuilt)
    });
    assert_eq!(target.view().copy_entity_links_v3(1..6).unwrap(), clip);
    assert_eq!(
        target.view().entity_links_v3(),
        vec![
            (0..1, link("previous", None)),
            (1..3, link("entry-a", Some("body-two"))),
            (4..6, link("entry-a", Some("body-two"))),
            (6..7, link("previous", None)),
        ]
    );
    assert!(
        target
            .view()
            .paragraphs()
            .flat_map(|p| p.runs)
            .all(|r| r.marks.bold)
    );
    let before = target.inner.core.doc.get_deep_value();
    assert!(
        target
            .edit(Origin::User, |t| t.apply_entity_links_v3(usize::MAX, &clip))
            .0
            .is_err()
    );
    assert!(
        EntityLinkMarksV3::from_marks(1, vec![(0..2, "entity:x".into(), true.into())]).is_err()
    );
    assert!(EntityLinkMarksV3::from_marks(1, vec![(0..1, "bold".into(), true.into())]).is_err());
    assert_eq!(target.inner.core.doc.get_deep_value(), before);
    let reopened = ProseDoc::load(
        target.doc_id().clone(),
        3,
        &[target.export_snapshot().unwrap()],
    )
    .unwrap();
    assert_eq!(reopened.view().copy_entity_links_v3(1..6).unwrap(), clip);
}

#[test]
fn v3_template_copy_preserves_body_and_table_modules_assets_and_unknown_fields() {
    let mut source = doc("template:book-a/tpl/prose", 1);
    let table = EmbedId::parse("table").unwrap();
    let file_embed = EmbedId::parse("file-embed").unwrap();
    let asset_id = AssetId::parse("asset-1").unwrap();
    user(&mut source, |t| {
        t.insert_text(0, "甲乙丙丁")?;
        t.link_entity_v3(0..2, &link("entry-a", Some("one")))?;
        t.link_entity_v3(2..4, &other_entry())?;
        let at = t.split(4)?;
        let w = t.insert_embed(at, &table, &EmbedKind::Table)?;
        w.add_col("col", &PosKey::first())?;
        w.add_row("row", &PosKey::first())?;
        w.set_cell("row", "col", "甲😀乙丙")?;
        let cell = w.cell("row", "col")?;
        cell.mark(0..2, "entity:entry-a", raw("table-extra", "two"))?;
        t.link_table_cell_entity_v3(&table, "row", "col", 2..4, &other_entry())?;
        let end = t.view().len() - 1;
        t.insert_embed(end, &file_embed, &EmbedKind::Asset(asset_id.clone()))?;
        Ok(())
    });
    source
        .inner
        .text
        .mark(0..2, "entity:entry-a", raw("body-extra", "one"))
        .unwrap();
    let embed_at = source.view().embed_refs()[0].0;
    user(&mut source, |t| {
        t.link_entity_v3(embed_at..embed_at + 1, &link("entry-a", Some("embed-link")))
    });
    source.inner.core.doc.commit();
    let mut target = doc("body:target/prose", 2);
    user(&mut target, |t| t.insert_copy_v3(0, &source.view()));
    assert_eq!(target.view().plain_text(), source.view().plain_text());
    assert_eq!(
        target.view().entity_links_v3(),
        source.view().entity_links_v3()
    );
    assert_eq!(
        target.view().copy_entity_links_v3(0..4).unwrap(),
        source.view().copy_entity_links_v3(0..4).unwrap()
    );
    let copied = target.view().embed_refs()[0].1.clone();
    assert_ne!(copied, table);
    let copied_asset_embed = target.view().embed_refs()[1].1.clone();
    assert_ne!(copied_asset_embed, file_embed);
    assert!(matches!(
        target.view().embed(&copied_asset_embed),
        Some(EmbedView::Asset {
            asset: Some(ref id),
            ..
        }) if id == &asset_id
    ));
    assert_eq!(
        target
            .view()
            .table_cell_entity_links_v3(&copied, "row", "col"),
        Some(vec![
            (0..2, link("entry-a", Some("two"))),
            (2..4, other_entry())
        ])
    );
    let cell_clip = source
        .view()
        .copy_table_cell_entity_links_v3(&table, "row", "col", 0..4)
        .unwrap();
    let copied_id = copied.clone();
    user(&mut target, |t| {
        t.apply_table_cell_entity_links_v3(&copied_id, "row", "col", 0, &cell_clip)
    });
    assert_eq!(
        target
            .view()
            .table_cell_text(&copied, "row", "col")
            .unwrap()
            .to_delta(),
        source
            .view()
            .table_cell_text(&table, "row", "col")
            .unwrap()
            .to_delta()
    );
    let src_ids: Vec<_> = source.view().paragraphs().map(|p| p.id).collect();
    assert!(target.view().paragraphs().all(|p| !src_ids.contains(&p.id)));
    let reopened = ProseDoc::load(
        target.doc_id().clone(),
        3,
        &[target.export_snapshot().unwrap()],
    )
    .unwrap();
    assert_eq!(
        reopened.view().entity_links_v3(),
        source.view().entity_links_v3()
    );
    // List formats in a copied source now succeed in entry bodies under the unified profile.
    let mut note = doc("material:note", 4);
    user(&mut note, |t| {
        t.insert_paragraphs(0, "甲\n乙")?;
        t.set_block_attrs(
            2,
            &BlockAttrs {
                list: Some(dr_model::kind::ListKind::Bullet),
                ..Default::default()
            },
        )
    });
    let mut list_target = doc("body:list-target/prose", 5);
    user(&mut list_target, |t| t.insert_copy_v3(0, &note.view()));
    assert_eq!(
        list_target.view().paragraphs().nth(1).unwrap().attrs.list,
        Some(dr_model::kind::ListKind::Bullet)
    );
    let before = target.inner.core.doc.get_deep_value();
    source
        .inner
        .embeds
        .ensure_mergeable_map(table.as_str())
        .unwrap()
        .insert("kind", "future-table")
        .unwrap();
    source.inner.core.doc.commit();
    assert!(
        target
            .edit(Origin::User, |t| t.insert_copy_v3(0, &source.view()))
            .0
            .is_err()
    );
    assert_eq!(target.inner.core.doc.get_deep_value(), before);
}

#[test]
fn set_table_cell_runs_v3_and_remove_cell_preserve_rich_marks_links_and_preflight() {
    use crate::prose::Run;
    use dr_model::prose::{InlineMarks, LINE_BREAK};

    let mut d = doc("body:entry-source/prose", 10);
    let table = EmbedId::parse("tbl-1").unwrap();
    let p0 = PosKey::parse("a0").unwrap();
    let p1 = PosKey::parse("a1").unwrap();
    user(&mut d, |t| {
        let w = t.insert_embed(0, &table, &EmbedKind::Table)?;
        w.add_row("r0", &p0)?;
        w.add_col("c0", &p0)?;
        w.add_col("c1", &p1)
    });

    let mut entry_block = link("entry-a", Some("mod-prose"));
    entry_block.block = Some(BlockId::parse("b1").unwrap());
    entry_block.end_block = Some(BlockId::parse("b2").unwrap());
    let other = other_entry();
    let runs = vec![
        Run {
            text: "赵太爷".into(),
            marks: InlineMarks {
                bold: true,
                ..InlineMarks::default()
            },
        },
        Run {
            text: LINE_BREAK.to_string(),
            marks: InlineMarks::default(),
        },
        Run {
            text: "举人老爷".into(),
            marks: InlineMarks {
                italic: true,
                link: Some("https://example.com".into()),
                ..InlineMarks::default()
            },
        },
    ];
    let links = vec![(0..3, entry_block.clone()), (4..6, other.clone())];
    user(&mut d, |t| {
        t.set_table_cell_runs_v3(&table, "r0", "c0", &runs, &links)?;
        t.table(&table)?.set_cell("r0", "c1", "临时")
    });

    assert_eq!(
        d.view().table_cell_entity_links_v3(&table, "r0", "c0"),
        Some(links.clone())
    );
    let read_runs = d.view().table_cell(&table, "r0", "c0").unwrap();
    assert!(read_runs[0].marks.bold);
    assert_eq!(read_runs[0].marks.entities[0].target, "entry-a");
    assert!(read_runs[2].marks.italic);
    assert_eq!(
        read_runs[2].marks.link.as_deref(),
        Some("https://example.com")
    );
    assert_eq!(read_runs[2].marks.entities[0].kind, EntityKind::Entry);
    assert_eq!(read_runs[2].marks.entities[0].target, "entry-b");

    // Highlight and inline code are allowed in entry table cells under the unified profile.
    let rich_highlight_code = vec![Run {
        text: "高亮代码".into(),
        marks: InlineMarks {
            highlight: Some("#ff0".into()),
            code: true,
            ..InlineMarks::default()
        },
    }];
    user(&mut d, |t| {
        t.set_table_cell_runs_v3(&table, "r0", "c0", &rich_highlight_code, &[])
    });
    assert_eq!(
        d.view().table_cell(&table, "r0", "c0"),
        Some(rich_highlight_code)
    );

    // Preflight rejects bad link, out-of-bounds link range, newline, or missing cell before mutating.
    let snap_before = d.inner.core.doc.get_deep_value();
    let ver_before = d.version();
    let plain_one = vec![Run {
        text: "x".into(),
        marks: InlineMarks::default(),
    }];
    let bad_link = EntityLinkV3 {
        kind: EntityKind::Patch,
        ..link("patch-a", None)
    };
    assert!(
        d.edit(Origin::User, |t| {
            t.set_table_cell_runs_v3(&table, "r0", "c0", &plain_one, &[(0..1, bad_link)])
        })
        .0
        .is_err()
    );
    assert!(
        d.edit(Origin::User, |t| {
            t.set_table_cell_runs_v3(&table, "r0", "c0", &plain_one, &[(0..5, other.clone())])
        })
        .0
        .is_err()
    );
    let bad_nl = vec![Run {
        text: "a\nb".into(),
        marks: InlineMarks::default(),
    }];
    assert!(
        d.edit(Origin::User, |t| {
            t.set_table_cell_runs_v3(&table, "r0", "c0", &bad_nl, &[])
        })
        .0
        .is_err()
    );
    assert!(
        d.edit(Origin::User, |t| {
            t.set_table_cell_runs_v3(&table, "missing", "c0", &[], &[])
        })
        .0
        .is_err()
    );
    assert_eq!(d.version(), ver_before);
    assert_eq!(d.inner.core.doc.get_deep_value(), snap_before);

    // Updating to plain text clears stale marks/links, and remove_cell drops unset cells.
    let plain_runs = vec![Run {
        text: "素文".into(),
        marks: InlineMarks::default(),
    }];
    user(&mut d, |t| {
        t.set_table_cell_runs_v3(&table, "r0", "c0", &plain_runs, &[])?;
        t.table(&table)?.remove_cell("r0", "c1")
    });
    assert_eq!(
        d.view().table_cell_entity_links_v3(&table, "r0", "c0"),
        Some(vec![])
    );
    assert_eq!(d.view().table_cell(&table, "r0", "c0"), Some(plain_runs));
    assert_eq!(d.view().table_cell(&table, "r0", "c1"), None);
}
