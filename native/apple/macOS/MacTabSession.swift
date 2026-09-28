import AppKit

/// Pages in the order a window showed them, as a browser keeps them:
/// recording after going back drops the pages ahead, and a page shown twice
/// in a row is kept once. At most `limit` pages are kept.
struct NavigationHistory<Entry: Equatable> {
    static var limit: Int { 100 }
    private(set) var entries: [Entry] = []
    /// The page 后退 and 前进 start from; -1 when there is none.
    private(set) var index = -1

    var canGoBack: Bool { index > 0 }
    var canGoForward: Bool { index + 1 < entries.count }
    var current: Entry? { entries.indices.contains(index) ? entries[index] : nil }

    mutating func record(_ entry: Entry) {
        guard current != entry else { return }
        entries = Array(entries.prefix(index + 1)) + [entry]
        if entries.count > Self.limit { entries.removeFirst(entries.count - Self.limit) }
        index = entries.count - 1
    }

    mutating func move(to position: Int) {
        if entries.indices.contains(position) { index = position }
    }

    /// A page that can no longer be shown leaves the history.
    mutating func remove(at position: Int) {
        guard entries.indices.contains(position) else { return }
        entries.remove(at: position)
        if position < index { index -= 1 }
        index = min(index, entries.count - 1)
    }

    mutating func update(_ transform: (Entry) -> Entry) { entries = entries.map(transform) }

    /// Pages that can no longer be shown (a deleted project's) leave it.
    mutating func removeAll(where gone: (Entry) -> Bool) {
        for position in entries.indices.reversed() where gone(entries[position]) { remove(at: position) }
    }

    mutating func reset() {
        entries = []
        index = -1
    }
}

/// A window's tabs across launches and projects. Each project's tabs are
/// kept in `settings.json` as they change (coalesced; typing changes no
/// tab) and put back when the project opens; the project selected last
/// opens at launch. Showing another project first saves the tabs of the
/// projects shown, then closes them through the close path, and starts a
/// new 后退/前进 history. Reads only: nothing is written to the journal.
final class MacTabSession {
    /// How long tab changes gather before they are saved.
    static var saveDelay: TimeInterval = 0.5

    let host: MacChapterWorkspace
    let store: LabSettingsStore
    let workspace: LabWorkspaceCore
    /// The project whose tabs the window shows.
    private(set) var projectID: String?
    /// While positive (restoring, switching, quitting) changes are not saved.
    private var paused = 0
    private var pendingSave: DispatchWorkItem?
    /// Stored pages a restore has not put back yet, by project: those of a
    /// list that could not be read, or all of a refused restore. Every save
    /// of the project keeps them until a restore completes.
    struct Unrestored: Equatable {
        /// The session as stored when the restore began: where each page was.
        let stored: TabSession
        /// The pages not put back.
        let pages: Set<RecentPage>
        /// A refused restore: the 项目主页 and the split are kept too.
        let whole: Bool
    }
    private(set) var unrestored: [String: Unrestored] = [:]
    /// A retried restore's refusal or failure, as `enter`'s completion
    /// reports the first one.
    var onError: ((Error) -> Void)?

    init(host: MacChapterWorkspace, store: LabSettingsStore, workspace: LabWorkspaceCore) {
        self.host = host
        self.store = store
        self.workspace = workspace
        host.onLayoutChange = { [weak self] in self?.scheduleSave() }
    }

    /// The project to open at launch: the one selected last, while it
    /// exists; nil lets the 项目书架 open instead.
    func launchProject(in projects: [WorkspaceProject]) -> WorkspaceProject? {
        store.lastProject.flatMap { id in projects.first { $0.id == id } }
    }

    /// Shows the project: `leave(for:)`, then `enter(_:)`.
    func show(_ project: WorkspaceProject, completion: @escaping (Result<Void, Error>) -> Void) {
        leave(for: project) { [weak self] result in
            guard let self else { return }
            if case .failure(let error) = result { completion(.failure(error)); return }
            self.enter(project) { _ in completion(.success(())) }
        }
    }

    /// Before another project shows: the tabs of every other project are
    /// saved as they are, then closed one by one through the close path.
    /// The first that cannot close stops it, naming the tab; those already
    /// closed stay closed.
    func leave(for project: WorkspaceProject, completion: @escaping (Result<Void, Error>) -> Void) {
        let others = host.projectsWithTabs.subtracting([project.id]).sorted()
        guard !others.isEmpty else { completion(.success(())); return }
        saveNow()
        paused += 1
        func next(_ remaining: ArraySlice<String>) {
            guard let id = remaining.first else { paused -= 1; completion(.success(())); return }
            host.closeTabs(projectID: id) { [weak self] result in
                guard let self else { return }
                switch result {
                case .success: next(remaining.dropFirst())
                case .failure(let error):
                    // Saved before closing; the refusal saves nothing, so
                    // the tabs it could not close stay stored as they were.
                    self.paused -= 1
                    completion(.failure(error))
                }
            }
        }
        next(others[...])
    }

