//! Canonical v3 level surface.
pub mod v3 {
    use std::{
        collections::{BTreeMap, BTreeSet},
        rc::Rc,
    };

    pub use crate::data::v3::{DropSlot, SortOrder, UpdatedMap};
    use crate::data::v3::{
        compare_entries, drop_slot_at, prepare_resolved_drop, resolve_drop_with, resolve_hung_drop,
        sort_memory_key, updated_timestamps,
    };
    use dr_i18n::keys;
    use dr_shell::{
        actions::left,
        book::Book,
        nav::{Open, Target},
        strings::t,
        v3::{DisplaySurface, EntryDrag, LevelHost, ROOT_LEVEL, Rendered, entry_target},
    };
    use dr_ui::{
        Theme,
        components::{
            CardKeys, DraggedPill, Pill, SandCell, Segmented,
            cell::{RING_RIM, ring_tone},
            hover_card, overlay,
        },
        fonts::Role,
        glass,
        sand::{self, Icon, KindMark, SandFrame},
        style::DrStyled,
        tokens::radius,
    };
    use gpui::{prelude::*, *};
    use std::{cell::RefCell, collections::HashMap};

    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    pub enum Display {
        List,
        Board,
        Grid,
        Islands,
    }

    #[derive(Clone, Debug, PartialEq, Eq)]
    pub enum Row {
        /// An entry living where the row's parent is.
        Entry {
            id: String,
            depth: usize,
        },
        /// An entry attached to `host`: listed after what lives there, with a
        /// dotted guide in the left sidebar (`W31Hung`); dragging moves the
        /// hang to another accepting host without moving residence.
        Member {
            id: String,
            depth: usize,
            host: String,
        },
        Tiles {
            ids: Vec<String>,
            depth: usize,
        },
        Island {
            id: String,
            members: Vec<String>,
        },
    }

    /// What lives under `level` and what is attached to it (the outermost
    /// entries for [`ROOT_LEVEL`], which nothing is attached to).
    fn below(v: &dr_shell::book::v3::BookV3, level: &str) -> Option<(Vec<String>, Vec<String>)> {
        if level == ROOT_LEVEL {
            return Some((v.roots.clone(), Vec::new()));
        }
        let l = v.levels.get(level)?;
        Some((l.children.clone(), l.members.clone()))
    }

    fn ordered_ids(
        v: &dr_shell::book::v3::BookV3,
        ids: &[String],
        sort: SortOrder,
        updated: &UpdatedMap,
    ) -> Vec<String> {
        if sort == SortOrder::Manual {
            return ids.to_vec();
        }
        let mut out = ids.to_vec();
        out.sort_by(|a, b| compare_entries(v, a, b, sort, updated));
        out
    }

    /// The list of a level (`kernel-v5.md` §16 「层级的列表」): only its
    /// tree. What lives under it, in its order; an entry that holds entries
    /// opens to what lives under it, then what is attached to it. A Tab
    /// (`Sidebar`) lists what is attached to the level itself after what
    /// lives under it; an entry page lists them in its two blocks (`Page`,
    /// `Members`).
    pub fn rows(
        book: &Book,
        level: &str,
        display: Display,
        surface: DisplaySurface,
        folded: &BTreeSet<String>,
        columns: usize,
    ) -> Vec<Row> {
        rows_sorted(
            book,
            level,
            display,
            surface,
            SortOrder::Manual,
            &BTreeMap::new(),
            folded,
            columns,
        )
    }

