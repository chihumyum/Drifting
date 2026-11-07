//! The known rich-text undo issues of Loro 1.17.1 (#1229, #1228, #1245),
//! replayed the way Drifting would use the `UndoManager`: one manager per
//! open prose document, Agent writes excluded by origin, IME text committed
//! once per confirmed word, and a merge interval instead of manual groups.

use loro::{CommitOptions, ExportMode, LoroDoc, LoroValue, UndoManager};

use crate::agent::{AGENT_PREFIX, agent_origin, write_in_place};
use crate::prose::ProseDoc;
use crate::schema::block;

#[derive(Clone, Debug)]
pub struct UndoCase {
    pub name: &'static str,
    pub issue: &'static str,
    /// Whether this is a pattern the new editor would use.
    pub our_usage: bool,
    pub expected: String,
    pub actual: String,
    pub undo_steps: usize,
}

impl UndoCase {
    pub fn wrong(&self) -> bool {
        self.expected != self.actual
    }
}

fn pair() -> (ProseDoc, ProseDoc) {
    let a = ProseDoc::create("node:undo-case", 1);
    let b = ProseDoc::create("node:undo-case", 2);
    (a, b)
}

fn sync(from: &LoroDoc, to: &LoroDoc) {
    let bytes = from.export(ExportMode::updates(&to.oplog_vv())).unwrap();
    to.import(&bytes).unwrap();
}

fn manager(doc: &LoroDoc, merge_ms: i64) -> UndoManager {
    let mut um = UndoManager::new(doc);
    um.set_merge_interval(merge_ms);
    um.add_exclude_origin_prefix(AGENT_PREFIX);
    um
}

fn undo_all(um: &mut UndoManager) -> usize {
    let mut n = 0;
    while um.can_undo() && n < 20 {
        um.undo().unwrap();
        n += 1;
    }
    n
}

fn heading_of(p: &ProseDoc) -> String {
    match p.newline_attrs(p.len() - 1).get(block::HEADING) {
        Some(LoroValue::I64(h)) => format!("H{h}"),
        _ => "body".into(),
    }
}

fn marks(p: &ProseDoc) -> String {
    let paras = p.paragraphs();
    let mut out = Vec::new();
    for para in paras {
        for (t, a) in para.runs {
            let keys: Vec<String> = a
                .iter()
                .map(|(k, v)| match v {
                    LoroValue::String(s) => format!("{k}={}", s.as_str()),
                    _ => k.clone(),
                })
                .collect();
            out.push(format!("{t}[{}]", keys.join(",")));
        }
    }
    out.join(" ")
}

/// #1229: a heading changed by another device after the author set it.
fn heading_overwritten_by_remote() -> UndoCase {
    let (a, b) = pair();
    a.insert_text(0, "标题");
    a.doc.commit();
    sync(&a.doc, &b.doc);
    let mut um = manager(&a.doc, 0);
    let nl = a.len() - 1;
    a.set_block_attr(nl, block::HEADING, Some(1.into()));
    a.doc.commit();
    sync(&a.doc, &b.doc);
    b.set_block_attr(nl, block::HEADING, Some(2.into()));
    b.doc.commit();
    sync(&b.doc, &a.doc);
    let steps = undo_all(&mut um);
    UndoCase {
        name: "heading set by author, changed by another device, author undoes",
        issue: "#1229",
        our_usage: true,
        expected: "H2".into(),
        actual: heading_of(&a),
        undo_steps: steps,
    }
}

/// #1229 through an in-place Agent write.
fn heading_overwritten_by_agent() -> UndoCase {
    let (a, _) = pair();
    a.insert_text(0, "标题");
    a.doc.commit();
    let mut um = manager(&a.doc, 0);
    let nl = a.len() - 1;
    a.set_block_attr(nl, block::HEADING, Some(1.into()));
    a.doc.commit();
    write_in_place(&a, &agent_origin("s1", 1), |p| {
        p.set_block_attr(nl, block::HEADING, Some(2.into()))
    });
    let steps = undo_all(&mut um);
    UndoCase {
        name: "heading set by author, changed by an in-place Agent write, author undoes",
        issue: "#1229",
        our_usage: true,
        expected: "H2".into(),
        actual: heading_of(&a),
        undo_steps: steps,
    }
}

/// #1229 with different keys: author bolds, another device italicises the
/// same text, author undoes the bold.
fn bold_then_remote_italic() -> UndoCase {
    let (a, b) = pair();
    a.insert_text(0, "abc");
    a.doc.commit();
    sync(&a.doc, &b.doc);
    let mut um = manager(&a.doc, 0);
    a.mark_inline(0..3, "bold", true);
    a.doc.commit();
    sync(&a.doc, &b.doc);
    b.mark_inline(0..3, "italic", true);
    b.doc.commit();
    sync(&b.doc, &a.doc);
    let steps = undo_all(&mut um);
    UndoCase {
        name: "author bolds, another device italicises the same text, author undoes",
        issue: "#1229",
        our_usage: true,
        expected: "abc[italic]".into(),
        actual: marks(&a),
        undo_steps: steps,
    }
}