    /// The project shows: it opens at the next launch, a new history
    /// starts, and its tabs come back unless it has tabs here already. Pages
    /// that no longer exist are left out silently; a shown tab that does
    /// not open is reported. The stored tabs are never erased by a restore
    /// that did not finish: pages of a list that could not be read, and all
    /// pages of a refused restore, are kept in every later save of the
    /// project until a restore completes, and a refused restore is tried
    /// again once navigation is possible (unless the project has tabs by
    /// then). A restore overtaken by another project saves nothing.
    func enter(_ project: WorkspaceProject, completion: @escaping (Error?) -> Void) {
        let switching = projectID != project.id
        projectID = project.id
        store.setLastProject(project.id)
        guard !host.hasTabs(projectID: project.id), let session = store.tabSession(projectID: project.id) else {
            // A project without saved tabs keeps no split of another's.
            if !host.hasTabs(projectID: project.id) { host.removeEmptySecondPane() }
            if switching { host.resetHistory() }
            completion(nil); return
        }
        paused += 1
        restore(project, session) { [weak self] error, outcome in
            guard let self else { return }
            self.paused -= 1
            guard self.projectID == project.id, outcome != .overtaken else { completion(error); return }
            self.host.resetHistory()
            switch outcome {
            case .complete:
                // Pages left out leave the stored tabs too.
                self.unrestored[project.id] = nil
                self.saveNow()
            case .partial(let unread):
                self.unrestored[project.id] = Unrestored(stored: session, pages: unread, whole: false)
                self.saveNow()
            case .refused:
                self.unrestored[project.id] = Unrestored(stored: session, pages: Set(session.panes.flatMap(\.tabs)), whole: true)
                self.retryWhenNavigable(project)
            case .overtaken: break
            }
            completion(error)
        }
    }

    /// A refused restore runs again once the tab host lets navigation go
    /// on, while the project is still shown without tabs.
    private func retryWhenNavigable(_ project: WorkspaceProject) {
        host.whenNavigable(ignoringPlotGrids: false) { [weak self] in
            guard let self, self.projectID == project.id, self.unrestored[project.id] != nil else { return }
            guard self.host.canNavigate else { self.retryWhenNavigable(project); return }
            // Tabs opened meanwhile stay; the stored pages stay kept.
            guard !self.host.hasTabs(projectID: project.id) else { return }
            self.enter(project) { [weak self] error in
                if let error { self?.onError?(error) }
            }
        }
    }

    enum RestoreOutcome: Equatable {
        /// Every stored page that exists was put back.
        case complete
        /// These stored pages were not: a list could not be read.
        case partial(Set<RecentPage>)
        /// The tab host held navigation; nothing was put back.
        case refused
        /// Another project was shown first; nothing was put back.
        case overtaken
    }