    #[allow(clippy::too_many_arguments)]
    pub fn rows_sorted(
        book: &Book,
        level: &str,
        display: Display,
        surface: DisplaySurface,
        sort: SortOrder,
        updated: &UpdatedMap,
        folded: &BTreeSet<String>,
        columns: usize,
    ) -> Vec<Row> {
        let Some(v) = book.v3() else {
            return Vec::new();
        };
        if surface == DisplaySurface::BookTab {
            let entries = v.book_entries();
            return entries
                .chunks(columns.max(1))
                .map(|ids| Row::Tiles {
                    ids: ids.to_vec(),
                    depth: 0,
                })
                .collect();
        }
        let Some((children, members)) = below(v, level) else {
            return Vec::new();
        };
        let mut out = Vec::new();
        let active_sort = if matches!(display, Display::List | Display::Grid) {
            sort
        } else {
            SortOrder::Manual
        };
        let member_sort = |host_id: &str| {
            if v.is_lane(host_id) {
                SortOrder::Manual
            } else {
                active_sort
            }
        };
        if surface == DisplaySurface::Members {
            out.extend(
                ordered_ids(v, &members, member_sort(level), updated)
                    .into_iter()
                    .map(|id| Row::Member {
                        id,
                        depth: 0,
                        host: level.to_owned(),
                    }),
            );
            return out;
        }
        // (id, depth, hung_host, the entries above it), last first. An
        // attached entry shows under each entry it is attached to, as well
        // as where it lives; only an entry above itself is cut.
        type Path = Rc<Vec<String>>;
        let top: Path = Rc::new(vec![level.to_owned()]);
        let mut pending: Vec<(String, usize, Option<String>, Path)> = Vec::new();
        if surface == DisplaySurface::Sidebar {
            pending.extend(
                ordered_ids(v, &members, member_sort(level), updated)
                    .into_iter()
                    .rev()
                    .map(|id| (id, 0, Some(level.to_owned()), top.clone())),
            );
        }
        pending.extend(
            ordered_ids(v, &children, active_sort, updated)
                .into_iter()
                .rev()
                .map(|id| (id, 0, None, top.clone())),
        );
        while let Some((id, depth, hung_host, path)) = pending.pop() {
            if path.contains(&id) {
                continue;
            }
            let attached = hung_host.is_some();
            let Some(child) = v.levels.get(&id) else {
                if display == Display::List || attached {
                    out.push(match hung_host {
                        Some(host) => Row::Member { id, depth, host },
                        None => Row::Entry { id, depth },
                    });
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
            if display == Display::Islands && !attached {
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
                continue;
            }
            out.push(match hung_host {
                Some(host) => Row::Member {
                    id: id.clone(),
                    depth,
                    host,
                },
                None => Row::Entry {
                    id: id.clone(),
                    depth,
                },
            });
            if !folded.contains(&id) {
                let mut below: Vec<String> = path.as_ref().clone();
                below.push(id.clone());
                let below: Path = Rc::new(below);
                // Last first: what is attached comes after what lives here.
                pending.extend(
                    ordered_ids(v, &child.members, member_sort(&id), updated)
                        .into_iter()
                        .rev()
                        .map(|m| (m, depth + 1, Some(id.clone()), below.clone())),
                );
                pending.extend(
                    ordered_ids(v, &child.children, active_sort, updated)
                        .into_iter()
                        .rev()
                        .map(|c| (c, depth + 1, None, below.clone())),
                );
            }
        }
        out
    }

    /// The entries a board shows: what lives under the level on an entry
    /// page's first block, what is attached to it on its second, both on a
    /// Tab's one canvas.
    pub fn board_ids(book: &Book, level: &str, surface: DisplaySurface) -> Vec<String> {
        if surface == DisplaySurface::BookTab {
            return book.v3().map_or_else(Vec::new, |v| v.book_entries());
        }
        let Some((children, members)) = book.v3().and_then(|v| below(v, level)) else {
            return vec![];
        };
        match surface {
            DisplaySurface::Page => children,
            DisplaySurface::Members => members,
            DisplaySurface::Sidebar | DisplaySurface::BookTab => {
                let mut seen = BTreeSet::new();
                children
                    .into_iter()
                    .chain(members)
                    .filter(|id| seen.insert(id.clone()))
                    .collect()
            }
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
    #[allow(clippy::too_many_arguments)]
    fn drop_on_resolved(
        page: &dr_shell::pages::PageViewHost,
        drag: &EntryDrag,
        onto: &str,
        slot: DropSlot,
        can_reorder: bool,
        onto_host: Option<&str>,
        is_member: bool,
        attach: bool,
        cx: &mut App,
    ) {
        if !drag.matches(page) || !drag.is_current(cx) {
            return;
        }
        if dr_shell::v3::tabs::detach_timeline_clip(page, drag, cx) {
            return;
        }
        let target = if let Some(from_host) = &drag.hung_host {
            resolve_hung_drop(
                &drag.page().book,
                &drag.entry,
                from_host,
                onto,
                onto_host,
                slot,
                attach,
            )
        } else {
            resolve_drop_with(
                &drag.page().book,
                &drag.entry,
                onto,
                slot,
                can_reorder,
                is_member,
                attach,
            )
        };
        let Some(target) = target else {
            return;
        };
        if let Ok(edit) = prepare_resolved_drop(&drag.page().book, &drag.entry, target) {
            admit_drag(
                drag.page(),
                move |lib| edit.commit_if_changed(&lib).map(|v| v.unwrap_or_default()),
                cx,
            );
        }
    }
    fn drop_on_entry(
        page: &dr_shell::pages::PageViewHost,
        drag: &EntryDrag,
        onto: &str,
        after: bool,
        attach: bool,
        cx: &mut App,
    ) {
        if !drag.matches(page) || !drag.is_current(cx) {
            return;
        }
        let target = if let Some(from) = &drag.hung_host {
            resolve_hung_drop(
                &drag.page().book,
                &drag.entry,
                from,
                onto,
                None,
                DropSlot::Into,
                attach,
            )
        } else {
            crate::data::v3::drop_target_with(&drag.page().book, &drag.entry, onto, after, attach)
        };
        if let Some(target) = target
            && let Ok(edit) = prepare_resolved_drop(&drag.page().book, &drag.entry, target)
        {
            admit_drag(
                drag.page(),
                move |lib| edit.commit_if_changed(&lib).map(|v| v.unwrap_or_default()),
                cx,
            );
        }
    }
    fn drop_on_board(
        page: &dr_shell::pages::PageViewHost,
        level: &str,
        sidebar: bool,
        drag: &EntryDrag,
        window: &Window,
        cx: &mut App,
    ) {
        if !drag.matches(page) || !drag.is_current(cx) {
            return;
        }
        if sidebar && dr_shell::v3::tabs::detach_timeline_clip(page, drag, cx) {
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
                crate::data::v3::prepare_board(&drag.page().book, level, &drag.entry, position)
            {
                admit_drag(drag.page(), move |lib| edit.commit(&lib), cx);
            }
        } else {
            drop_on_entry(page, drag, level, true, window.modifiers().alt, cx);
        }
    }

    /// One place the keyboard stops in a left-column Tab's tree (KB): a
    /// row, or one tile of a grid's row, in the order they are drawn.
    #[derive(Clone, Debug, PartialEq, Eq)]
    pub struct KeyStop {
        /// The row's path: the entries above it and itself, an attached one
        /// marked `~` (`level/~entry`). The same entry shown twice has two.
        pub key: String,
        pub id: String,
        /// The row it is under (for an attached row, the row it is
        /// attached to); `None` outermost.
        pub parent: Option<String>,
        /// It holds entries: its fold opens and closes it.
        pub holds: bool,
        pub folded: bool,
        /// Attached here rather than living here (the dotted guide).
        pub hung: bool,
        /// Its row in the list; `None` for the Tab's own entry above it.
        pub list_row: Option<usize>,
        /// A tile of a grid's row.
        pub tile: bool,
    }

    /// [`LevelDisplay`]'s wait for a switch's question (KB).
    #[derive(Clone, Debug)]
    struct SwitchWait {
        row_key: String,
        row_id: SharedString,
        /// The question is up (a dialog over the workspace).
        asked: bool,
    }

    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    enum GridStep {
        Up,
        Down,
        Left,
        Right,
    }

    fn stop_key(parent: Option<&str>, id: &str, hung: bool) -> String {
        let mark = if hung { "~" } else { "" };
        match parent {
            Some(parent) => format!("{parent}/{mark}{id}"),
            None => format!("{mark}{id}"),
        }
    }

    pub struct LevelDisplay {
        pub host: LevelHost,
        pub display: Display,
        pub sort: SortOrder,
        pub folded: BTreeSet<String>,
        pub rows: Rc<Vec<Row>>,
        updated: UpdatedMap,
        focus: Option<FocusHandle>,
        /// The keyboard's stops, in order (KB; empty where it walks
        /// nothing), with the row the keyboard is on.
        stops: Rc<Vec<KeyStop>>,
        keys_row: Option<String>,
        /// A press on a row began: the press is not on blank space.
        pressing_row: bool,
        /// The row whose card the keyboard opened, and the keyboard in it.
        card_row: Option<String>,
        /// A switch run from the card (「层级」) whose question may come up:
        /// once it has been asked and answered, the card is back with the
        /// keyboard on that row.
        switch_wait: Option<SwitchWait>,
        card_keys: Option<Entity<CardKeys>>,
        /// The grid's tiles as last drawn, by stop.
        tile_bounds: RefCell<HashMap<String, Entity<Option<Bounds<Pixels>>>>>,
        me: WeakEntity<Self>,
        _observers: Vec<Subscription>,
        list: ListState,
        scroll: ScrollHandle,
        /// How often the rows were sorted and the update times read: a
        /// redraw with the same book does neither (T9 review).
        rebuilds: usize,
        timestamp_reads: usize,
        /// The widest tile name of the display's grid lines, in
        /// `name_units`: one least width for every line, so the lines'
        /// tiles share columns (UP, P4).
        tile_units: f32,
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
        let ws = host.page.workspace.upgrade();
        let view = cx.new(|cx| {
            let mut this = LevelDisplay::new(host, display);
            this.focus = Some(cx.focus_handle());
            this.me = cx.weak_entity();
            if this.walks() {
                this.card_keys = Some(CardKeys::make(cx));
            }
            if let Some(ws) = &ws {
                this._observers
                    .push(cx.observe(ws, |this: &mut LevelDisplay, ws, cx| {
                        if this.sync_workspace_memory(ws.read(cx)) {
                            cx.notify();
                        }
                    }));
            }
            this
        });
        if let Some(ws) = ws {
            // `make` may be invoked from inside `Workspace::render` or
            // `Workspace::prepare_editor` while `ws` is mutably borrowed;
            // defer the initial `ws.read(cx)` check until the outer update ends.
            let weak = view.downgrade();
            cx.defer(move |cx| {
                let _ = weak.update(cx, |this, cx| {
                    if this.sync_workspace_memory(ws.read(cx)) {
                        cx.notify();
                    }
                });
            });
        }
        let weak = view.downgrade();
        let (walks, focus) = {
            let this = view.read(cx);
            (this.walks(), this.focus.clone())
        };
        let refresh = weak.clone();
        let part = Rendered::new(view).on_refresh(move |book, cx| {
            let _ = refresh.update(cx, |this, cx| this.refresh(book, cx));
        });
        match focus.filter(|_| walks) {
            // A left-column Tab's list or grid: the keyboard walks it (KB).
            Some(focus) => {
                let (land, probe) = (weak.clone(), weak.clone());
                part.focus(focus)
                    .on_land(move |window, cx| {
                        let _ = land.update(cx, |this, cx| this.land(window, cx));
                    })
                    .on_keyboard_state(move |window, cx| {
                        probe
                            .upgrade()
                            .map(|this| this.read(cx).keyboard_state(window, cx))
                            .unwrap_or_default()
                    })
            }
            None => part,
        }
    }

    impl LevelDisplay {
        pub fn new(host: LevelHost, display: Display) -> Self {
            let mut sort = SortOrder::Manual;
            let row = format!(
                "memory:{}:{}",
                host.page.book_id,
                sort_memory_key(&host.level)
            );
            // A Tab's tree in the left column is always the order the author
            // dragged (Tab prototype, 2026-11-15): no sort of its own.
            if !host.surface.is_sidebar()
                && let Ok(Some(raw)) = host
                    .page
                    .library
                    .library()
                    .local_get(dr_shell::workspace::BOOK_MEMORY_SCOPE, &row)
                && let Ok(parsed) = serde_json::from_str::<String>(&raw)
                && let Some(saved) = SortOrder::parse(&parsed)
            {
                sort = saved;
            }
            let updated = if sort == SortOrder::Updated {
                updated_timestamps(&host.page.library, &host.page.book)
            } else {
                BTreeMap::new()
            };
            let timestamp_reads = usize::from(sort == SortOrder::Updated);
            // 「全部」 (the root's list in the left column) opens with the
            // outermost entries folded, as the Tab prototype draws it.
            let folded: BTreeSet<String> = match host.page.book.v3() {
                Some(v) if host.level == ROOT_LEVEL && host.surface == DisplaySurface::Sidebar => v
                    .roots
                    .iter()
                    .filter(|id| {
                        v.levels
                            .get(*id)
                            .is_some_and(|l| !l.children.is_empty() || !l.members.is_empty())
                    })
                    .cloned()
                    .collect(),
                _ => BTreeSet::new(),
            };
            let mut this = Self {
                host,
                display,
                sort,
                folded,
                rows: Rc::default(),
                updated,
                focus: None,
                stops: Rc::default(),
                keys_row: None,
                pressing_row: false,
                card_row: None,
                switch_wait: None,
                card_keys: None,
                tile_bounds: RefCell::default(),
                me: WeakEntity::new_invalid(),
                _observers: Vec::new(),
                list: ListState::new(0, ListAlignment::Top, px(300.0)),
                scroll: ScrollHandle::new(),
                rebuilds: 0,
                timestamp_reads,
                tile_units: 0.0,
            };
            this.rebuild();
            this
        }
        /// How many times the rows were built (sorted, remeasured) and the
        /// update times read since the list was made.
        pub fn work_done(&self) -> (usize, usize) {
            (self.rebuilds, self.timestamp_reads)
        }
        fn read_timestamps(&mut self) {
            self.timestamp_reads += 1;
            self.updated = updated_timestamps(&self.host.page.library, &self.host.page.book);
        }
        pub fn is_lane(&self) -> bool {
            self.host
                .page
                .book
                .v3()
                .is_some_and(|v| v.is_lane(&self.host.level))
        }
        pub fn can_reorder(&self) -> bool {
            matches!(self.display, Display::List | Display::Grid)
                && self.sort == SortOrder::Manual
                && self.host.surface != DisplaySurface::Members
        }
        /// Whether a row hung on `host` takes an order drop from another row
        /// hung there: only while the list shows that order, `host`'s scale
        /// when it is a lane, else the manual order (as `rows_sorted` sorts
        /// them). Under another sort the drop would write an order nobody
        /// sees, just as for the rows living here (T9 review).
        pub fn hung_can_reorder(&self, host: &str) -> bool {
            !matches!(self.display, Display::List | Display::Grid)
                || self.sort == SortOrder::Manual
                || self.host.page.book.v3().is_some_and(|v| v.is_lane(host))
        }
        fn sync_workspace_memory(&mut self, ws: &dr_shell::Workspace) -> bool {
            if ws.book_id != self.host.page.book_id {
                return false;
            }
            let key = sort_memory_key(&self.host.level);
            let next = if let Some(saved) = ws
                .book_memory(&key)
                .and_then(|v| v.as_str())
                .and_then(SortOrder::parse)
            {
                Some(saved)
            } else if ws.book_memory_ready() {
                Some(SortOrder::Manual)
            } else {
                None
            };
            let Some(next) = next else {
                return false;
            };
            if self.sort == next {
                return false;
            }
            self.sort = next;
            if self.sort == SortOrder::Updated {
                self.read_timestamps();
            }
            self.rebuild();
            true
        }
        pub fn set_sort(&mut self, sort: SortOrder, cx: &mut Context<Self>) {
            let changed = self.sort != sort;
            self.sort = sort;
            if self.sort == SortOrder::Updated {
                self.read_timestamps();
            }
            if changed || self.sort == SortOrder::Updated {
                self.rebuild();
            }
            let key = sort_memory_key(&self.host.level);
            let val = serde_json::json!(sort.as_str());
            if let Some(ws) = self.host.page.workspace.upgrade() {
                ws.update(cx, |ws, cx| {
                    ws.set_book_memory(&key, val, cx);
                    cx.notify();
                });
            } else {
                let lib = self.host.page.library.clone();
                let book = self.host.page.book_id.clone();
                let row = format!("memory:{book}:{key}");
                let raw = val.to_string();
                let _ = lib.library().local_set(
                    dr_shell::workspace::BOOK_MEMORY_SCOPE,
                    &row,
                    &raw,
                    Some(&book),
                );
            }
            cx.notify();
        }
        /// How many tiles a grid line holds.
        fn tiles_per_row(&self) -> usize {
            if self.host.surface == DisplaySurface::Sidebar {
                2
            } else {
                4
            }
        }
        fn rebuild(&mut self) {
            self.rebuilds += 1;
            let columns = self.tiles_per_row();
            let rows = rows_sorted(
                &self.host.page.book,
                &self.host.level,
                self.display,
                self.host.surface,
                self.sort,
                &self.updated,
                &self.folded,
                columns,
            );
            self.tile_units = self
                .host
                .page
                .book
                .v3()
                .map(|v| {
                    rows.iter()
                        .filter_map(|row| match row {
                            Row::Tiles { ids, .. } => Some(ids),
                            _ => None,
                        })
                        .flatten()
                        .filter_map(|id| v.entry(id))
                        .map(|e| super::name_units(&e.title))
                        .fold(0.0, f32::max)
                })
                .unwrap_or(0.0);
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
            self.restop();
        }
        pub fn scroll_state(&self) -> ListState {
            self.list.clone()
        }
        /// Takes a new book snapshot. The same snapshot again changes
        /// nothing: no sort, no update times read from the library, no
        /// redraw (a surface may hand it over on every frame).
        pub fn refresh(&mut self, book: Rc<Book>, cx: &mut Context<Self>) {
            if Rc::ptr_eq(&self.host.page.book, &book) {
                return;
            }
            self.host.page.book = book;
            if self.sort == SortOrder::Updated {
                self.read_timestamps();
            }
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

        // The keyboard (KB, `kernel-v5.md` §15 item 48): a left-column Tab's
        // list or grid. ↑↓ walk the rows and stop at either end (↑ on the
        // first goes to the Tab row); → unfolds, then goes to the first row
        // inside; ← folds, then goes to the row outside (an attached row's
        // to the row it is attached to); Enter previews the row's page with
        // the keyboard staying here, and on the row in front keeps it and
        // goes there; Space opens the row's card. A grid's tiles go by where
        // they were drawn. Typing does nothing.

        /// Whether the keyboard walks this list: a left-column Tab's list
        /// or grid (not a board, islands, the book, an entry page's lists).
        pub fn walks(&self) -> bool {
            self.host.surface == DisplaySurface::Sidebar
                && matches!(self.display, Display::List | Display::Grid)
        }

        /// Whether the keyboard walks it now: not while the left column
        /// fills (that list takes no keys this round).
        fn keys_live(&self, cx: &App) -> bool {
            self.walks()
                && !self
                    .host
                    .page
                    .workspace
                    .upgrade()
                    .is_some_and(|ws| ws.read(cx).is_filled(dr_shell::workspace::FillPlace::Left))
        }

        /// Whether the keyboard is in this tree (a row's card included).
        pub fn has_keyboard(&self, window: &Window, cx: &App) -> bool {
            self.focus
                .as_ref()
                .is_some_and(|f| f.contains_focused(window, cx))
        }

        /// The keyboard's stops, in order.
        pub fn stops(&self) -> Rc<Vec<KeyStop>> {
            self.stops.clone()
        }

        /// The row the keyboard is on (its stop's key).
        pub fn keyboard_row(&self) -> Option<&str> {
            self.keys_row.as_deref()
        }

        /// The row whose card the keyboard opened, while open.
        pub fn card_row(&self, cx: &App) -> Option<&str> {
            self.card_row.as_deref().filter(|_| {
                self.card_keys
                    .as_ref()
                    .is_some_and(|k| k.read(cx).is_open())
            })
        }

        /// The keyboard in the card it opened.
        pub fn card_keys(&self) -> Option<Entity<CardKeys>> {
            self.card_keys.clone()
        }

        fn keyboard_state(&self, window: &Window, cx: &App) -> serde_json::Value {
            let stop = |key: Option<&str>| {
                key.and_then(|key| self.stops.iter().find(|s| s.key == key))
                    .map(|s| serde_json::json!({"key": s.key, "entry": s.id, "hung": s.hung}))
            };
            serde_json::json!({
                "focused": self.has_keyboard(window, cx),
                "row": stop(self.keys_row.as_deref()),
                "card": stop(self.card_row(cx)),
                "cardRow": self.card_keys.as_ref().and_then(|k| k.read(cx).at()),
            })
        }

        /// The stops again (the rows or the folds changed); the keyboard on
        /// a row that went goes to the nearest row still shown above it
        /// (a fold the pointer closed), else to the first.
        fn restop(&mut self) {
            let stops = self.make_stops();
            if let Some(key) = &self.keys_row
                && !stops.iter().any(|s| &s.key == key)
            {
                let mut at = key.as_str();
                let mut found = None;
                while let Some(cut) = at.rfind('/') {
                    at = &at[..cut];
                    if stops.iter().any(|s| s.key == at) {
                        found = Some(at.to_owned());
                        break;
                    }
                }
                self.keys_row = found.or_else(|| stops.first().map(|s| s.key.clone()));
            }
            self.stops = Rc::new(stops);
        }

        fn make_stops(&self) -> Vec<KeyStop> {
            let Some(v) = self.host.page.book.v3().filter(|_| self.walks()) else {
                return Vec::new();
            };
            let mut out = Vec::new();
            let header = (self.host.level != ROOT_LEVEL).then(|| self.host.level.clone());
            if let Some(level) = &header {
                out.push(KeyStop {
                    key: stop_key(None, level, false),
                    id: level.clone(),
                    parent: None,
                    holds: true,
                    folded: false,
                    hung: false,
                    list_row: None,
                    tile: false,
                });
            }
            // The row last seen at each depth: the parent of the next one
            // a level deeper.
            let mut above: Vec<String> = Vec::new();
            let parent_at = |above: &[String], depth: usize| {
                if depth == 0 {
                    header.as_deref().map(|h| stop_key(None, h, false))
                } else {
                    above.get(depth - 1).cloned()
                }
            };
            for (i, row) in self.rows.iter().enumerate() {
                match row {
                    Row::Entry { id, depth } | Row::Member { id, depth, .. } => {
                        let hung = matches!(row, Row::Member { .. });
                        let parent = parent_at(&above, *depth);
                        let key = stop_key(parent.as_deref(), id, hung);
                        above.truncate(*depth);
                        above.push(key.clone());
                        out.push(KeyStop {
                            key,
                            id: id.clone(),
                            parent,
                            holds: v.levels.contains_key(id),
                            folded: self.folded.contains(id),
                            hung,
                            list_row: Some(i),
                            tile: false,
                        });
                    }
                    Row::Tiles { ids, depth } => {
                        let parent = parent_at(&above, *depth);
                        above.truncate(*depth);
                        for id in ids {
                            out.push(KeyStop {
                                key: stop_key(parent.as_deref(), id, false),
                                id: id.clone(),
                                parent: parent.clone(),
                                holds: false,
                                folded: false,
                                hung: false,
                                list_row: Some(i),
                                tile: true,
                            });
                        }
                    }
                    Row::Island { .. } => {}
                }
            }
            out
        }

        /// Where the keyboard lands coming into the tree: the row of the
        /// page in front (its first, when shown twice); folded away, the
        /// nearest row shown above it where it lives; not in this Tab (or
        /// nothing in front), the first row.
        fn landing(&self, cx: &App) -> Option<String> {
            let front =
                self.host
                    .page
                    .workspace
                    .upgrade()
                    .and_then(|ws| match ws.read(cx).nav.current() {
                        Some(Target::Entry { id, .. }) | Some(Target::Book(id)) => {
                            Some(id.to_string())
                        }
                        _ => None,
                    });
            let find = |id: &str| {
                self.stops
                    .iter()
                    .find(|s| s.id == id)
                    .map(|s| s.key.clone())
            };
            if let Some(front) = front {
                if let Some(key) = find(&front) {
                    return Some(key);
                }
                let v = self.host.page.book.v3();
                let mut at = v
                    .and_then(|v| v.entry(&front))
                    .and_then(|e| e.parent.clone());
                let mut guard = 0;
                while let Some(parent) = at {
                    if let Some(key) = find(&parent) {
                        return Some(key);
                    }
                    guard += 1;
                    if guard > 64 {
                        break;
                    }
                    at = v
                        .and_then(|v| v.entry(&parent))
                        .and_then(|e| e.parent.clone());
                }
            }
            self.stops.first().map(|s| s.key.clone())
        }

        /// The keyboard comes into the tree (⌘⇧L, ↓ from the Tab row, a
        /// click on a Tab from the tree): it lands, and the tree has it.
        pub fn land(&mut self, window: &mut Window, cx: &mut Context<Self>) {
            if !self.keys_live(cx) {
                return;
            }
            let key = self.landing(cx);
            self.card_row = None;
            self.switch_wait = None;
            if let Some(keys) = &self.card_keys {
                keys.update(cx, |k, _| k.close());
            }
            if let Some(focus) = &self.focus {
                window.focus(focus, cx);
            }
            self.go(key, cx);
        }

        /// The keyboard onto the row `key`, the tree scrolling (only the
        /// tree) to show it.
        fn go(&mut self, key: Option<String>, cx: &mut Context<Self>) {
            if let Some(row) = key
                .as_ref()
                .and_then(|k| self.stops.iter().find(|s| &s.key == k))
                .and_then(|s| s.list_row)
            {
                self.list.scroll_to_reveal_item(row);
            }
            self.keys_row = key;
            cx.notify();
        }

        fn at(&self) -> Option<(usize, KeyStop)> {
            let key = self.keys_row.as_ref()?;
            self.stops
                .iter()
                .position(|s| &s.key == key)
                .map(|i| (i, self.stops[i].clone()))
        }

        /// The tree's own key, if the keyboard walks it now: `None` passes
        /// the key on.
        fn keyed(
            &mut self,
            window: &mut Window,
            cx: &mut Context<Self>,
        ) -> Option<(usize, KeyStop)> {
            if !self.keys_live(cx) {
                cx.propagate();
                return None;
            }
            match self.at() {
                Some(at) => Some(at),
                None => {
                    self.land(window, cx);
                    None
                }
            }
        }

        fn key_up(&mut self, window: &mut Window, cx: &mut Context<Self>) {
            let Some((i, stop)) = self.keyed(window, cx) else {
                return;
            };
            if stop.tile && self.display == Display::Grid {
                return self.grid_step(GridStep::Up, i, &stop, cx);
            }
            if i == 0 {
                // The Tab row is above the first row.
                if let Some(sidebar) = self
                    .host
                    .page
                    .workspace
                    .upgrade()
                    .and_then(|ws| ws.read(cx).v3_sidebar.clone())
                {
                    sidebar.update(cx, |s, cx| s.keyboard_to_tabs(window, cx));
                }
                return;
            }
            let key = self.stops[i - 1].key.clone();
            self.go(Some(key), cx);
        }

        fn key_down(&mut self, window: &mut Window, cx: &mut Context<Self>) {
            let Some((i, stop)) = self.keyed(window, cx) else {
                return;
            };
            if stop.tile && self.display == Display::Grid {
                return self.grid_step(GridStep::Down, i, &stop, cx);
            }
            if let Some(next) = self.stops.get(i + 1) {
                let key = next.key.clone();
                self.go(Some(key), cx);
            }
        }

        fn key_right(&mut self, window: &mut Window, cx: &mut Context<Self>) {
            let Some((i, stop)) = self.keyed(window, cx) else {
                return;
            };
            if stop.tile && self.display == Display::Grid {
                return self.grid_step(GridStep::Right, i, &stop, cx);
            }
            if stop.holds && stop.folded {
                self.toggle(&stop.id, cx);
                return;
            }
            if stop.holds
                && let Some(first) = self
                    .stops
                    .get(i + 1)
                    .filter(|next| next.parent.as_deref() == Some(stop.key.as_str()))
            {
                let key = first.key.clone();
                self.go(Some(key), cx);
            }
        }

        fn key_left(&mut self, window: &mut Window, cx: &mut Context<Self>) {
            let Some((i, stop)) = self.keyed(window, cx) else {
                return;
            };
            if stop.tile && self.display == Display::Grid {
                return self.grid_step(GridStep::Left, i, &stop, cx);
            }
            if stop.holds && !stop.folded && stop.list_row.is_some() {
                self.toggle(&stop.id, cx);
                return;
            }
            if let Some(parent) = stop.parent {
                self.go(Some(parent), cx);
            }
        }

        /// Enter: the row's page, a preview, the keyboard staying here;
        /// on the row of the page in front, that page kept and the keyboard
        /// there. The row's own page, not an unfolding.
        fn key_enter(&mut self, window: &mut Window, cx: &mut Context<Self>) {
            let Some((_, stop)) = self.keyed(window, cx) else {
                return;
            };
            let Some(target) = entry_target(&stop.id) else {
                return;
            };
            let Some(ws) = self.host.page.workspace.upgrade() else {
                return;
            };
            let in_front = ws
                .read(cx)
                .nav
                .current()
                .is_some_and(|current| current.same_page(&target));
            if in_front {
                ws.update(cx, |ws, cx| {
                    ws.open(target, Open::KEEP, cx);
                    ws.keyboard_to_page(window, cx);
                });
            } else {
                ws.update(cx, |ws, cx| ws.open(target, Open::PREVIEW.stay(), cx));
            }
        }

        /// Space: the row's card, the keyboard on its first row.
        fn key_space(&mut self, window: &mut Window, cx: &mut Context<Self>) {
            let Some((_, stop)) = self.keyed(window, cx) else {
                return;
            };
            let Some(keys) = self.card_keys.clone() else {
                return;
            };
            self.switch_wait = None;
            self.card_row = Some(stop.key);
            keys.update(cx, |k, cx| k.open(window, cx));
            cx.notify();
        }

        /// Esc: back to the page (a layer over the workspace goes first).
        fn key_back(&mut self, window: &mut Window, cx: &mut Context<Self>) {
            if !self.keys_live(cx) {
                cx.propagate();
                return;
            }
            let Some(ws) = self.host.page.workspace.upgrade() else {
                return;
            };
            if ws.read(cx).top_layer().is_some() {
                cx.propagate();
                return;
            }
            ws.update(cx, |ws, cx| ws.keyboard_to_page(window, cx));
        }

        /// Esc or Space in the card: it closes, the keyboard back on its row.
        fn card_close(&mut self, window: &mut Window, cx: &mut Context<Self>) {
            self.switch_wait = None;
            if let Some(keys) = &self.card_keys {
                keys.update(cx, |k, cx| {
                    k.close();
                    cx.notify();
                });
            }
            self.card_row = None;
            if let Some(focus) = &self.focus {
                window.focus(focus, cx);
            }
            cx.notify();
        }

        /// Enter in the card: its row runs. A switch (「层级」) leaves the
        /// card open, the keyboard on it; 「放进最近删除」 closes it, the
        /// keyboard on the row after (the one before, at the end); every
        /// other row closes it, the keyboard going where the row goes (a
        /// page, a dialog).
        fn card_confirm(&mut self, window: &mut Window, cx: &mut Context<Self>) {
            self.switch_wait = None;
            let (Some(keys), Some(row_key)) = (self.card_keys.clone(), self.card_row.clone())
            else {
                return;
            };
            // The row the keyboard is on, by its id: rows that came or went
            // since the card was drawn (a sync) never shift it onto another;
            // a row that is gone runs nothing.
            let Some(at_id) = keys.read(cx).at_id() else {
                return;
            };
            let Some(stop) = self.stops.iter().find(|s| s.key == row_key).cloned() else {
                return;
            };
            let (Some(target), Some(ws)) =
                (entry_target(&stop.id), self.host.page.workspace.upgrade())
            else {
                return;
            };
            let host = dr_shell::pages::PageMenuHost::of(&ws, cx);
            let rows =
                dr_shell::v3::card::rows(&target, &host, &dr_shell::pages::CardRows::default(), cx);
            let Some(row) = rows.iter().find(|r| r.id == at_id) else {
                return;
            };
            let Some(run) = row.run.clone() else {
                return;
            };
            if row.stays_open {
                // A question it asks takes the keyboard for a while; the card
                // comes back on this row once it is answered.
                self.switch_wait = Some(SwitchWait {
                    row_key,
                    row_id: row.id.clone(),
                    asked: false,
                });
                window.defer(cx, move |window, cx| run(window, cx));
                return;
            }
            let trash = row.id.as_ref() == dr_shell::v3::card::TRASH;
            if trash {
                let next = self.after_trash(&stop, cx);
                self.card_close(window, cx);
                self.go(next, cx);
                window.defer(cx, move |window, cx| run(window, cx));
                return;
            }
            keys.update(cx, |k, cx| {
                k.close();
                cx.notify();
            });
            self.card_row = None;
            cx.notify();
            // The row has the keyboard while the row runs: a dialog that
            // gives back the keyboard it found on closing gives it back here.
            let Some(tree) = self.focus.clone() else {
                return;
            };
            window.focus(&tree, cx);
            window.defer(cx, move |window, cx| {
                run(window, cx);
                // Nothing took the keyboard (a page opened, not a dialog):
                // it goes to the page in front.
                if tree.is_focused(window) {
                    ws.update(cx, |ws, cx| ws.keyboard_to_page(window, cx));
                }
            });
        }

        /// A switch run from the card (KB): while its question is up, wait;
        /// once it is answered (either way), the card is back, the keyboard
        /// on the switch's row. Without a question the card never closed;
        /// closed otherwise, the wait ends.
        fn follow_switch(&mut self, window: &mut Window, cx: &mut Context<Self>) {
            let Some(wait) = self.switch_wait.as_mut() else {
                return;
            };
            let Some(keys) = self.card_keys.clone() else {
                self.switch_wait = None;
                return;
            };
            let modal = self
                .host
                .page
                .workspace
                .upgrade()
                .is_some_and(|ws| ws.read(cx).modal());
            if modal {
                wait.asked = true;
                return;
            }
            if !wait.asked {
                if !keys.read(cx).is_open() {
                    self.switch_wait = None;
                }
                return;
            }
            let Some(wait) = self.switch_wait.take() else {
                return;
            };
            if !self.stops.iter().any(|s| s.key == wait.row_key) {
                return;
            }
            self.card_row = Some(wait.row_key);
            // On the next frame: closing the question gives the page the
            // keyboard, and a body hands it on to its editor a moment later
            // (a deferred focus); the card takes it after that.
            window.on_next_frame(move |window, cx| {
                keys.update(cx, |k, cx| {
                    k.open_on(&wait.row_id, window, cx);
                    cx.notify();
                });
            });
        }

        /// The row the keyboard goes to once `stop`'s entry is in Recently
        /// Deleted: the next row that stays (not it, not what lives under it,
        /// wherever shown), else the one before.
        fn after_trash(&self, stop: &KeyStop, cx: &App) -> Option<String> {
            let mut gone: BTreeSet<String> = BTreeSet::from([stop.id.clone()]);
            if let Some(v) = self.host.page.book.v3() {
                let mut todo = vec![stop.id.clone()];
                while let Some(id) = todo.pop() {
                    if let Some(l) = v.levels.get(&id) {
                        for child in &l.children {
                            if gone.insert(child.clone()) {
                                todo.push(child.clone());
                            }
                        }
                    }
                }
            }
            let _ = cx;
            let gone_keys: Vec<&str> = self
                .stops
                .iter()
                .filter(|s| gone.contains(&s.id))
                .map(|s| s.key.as_str())
                .collect();
            let stays = |s: &&KeyStop| {
                !gone.contains(&s.id)
                    && !gone_keys
                        .iter()
                        .any(|k| s.key.starts_with(&format!("{k}/")))
            };
            let i = self.stops.iter().position(|s| s.key == stop.key)?;
            self.stops[i + 1..]
                .iter()
                .find(stays)
                .or_else(|| self.stops[..i].iter().rev().find(stays))
                .map(|s| s.key.clone())
        }

        /// ←→↑↓ on a grid's tile, by where the tiles were drawn: ← → one
        /// tile (← on the first goes out to the row it is under), ↑↓ the
        /// line above or below, to its tile nearest across; past the first
        /// or last line, out of the grid to the row before or after it.
        fn grid_step(&mut self, step: GridStep, i: usize, stop: &KeyStop, cx: &mut Context<Self>) {
            // The run of tiles this one is in.
            let mut first = i;
            while first > 0
                && self.stops[first - 1].tile
                && self.stops[first - 1].parent == stop.parent
            {
                first -= 1;
            }
            let mut last = i;
            while last + 1 < self.stops.len()
                && self.stops[last + 1].tile
                && self.stops[last + 1].parent == stop.parent
            {
                last += 1;
            }
            let tiles: Vec<KeyStop> = self.stops[first..=last].to_vec();
            let at = i - first;
            let next = match step {
                GridStep::Left if at > 0 => Some(tiles[at - 1].key.clone()),
                GridStep::Left => stop.parent.clone(),
                GridStep::Right => tiles.get(at + 1).map(|t| t.key.clone()),
                GridStep::Up | GridStep::Down => {
                    // Last frame's cells; a tile not drawn falls back on the
                    // list's own lines.
                    let drawn: Option<Vec<(f32, f32)>> = {
                        let bounds = self.tile_bounds.borrow();
                        tiles
                            .iter()
                            .map(|t| {
                                bounds.get(&t.key).and_then(|b| *b.read(cx)).map(|b| {
                                    (f32::from(b.center().x), f32::from(b.origin.y).round())
                                })
                            })
                            .collect()
                    };
                    let places: Vec<(f32, f32)> = drawn.unwrap_or_else(|| {
                        let mut col = 0;
                        let mut line = None;
                        tiles
                            .iter()
                            .map(|t| {
                                if line != t.list_row {
                                    line = t.list_row;
                                    col = 0;
                                }
                                col += 1;
                                (col as f32, t.list_row.unwrap_or(0) as f32)
                            })
                            .collect()
                    });
                    let mut lines: Vec<f32> = places.iter().map(|p| p.1).collect();
                    lines.sort_by(f32::total_cmp);
                    lines.dedup();
                    let here = places[at];
                    let li = lines.iter().position(|y| *y == here.1).unwrap_or(0);
                    let to = match step {
                        GridStep::Up => li.checked_sub(1),
                        _ => Some(li + 1).filter(|l| *l < lines.len()),
                    };
                    match to {
                        Some(l) => places
                            .iter()
                            .enumerate()
                            .filter(|(_, p)| p.1 == lines[l])
                            .min_by(|a, b| {
                                (a.1.0 - here.0).abs().total_cmp(&(b.1.0 - here.0).abs())
                            })
                            .map(|(j, _)| tiles[j].key.clone()),
                        None => {
                            let out = match step {
                                GridStep::Up => first.checked_sub(1),
                                _ => Some(last + 1).filter(|n| *n < self.stops.len()),
                            };
                            out.map(|n| self.stops[n].key.clone())
                        }
                    }
                }
            };
            if next.is_some() {
                self.go(next, cx);
            }
        }
        fn entry(
            &self,
            id: &str,
            depth: usize,
            tile: bool,
            window: &mut Window,
            cx: &mut App,
        ) -> AnyElement {
            // The Tab's own entry, above its list: the keyboard's first stop.
            let key = stop_key(None, id, false);
            self.entry_at(id, depth, tile, "root", None, None, Some(&key), window, cx)
        }
        fn entry_scoped(
            &self,
            id: &str,
            tile: bool,
            scope: &str,
            key: Option<&str>,
            window: &mut Window,
            cx: &mut App,
        ) -> AnyElement {
            self.entry_at(id, 0, tile, scope, None, None, key, window, cx)
        }
        /// The stop of list row `row` (its tile `id`'s for a grid's row).
        fn stop_of(&self, row: usize, id: &str) -> Option<String> {
            self.stops
                .iter()
                .find(|s| s.list_row == Some(row) && s.id == id)
                .map(|s| s.key.clone())
        }
        #[allow(clippy::too_many_arguments)]
        fn entry_at(
            &self,
            id: &str,
            depth: usize,
            tile: bool,
            scope: &str,
            hung_host: Option<&str>,
            board: Option<(String, (f64, f64))>,
            key: Option<&str>,
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
            let is_member = hung_host.is_some();
            let is_level = v.levels.contains_key(id);
            let row_can_reorder =
                self.can_reorder() && scope != "root" && !is_member && board.is_none();
            let hung_can_reorder =
                hung_host.is_some_and(|host| self.hung_can_reorder(host)) && board.is_none();
            let (mark, color) = self.host.page.book.mark(&target);
            let weak = self.host.page.workspace.clone();
            let card_ws = weak.upgrade();
            let selected = card_ws
                .as_ref()
                .is_some_and(|ws| ws.read(cx).nav.is_selected(&target));
            // The keyboard (KB): its row lit, the card it opened.
            let key = key.filter(|_| self.walks()).map(str::to_owned);
            let lit = key.is_some()
                && key == self.keys_row
                && self.keys_live(cx)
                && self.has_keyboard(window, cx);
            let card_keys = self
                .card_keys
                .clone()
                .filter(|_| key.is_some() && key == self.card_row);
            let open = target.clone();
            let me = self.me.clone();
            let tree_focus = self.focus.clone();
            let row_key = key.clone();
            let on_click = move |event: &ClickEvent, window: &mut Window, cx: &mut App| {
                let Some(ws) = weak.upgrade() else {
                    return;
                };
                let keep = event.click_count() > 1;
                let walked = row_key.is_some()
                    && me.upgrade().is_some_and(|this| this.read(cx).keys_live(cx));
                if !walked {
                    ws.update(cx, |ws, cx| {
                        ws.open(
                            open.clone(),
                            if keep { Open::KEEP } else { Open::PREVIEW },
                            cx,
                        )
                    });
                } else if keep {
                    // A double click keeps the page and gives it the keyboard.
                    ws.update(cx, |ws, cx| {
                        ws.open(open.clone(), Open::KEEP, cx);
                        ws.keyboard_to_page(window, cx);
                    });
                } else {
                    // A click previews the page; the keyboard stays in the
                    // tree, on this row.
                    ws.update(cx, |ws, cx| ws.open(open.clone(), Open::PREVIEW.stay(), cx));
                    let _ = me.update(cx, |this, cx| {
                        if let Some(keys) = &this.card_keys {
                            keys.update(cx, |k, _| k.close());
                        }
                        this.card_row = None;
                        this.switch_wait = None;
                        this.keys_row = row_key.clone();
                        cx.notify();
                    });
                    if let Some(focus) = &tree_focus {
                        window.focus(focus, cx);
                    }
                }
            };
            let cell_id: SharedString = format!("g2-entry-{}-{scope}-{id}", self.host.level).into();
            let cell = if tile || self.display == Display::Board && id != self.host.level {
                let theme = Theme::of(window, cx);
                // The keyboard's still ring (KB): a tile shows no other.
                let ring = key.is_some().then(|| {
                    let state = glass::use_state(
                        SharedString::from(format!("{cell_id}-keys")),
                        glass::Kind::Hidden,
                        glass::Mode::default(),
                        lit,
                        theme,
                        window,
                        cx,
                    );
                    glass::layer(
                        state,
                        glass::Spec::new(ring_tone(color, theme.palette.glass_clear), radius::SM)
                            .rim(RING_RIM),
                        theme,
                    )
                });
                let keyed_selector = cell_id.clone();
                div()
                    .id(cell_id.clone())
                    .when(lit, |el| {
                        el.debug_selector(move || format!("{keyed_selector}-keyboard"))
                    })
                    .relative()
                    .children(ring)
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
                    .child({
                        let name_selector = format!("g2-tile-name-{id}");
                        div()
                            .debug_selector(move || name_selector)
                            .flex_1()
                            .min_w_0()
                            .truncate()
                            .child(entry.title.clone())
                    })
                    .into_any_element()
            } else {
                let theme = Theme::of(window, cx);
                SandCell::new(cell_id, entry.title.clone())
                    .mark(mark)
                    .color_opt(color)
                    .selected(selected)
                    .keyboard(lit)
                    .font(if is_level { Role::Structure } else { Role::Ui })
                    .on_click(on_click)
                    // Where an attached entry lives, on the entry page's
                    // 「挂在这里的条目」.
                    .when(
                        is_member && self.host.surface == DisplaySurface::Members,
                        |cell| {
                            cell.child(
                                div()
                                    .flex_none()
                                    .font_role(Role::Ui)
                                    .type_px(theme.scale.caption, theme.scale.line_caption)
                                    .text_color(theme.palette.muted().solid())
                                    .child(dr_shell::v3::page::lives_in(
                                        &self.host.page.book,
                                        id,
                                        cx,
                                    )),
                            )
                        },
                    )
                    .into_any_element()
            };
            let cell = if let Some(ws) = card_ws {
                dr_shell::workspace::page_hover_card_keyed(
                    format!("g2-card-{}-{scope}-{id}", self.host.level),
                    cell,
                    &target,
                    &ws,
                    Default::default(),
                    card_keys,
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
            // Where a grid's tile was drawn, for the keyboard's ↑↓.
            if tile && let Some(key) = &key {
                self.tile_bounds
                    .borrow_mut()
                    .insert(key.clone(), bounds.clone());
            }
            let pressing = self.me.clone();
            let can_bounds = bounds.clone();
            let over_bounds = bounds.clone();
            let drop_bounds = bounds.clone();
            let grab_bounds = bounds.clone();
            let drag_focus = self.focus.clone();
            let drop_focus = self.focus.clone();
            let in_board = board.is_some();
            let start = window.use_keyed_state(
                SharedString::from(format!("g2-drag-start-{}-{scope}-{id}", self.host.level)),
                cx,
                |_, _| None::<Point<Pixels>>,
            );
            let pressed = start.clone();
            let mut drag = EntryDrag::new(self.host.page.clone(), id, entry.title.clone())
                .with_source(EntryDragSource { start, board });
            if let Some(host) = hung_host {
                drag = drag.with_hung_host(host);
            }
            let ghost = entry.title.clone();
            let page = self.host.page.clone();
            let can_page = page.clone();
            let onto = id.to_owned();
            let can_onto = onto.clone();
            let is_sidebar = self.host.surface.is_sidebar();
            let show_hung_guide = hung_host.is_some() && is_sidebar && !tile;
            let pad_left = if show_hung_guide {
                (depth.min(20) as f32 * 14.0).max(10.0)
            } else {
                depth.min(20) as f32 * 14.0
            };
            let palette = Theme::of(window, cx).palette;
            let body_px = Theme::of(window, cx).scale.body;
            let wash = palette.accent.alpha(0.08);
            let line = palette.accent.alpha(0.55);
            let dot_color = palette.ink(4).solid();
            let hung_guide = hung_host.filter(|_| show_hung_guide).map(|host| {
                let guide_sel = format!("v3-hung-guide-{host}-{id}");
                div()
                    .id(SharedString::from(format!(
                        "v3-hung-guide-{scope}-{host}-{id}"
                    )))
                    .debug_selector(move || guide_sel.clone())
                    .absolute()
                    .left(px(pad_left - 8.0))
                    .top(px(3.0))
                    .bottom(px(3.0))
                    .w(px(2.0))
                    .child(
                        canvas(
                            |bounds, _, _| bounds,
                            move |bounds, _, window, _| {
                                let mut y = f32::from(bounds.origin.y);
                                let end = y + f32::from(bounds.size.height);
                                let x = f32::from(bounds.origin.x);
                                while y + 2.0 <= end + 0.5 {
                                    window.paint_quad(fill(
                                        Bounds::new(point(px(x), px(y)), size(px(2.0), px(2.0))),
                                        dot_color,
                                    ));
                                    y += 4.5;
                                }
                            },
                        )
                        .size_full(),
                    )
            });
            let onto_host = hung_host.map(str::to_owned);
            let can_host = onto_host.clone();
            let slot_host = onto_host.clone();
            let slot_for = move |bounds: &Entity<Option<Bounds<Pixels>>>,
                                 window: &Window,
                                 cx: &App,
                                 drag: &EntryDrag,
                                 host: &Option<String>| {
                let reorder_hung = hung_can_reorder && host.is_some() && &drag.hung_host == host;
                bounds
                    .read(cx)
                    .as_ref()
                    .map(|b| {
                        drop_slot_at(
                            *b,
                            window.mouse_position(),
                            is_level && !reorder_hung,
                            tile,
                            row_can_reorder || reorder_hung,
                        )
                    })
                    .unwrap_or(if is_level || !row_can_reorder {
                        DropSlot::Into
                    } else {
                        DropSlot::After
                    })
            };
            let row_selector = key.clone();
            div()
                .id(SharedString::from(format!(
                    "g2-drag-{}-{scope}-{id}",
                    self.host.level
                )))
                .when_some(row_selector, |el, key| {
                    el.debug_selector(move || format!("kb-row-{key}"))
                })
                .relative()
                .when(!tile, |el| el.w_full())
                .pl(px(pad_left))
                .min_w_0()
                .when(tile, |el| {
                    el.min_w(px(super::tile_basis(&entry.title, body_px)))
                        .max_w(px(super::TILE_WIDEST))
                        .flex_1()
                })
                .on_mouse_down(MouseButton::Left, move |event, _, cx| {
                    pressed.update(cx, |start, _| *start = Some(event.position));
                    // A press on a row, not on the tree's blank space.
                    let _ = pressing.update(cx, |this, _| this.pressing_row = true);
                })
                .on_drag(drag, move |drag, _, window, cx| {
                    if let Some(focus) = &drag_focus {
                        focus.focus(window, cx);
                    }
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
                    el.can_drop(move |value, window, cx| {
                        value.downcast_ref::<EntryDrag>().is_some_and(|drag| {
                            if !drag.matches(&can_page) {
                                return false;
                            }
                            if drag.timeline_clip.is_some() {
                                return is_sidebar;
                            }
                            let slot = slot_for(&can_bounds, window, cx, drag, &can_host);
                            if let Some(from_host) = &drag.hung_host {
                                return resolve_hung_drop(
                                    &drag.page().book,
                                    &drag.entry,
                                    from_host,
                                    &can_onto,
                                    can_host.as_deref(),
                                    slot,
                                    window.modifiers().alt,
                                )
                                .is_some();
                            }
                            resolve_drop_with(
                                &drag.page().book,
                                &drag.entry,
                                &can_onto,
                                slot,
                                row_can_reorder,
                                is_member,
                                window.modifiers().alt,
                            )
                            .is_some()
                        })
                    })
                    .drag_over::<EntryDrag>(move |style, drag, window, cx| {
                        if drag.timeline_clip.is_some()
                            || (drag.hung_host.is_some() && drag.hung_host != slot_host)
                        {
                            return style.bg(wash);
                        }
                        let slot = slot_for(&over_bounds, window, cx, drag, &slot_host);
                        if slot == DropSlot::Into || tile {
                            style.bg(wash)
                        } else if slot == DropSlot::Before {
                            style.border_t_1().border_color(line)
                        } else {
                            style.border_b_1().border_color(line)
                        }
                    })
                    .on_drop(move |drag: &EntryDrag, window, cx| {
                        if let Some(focus) = &drop_focus {
                            focus.focus(window, cx);
                        }
                        let slot = slot_for(&drop_bounds, window, cx, drag, &onto_host);
                        let attach = window.modifiers().alt;
                        drop_on_resolved(
                            &page,
                            drag,
                            &onto,
                            slot,
                            row_can_reorder,
                            onto_host.as_deref(),
                            is_member,
                            attach,
                            cx,
                        );
                    })
                })
                .child(overlay::probe(bounds))
                .children(hung_guide)
                .child(cell)
                .into_any_element()
        }
        /// The compact index's columns (UP, kernel-v5 §15 item 50, P4):
        /// tiles of one width, as many to a line as it holds (`cap`, when
        /// the rows were cut to a count) and as fit, the last line from the
        /// left. The widest name (`units`) sets the least width, so a name
        /// is cut only past a tile's widest; a column is no wider than that,
        /// so the columns stand together from the left. The line's width is last
        /// frame's (`None` before it is drawn: the tiles then size as
        /// before); a change draws again.
        fn tile_columns(
            &self,
            key: String,
            cap: Option<usize>,
            units: f32,
            inset: f32,
            window: &mut Window,
            cx: &mut App,
        ) -> (Option<f32>, AnyElement) {
            let body_px = Theme::of(window, cx).scale.body;
            let least = super::units_basis(units, body_px);
            let cell = window.use_keyed_state(SharedString::from(key), cx, |_, _| None::<f32>);
            let width = cell.read(cx).map(|w| (w - inset).max(0.0)).map(|w| {
                let fit = ((w + super::TILE_GAP) / (least + super::TILE_GAP)).floor();
                let n = cap.map_or(fit, |cap| fit.min(cap as f32)).max(1.0);
                ((w - (n - 1.0) * super::TILE_GAP) / n)
                    .floor()
                    .min(super::TILE_WIDEST)
            });
            let probe = canvas(
                move |bounds, window, cx| {
                    let w = f32::from(bounds.size.width);
                    if *cell.read(cx) != Some(w) {
                        cell.update(cx, |c, _| *c = Some(w));
                        window.refresh();
                    }
                },
                |_, _, _, _| {},
            )
            .absolute()
            .top_0()
            .left_0()
            .size_full()
            .into_any_element();
            (width, probe)
        }

        fn row(
            &self,
            row: &Row,
            list_row: Option<usize>,
            entity: &Entity<Self>,
            scope: &str,
            window: &mut Window,
            cx: &mut App,
        ) -> AnyElement {
            let theme = Theme::of(window, cx);
            match row {
                Row::Entry { id, depth } | Row::Member { id, depth, .. } => {
                    let hung_host = match row {
                        Row::Member { host, .. } => Some(host.as_str()),
                        _ => None,
                    };
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
                                // Folding with the pointer leaves the keyboard
                                // where it was (the prototype).
                                .when(self.walks(), |el| {
                                    el.on_mouse_down(MouseButton::Left, |_, window, _| {
                                        window.prevent_default()
                                    })
                                })
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
                    let key = list_row.and_then(|i| self.stop_of(i, id));
                    row.child(div().flex_1().min_w_0().child(self.entry_at(
                        id,
                        *depth,
                        false,
                        scope,
                        hung_host,
                        None,
                        key.as_deref(),
                        window,
                        cx,
                    )))
                    .into_any_element()
                }
                Row::Tiles { ids, depth } => {
                    let inset = *depth as f32 * 14.0;
                    let (width, probe) = self.tile_columns(
                        format!(
                            "g2-tiles-{}-{scope}-{}",
                            self.host.level,
                            ids.first().map(String::as_str).unwrap_or_default()
                        ),
                        Some(self.tiles_per_row()),
                        self.tile_units,
                        inset,
                        window,
                        cx,
                    );
                    div()
                        .relative()
                        .w_full()
                        .flex()
                        .flex_wrap()
                        .gap(px(super::TILE_GAP))
                        .py_1()
                        .pl(px(inset))
                        .child(probe)
                        .children(ids.iter().map(|id| {
                            let key = list_row.and_then(|i| self.stop_of(i, id));
                            super::in_column(
                                width,
                                self.entry_scoped(id, true, scope, key.as_deref(), window, cx),
                            )
                        }))
                        .into_any_element()
                }
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
                            None,
                            entity,
                            scope,
                            window,
                            cx,
                        ))
                        .child({
                            let units = self
                                .host
                                .page
                                .book
                                .v3()
                                .map(|v| {
                                    members
                                        .iter()
                                        .filter_map(|id| v.entry(id))
                                        .map(|e| super::name_units(&e.title))
                                        .fold(0.0, f32::max)
                                })
                                .unwrap_or(0.0);
                            let (width, probe) = self.tile_columns(
                                format!("g2-island-tiles-{}-{scope}-{id}", self.host.level),
                                None,
                                units,
                                0.0,
                                window,
                                cx,
                            );
                            div()
                                .relative()
                                .w_full()
                                .flex()
                                .flex_wrap()
                                .gap(px(super::TILE_GAP))
                                .child(probe)
                                .children(members.iter().map(|id| {
                                    super::in_column(
                                        width,
                                        self.entry_scoped(id, true, scope, None, window, cx),
                                    )
                                }))
                        })
                        .into_any_element()
                }
            }
        }
        fn board(&self, window: &mut Window, cx: &mut App) -> AnyElement {
            let ids = board_ids(&self.host.page.book, &self.host.level, self.host.surface);
            let content = div().flex().flex_col().gap_3().child(self.board_canvas(
                &ids,
                &format!("board-{:?}", self.host.surface),
                window,
                cx,
            ));
            let scroll = self.scroll.clone();
            let page = self.host.page.clone();
            let can_page = page.clone();
            let level = self.host.level.clone();
            let can_level = level.clone();
            let sidebar = self.host.surface.is_sidebar();
            div()
                .id("g2-board-scroll")
                .role(gpui::Role::Group)
                .aria_label(t(cx, keys::v3_shell::ENTRIES))
                .can_drop(move |value, _, _| {
                    value.downcast_ref::<EntryDrag>().is_some_and(|drag| {
                        drag.matches(&can_page)
                            && (sidebar && drag.timeline_clip.is_some()
                                || drag
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
                    drop_on_board(&page, &level, sidebar, drag, window, cx)
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
                    // Where a drop wrote it (`prepare_board`): the level's
                    // own scope, whichever block or Tab shows the board.
                    v.layout_position(&self.host.level, "board", id)
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
                            None,
                            Some((self.host.level.clone(), *position)),
                            None,
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
            self.follow_switch(window, cx);
            let focus = self.focus.get_or_insert_with(|| cx.focus_handle()).clone();
            let walks = self.walks();
            let mut root = div()
                .id(SharedString::from(format!(
                    "{}-{}",
                    if self.host.surface == DisplaySurface::Members {
                        "g2-members"
                    } else {
                        "g2-display"
                    },
                    self.host.level
                )))
                .track_focus(&focus)
                .when(walks, |el| {
                    let blank = focus.clone();
                    let selector = format!("kb-tree-{}", self.host.level);
                    el.debug_selector(move || selector)
                        .key_context(dr_shell::keymap::LEFT_TREE)
                        .on_action(cx.listener(|this, _: &left::Up, w, cx| this.key_up(w, cx)))
                        .on_action(cx.listener(|this, _: &left::Down, w, cx| this.key_down(w, cx)))
                        .on_action(cx.listener(|this, _: &left::Left, w, cx| this.key_left(w, cx)))
                        .on_action(
                            cx.listener(|this, _: &left::Right, w, cx| this.key_right(w, cx)),
                        )
                        .on_action(
                            cx.listener(|this, _: &left::Enter, w, cx| this.key_enter(w, cx)),
                        )
                        .on_action(
                            cx.listener(|this, _: &left::Space, w, cx| this.key_space(w, cx)),
                        )
                        .on_action(cx.listener(|this, _: &left::Back, w, cx| this.key_back(w, cx)))
                        // A card the keyboard opened: its Enter and its Esc or
                        // Space come here.
                        .on_action(cx.listener(|this, _: &hover_card::Confirm, w, cx| {
                            this.card_confirm(w, cx)
                        }))
                        .on_action(
                            cx.listener(|this, _: &hover_card::Close, w, cx| {
                                this.card_close(w, cx)
                            }),
                        )
                        // A press on the tree's blank space brings the keyboard
                        // in, landing as ⌘⇧L does; a press on a row puts it
                        // on that row (its click).
                        .on_mouse_down(
                            MouseButton::Left,
                            cx.listener(move |this, _: &MouseDownEvent, window, cx| {
                                let on_row = std::mem::take(&mut this.pressing_row);
                                if on_row || !this.keys_live(cx) {
                                    return;
                                }
                                if !blank.contains_focused(window, cx) {
                                    this.land(window, cx);
                                    window.prevent_default();
                                }
                            }),
                        )
                })
                .flex()
                .flex_col()
                .min_h_0()
                .w_full()
                .when(self.host.surface.is_sidebar(), |el| el.h_full())
                .when(!self.host.surface.is_sidebar(), |el| el.h(px(440.0)));
            if self.host.surface == DisplaySurface::Sidebar && self.host.level != ROOT_LEVEL {
                // In a view, the list's order is the view's scale: its name
                // above the list (`kernel-v5.md` §16 「层级的列表」).
                if let Some(view) = self
                    .host
                    .page
                    .book
                    .v3()
                    .and_then(|v| v.ordering_view(&self.host.level))
                {
                    root = root.child(dr_shell::v3::page::view_tag(view.name.clone(), window, cx));
                }
                // The selected root is itself an entry: open its level page
                // and use exactly the same common card as its descendants.
                root = root.child(self.entry(&self.host.level, 0, false, window, cx));
            }
            if matches!(self.display, Display::List | Display::Grid)
                && !matches!(
                    self.host.surface,
                    DisplaySurface::Members | DisplaySurface::Sidebar | DisplaySurface::BookTab
                )
            {
                let weak = cx.entity().downgrade();
                let sort_sel = format!("g2-sort-scroll-{}", self.host.level);
                root = root.child(
                    div()
                        .id(SharedString::from(sort_sel.clone()))
                        .debug_selector(move || sort_sel.clone())
                        .overflow_x_scroll()
                        .flex_shrink_0()
                        .child(
                            Segmented::new(
                                SharedString::from(format!("g2-sort-{}", self.host.level)),
                                [
                                    t(cx, keys::v3_levels::SORT_MANUAL),
                                    t(cx, keys::v3_levels::SORT_UPDATED),
                                    t(cx, keys::v3_levels::SORT_CREATED),
                                    t(cx, keys::v3_levels::SORT_NAME),
                                ],
                                self.sort.index(),
                            )
                            .on_change(move |index, _, cx| {
                                let _ = weak.update(cx, |this, cx| {
                                    this.set_sort(SortOrder::from_index(index), cx);
                                });
                            }),
                        ),
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
                                this.row(
                                    &rows[i],
                                    Some(i),
                                    &entity,
                                    &format!("row-{i}"),
                                    window,
                                    cx,
                                )
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

/// A grid tile's least width for `name` at the interface's body size: its
/// 8px insets, the 10px mark and its 6px gap, and the name in `body_px`
/// characters (a CJK character is a full em, Latin about 0.62). It counted
/// 12.5px a character, short of the 16px of the standard size, so a
/// four-character name (「周记面馆」) was cut to 「周记…」 with room beside it.
pub fn tile_basis(name: &str, body_px: f32) -> f32 {
    units_basis(name_units(name), body_px)
}

/// A name's width in ems: a CJK character a full em, Latin about 0.62, a
/// space 0.35.
fn name_units(name: &str) -> f32 {
    name.chars()
        .map(|c| {
            if c == ' ' {
                0.35
            } else if c.is_ascii() {
                0.62
            } else {
                1.0
            }
        })
        .sum()
}

/// A tile's least width for a name `units` ems wide.
fn units_basis(units: f32, body_px: f32) -> f32 {
    (TILE_CHROME + units * body_px).clamp(80.0, TILE_WIDEST)
}

/// A tile's widest: a longer name is cut.
const TILE_WIDEST: f32 = 172.0;

/// The gap between a compact index's tiles.
const TILE_GAP: f32 = 4.0;

/// A tile in its column: `width` wide when the line's columns are known.
fn in_column(width: Option<f32>, tile: gpui::AnyElement) -> gpui::AnyElement {
    use gpui::{IntoElement as _, ParentElement as _, Styled as _};
    match width {
        Some(w) => gpui::div()
            .flex_none()
            .w(gpui::px(w))
            .overflow_hidden()
            .child(tile)
            .into_any_element(),
        None => tile,
    }
}

/// A tile's width besides its name: the 8px insets either side, the 10px
/// mark and its 6px gap, and 4px for a glyph's side bearings.
const TILE_CHROME: f32 = 8.0 * 2.0 + 10.0 + 6.0 + 4.0;
