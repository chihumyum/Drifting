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
                    // The tabs that did close are saved as closed.
                    self.paused -= 1
                    self.scheduleSave()
                    completion(.failure(error))
                }
            }
        }
        next(others[...])
    }

    /// The project shows: it opens at the next launch, a new history
    /// starts, and its tabs come back unless it has tabs here already. Pages
    /// that no longer exist are left out silently; a shown tab that does
    /// not open is reported.
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
        restore(project, session) { [weak self] error in
            guard let self else { return }
            self.paused -= 1
            self.host.resetHistory()
            // Pages left out leave the stored tabs too.
            self.saveNow()
            completion(error)
        }
    }

    /// Reads what the session names (chapters, the element library, drifts,
    /// storylines: only the lists it needs) and puts back what still exists.
    private func restore(_ project: WorkspaceProject, _ session: TabSession, completion: @escaping (Error?) -> Void) {
        let kinds = Set(session.panes.flatMap { $0.tabs.map(\.kind) })
        let projectID = project.id, workspace = self.workspace
        var chapters: [WorkspaceChapter]?
        var elements: WorkspaceElementLibrary?
        var drifts: WorkspaceDriftLibrary?
        var storylines: WorkspaceStorylineLibrary?
        let reads: [(@escaping () -> Void) -> Void] = [
            { done in
                guard kinds.contains(.chapter) else { done(); return }
                workspace.chapters(projectID: projectID) { chapters = try? $0.get(); done() }
            },
            { done in
                guard kinds.contains(.element) || kinds.contains(.category) else { done(); return }
                workspace.elementLibrary(projectID: projectID) { elements = try? $0.get(); done() }
            },
            { done in
                guard kinds.contains(.drift) else { done(); return }
                workspace.driftLibrary(projectID: projectID) { drifts = try? $0.get(); done() }
            },
            { done in
                guard kinds.contains(.storyline) else { done(); return }
                workspace.storylineLibrary(projectID: projectID) { storylines = try? $0.get(); done() }
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
        func apply() {
            let panes = session.panes.map { pane in
                MacChapterWorkspace.RestoredPane(targets: pane.tabs.compactMap(target), active: pane.active.flatMap(target),
                                                 home: pane.home, homeShown: pane.homeShown)
            }
            host.restoreTabs(project: project, panes: panes, activePane: session.activePane, completion: completion)
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
    /// tabs, now. A project without tabs keeps no entry.
    func saveNow() {
        pendingSave?.cancel()
        pendingSave = nil
        guard paused == 0 else { return }
        var ids = host.projectsWithTabs
        if let projectID { ids.insert(projectID) }
        for id in ids.sorted() { store.setTabSession(host.tabSession(projectID: id), projectID: id) }
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
    }
}