/// #1229 same key: author links, another device relinks, author undoes.
fn link_then_remote_link() -> UndoCase {
    let (a, b) = pair();
    a.insert_text(0, "abc");
    a.doc.commit();
    sync(&a.doc, &b.doc);
    let mut um = manager(&a.doc, 0);
    a.mark_inline(0..3, "link", "https://a.example");
    a.doc.commit();
    sync(&a.doc, &b.doc);
    b.mark_inline(0..3, "link", "https://b.example");
    b.doc.commit();
    sync(&b.doc, &a.doc);
    let steps = undo_all(&mut um);
    UndoCase {
        name: "author sets a link, another device changes it, author undoes",
        issue: "#1229",
        our_usage: true,
        expected: "abc[link=https://b.example]".into(),
        actual: marks(&a),
        undo_steps: steps,
    }
}

enum Between {
    RemoteBody,
    RemoteEmbeds,
    AgentBody,
    AgentEmbeds,
}

/// #1245 shape: two Backspaces merged by the merge interval, with another
/// change between them.
fn two_backspaces(between: Between) -> UndoCase {
    let (a, b) = pair();
    a.insert_text(0, "abcdef");
    a.doc.commit();
    sync(&a.doc, &b.doc);
    let mut um = manager(&a.doc, 60_000);
    a.delete(5..6);
    a.doc.commit();
    let (name, expected) = match between {
        Between::RemoteBody => {
            sync(&a.doc, &b.doc);
            b.insert_text(0, "k");
            b.doc.commit();
            sync(&b.doc, &a.doc);
            (
                "two Backspaces, another device types at the start in between",
                "kabcdef",
            )
        }
        Between::RemoteEmbeds => {
            sync(&a.doc, &b.doc);
            b.embeds().insert("k", 1).unwrap();
            b.doc.commit();
            sync(&b.doc, &a.doc);
            (
                "two Backspaces, another device changes the embeds map in between",
                "abcdef",
            )
        }
        Between::AgentBody => {
            write_in_place(&a, &agent_origin("s1", 1), |p| p.insert_text(0, "k"));
            (
                "two Backspaces, an in-place Agent write at the start in between",
                "kabcdef",
            )
        }
        Between::AgentEmbeds => {
            write_in_place(&a, &agent_origin("s1", 1), |p| {
                p.embeds().insert("k", 1).unwrap();
            });
            (
                "two Backspaces, an in-place Agent write to the embeds map in between",
                "abcdef",
            )
        }
    };
    a.delete(4..5);
    a.doc.commit();
    let steps = undo_all(&mut um);
    let actual = a.text().to_string().trim_end_matches('\n').to_string();
    UndoCase {
        name,
        issue: "#1245",
        our_usage: true,
        expected: expected.into(),
        actual,
        undo_steps: steps,
    }
}

/// #1245 exactly as reported: a manual group around two Backspaces.
fn grouped_backspaces() -> UndoCase {
    let (a, b) = pair();
    a.insert_text(0, "abcdef");
    a.doc.commit();
    sync(&a.doc, &b.doc);
    let mut um = manager(&a.doc, 0);
    um.group_start().unwrap();
    a.delete(5..6);
    a.doc.commit();
    sync(&a.doc, &b.doc);
    b.doc.get_map("meta").insert("k", 1).unwrap();
    b.doc.commit();
    sync(&b.doc, &a.doc);
    a.delete(4..5);
    a.doc.commit();
    um.group_end();
    let steps = undo_all(&mut um);
    UndoCase {
        name: "manual undo group around two Backspaces, remote map change in between",
        issue: "#1245",
        our_usage: false,
        expected: "abcdef".into(),
        actual: a.text().to_string().trim_end_matches('\n').to_string(),
        undo_steps: steps,
    }
}

/// #1228: intermediate text inside an undo span reaches another device,
/// which commits something that depends on it.
fn intermediate_text(grouped: bool) -> UndoCase {
    let (a, b) = pair();
    let mut um = manager(&a.doc, if grouped { 0 } else { 60_000 });
    if grouped {
        um.group_start().unwrap();
    }
    a.insert_text(0, "x");
    a.doc.commit();
    sync(&a.doc, &b.doc);
    b.doc.get_map("meta").insert("flag", true).unwrap();
    b.doc.commit();
    a.delete(0..1);
    a.insert_text(0, "y");
    a.doc.commit();
    if grouped {
        um.group_end();
    }
    sync(&b.doc, &a.doc);
    let steps = undo_all(&mut um);
    UndoCase {
        name: if grouped {
            "manual group: type x, it syncs, retype as y, remote dependent change, undo"
        } else {
            "merge interval: type x, it syncs, retype as y, remote dependent change, undo"
        },
        issue: "#1228",
        our_usage: !grouped,
        expected: "".into(),
        actual: a.text().to_string().trim_end_matches('\n').to_string(),
        undo_steps: steps,
    }
}

