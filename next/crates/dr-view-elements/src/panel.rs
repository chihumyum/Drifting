//! Canonical v3 level surface.
pub mod v3 {
    use std::{collections::BTreeSet, rc::Rc};

    use dr_i18n::keys;
    use dr_shell::{
        book::Book,
        nav::Open,
        strings::t,
        v3::{DisplaySurface, EntryDrag, LevelHost, Rendered, entry_target},
    };
    use dr_ui::{
        Theme,
        components::{DraggedPill, Pill, SandCell, Segmented, overlay},
        fonts::Role,
        sand::{self, Icon, KindMark, SandFrame},
        style::DrStyled,
    };
    use gpui::{prelude::*, *};

    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    pub enum Display {
        List,
        Board,
        Grid,
        Islands,
    }

    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    pub enum Section {
        Residents,
        Members,
        Unassigned,
    }

    #[derive(Clone, Debug, PartialEq, Eq)]
    pub enum Row {
        Section(Section),
        Entry { id: String, depth: usize },
        Member { id: String },
        Tiles { ids: Vec<String>, depth: usize },
        Island { id: String, members: Vec<String> },
    }

    /// Flatten only the effective residence tree. Accepted entries are a
    /// separate section and never silently become children in the tree.
    pub fn rows(
        book: &Book,
        level: &str,
        display: Display,
        grouped: bool,
        folded: &BTreeSet<String>,
        columns: usize,
    ) -> Vec<Row> {
        let Some(v) = book.v3() else {
            return Vec::new();
        };
        let Some(root) = v.levels.get(level) else {
            return Vec::new();
        };
        let mut out = Vec::new();
        if grouped && display == Display::List {
            // The entries the manuscript sequence numbers under this level,
            // in that order, whatever their switch.
            let mut numbered = Vec::new();
            let mut pending: Vec<_> = root.children.iter().rev().cloned().collect();
            let mut seen = BTreeSet::new();
            while let Some(id) = pending.pop() {
                if !seen.insert(id.clone()) {
                    continue;
                }
                if let Some(n) = v.manuscript_number(&id) {
                    numbered.push((n, id.clone()));
                }
                if let Some(l) = v.levels.get(&id) {
                    pending.extend(l.children.iter().rev().cloned());
                }
            }
            numbered.sort();
            let numbered: Vec<String> = numbered.into_iter().map(|(_, id)| id).collect();
            let mut used = BTreeSet::new();
            for lane in v.entries.iter().filter(|e| v.is_lane(&e.id)) {
                let members: Vec<_> = numbered
                    .iter()
                    .filter(|id| {
                        let accepted: BTreeSet<_> = v
                            .memberships
                            .iter()
                            .filter(|m| m.member == **id)
                            .map(|m| m.host.as_str())
                            .collect();
                        let primary = v
                            .entry(id)
                            .and_then(|e| e.primary.as_deref())
                            .filter(|p| accepted.contains(p))
                            .or_else(|| accepted.first().copied());
                        primary == Some(lane.id.as_str())
                    })
                    .cloned()
                    .collect();
                if !members.is_empty() {
                    out.push(Row::Entry {
                        id: lane.id.clone(),
                        depth: 0,
                    });
                    used.extend(members.iter().cloned());
                    if !folded.contains(&lane.id) {
                        out.extend(members.into_iter().map(|id| Row::Entry { id, depth: 1 }));
                    }
                }
            }
            let loose: Vec<_> = numbered
                .into_iter()
                .filter(|id| !used.contains(id))
                .collect();
            if !loose.is_empty() {
                out.push(Row::Section(Section::Unassigned));
                out.extend(loose.into_iter().map(|id| Row::Entry { id, depth: 0 }));
            }
        } else {
            out.push(Row::Section(Section::Residents));
            let mut pending: Vec<_> = root
                .children
                .iter()
                .rev()
                .map(|id| (id.clone(), 0))
                .collect();
            let mut seen = BTreeSet::new();
            while let Some((id, depth)) = pending.pop() {
                if !seen.insert(id.clone()) {
                    continue;
                }
                let Some(child) = v.levels.get(&id) else {
                    if display == Display::List {
                        out.push(Row::Entry { id, depth });
                    } else if let Some(Row::Tiles {
                        ids,
                        depth: row_depth,
                    }) = out.last_mut()
                        && *row_depth == depth
                        && ids.len() < columns.max(1)
                    {
                        ids.push(id);
                    } else {
                        out.push(Row::Tiles {
                            ids: vec![id],
                            depth,
                        });
                    }
                    continue;
                };
                if display == Display::Islands {
                    let mut members = Vec::new();
                    let mut todo: Vec<_> = child
                        .children
                        .iter()
                        .chain(&child.members)
                        .rev()
                        .cloned()
                        .collect();
                    let mut visited = BTreeSet::from([id.clone()]);
                    if !folded.contains(&id) {
                        while let Some(member) = todo.pop() {
                            if !visited.insert(member.clone()) {
                                continue;
                            }
                            if let Some(l) = v.levels.get(&member) {
                                todo.extend(l.children.iter().chain(&l.members).rev().cloned());
                            }
                            members.push(member);
                        }
                    }
                    out.push(Row::Island { id, members });
                } else {
                    out.push(Row::Entry {
                        id: id.clone(),
                        depth,
                    });
                    if !folded.contains(&id) {
                        pending.extend(
                            child
                                .children
                                .iter()
                                .rev()
                                .map(|id| (id.clone(), depth + 1)),
                        );
                    }
                }
            }
        }
        if !root.members.is_empty() {
            out.push(Row::Section(Section::Members));
            for id in &root.members {
                out.push(Row::Member { id: id.clone() });
            }
        }
        out
    }

