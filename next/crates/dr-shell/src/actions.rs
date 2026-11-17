//! The shell's actions. Every shortcut and menu item dispatches one of these
//! (or an editor's own, such as `prose_editor::ToggleBold`); nothing listens
//! to raw key events. Opening a panel or a dialog is an action too, not an
//! event on a bus (simplifications.md, 「全局事件总线」).

use gpui::actions;

actions!(
    workspace,
    [
        /// Opens or closes the left sidebar.
        ToggleLeftSidebar,
        /// The keyboard into the left column (⌘⇧L, KB): its tree, or its
        /// Tab row; pressed again there, back to the page. A closed column
        /// opens first; a filled one does nothing.
        FocusLeftSidebar,
        /// Opens or closes the right sidebar.
        ToggleRightSidebar,
        /// The previous page (⌘[).
        GoBack,
        /// The next page (⌘]).
        GoForward,
        /// The tab to the left, wrapping.
        PreviousTab,
        /// The tab to the right, wrapping.
        NextTab,
        /// Closes the active tab (⌘W).
        CloseActiveTab,
        /// The Project Home with its create row (⌘N).
        NewEntity,
        /// The Project Home (⌘⌥1).
        ShowProjectHome,
        /// 全部项目: the row of projects that drops from the top of the
        /// workspace (the button right of the traffic lights).
        ToggleProjects,
        /// The bottom timeline (⌘J).
        ToggleBottomTimeline,
        /// Immersive writing (⌘⇧↩).
        ToggleImmersiveWriting,
        /// Find in the current editor (⌘F).
        FindInEditor,
        /// Find and replace in the current editor (⌥⌘F / Ctrl+H).
        ReplaceInEditor,
        /// Search the whole book (⇧⌘F).
        GlobalSearch,
        /// Opens or closes the notification center.
        ToggleNotifications,
        /// Opens the feedback dialog (M39, [`crate::dialogs`]).
        SendFeedback,
        /// Imports Markdown, text and Word files into the open book (M41,
        /// `dr-view-transfer` takes it with `cx.on_action`).
        ImportDocuments,
        /// Settings → 本地数据 「导出备份…」: the whole library as a `.drifting`
        /// file (M41, `dr-view-transfer` takes it).
        BackupLibrary,
        /// Settings → 本地数据 「选择备份…」: replaces the library with a
        /// backup (M41, `dr-view-transfer` takes it).
        RestoreLibrary,
        /// Esc: closes the topmost layer (a popover, Settings, a panel fill).
        Dismiss,
    ]
);

actions!(
    app,
    [
        /// Opens the About window.
        About,
        /// Opens Settings.
        OpenSettings,
        /// Hides the app (macOS).
        Hide,
        /// Hides every other app (macOS).
        HideOthers,
        /// Shows every hidden app (macOS).
        ShowAll,
        /// Quits the app: saves, hands over, then quits.
        Quit,
    ]
);

actions!(
    edit,
    [
        /// Undoes the focused view's last change.
        Undo,
        /// Redoes the focused view's last undone change.
        Redo,
        /// Cuts the selection.
        Cut,
        /// Copies the selection.
        Copy,
        /// Pastes the clipboard.
        Paste,
        /// Selects everything in the focused view.
        SelectAll,
    ]
);

actions!(
    window,
    [
        /// Minimizes the active window.
        Minimize,
        /// Zooms the active window.
        Zoom,
        /// Closes the active window.
        CloseWindow,
        /// Brings every window of the app to the front.
        BringAllToFront,
    ]
);

/// The left column's own keys (KB, `kernel-v5.md` §15 item 48), bound in
/// its tree's ([`crate::keymap::LEFT_TREE`]) and its Tab row's
/// ([`crate::keymap::LEFT_TABS`]) key contexts only: not shortcuts, and
/// nothing anywhere else.
pub mod left {
    gpui::actions!(
        left_column,
        [
            /// ↑: the row above; on the tree's first row, the Tab row.
            Up,
            /// ↓: the row below; on the Tab row, the tree.
            Down,
            /// ←: fold, or the row outside; on the Tab row, the Tab before.
            Left,
            /// →: unfold, or the first row inside; on the Tab row, the Tab after.
            Right,
            /// Enter: open the row (a preview), or keep the row in front and
            /// go to its page.
            Enter,
            /// Space: the row's hover card.
            Space,
            /// Esc: back to the page.
            Back,
        ]
    );
}

/// RL (`v5-tracks.md` § RL, kernel-v5 § 19): after a relation is made in
/// place in the prose, the right sidebar opens on 「关系」, scrolls to row
/// `row` of the open book and flashes it. The prose side dispatches it; the
/// workspace handles it (`Workspace::reveal_relation_row`) and the rail
/// (`dr-view-relations`) scrolls to the row once it has drawn it
/// ([`crate::relations::request_reveal`]).
#[derive(Clone, Debug, PartialEq, Eq, gpui::Action)]
#[action(namespace = workspace, no_json)]
pub struct RevealRelationRow {
    /// The relation row's id (`RelationRow::id`).
    pub row: String,
}