/// #1228 with Loro's merge interval at 0 and the editor grouping a burst
/// of items itself (one Cmd-Z pops every item of the burst).
fn intermediate_text_burst() -> UndoCase {
    let (a, b) = pair();
    let mut um = manager(&a.doc, 0);
    a.insert_text(0, "x");
    a.doc.commit();
    sync(&a.doc, &b.doc);
    b.doc.get_map("meta").insert("flag", true).unwrap();
    b.doc.commit();
    a.delete(0..1);
    a.insert_text(0, "y");
    a.doc.commit();
    sync(&b.doc, &a.doc);
    let steps = undo_all(&mut um);
    UndoCase {
        name: "merge interval 0 + editor-side burst: type x, it syncs, retype as y, remote dependent change, undo burst",
        issue: "#1228",
        our_usage: true,
        expected: "".into(),
        actual: a.text().to_string().trim_end_matches('\n').to_string(),
        undo_steps: steps,
    }
}

/// #1228 through a forked Agent write: the fork sees the author's
/// intermediate text, the author keeps typing inside the merge interval,
/// then the fork is imported.
fn intermediate_text_forked_agent(merge_ms: i64) -> UndoCase {
    let (a, _) = pair();
    let mut um = manager(&a.doc, merge_ms);
    a.insert_text(0, "x");
    a.doc.commit();
    let fork = a.doc.fork();
    fork.set_peer_id(99).unwrap();
    fork.get_map("meta").insert("agent", true).unwrap();
    fork.commit();
    a.delete(0..1);
    a.insert_text(0, "y");
    a.doc.commit();
    let bytes = fork.export(ExportMode::updates(&a.doc.oplog_vv())).unwrap();
    a.doc.import_with(&bytes, &agent_origin("s1", 1)).unwrap();
    let steps = undo_all(&mut um);
    UndoCase {
        name: if merge_ms > 0 {
            "forked Agent write imported after the author retyped inside the merge interval"
        } else {
            "forked Agent write imported after the author retyped, merge interval 0 + burst"
        },
        issue: "#1228",
        our_usage: true,
        expected: "".into(),
        actual: a.text().to_string().trim_end_matches('\n').to_string(),
        undo_steps: steps,
    }
}

/// #1245 shape with merge interval 0 and an editor-side burst.
fn two_backspaces_burst() -> UndoCase {
    let (a, b) = pair();
    a.insert_text(0, "abcdef");
    a.doc.commit();
    sync(&a.doc, &b.doc);
    let mut um = manager(&a.doc, 0);
    a.delete(5..6);
    a.doc.commit();
    sync(&a.doc, &b.doc);
    b.embeds().insert("k", 1).unwrap();
    b.doc.commit();
    sync(&b.doc, &a.doc);
    a.delete(4..5);
    a.doc.commit();
    let steps = undo_all(&mut um);
    UndoCase {
        name: "merge interval 0 + editor-side burst: two Backspaces, remote embeds change in between",
        issue: "#1245",
        our_usage: true,
        expected: "abcdef".into(),
        actual: a.text().to_string().trim_end_matches('\n').to_string(),
        undo_steps: steps,
    }
}

/// Author typing interleaved with in-place Agent writes: the author's Undo
/// must remove only the author's text.
fn author_undo_keeps_agent_text(forked: bool) -> UndoCase {
    let (a, _) = pair();
    a.insert_text(0, "甲乙丙");
    a.doc.commit();
    let mut um = manager(&a.doc, 0);
    let end = a.len() - 1;
    a.insert_text(end, "作者");
    a.doc.commit();
    let origin = agent_origin("s1", 1);
    if forked {
        crate::agent::write_forked(&a, &origin, 99, |p| p.insert_text(0, "【Agent】"));
    } else {
        write_in_place(&a, &origin, |p| p.insert_text(0, "【Agent】"));
    }
    let end = a.len() - 1;
    a.insert_text(end, "再写");
    a.doc.commit_with(CommitOptions::new());
    let steps = undo_all(&mut um);
    UndoCase {
        name: if forked {
            "author types, forked Agent write, author types, author undoes everything"
        } else {
            "author types, in-place Agent write, author types, author undoes everything"
        },
        issue: "—",
        our_usage: true,
        expected: "【Agent】甲乙丙".into(),
        actual: a.text().to_string().trim_end_matches('\n').to_string(),
        undo_steps: steps,
    }
}

pub fn run_all() -> Vec<UndoCase> {
    vec![
        heading_overwritten_by_remote(),
        heading_overwritten_by_agent(),
        bold_then_remote_italic(),
        link_then_remote_link(),
        two_backspaces(Between::RemoteBody),
        two_backspaces(Between::RemoteEmbeds),
        two_backspaces(Between::AgentBody),
        two_backspaces(Between::AgentEmbeds),
        grouped_backspaces(),
        intermediate_text(true),
        intermediate_text(false),
        intermediate_text_burst(),
        intermediate_text_forked_agent(60_000),
        intermediate_text_forked_agent(0),
        two_backspaces_burst(),
        author_undo_keeps_agent_text(false),
        author_undo_keeps_agent_text(true),
    ]
}