    /// The page distinguishes residence from membership even when the same
    /// entry has both records. The sidebar remains one compact navigation canvas.
    pub fn board_sections(
        book: &Book,
        level: &str,
        surface: DisplaySurface,
    ) -> Vec<(Option<Section>, Vec<String>)> {
        let Some(level) = book.v3().and_then(|v| v.levels.get(level)) else {
            return vec![];
        };
        if surface == DisplaySurface::Page {
            let mut sections = vec![(Some(Section::Residents), level.children.clone())];
            if !level.members.is_empty() {
                sections.push((Some(Section::Members), level.members.clone()));
            }
            sections
        } else {
            let mut seen = BTreeSet::new();
            vec![(
                None,
                level
                    .children
                    .iter()
                    .chain(&level.members)
                    .filter(|id| seen.insert(*id))
                    .cloned()
                    .collect(),
            )]
        }
    }

    #[derive(Clone)]
    struct EntryDragSource {
        start: Entity<Option<Point<Pixels>>>,
        board: Option<(String, (f64, f64))>,
    }
    fn admit_drag(
        host: &dr_shell::pages::PageViewHost,
        job: impl FnOnce(dr_workspace::Workspace) -> Result<serde_json::Value, dr_workspace::WsError>
        + Send
        + 'static,
        cx: &mut App,
    ) {
        let lib = host.library.clone();
        let book = host.book_id.clone();
        let owner = host.workspace.clone();
        let identity = lib.library() as *const _ as usize;
        let (tx, rx) = futures::channel::oneshot::channel();
        // The detached worker owns the lease, even if the UI receiver closes.
        cx.background_executor()
            .spawn(async move {
                let result = job(lib);
                let _ = tx.send(result);
            })
            .detach();
        cx.spawn(async move |cx| {
            if let Ok(Err(error)) = rx.await {
                log::warn!("v3 entry drop: {error}");
                owner
                    .update(cx, |ws, cx| {
                        if ws.book_id == book
                            && ws
                                .library
                                .as_ref()
                                .is_some_and(|lib| lib.library() as *const _ as usize == identity)
                        {
                            let text = t(cx, keys::common::SAVE_FAILED);
                            ws.toast(text, cx);
                        }
                    })
                    .ok();
            }
        })
        .detach();
    }
    fn drop_on_entry(
        page: &dr_shell::pages::PageViewHost,
        drag: &EntryDrag,
        onto: &str,
        after: bool,
        cx: &mut App,
    ) {
        if !drag.matches(page) || !drag.is_current(cx) {
            return;
        }
        if let Ok(edit) = crate::data::v3::prepare_drop(&drag.page().book, &drag.entry, onto, after)
        {
            admit_drag(drag.page(), move |lib| edit.commit(&lib), cx);
        }
    }
    fn drop_on_board(
        page: &dr_shell::pages::PageViewHost,
        level: &str,
        drag: &EntryDrag,
        window: &Window,
        cx: &mut App,
    ) {
        if !drag.matches(page) || !drag.is_current(cx) {
            return;
        }
        if let Some(source) = drag.source::<EntryDragSource>()
            && let Some((origin, position)) = &source.board
            && origin == level
        {
            let Some(start) = *source.start.read(cx) else {
                return;
            };
            let delta = window.mouse_position() - start;
            let position = (
                position.0 + f64::from(f32::from(delta.x)),
                position.1 + f64::from(f32::from(delta.y)),
            );
            if let Ok(edit) =
                crate::data::v3::prepare_board(&drag.page().book, &drag.entry, position)
            {
                admit_drag(drag.page(), move |lib| edit.commit(&lib), cx);
            }
        } else {
            drop_on_entry(page, drag, level, true, cx);
        }
    }