    /// Reads what the session names (chapters, the element library, drifts,
    /// storylines: only the lists it needs) and puts back what still exists.
    /// A list that could not be read leaves its pages out, reported as
    /// `partial`, not dropped.
    private func restore(_ project: WorkspaceProject, _ session: TabSession,
                         completion: @escaping (_ error: Error?, _ outcome: RestoreOutcome) -> Void) {
        let kinds = Set(session.panes.flatMap { $0.tabs.map(\.kind) })
        let projectID = project.id, workspace = self.workspace
        var chapters: [WorkspaceChapter]?
        var elements: WorkspaceElementLibrary?
        var drifts: WorkspaceDriftLibrary?
        var storylines: WorkspaceStorylineLibrary?
        var failure: Error?
        func value<T>(_ result: Result<T, Error>) -> T? {
            switch result {
            case .success(let value): return value
            case .failure(let error): failure = failure ?? error; return nil
            }
        }
        let reads: [(@escaping () -> Void) -> Void] = [
            { done in
                guard kinds.contains(.chapter) else { done(); return }
                workspace.chapters(projectID: projectID) { chapters = value($0); done() }
            },
            { done in
                guard kinds.contains(.element) || kinds.contains(.category) else { done(); return }
                workspace.elementLibrary(projectID: projectID) { elements = value($0); done() }
            },
            { done in
                guard kinds.contains(.drift) else { done(); return }
                workspace.driftLibrary(projectID: projectID) { drifts = value($0); done() }
            },
            { done in
                guard kinds.contains(.storyline) else { done(); return }
                workspace.storylineLibrary(projectID: projectID) { storylines = value($0); done() }
            },
        ]
        func target(_ page: RecentPage) -> WorkspaceTabTarget? {
            switch page.kind {
            case .chapter: return chapters?.first { $0.id == page.id }.map { .chapter($0) }
            case .element: return elements?.elements.first { $0.id == page.id }.map { .element($0) }
            case .category: return elements?.categories.first { $0.id == page.id }.map { .category($0) }
            case .drift: return drifts?.drift(id: page.id).map { .drift($0) }
            case .storyline: return storylines?.storyline(id: page.id).map { .storyline($0) }
            }
        }
        /// A page whose list could not be read: kept, not dropped.
        func unread(_ page: RecentPage) -> Bool {
            switch page.kind {
            case .chapter: return chapters == nil
            case .element, .category: return elements == nil
            case .drift: return drifts == nil
            case .storyline: return storylines == nil
            }
        }
        func apply() {
            // Another project was shown meanwhile: this one's tabs stay stored.
            guard self.projectID == projectID else { completion(nil, .overtaken); return }
            let panes = session.panes.map { pane in
                MacChapterWorkspace.RestoredPane(targets: pane.tabs.compactMap(target), active: pane.active.flatMap(target),
                                                 home: pane.home, homeShown: pane.homeShown)
            }
            host.restoreTabs(project: project, panes: panes, activePane: session.activePane) { restored, error in
                guard restored else { completion(error, .refused); return }
                guard let failure else { completion(error, .complete); return }
                let left = Set(session.panes.flatMap(\.tabs).filter(unread))
                completion(LabError.message("部分标签未能恢复：\(failure.localizedDescription)"), .partial(left))
            }
        }
        func read(_ position: Int) {
            guard position < reads.count else { apply(); return }
            let next = reads[position]
            next { read(position + 1) }
        }
        read(0)
    }

    /// A tab changed: saved after `saveDelay`, once for a burst of changes.
    func scheduleSave() {
        guard paused == 0 else { return }
        pendingSave?.cancel()
        let work = DispatchWorkItem { [weak self] in
            self?.pendingSave = nil
            self?.saveNow()
        }
        pendingSave = work
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.saveDelay, execute: work)
    }

    /// Saves the tabs of the shown project, and of any other project with
    /// tabs, now, keeping the pages a restore has not put back yet. A
    /// project without tabs keeps no entry.
    func saveNow() {
        pendingSave?.cancel()
        pendingSave = nil
        guard paused == 0 else { return }
        var ids = host.projectsWithTabs
        if let projectID { ids.insert(projectID) }
        for id in ids.sorted() {
            let shown = host.tabSession(projectID: id)
            store.setTabSession(unrestored[id].map { Self.merged(shown, keeping: $0) } ?? shown, projectID: id)
        }
    }

    /// The shown tabs with the pages not put back yet: each in its pane,
    /// after the page it followed when stored (first when none of those is
    /// shown); the shown tab, 项目主页 and pane stay as shown. Without any
    /// shown tab a refused restore's session stays as it was stored.
    static func merged(_ shown: TabSession, keeping pending: Unrestored) -> TabSession {
        if shown.isEmpty, pending.whole { return pending.stored }
        var panes = shown.panes
        for (index, stored) in pending.stored.panes.enumerated() {
            let kept = stored.tabs.filter { pending.pages.contains($0) }
            guard !kept.isEmpty || (pending.whole && stored.home) else { continue }
            if index >= panes.count { panes.append(TabSession.Pane()) }
            var tabs = panes[index].tabs
            for (position, page) in stored.tabs.enumerated() where pending.pages.contains(page) && !tabs.contains(page) {
                let before = stored.tabs[..<position].reversed().first { tabs.contains($0) }
                tabs.insert(page, at: before.flatMap { tabs.firstIndex(of: $0) }.map { $0 + 1 } ?? 0)
            }
            panes[index].tabs = tabs
            if panes[index].active == nil, !panes[index].homeShown, let active = stored.active, pending.pages.contains(active) {
                panes[index].active = active
            }
            if pending.whole { panes[index].home = panes[index].home || stored.home }
        }
        return TabSession(panes: panes, activePane: shown.activePane)
    }

    /// Quitting or closing the window: the tabs are saved as they are, and
    /// closing them afterwards saves nothing.
    func suspend() {
        saveNow()
        paused += 1
    }

    /// Closing did not happen after all.
    func resume() {
        paused = max(0, paused - 1)
        scheduleSave()
    }

    /// A deleted project: nothing more is saved for it.
    func forget(projectID id: String) {
        if projectID == id { projectID = nil }
        unrestored[id] = nil
    }
}
