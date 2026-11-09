use super::*;

#[gpui::test]
fn unchanged_refresh_preserves_scroll_and_ambiguous_hits_require_reselection(
    cx: &mut gpui::TestAppContext,
) {
    let dir = tempfile::tempdir().unwrap();
    let store =
        dr_store::Library::open(dir.path(), dr_workspace::library_options("0.2.0-dev")).unwrap();
    let made = dr_testkit::seed::generate_v3(
        dr_testkit::seed::Preset::Tiny,
        dr_testkit::seed::DEFAULT_SEED,
    )
    .unwrap();
    let book = made.books[0].book_id().to_string();
    made.write_to(&store).unwrap();
    store.close().unwrap();
    let ws = Workspace::open_dir(dir.path(), "0.2.0-dev").unwrap();
    for doc in ws.library().docs(Some(&book), None).unwrap() {
        ws.library().reindex_doc(&doc.doc_id).unwrap();
    }
    let groups = crate::v3::search(&ws, &book, "灯", LIMIT).unwrap();
    assert!(!groups.is_empty());
    let (panel, cx) = cx.add_window_view(move |window, cx| {
        SearchPanel::new_v3(
            None,
            book,
            Rc::new(|_| (sand::Kind::Element, None)),
            Locale::En,
            Platform::Mac,
            window,
            cx,
        )
    });
    panel.update(cx, |p, cx| {
        p.set_query("灯", cx);
        p.set_v3_results(groups.clone(), true, cx);
        let selected = p.selected();
        assert!(selected.is_some());
        let offset = point(px(0.0), px(-120.0));
        p.scroll.0.borrow().base_handle.set_offset(offset);
        p.scroll.0.borrow_mut().deferred_scroll_to_item = None;
        p.set_v3_results(groups.clone(), true, cx);
        assert_eq!(p.selected(), selected);
        assert_eq!(p.scroll.0.borrow().base_handle.offset(), offset);
        assert!(
            p.scroll.0.borrow().deferred_scroll_to_item.is_none(),
            "unchanged results must not schedule a scroll on the next frame"
        );

        let Some(Line::Hit(g, r)) = selected else {
            unreachable!()
        };
        let mut ambiguous = groups.clone();
        let duplicate = ambiguous[g].rows[r].clone();
        ambiguous[g].rows.push(duplicate);
        p.set_v3_results(ambiguous, true, cx);
        assert_eq!(p.selected(), None, "do not guess between identical hits");
        p.step(1, cx);
        assert_eq!(p.selected(), Some(Line::Hit(0, 0)));
        p.set_v3_results(Vec::new(), true, cx);
        p.set_v3_results(groups.clone(), true, cx);
        assert_eq!(
            p.selected(),
            None,
            "a later reappearance is not the first result of this query"
        );
        p.set_query("", cx);
        p.set_query("灯", cx);
        p.set_v3_results(groups, true, cx);
        assert_eq!(
            p.selected(),
            Some(Line::Hit(0, 0)),
            "a new query can select its first result again"
        );
    });
}