    pub struct LevelDisplay {
        pub host: LevelHost,
        pub display: Display,
        pub grouped: bool,
        pub folded: BTreeSet<String>,
        pub rows: Rc<Vec<Row>>,
        list: ListState,
        scroll: ScrollHandle,
    }

    /// Opt-in native draw timings for the G2 milestone. No prose, IDs, paths
    /// or user input are recorded; release builds do not start this probe.
    #[cfg(all(feature = "measure-v3", debug_assertions))]
    fn start_frame_probe() {
        use std::{
            io::Write as _,
            sync::atomic::{AtomicBool, Ordering},
            time::{Duration, Instant, SystemTime, UNIX_EPOCH},
        };
        static STARTED: AtomicBool = AtomicBool::new(false);
        let Some(path) = std::env::var_os("DRIFTING_G2_FRAME_LOG") else {
            return;
        };
        if STARTED.swap(true, Ordering::Relaxed) {
            return;
        }
        let Ok(mut sink) = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(path)
        else {
            log::warn!("G2 frame probe could not create its output");
            return;
        };
        gpui::profiler::set_trace_enabled(true);
        let mut collector = gpui::profiler::FrameTimingCollector::new();
        std::thread::spawn(move || {
            loop {
                for event in collector.collect_unseen() {
                    if let gpui::profiler::FrameEvent::Draw(frame) = event {
                        let now = Instant::now();
                        let unix = SystemTime::now()
                            .duration_since(UNIX_EPOCH)
                            .unwrap_or_default()
                            .as_micros();
                        let at = unix.saturating_sub(
                            now.saturating_duration_since(frame.draw_start).as_micros(),
                        );
                        let _ = writeln!(
                            sink,
                            "{{\"at_us\":{},\"draw_us\":{},\"layout_us\":{},\"prepaint_us\":{},\"paint_us\":{}}}",
                            at,
                            frame
                                .draw_end
                                .saturating_duration_since(frame.draw_start)
                                .as_micros(),
                            frame.phases.request_layout.as_micros(),
                            frame.phases.prepaint.as_micros(),
                            frame.phases.paint.as_micros()
                        );
                    }
                }
                std::thread::sleep(Duration::from_millis(50));
            }
        });
    }

    pub fn register(cx: &mut App) {
        #[cfg(all(feature = "measure-v3", debug_assertions))]
        start_frame_probe();
        for (name, kind) in [
            ("list", Display::List),
            ("grid", Display::Grid),
            ("island", Display::Islands),
        ] {
            dr_shell::v3::add_level_display(cx, name, move |host, _, cx| make(host, kind, cx));
        }
    }

