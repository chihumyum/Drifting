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
