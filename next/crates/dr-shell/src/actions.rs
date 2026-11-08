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
        /// Closes the book and returns to the bookshelf (⇧⌘W).
        CloseProject,
        /// The Project Home with its create row (⌘N).
        NewEntity,
        /// The Project Home (⌘⌥1).
        ShowProjectHome,
        /// The whole book in one tab (⌘⌥2).
        ShowWholeBook,
        /// The story graph Super View (⌘⌥3).
        ToggleStoryGraph,
        /// The element overview Super View (⌘⌥4).
        ToggleElementOverview,
        /// The review and materials Super View (⌘⌥5).
        ToggleReviewMaterials,
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
        /// Esc: closes the topmost layer (a popover, Settings, a Super View).
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
