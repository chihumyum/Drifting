//! Prose bodies: the old editor JSON in, schema v2 prose documents out.
//!
//! - [`pm`]: the old JSON as lines (P0-E's parser);
//! - [`plan`]: lines → the paragraphs the document must hold;
//! - [`write`]: make a dr-doc prose document equal to a plan;
//! - [`read`]: the paragraphs back out of a document;
//! - [`export`]: paragraphs → old JSON, for the round trip.

pub mod export;
pub mod plan;
pub mod pm;
pub mod read;
pub mod write;

pub use plan::{BlockSpan, Context, DocBlocks, LineAt, Notes, Para, Plan, doc_blocks, plan};

use dr_model::ProseProfile;

/// The round trip: the paragraphs, exported to the old JSON and imported
/// again (no outside remapping), are the same paragraphs.
pub fn round_trips(paras: &[Para], profile: ProseProfile) -> bool {
    let json = export::export(paras);
    let Ok(lines) = pm::parse_value(&json) else {
        return false;
    };
    let blocks = doc_blocks(&lines);
    let ctx = Context {
        profile,
        span: &|_| None,
        todo: &|_| None,
    };
    plan(&lines, &blocks, &ctx).paras == paras
}

#[cfg(test)]
mod tests {
    use super::*;
    use dr_doc::peer::import_peer;
    use dr_doc::prose::ProseDoc;
    use dr_model::{DocId, Origin};

    fn planned(json: &str, profile: ProseProfile) -> Plan {
        let lines = pm::parse(json).unwrap();
        let blocks = doc_blocks(&lines);
        plan(
            &lines,
            &blocks,
            &Context {
                profile,
                span: &|_| None,
                todo: &|_| None,
            },
        )
    }

    fn write_versions(doc_id: &str, versions: &[&Plan]) -> (ProseDoc, Vec<loro::Frontiers>) {
        let id = DocId::parse(doc_id).unwrap();
        let mut doc = ProseDoc::create(id.clone(), import_peer(doc_id)).unwrap();
        let mut frontiers = Vec::new();
        for (n, p) in versions.iter().enumerate() {
            let (r, _) = doc.edit_at(Origin::Import, Some(1_000 + n as i64), |t| {
                write::sync(t, &p.paras)
            });
            r.unwrap();
            assert_eq!(read::read_paras(&doc.view()), p.paras, "version {n}");
            frontiers.push(doc.frontiers());
        }
        (doc, frontiers)
    }

