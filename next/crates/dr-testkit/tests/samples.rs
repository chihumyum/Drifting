//! The sample books and the showcase library lay out completely.

use dr_testkit::samples;
use dr_testkit::seed::{self, Preset};

#[test]
fn the_two_sample_books_and_the_showcase_book_lay_out() {
    for (book, chapters, elements, name) in [
        (
            samples::pride_and_prejudice().unwrap(),
            61,
            31,
            "Pride and Prejudice (Sample)",
        ),
        (samples::a_q().unwrap(), 9, 29, "阿Q正传（示例）"),
        (samples::slow_clock().unwrap(), 24, 24, "慢钟"),
    ] {
        let v = book.book.view();
        assert_eq!(v.meta().name, name);
        assert_eq!(v.chapters().len(), chapters, "{name}");
        assert_eq!(v.elements().len(), elements, "{name}");
        assert!(v.repair_plan().is_empty(), "{name} needs no repair");
        assert!(v.element_name_conflicts().is_empty(), "{name}");
        assert!(!v.relations().is_empty(), "{name}");
        assert!(v.plot_grid(&v.chapters()[0].id).is_some() || !v.patches().is_empty());
        // Every quoted comment found its quotation in the chapter text.
        let quoted: Vec<_> = v
            .comments()
            .into_iter()
            .filter(|c| c.quote.is_some())
            .collect();
        assert!(!quoted.is_empty(), "{name}");
        assert!(quoted.iter().all(|c| c.anchor.is_some()), "{name}");
        // Chapter text links its people.
        let links: usize = book
            .prose
            .iter()
            .map(|p| p.view().entity_links().len())
            .sum();
        assert!(links > 0, "{name}");
    }
}

#[test]
fn pride_and_prejudice_keeps_its_italics_and_letters() {
    let book = samples::pride_and_prejudice().unwrap();
    let styled = book
        .prose
        .iter()
        .flat_map(|p| p.view().paragraphs().collect::<Vec<_>>())
        .filter(|p| p.runs.iter().any(|r| r.marks.italic))
        .count();
    assert!(styled > 100, "{styled} paragraphs with italics");
    let quoted = book
        .prose
        .iter()
        .flat_map(|p| p.view().paragraphs().collect::<Vec<_>>())
        .filter(|p| p.attrs.quote)
        .count();
    assert!(quoted > 0, "letters are block quotes");
}

#[test]
fn the_showcase_is_a_shelf_of_books_with_writing_days() {
    let s = seed::generate(Preset::Showcase, seed::DEFAULT_SEED).unwrap();
    let shape = s.shape();
    assert!(shape.books >= 8, "{} books", shape.books);
    assert!(shape.writing_days > 300);
    let names: Vec<String> = s.books.iter().map(|b| b.book.view().meta().name).collect();
    assert_eq!(names[0], "慢钟");
    assert_eq!(names[1], "阿Q正传（示例）");
    let again = seed::generate(Preset::Showcase, seed::DEFAULT_SEED).unwrap();
    assert_eq!(again.shape(), shape);
}

#[test]
fn v3_sample_books_and_showcase_lay_out_and_match_v2_shape() {
    for (book, chapters, elements, name) in [
        (
            samples::pride_and_prejudice_v3().unwrap(),
            61,
            31,
            "Pride and Prejudice (Sample)",
        ),
        (samples::a_q_v3().unwrap(), 9, 29, "阿Q正传（示例）"),
        (samples::slow_clock_v3().unwrap(), 24, 24, "慢钟"),
    ] {
        let v = book.book.view();
        assert_eq!(v.meta().name, name);
        let tpl_ms =
            dr_model::id::EntryTemplateId::parse(dr_doc::v3::novel::TPL_MANUSCRIPT).unwrap();
        let ms = v
            .root_entry_by_template(&tpl_ms)
            .expect("manuscript root entry");
        assert_eq!(v.manuscript_leaves(&ms.id).len(), chapters, "{name}");
        let tpl_char =
            dr_model::id::EntryTemplateId::parse(dr_doc::v3::novel::TPL_CHARACTER).unwrap();
        let elem_count = v
            .entries()
            .iter()
            .filter(|e| !e.is_trashed() && e.template.as_ref() == Some(&tpl_char))
            .count();
        assert_eq!(elem_count, elements, "{name}");
        assert!(v.repair_plan().is_empty(), "{name} needs no repair");
        assert!(v.autolink_name_conflicts().is_empty(), "{name}");
        assert!(!v.relations().is_empty(), "{name}");
        let entries_map = v.entries_map();
        let templates_map = v.templates_map();
        for e in entries_map.values().filter(|e| !e.is_trashed()) {
            assert!(
                dr_model::v3::check_parent_is_level(
                    e.parent.as_ref(),
                    &entries_map,
                    &templates_map
                )
                .is_ok()
            );
            assert!(
                dr_model::v3::check_level_allows_template(
                    e.parent.as_ref(),
                    e.template.as_ref(),
                    &entries_map,
                    &templates_map,
                )
                .is_ok()
            );
        }
        for m in v.memberships_raw() {
            assert!(
                dr_model::v3::check_membership(&m.host, &m.member, &entries_map, &templates_map)
                    .is_ok()
            );
        }
        for p in &book.prose {
            assert!(v.owns_prose(p.doc_id()), "{}", p.doc_id());
        }
    }

    let s_v2 = seed::generate(Preset::Showcase, seed::DEFAULT_SEED).unwrap();
    let s_v3 = seed::generate_v3(Preset::Showcase, seed::DEFAULT_SEED).unwrap();
    // A v3 seed writes the two documents beside each book (`stats:`,
    // `checkpoints:`) on top of what a v2 seed writes; everything else
    // matches.
    let mut shape = s_v3.shape();
    let beside = 2 * s_v3.books.len();
    assert_eq!(shape.documents, s_v2.shape().documents + beside);
    shape.documents -= beside;
    assert_eq!(shape, s_v2.shape());
    // The conversion uses deterministic IDs scoped by book, including all roots.
    let mut ids = std::collections::BTreeSet::new();
    for book in &s_v3.books {
        for entry in book.book.view().entries_raw() {
            assert!(ids.insert(entry.id.clone()), "shared entry {}", entry.id);
        }
    }
    let mut docs = std::collections::BTreeSet::new();
    for book in &s_v3.books {
        assert!(docs.insert(book.book.doc_id().to_string()));
        for prose in &book.prose {
            assert!(docs.insert(prose.doc_id().to_string()));
        }
    }
}
