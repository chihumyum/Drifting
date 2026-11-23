//! Where pasted paragraphs go. The expectations are what ProseMirror (the
//! editor of Drifting 0.1, prosemirror-transform 1.12) does with the same
//! slice, except where its one list item holding several paragraphs has
//! to be several items here.

use std::collections::HashSet;

use super::*;
use crate::{
    schema::inline,
    text::{BlockKind, ORIGIN_USER, ProseDoc},
};

type Attrs<'a> = &'a [(&'a str, LoroValue)];

fn doc(paragraphs: &[(&str, Attrs<'_>)]) -> ProseDoc {
    let mut d = ProseDoc::from_paragraphs(paragraphs.iter().map(|(t, _)| (BlockKind::Body, *t)));
    for (ix, (_, attrs)) in paragraphs.iter().enumerate() {
        for (key, value) in attrs.iter() {
            d.set_block_attr(ix, key, Some(value.clone()), ORIGIN_USER);
        }
    }
    d.checkpoint();
    d
}

fn para(text: &str, attrs: Attrs<'_>) -> FragmentParagraph {
    let mut a = BlockAttrs::default();
    for (key, value) in attrs {
        a.set(key, Some(value.clone()));
    }
    FragmentParagraph {
        text: text.into(),
        marks: Vec::new(),
        attrs: a,
    }
}

fn frag(paragraphs: Vec<FragmentParagraph>) -> Fragment {
    Fragment { paragraphs }
}

/// Every paragraph as `look|text`, its look as in `html::tests`.
fn state(d: &ProseDoc) -> Vec<String> {
    d.lines()[..d.visible_lines()]
        .iter()
        .map(|line| {
            let look = PASTED_KEYS
                .iter()
                .chain([&block::TODO])
                .filter_map(|key| {
                    Some(match line.block.get(key)? {
                        LoroValue::Bool(true) => key.to_string(),
                        LoroValue::I64(n) => format!("{key}={n}"),
                        LoroValue::String(s) => format!("{key}={}", s.as_str()),
                        other => format!("{key}={other:?}"),
                    })
                })
                .collect::<Vec<_>>()
                .join(" ");
            format!("{look}|{}", line.text)
        })
        .collect()
}

/// Pastes `f` over `range` as the editor does (one step); returns the caret.
fn paste(d: &mut ProseDoc, range: Range<usize>, f: &Fragment) -> usize {
    let plan = PastePlan::new(d, range.clone(), f);
    let clears: Vec<MarkOverride> = d
        .marks_before(range.start)
        .iter()
        .map(|(k, _)| (k.to_owned(), None))
        .collect();
    d.checkpoint();
    d.edit_batch(&plan.edits(&clears), ORIGIN_USER);
    d.checkpoint();
    assert_eq!(d.mirror_snapshot(), d.reread(), "mirror drifted");
    plan.caret()
}

fn h1() -> Vec<(&'static str, LoroValue)> {
    vec![(block::HEADING, LoroValue::I64(1))]
}

fn bullet() -> Vec<(&'static str, LoroValue)> {
    vec![(block::LIST, LoroValue::from("bullet"))]
}

fn rule() -> Vec<(&'static str, LoroValue)> {
    vec![(block::RULE, LoroValue::Bool(true))]
}

/// One case: the document, the caret (or selection), the pasted
/// paragraphs, and what ProseMirror leaves.
fn case(
    paragraphs: &[(&str, Attrs<'_>)],
    range: Range<usize>,
    pasted: Vec<FragmentParagraph>,
    want: &[&str],
) {
    let mut d = doc(paragraphs);
    let before = state(&d);
    let last = d.line_of(range.end);
    let tail: String = d
        .line(last)
        .text
        .chars()
        .skip(range.end - d.line_start(last))
        .collect();
    let f = frag(pasted);
    let caret = paste(&mut d, range.clone(), &f);
    assert_eq!(
        state(&d),
        want,
        "pasting {:?} at {range:?} of {before:?}",
        f.text()
    );
    // The caret is where the text after the range now starts.
    let (line, inner) = d.locate(caret);
    let after: String = d.line(line).text.chars().skip(inner).collect();
    assert_eq!(after, tail, "the caret after pasting {:?}", f.text());
    assert!(
        d.line(line).block.get(block::RULE).is_none(),
        "never on a rule"
    );
    // Fresh block ids, none twice.
    let ids: Vec<_> = d.lines()[..d.visible_lines()]
        .iter()
        .map(|l| l.bid().expect("a block id").to_owned())
        .collect();
    assert_eq!(ids.iter().collect::<HashSet<_>>().len(), ids.len());
    // One undo takes it all back.
    d.undo();
    assert_eq!(state(&d), before, "undo after pasting {:?}", f.text());
}

#[test]
fn one_paragraph() {
    // Into text it is text; into a whole paragraph it brings its look,
    // unless it is plain and the paragraph is more.
    case(&[("abcd", &[])], 2..2, vec![para("T", &h1())], &["|abTcd"]);
    case(&[("", &[])], 0..0, vec![para("T", &h1())], &["heading=1|T"]);
    case(&[("", &h1())], 0..0, vec![para("T", &[])], &["heading=1|T"]);
    case(
        &[("", &bullet())],
        0..0,
        vec![para("T", &[])],
        &["list=bullet|T"],
    );
    case(
        &[("abc", &[])],
        0..0,
        vec![para("T", &h1())],
        &["heading=1|Tabc"],
    );
    case(
        &[("xy", &[])],
        1..1,
        vec![para("one", &bullet())],
        &["|xoney"],
    );
    // Over all of a paragraph's text.
    case(
        &[("old", &[])],
        0..3,
        vec![para("T", &h1())],
        &["heading=1|T"],
    );
    let centred = [(block::ALIGN, LoroValue::from("center"))];
    case(
        &[("", &[])],
        0..0,
        vec![para("T", &centred)],
        &["align=center|T"],
    );
}

#[test]
fn several_paragraphs() {
    case(
        &[("abcdef", &[])],
        3..3,
        vec![para("T", &h1()), para("b", &[])],
        &["|abcT", "|bdef"],
    );
    case(
        &[("abcd", &h1())],
        2..2,
        vec![para("a", &[]), para("b", &[])],
        &["heading=1|aba", "|bcd"],
    );
    case(
        &[("", &[])],
        0..0,
        vec![para("one", &bullet()), para("two", &bullet())],
        &["list=bullet|one", "list=bullet|two"],
    );
    case(
        &[("xy", &[])],
        1..1,
        vec![
            para("intro", &[]),
            para("one", &bullet()),
            para("two", &bullet()),
        ],
        &["|xintro", "list=bullet|one", "list=bullet|twoy"],
    );
    case(
        &[("Title", &h1())],
        0..0,
        vec![para("a", &[]), para("b", &[])],
        &["heading=1|a", "|bTitle"],
    );
    case(
        &[("abc", &[])],
        3..3,
        vec![para("T", &h1()), para("b", &[])],
        &["|abcT", "|b"],
    );
    case(
        &[("xy", &[])],
        1..1,
        vec![para("a", &[]), para("T", &h1())],
        &["|xa", "heading=1|Ty"],
    );
    case(
        &[("", &h1())],
        0..0,
        vec![para("a", &[]), para("b", &[])],
        &["heading=1|a", "|b"],
    );
    case(
        &[("abc", &[])],
        0..0,
        vec![para("T", &h1()), para("b", &[])],
        &["heading=1|T", "|babc"],
    );
    case(
        &[("Title", &h1())],
        5..5,
        vec![para("a", &[]), para("b", &[])],
        &["heading=1|Titlea", "|b"],
    );
    case(
        &[("xy", &[])],
        1..1,
        vec![para("one", &bullet()), para("two", &bullet())],
        &["|xone", "list=bullet|twoy"],
    );
}

#[test]
fn over_a_selection() {
    case(
        &[("ab", &[]), ("cd", &[])],
        1..4,
        vec![para("X", &[]), para("Y", &h1())],
        &["|aX", "heading=1|Yd"],
    );
    case(
        &[("ab", &h1()), ("cd", &[])],
        1..4,
        vec![para("X", &[])],
        &["heading=1|aXd"],
    );
}

#[test]
fn inside_lists_and_quotes() {
    // Plain paragraphs stay in the list (ProseMirror keeps them in the one
    // item; here each is an item).
    case(
        &[("abcd", &bullet())],
        2..2,
        vec![para("a", &[]), para("b", &[])],
        &["list=bullet|aba", "list=bullet|bcd"],
    );
    case(
        &[("abcd", &bullet())],
        2..2,
        vec![para("a", &[]), para("T", &h1())],
        &["list=bullet|aba", "heading=1|Tcd"],
    );
    // Pasted items keep their depth under the item they land in.
    let deep = [
        (block::LIST, LoroValue::from("bullet")),
        (block::LIST_LEVEL, LoroValue::I64(1)),
    ];
    let one_deeper = [
        (block::LIST, LoroValue::from("ordered")),
        (block::LIST_LEVEL, LoroValue::I64(1)),
    ];
    case(
        &[("abcd", &deep)],
        2..2,
        vec![para("one", &bullet()), para("two", &one_deeper)],
        &[
            "list=bullet list_level=1|abone",
            "list=ordered list_level=2|twocd",
        ],
    );
    let quote = [(block::QUOTE, LoroValue::Bool(true))];
    case(
        &[("abcd", &quote)],
        2..2,
        vec![para("a", &[]), para("b", &[])],
        &["quote|aba", "quote|bcd"],
    );
    case(
        &[("abcd", &quote)],
        2..2,
        vec![para("T", &h1()), para("b", &[])],
        &["quote|abT", "quote|bcd"],
    );
    case(
        &[("abcd", &quote)],
        2..2,
        vec![para("a", &[]), para("one", &bullet())],
        &["quote|aba", "quote list=bullet|onecd"],
    );
}

#[test]
fn a_rule_never_takes_text() {
    case(
        &[("abcd", &[])],
        2..2,
        vec![para("", &rule())],
        &["|ab", "rule|", "|cd"],
    );
    case(
        &[("xy", &[])],
        1..1,
        vec![para("a", &[]), para("", &rule()), para("b", &[])],
        &["|xa", "rule|", "|by"],
    );
    case(&[("", &[])], 0..0, vec![para("", &rule())], &["rule|", "|"]);
    case(
        &[("ab", &[])],
        2..2,
        vec![para("", &rule())],
        &["|ab", "rule|", "|"],
    );
    // A rule's text, if a fragment had one, is not pasted.
    case(
        &[("", &[])],
        0..0,
        vec![para("x", &rule()), para("y", &[])],
        &["rule|", "|y"],
    );
}

#[test]
fn marks_are_pasted_and_the_caret_marks_are_not() {
    let mut d = doc(&[("1234", &[])]);
    d.mark(0..2, inline::BOLD, LoroValue::Bool(true), ORIGIN_USER);
    d.checkpoint();
    let mut p = para("xby", &[]);
    p.marks = vec![
        (1..2, inline::BOLD.to_owned(), LoroValue::Bool(true)),
        (
            0..3,
            inline::LINK.to_owned(),
            LoroValue::from("https://example.com"),
        ),
        // Out of range and paragraph keys are dropped.
        (2..9, inline::ITALIC.to_owned(), LoroValue::Bool(true)),
        (0..1, block::HEADING.to_owned(), LoroValue::I64(1)),
    ];
    let f = frag(vec![p]);
    let caret = paste(&mut d, 2..2, &f);
    assert_eq!(caret, 5);
    assert_eq!(state(&d), ["|12xby34"]);
    assert!(d.range_has_mark(0..2, inline::BOLD));
    assert!(
        !d.range_has_mark(2..3, inline::BOLD),
        "the caret's bold does not run on"
    );
    assert!(d.range_has_mark(3..4, inline::BOLD));
    assert!(!d.range_has_mark(4..5, inline::BOLD));
    assert!(d.range_has_mark(2..5, inline::LINK));
    assert!(d.range_has_mark(4..5, inline::ITALIC));
    assert!(!d.range_has_mark(5..7, inline::ITALIC));
}

#[test]
fn a_linked_task_keeps_its_todo_only_while_a_task() {
    let task = [
        (block::LIST, LoroValue::from("task")),
        (block::TODO, LoroValue::from("todo-1")),
    ];
    // Still an item of the task list: the TODO stays with its text.
    case(
        &[("abcd", &task)],
        2..2,
        vec![para("x", &[]), para("y", &[])],
        &["list=task|abx", "list=task todo=todo-1|ycd"],
    );
    // A heading now: no TODO.
    case(
        &[("abcd", &task)],
        2..2,
        vec![para("x", &[]), para("y", &h1())],
        &["list=task|abx", "heading=1|ycd"],
    );
}

#[test]
fn objects_and_line_ends_are_never_pasted() {
    let f = frag(vec![para("a\u{fffc}b\nc", &[])]);
    let mut d = doc(&[("", &[])]);
    paste(&mut d, 0..0, &f);
    assert_eq!(state(&d), ["|abc"]);
}

#[test]
fn an_empty_fragment_deletes_the_selection() {
    let f = Fragment::default();
    assert!(f.is_empty() && f.is_plain());
    let mut d = doc(&[("abcd", &[])]);
    assert_eq!(paste(&mut d, 1..3, &f), 1);
    assert_eq!(state(&d), ["|ad"]);
}