    const CHAPTER: &str = r#"{"type":"doc","content":[
      {"type":"heading","attrs":{"id":"h1","level":1},"content":[{"type":"text","text":"第一章"}]},
      {"type":"paragraph","attrs":{"id":"p1","textAlign":"right","indent":1},"content":[
        {"type":"text","text":"我要给"},
        {"type":"text","text":"阿Q","marks":[{"type":"bold"},{"type":"entityLink","attrs":{"targetKind":"element","targetId":"e1"}}]},
        {"type":"text","text":"Q做正传","marks":[{"type":"entityLink","attrs":{"targetKind":"element","targetId":"e2","targetBlockId":"x1","targetEndBlockId":"x2"}}]},
        {"type":"hardBreak"},{"type":"text","text":"😀第二行","marks":[{"type":"italic"},{"type":"underline"},{"type":"strike"},{"type":"link","attrs":{"href":"https://example.com","target":"_blank"}}]}]},
      {"type":"blockquote","attrs":{"id":"q1","indent":2},"content":[
        {"type":"paragraph","attrs":{"id":"p2"},"content":[{"type":"text","text":"信的第一段"}]},
        {"type":"paragraph","attrs":{"id":"p3"}}]},
      {"type":"horizontalRule","attrs":{"id":"hr"}},
      {"type":"paragraph","attrs":{"id":"p4"},"content":[]}
    ]}"#;

    const NOTE: &str = r##"{"type":"doc","content":[
      {"type":"taskList","attrs":{"id":"t"},"content":[
        {"type":"taskItem","attrs":{"id":"ti1","checked":true},"content":[{"type":"paragraph","attrs":{"id":"tp1"},"content":[{"type":"text","text":"核对","marks":[{"type":"highlight","attrs":{"color":"#ff0"}}]}]}]},
        {"type":"taskItem","attrs":{"id":"ti2","checked":false,"todoId":"todo-x"},"content":[{"type":"paragraph","attrs":{"id":"tp2"},"content":[{"type":"text","text":"补"}]},
          {"type":"orderedList","content":[{"type":"listItem","content":[{"type":"paragraph","attrs":{"id":"n1"},"content":[{"type":"text","text":"深","marks":[{"type":"code"}]}]}]}]}]}]},
      {"type":"table","attrs":{"id":"tb"},"content":[
        {"type":"tableRow","content":[{"type":"tableCell","content":[{"type":"paragraph","content":[{"type":"text","text":"人物"}]}]},{"type":"tableCell","content":[{"type":"paragraph","content":[]}]}]},
        {"type":"tableRow","content":[{"type":"tableCell","content":[{"type":"paragraph","content":[{"type":"text","text":"赵太爷"}]},{"type":"paragraph","content":[{"type":"text","text":"举人"}]}]},{"type":"tableCell","content":[{"type":"paragraph","content":[{"type":"text","text":"六十"}]}]}]}]},
      {"type":"callout","content":[{"type":"paragraph","attrs":{"id":"co"},"content":[{"type":"text","text":"注意"}]}]},
      {"type":"codeBlock","attrs":{"id":"cb","language":"rust"},"content":[{"type":"text","text":"fn a() {}\n\nlet b;"}]},
      {"type":"materialEmbed","attrs":{"id":"me","libraryItemId":"lib-1"}}
    ]}"##;

    #[test]
    fn a_chapter_is_stored_exactly_and_round_trips() {
        let p = planned(CHAPTER, ProseProfile::Prose);
        let (doc, _) = write_versions("node:n1", &[&p]);
        let back = read::read_paras(&doc.view());
        let again = {
            let json = export::export(&back);
            let lines = pm::parse_value(&json).unwrap();
            let blocks = doc_blocks(&lines);
            plan(
                &lines,
                &blocks,
                &Context {
                    profile: ProseProfile::Prose,
                    span: &|_| None,
                    todo: &|_| None,
                },
            )
            .paras
        };
        assert_eq!(again.len(), back.len(), "{}", export::export(&back));
        for (a, b) in again.iter().zip(&back) {
            assert_eq!(a, b);
        }
        assert!(round_trips(&back, ProseProfile::Prose));
        assert_eq!(doc.view().plain_text(), p.body_text());
        // Overlapping links to two targets survive.
        let links = doc.view().entity_links();
        assert_eq!(links.len(), 2);
        assert_eq!(links[1].1.block.as_ref().unwrap().as_str(), "x1");
        // The rule and the quote indent.
        assert!(back[4].attrs.rule);
        assert_eq!(back[3].attrs.indent, 2);
    }

    #[test]
    fn a_note_is_stored_exactly_and_round_trips() {
        let p = planned(NOTE, ProseProfile::Note);
        let (doc, _) = write_versions("material:m1", &[&p]);
        let back = read::read_paras(&doc.view());
        assert!(round_trips(&back, ProseProfile::Note));
        assert!(back[0].runs[0].marks.highlight.as_deref() == Some("#ff0"));
        assert_eq!(back[1].attrs.todo.as_ref().unwrap().as_str(), "todo-x");
        assert_eq!(back[2].attrs.list, Some(dr_model::kind::ListKind::Ordered));
    }

    #[test]
    fn later_versions_are_small_diffs_and_every_version_checks_out() {
        let v1 = planned(CHAPTER, ProseProfile::Prose);
        let v2 = planned(
            &CHAPTER.replace("信的第一段", "信的第一段，又添了一句"),
            ProseProfile::Prose,
        );
        let v3 = planned(
            &CHAPTER
                .replace(r#"{"type":"horizontalRule","attrs":{"id":"hr"}},"#, "")
                .replace("第一章", "第一章 序"),
            ProseProfile::Prose,
        );
        let v4 = planned(
            r#"{"type":"doc","content":[{"type":"paragraph","attrs":{"id":"only"},"content":[{"type":"text","text":"全删了"}]}]}"#,
            ProseProfile::Prose,
        );
        let (doc, frontiers) = write_versions("node:n2", &[&v1, &v2, &v3, &v4, &v1]);
        let id = DocId::parse("node:n2").unwrap();
        let bytes = vec![doc.export_snapshot().unwrap()];
        for (f, want) in frontiers.iter().zip([&v1, &v2, &v3, &v4, &v1]) {
            let copy = dr_doc::prose::ProseReader::load_at(id.clone(), &bytes, f).unwrap();
            assert_eq!(read::read_paras(&copy.view()), want.paras);
        }
    }

    #[test]
    fn notes_embeds_survive_versions() {
        let v1 = planned(NOTE, ProseProfile::Note);
        let v2 = planned(&NOTE.replace("六十", "七十"), ProseProfile::Note);
        let v3 = planned(r#"{"type":"doc","content":[]}"#, ProseProfile::Note);
        write_versions("material:m2", &[&v1, &v2, &v3, &v2]);
    }
}