    pub fn make(host: LevelHost, display: Display, cx: &mut App) -> Rendered {
        let view = cx.new(|_| LevelDisplay::new(host, display));
        let weak = view.downgrade();
        Rendered::new(view).on_refresh(move |book, cx| {
            let _ = weak.update(cx, |this, cx| this.refresh(book, cx));
        })
    }

    impl LevelDisplay {
        pub fn new(host: LevelHost, display: Display) -> Self {
            let mut this = Self {
                host,
                display,
                grouped: false,
                folded: BTreeSet::new(),
                rows: Rc::default(),
                list: ListState::new(0, ListAlignment::Top, px(300.0)),
                scroll: ScrollHandle::new(),
            };
            this.rebuild();
            this
        }
        fn rebuild(&mut self) {
            let columns = if self.host.surface == DisplaySurface::Sidebar {
                2
            } else {
                4
            };
            let rows = rows(
                &self.host.page.book,
                &self.host.level,
                self.display,
                self.grouped,
                &self.folded,
                columns,
            );
            // Keep the visible entry anchored when a book event inserts or
            // removes rows above it. reset() alone clears GPUI's anchor.
            if *self.rows != rows {
                let mut offset = self.list.logical_scroll_top();
                if let Some(row) = self.rows.get(offset.item_ix)
                    && let Some(index) = rows.iter().position(|next| next == row)
                {
                    offset.item_ix = index;
                }
                offset.item_ix = offset.item_ix.min(rows.len().saturating_sub(1));
                self.list.reset(rows.len());
                self.list.scroll_to(offset);
                self.rows = Rc::new(rows);
            } else {
                // Tile names can change wrapping without changing row IDs.
                self.list.remeasure_items(0..rows.len());
            }
        }
        pub fn scroll_state(&self) -> ListState {
            self.list.clone()
        }
        pub fn refresh(&mut self, book: Rc<Book>, cx: &mut Context<Self>) {
            self.host.page.book = book;
            self.rebuild();
            cx.notify();
        }
        pub fn toggle(&mut self, id: &str, cx: &mut Context<Self>) {
            if !self.folded.remove(id) {
                self.folded.insert(id.into());
            }
            self.rebuild();
            cx.notify();
        }
        fn entry(
            &self,
            id: &str,
            depth: usize,
            tile: bool,
            window: &mut Window,
            cx: &mut App,
        ) -> AnyElement {
            self.entry_at(id, depth, tile, "root", None, window, cx)
        }
        fn entry_scoped(
            &self,
            id: &str,
            depth: usize,
            tile: bool,
            scope: &str,
            window: &mut Window,
            cx: &mut App,
        ) -> AnyElement {
            self.entry_at(id, depth, tile, scope, None, window, cx)
        }
        #[allow(clippy::too_many_arguments)]
        fn entry_at(
            &self,
            id: &str,
            depth: usize,
            tile: bool,
            scope: &str,
            board: Option<(String, (f64, f64))>,
            window: &mut Window,
            cx: &mut App,
        ) -> AnyElement {
            let Some(v) = self.host.page.book.v3() else {
                return div().into_any_element();
            };
            let Some(entry) = v.entry(id) else {
                return div().into_any_element();
            };
            let Some(target) = entry_target(id) else {
                return div().into_any_element();
            };
            let (mark, color) = self.host.page.book.mark(&target);
            let weak = self.host.page.workspace.clone();
            let card_ws = weak.upgrade();
            let selected = card_ws
                .as_ref()
                .is_some_and(|ws| ws.read(cx).nav.is_selected(&target));
            let open = target.clone();
            let on_click = move |event: &ClickEvent, _: &mut Window, cx: &mut App| {
                if let Some(ws) = weak.upgrade() {
                    ws.update(cx, |ws, cx| {
                        ws.open(
                            open.clone(),
                            if event.click_count() > 1 {
                                Open::KEEP
                            } else {
                                Open::PREVIEW
                            },
                            cx,
                        )
                    });
                }
            };
            let cell_id: SharedString = format!("g2-entry-{}-{scope}-{id}", self.host.level).into();
            let cell = if tile || self.display == Display::Board && id != self.host.level {
                let theme = Theme::of(window, cx);
                div()
                    .id(cell_id.clone())
                    .relative()
                    .min_h(px(28.0))
                    .px_2()
                    .py_1()
                    .flex()
                    .items_center()
                    .gap(px(6.0))
                    .min_w_0()
                    .cursor_pointer()
                    .role(gpui::Role::Button)
                    .aria_label(entry.title.clone())
                    .aria_selected(selected)
                    .font_role(Role::Ui)
                    .type_px(theme.scale.body, theme.scale.line_body)
                    .text_color(theme.palette.ink(if selected { 1 } else { 2 }).solid())
                    .on_click(on_click)
                    .child(
                        SandFrame::new(SharedString::from(format!("{cell_id}-frame")), selected)
                            .when_some(color, |frame, color| frame.color(color)),
                    )
                    .child(
                        div().flex_none().size(px(10.0)).child(
                            KindMark::new(SharedString::from(format!("{cell_id}-mark")), mark)
                                .scale(10.0 / 14.0)
                                .when_some(color, |mark, color| mark.color(color)),
                        ),
                    )
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .truncate()
                            .child(entry.title.clone()),
                    )
                    .into_any_element()
            } else {
                SandCell::new(cell_id, entry.title.clone())
                    .mark(mark)
                    .color_opt(color)
                    .selected(selected)
                    .font(if v.levels.contains_key(id) {
                        Role::Structure
                    } else {
                        Role::Ui
                    })
                    .on_click(on_click)
                    .into_any_element()
            };
            let cell = if let Some(ws) = card_ws {
                dr_shell::workspace::page_hover_card(
                    format!("g2-card-{}-{scope}-{id}", self.host.level),
                    cell,
                    &target,
                    &ws,
                    Default::default(),
                    cx,
                )
            } else {
                cell.into_any_element()
            };
            let bounds = overlay::use_bounds(
                SharedString::from(format!("g2-drop-bounds-{}-{scope}-{id}", self.host.level)),
                window,
                cx,
            );
            let drop_bounds = bounds.clone();
            let grab_bounds = bounds.clone();
            let in_board = board.is_some();
            let start = window.use_keyed_state(
                SharedString::from(format!("g2-drag-start-{}-{scope}-{id}", self.host.level)),
                cx,
                |_, _| None::<Point<Pixels>>,
            );
            let pressed = start.clone();
            let drag = EntryDrag::new(self.host.page.clone(), id, entry.title.clone())
                .with_source(EntryDragSource { start, board });
            let ghost = entry.title.clone();
            let page = self.host.page.clone();
            let can_page = page.clone();
            let onto = id.to_owned();
            let can_onto = onto.clone();
            let wash = Theme::of(window, cx).palette.accent.alpha(0.08);
            div()
                .id(SharedString::from(format!(
                    "g2-drag-{}-{scope}-{id}",
                    self.host.level
                )))
                .relative()
                .when(!tile, |el| el.w_full())
                .pl(px(depth.min(20) as f32 * 14.0))
                .min_w_0()
                .when(tile, |el| {
                    el.min_w(px(super::tile_basis(&entry.title)))
                        .max_w(px(172.0))
                        .flex_1()
                })
                .on_mouse_down(MouseButton::Left, move |event, _, cx| {
                    pressed.update(cx, |start, _| *start = Some(event.position));
                })
                .on_drag(drag, move |drag, _, window, cx| {
                    let source = drag.source::<EntryDragSource>().expect("G2 drag source");
                    if source.start.read(cx).is_none() {
                        source
                            .start
                            .update(cx, |start, _| *start = Some(window.mouse_position()));
                    }
                    if let Some(press) = *source.start.read(cx)
                        && let Some(bounds) = grab_bounds.read(cx).as_ref()
                    {
                        drag.set_grab(f32::from(press.x - bounds.origin.x));
                    }
                    let pill = Pill::new(ghost.clone()).mark(mark, color);
                    let at = window.mouse_position();
                    cx.new(|_| DraggedPill::new(pill, at))
                })
                .when(!in_board, |el| {
                    el.can_drop(move |value, _, _| {
                        value.downcast_ref::<EntryDrag>().is_some_and(|drag| {
                            drag.matches(&can_page)
                                && crate::data::v3::drop_target(
                                    &drag.page().book,
                                    &drag.entry,
                                    &can_onto,
                                    true,
                                )
                                .is_some()
                        })
                    })
                    .drag_over::<EntryDrag>(move |style, _, _, _| style.bg(wash))
                    .on_drop(move |drag: &EntryDrag, window, cx| {
                        let after = drop_bounds
                            .read(cx)
                            .as_ref()
                            .is_some_and(|bounds| window.mouse_position().y >= bounds.center().y);
                        drop_on_entry(&page, drag, &onto, after, cx);
                    })
                })
                .child(overlay::probe(bounds))
                .child(cell)
                .into_any_element()
        }
        fn heading(&self, section: Section, cx: &App) -> SharedString {
            t(
                cx,
                match section {
                    Section::Residents => keys::v3_levels::RESIDENTS,
                    Section::Members => keys::v3_levels::MEMBERS,
                    Section::Unassigned => keys::v3_levels::UNASSIGNED,
                },
            )
        }
        fn row(
            &self,
            row: &Row,
            entity: &Entity<Self>,
            scope: &str,
            window: &mut Window,
            cx: &mut App,
        ) -> AnyElement {
            let theme = Theme::of(window, cx);
            match row {
                Row::Section(section) => div()
                    .id(SharedString::from(format!(
                        "g2-section-{}-{section:?}",
                        self.host.level
                    )))
                    .h(px(32.0))
                    .pt_2()
                    .font_role(Role::Structure)
                    .text_color(theme.palette.muted().solid())
                    .role(gpui::Role::Heading)
                    .aria_label(self.heading(*section, cx))
                    .child(self.heading(*section, cx))
                    .into_any_element(),
                Row::Member { id } => self.entry_scoped(id, 0, false, scope, window, cx),
                Row::Entry { id, depth } => {
                    let mut row = div().flex().items_center().min_w_0().w_full();
                    if self
                        .host
                        .page
                        .book
                        .v3()
                        .is_some_and(|v| v.levels.contains_key(id))
                    {
                        let weak = entity.downgrade();
                        let id = id.clone();
                        let folded = self.folded.contains(&id);
                        let name = self
                            .host
                            .page
                            .book
                            .v3()
                            .and_then(|v| v.entry(&id))
                            .map(|e| e.title.clone())
                            .unwrap_or_default();
                        row = row.child(
                            div()
                                .id(SharedString::from(format!("g2-fold-{scope}-{id}")))
                                .size(px(14.0))
                                .flex_none()
                                .flex()
                                .items_center()
                                .justify_center()
                                .cursor_pointer()
                                .role(gpui::Role::Button)
                                .aria_label(dr_shell::strings::tf(
                                    cx,
                                    if folded {
                                        keys::v3_levels::EXPAND
                                    } else {
                                        keys::v3_levels::COLLAPSE
                                    },
                                    &[("name", &name)],
                                ))
                                .child(sand::icon(
                                    if folded {
                                        Icon::ChevronRight
                                    } else {
                                        Icon::ChevronDown
                                    },
                                    11.0,
                                    theme.palette.ink(3).solid(),
                                ))
                                .on_click(move |_, _, cx| {
                                    let _ = weak.update(cx, |this, cx| this.toggle(&id, cx));
                                }),
                        );
                    }
                    row.child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .child(self.entry_scoped(id, *depth, false, scope, window, cx)),
                    )
                    .into_any_element()
                }
                Row::Tiles { ids, depth } => div()
                    .flex()
                    .flex_wrap()
                    .gap_1()
                    .py_1()
                    .pl(px(*depth as f32 * 14.0))
                    .children(
                        ids.iter()
                            .map(|id| self.entry_scoped(id, 0, true, scope, window, cx)),
                    )
                    .into_any_element(),
                Row::Island { id, members } => {
                    let color = entry_target(id)
                        .and_then(|t| self.host.page.book.mark(&t).1)
                        .unwrap_or(theme.palette.accent);
                    div()
                        .relative()
                        .mx_2()
                        .my_2()
                        .p_2()
                        .child(
                            div().absolute().inset_0().child(
                                SandFrame::new(SharedString::from(format!("g2-island-{id}")), true)
                                    .color(color),
                            ),
                        )
                        .child(self.row(
                            &Row::Entry {
                                id: id.clone(),
                                depth: 0,
                            },
                            entity,
                            scope,
                            window,
                            cx,
                        ))
                        .child(
                            div().flex().flex_wrap().gap_1().children(
                                members
                                    .iter()
                                    .map(|id| self.entry_scoped(id, 0, true, scope, window, cx)),
                            ),
                        )
                        .into_any_element()
                }
            }
        }
        fn board(&self, window: &mut Window, cx: &mut App) -> AnyElement {
            let mut content = div().flex().flex_col().gap_3();
            for (section, ids) in
                board_sections(&self.host.page.book, &self.host.level, self.host.surface)
            {
                if let Some(section) = section {
                    let label = t(
                        cx,
                        match section {
                            Section::Residents => keys::v3_levels::RESIDENTS,
                            Section::Members => keys::v3_levels::MEMBERS,
                            Section::Unassigned => keys::v3_levels::UNASSIGNED,
                        },
                    );
                    content = content.child(
                        div()
                            .id(SharedString::from(format!("g2-board-section-{section:?}")))
                            .role(gpui::Role::Heading)
                            .aria_label(label.clone())
                            .child(label),
                    );
                }
                content = content.child(self.board_canvas(
                    &ids,
                    &format!("board-{section:?}"),
                    window,
                    cx,
                ));
            }
            let scroll = self.scroll.clone();
            let page = self.host.page.clone();
            let can_page = page.clone();
            let level = self.host.level.clone();
            let can_level = level.clone();
            div()
                .id("g2-board-scroll")
                .role(gpui::Role::Group)
                .aria_label(t(cx, keys::v3_shell::ENTRIES))
                .can_drop(move |value, _, _| {
                    value.downcast_ref::<EntryDrag>().is_some_and(|drag| {
                        drag.matches(&can_page)
                            && (drag
                                .source::<EntryDragSource>()
                                .and_then(|source| source.board.as_ref())
                                .is_some_and(|(level, _)| level == &can_level)
                                || crate::data::v3::drop_target(
                                    &drag.page().book,
                                    &drag.entry,
                                    &can_level,
                                    true,
                                )
                                .is_some())
                    })
                })
                .on_drop(move |drag: &EntryDrag, window, cx| {
                    drop_on_board(&page, &level, drag, window, cx)
                })
                .overflow_scroll()
                .track_scroll(&self.scroll)
                // GPUI's div wheel handler updates the inner offset but does
                // not consume the event. Keep the enclosing page stationary.
                .on_scroll(move |event, window, cx| {
                    let delta = event.delta.pixel_delta(window.line_height());
                    let max = scroll.max_offset();
                    if !delta.y.is_zero() && max.y > px(0.0)
                        || !delta.x.is_zero() && max.x > px(0.0)
                    {
                        cx.stop_propagation();
                    }
                })
                .size_full()
                .child(content)
                .into_any_element()
        }
        fn board_canvas(
            &self,
            ids: &[String],
            scope: &str,
            window: &mut Window,
            cx: &mut App,
        ) -> AnyElement {
            let Some(v) = self.host.page.book.v3() else {
                return div().into_any_element();
            };
            let positions: Vec<_> = ids
                .iter()
                .enumerate()
                .map(|(index, id)| {
                    v.entry(id)
                        .and_then(|e| e.layout.board)
                        .unwrap_or(((index % 3) as f64 * 192.0, (index / 3) as f64 * 76.0))
                })
                .collect();
            // A negative saved coordinate is still on the canvas: translate
            // the viewport, rather than piling negative cards at (0, 0).
            let origin = positions
                .iter()
                .fold((0.0_f64, 0.0_f64), |(x, y), p| (x.min(p.0), y.min(p.1)));
            let mut board = div().relative().min_w(px(600.0)).min_h(px(480.0));
            let mut width: f32 = 600.0;
            let mut height: f32 = 480.0;
            for (id, position) in ids.iter().zip(&positions) {
                let (x, y) = (
                    (position.0 - origin.0) as f32 + 8.0,
                    (position.1 - origin.1) as f32 + 8.0,
                );
                width = width.max(x + 188.0);
                height = height.max(y + 72.0);
                board = board.child(
                    div()
                        .absolute()
                        .left(px(x))
                        .top(px(y))
                        .w(px(180.0))
                        .p_2()
                        .child(self.entry_at(
                            id,
                            0,
                            false,
                            scope,
                            Some((self.host.level.clone(), *position)),
                            window,
                            cx,
                        )),
                );
            }
            board.w(px(width)).h(px(height)).into_any_element()
        }
    }

    impl Render for LevelDisplay {
        fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
            let mut root = div()
                .flex()
                .flex_col()
                .min_h_0()
                .w_full()
                .when(self.host.surface == DisplaySurface::Sidebar, |el| {
                    el.h_full()
                })
                .when(self.host.surface == DisplaySurface::Page, |el| {
                    el.h(px(440.0))
                });
            if self.host.surface == DisplaySurface::Sidebar {
                // The selected root is itself an entry: open its level page
                // and use exactly the same common card as its descendants.
                root = root.child(self.entry(&self.host.level, 0, false, window, cx));
            }
            if self.display == Display::List
                && self
                    .host
                    .page
                    .book
                    .v3()
                    .and_then(|v| v.levels.get(&self.host.level))
                    .is_some_and(|l| l.settings.is_manuscript)
            {
                let weak = cx.entity().downgrade();
                root = root.child(
                    Segmented::new(
                        "g2-list-order",
                        [
                            t(cx, keys::v3_levels::MANUSCRIPT_ORDER),
                            t(cx, keys::v3_levels::BY_STORYLINE),
                        ],
                        usize::from(self.grouped),
                    )
                    .on_change(move |index, _, cx| {
                        let _ = weak.update(cx, |this, cx| {
                            this.grouped = index == 1;
                            this.rebuild();
                            cx.notify();
                        });
                    }),
                );
            }
            let body = if self.display == Display::Board {
                self.board(window, cx)
            } else {
                let rows = self.rows.clone();
                let weak = cx.entity().downgrade();
                list(self.list.clone(), move |i, window, cx| {
                    weak.upgrade()
                        .map(|entity| {
                            entity.update(cx, |this, cx| {
                                this.row(&rows[i], &entity, &format!("row-{i}"), window, cx)
                            })
                        })
                        .unwrap_or_else(|| div().into_any_element())
                })
                .size_full()
                .into_any_element()
            };
            root.child(
                div()
                    .flex()
                    .flex_col()
                    .flex_1()
                    .h_full()
                    .min_h_0()
                    .overflow_hidden()
                    .child(body),
            )
            .into_any_element()
        }
    }
}

pub fn tile_basis(name: &str) -> f32 {
    let units: f32 = name
        .chars()
        .map(|c| {
            if c == ' ' {
                0.35
            } else if c.is_ascii() {
                0.62
            } else {
                1.0
            }
        })
        .sum();
    (44.0 + units * 12.5).clamp(80.0, 172.0)
}
