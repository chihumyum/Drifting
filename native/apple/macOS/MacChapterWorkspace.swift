import AppKit

/// What a tab shows: a chapter body, or an element page (fields and body).
enum WorkspaceTabTarget {
    case chapter(WorkspaceChapter)
    case element(WorkspaceElement)
}

/// Two panes own their tab views; the shared workspace owns chapter and element
/// cores. Removing a view from the hierarchy never detaches its input/history
/// binding.
final class MacChapterWorkspace: NSView, NSSplitViewDelegate {
    private final class Tab {
        var project: WorkspaceProject
        var target: WorkspaceTabTarget
        let core: LabCore
        let view: NativeDocumentView
        /// Element tabs show their page; the body is the page's document view.
        let page: MacElementPageView?
        var content: NSView { page ?? view }
        var chapter: WorkspaceChapter? { if case .chapter(let chapter) = target { return chapter }; return nil }
        var element: WorkspaceElement? { if case .element(let element) = target { return element }; return nil }
        var title: String { chapter?.title ?? element?.name ?? "" }
        var scope: DocumentScope { Tab.scope(of: target, projectID: project.id) }
        static func scope(of target: WorkspaceTabTarget, projectID: String) -> DocumentScope {
            switch target {
            case .chapter(let chapter): return .chapter(ChapterScope(projectID: projectID, chapterID: chapter.id))
            case .element(let element): return .element(ElementScope(projectID: projectID, elementID: element.id))
            }
        }
        init(project: WorkspaceProject, target: WorkspaceTabTarget, core: LabCore, categories: [WorkspaceElementCategory]) {
            self.project = project; self.target = target; self.core = core
            switch target {
            case .chapter:
                view = NativeDocumentView(core: core); page = nil
            case .element(let element):
                let page = MacElementPageView(element: element, categories: categories, core: core)
                self.page = page; view = page.documentView
            }
        }
    }
    private final class Pane {
        let root = NSView()
        let tabsBar = NSStackView()
        let body = NSView()
        let label = NSTextField(labelWithString: "")
        var tabs: [Tab] = []
        var selected: DocumentScope?
        var active: Tab? { tabs.first { $0.scope == selected } }
    }

    private let workspace: LabWorkspaceCore
    private let splitView = NSSplitView()
    private var panes: [Pane] = []
    private weak var pendingFocus: NativeDocumentView?
    private var externallyLocked = false
    private var needsInitialSplitLayout = false
    private var elementCategories: [String: [WorkspaceElementCategory]] = [:]
    /// Per project, what entity links resolve against: the element library
    /// and the live and trashed chapters. Both come from the workspace store.
    private struct LinkSources {
        var library: WorkspaceElementLibrary?
        var chapters: [WorkspaceChapter]?
        var trashedChapters: [WorkspaceChapter]?
    }
    private var linkSources: [String: LinkSources] = [:]
    private var loadingLibraries: Set<String> = []
    private var loadingChapters: Set<String> = []
    private var chapterRereads: Set<String> = []
    private var linkDirectories: [String: EntityLinkDirectory] = [:]
    private var backlinkRefresh: [String: DispatchWorkItem] = [:]
    /// A backlink row opened a chapter; select its first link once shown.
    private var pendingLinkReveal: (view: NativeDocumentView, range: NativeRange, elementID: String)?
    /// Debounce before visible 被引用 sections read again after edits.
    static var backlinkDelay: TimeInterval = 0.3
    private(set) var activePane = 0
    private(set) var isBusy = false
    var onChange: (() -> Void)?
    var onActivity: ((Bool) -> Void)?
    var onError: ((Error) -> Void)?
    /// A view rendered different comment anchors, or created a comment.
    var onComments: ((NativeDocumentView) -> Void)?
    var onCommentCreated: ((NativeDocumentView, WorkspaceComment) -> Void)?
    /// A page edit or element trash returned this project's complete library.
    var onElementLibrary: ((String, WorkspaceElementLibrary) -> Void)?
    var paneCount: Int { panes.count }
    var activeView: NativeDocumentView? { panes[activePane].active?.view }
    var activeCore: LabCore? { panes[activePane].active?.core }
    /// Nil while an element page is active: chapter features stay disabled.
    var activeChapter: WorkspaceChapter? { panes[activePane].active?.chapter }
    var activeElement: WorkspaceElement? { panes[activePane].active?.element }
    var activeElementPage: MacElementPageView? { panes[activePane].active?.page }
    /// The active view only when it shows a chapter; comments bind to this.
    var activeChapterView: NativeDocumentView? { activeChapter == nil ? nil : activeView }
    var activeProject: WorkspaceProject? { panes[activePane].active?.project }
    var canNavigate: Bool {
        !isBusy && !externallyLocked && !workspace.isChangingOwners && allTabs.allSatisfy {
            !$0.view.binding.hasPendingWork && !$0.view.textView.hasMarkedText()
        }
    }
    var canReopenActive: Bool {
        guard canNavigate, let tab = panes[activePane].active else { return false }
        return allTabs.filter { $0.scope == tab.scope }.count == 1
    }
    private var allTabs: [Tab] { panes.flatMap(\.tabs) }

    func lockViews(_ value: Bool) {
        externallyLocked = value
        for tab in allTabs { tab.view.isInteractionLocked = value || isBusy }
        updateTabAvailability()
    }

    init(workspace: LabWorkspaceCore) {
        self.workspace = workspace
        super.init(frame: .zero)
        splitView.isVertical = true
        splitView.dividerStyle = .thin
        splitView.delegate = self
        splitView.translatesAutoresizingMaskIntoConstraints = false
        addSubview(splitView)
        NSLayoutConstraint.activate([
            splitView.leadingAnchor.constraint(equalTo: leadingAnchor), splitView.trailingAnchor.constraint(equalTo: trailingAnchor),
            splitView.topAnchor.constraint(equalTo: topAnchor), splitView.bottomAnchor.constraint(equalTo: bottomAnchor),
        ])
        addPane()
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func layout() {
        super.layout()
        guard needsInitialSplitLayout, panes.count == 2,
              splitView.bounds.width >= 600 + splitView.dividerThickness else { return }
        // adjustSubviews preserves existing proportions, including a newly
        // added view's zero width. Initialize once after real layout; later
        // layouts leave the author's divider position untouched.
        needsInitialSplitLayout = false
        splitView.setPosition((splitView.bounds.width - splitView.dividerThickness) / 2, ofDividerAt: 0)
    }

    func splitView(_ splitView: NSSplitView, constrainMinCoordinate proposedMinimumPosition: CGFloat,
                   ofSubviewAt dividerIndex: Int) -> CGFloat { max(proposedMinimumPosition, 300) }
    func splitView(_ splitView: NSSplitView, constrainMaxCoordinate proposedMaximumPosition: CGFloat,
                   ofSubviewAt dividerIndex: Int) -> CGFloat { min(proposedMaximumPosition, splitView.bounds.width - 300) }

    func retainedView(pane: Int, scope: ChapterScope) -> NativeDocumentView? {
        retainedView(pane: pane, scope: .chapter(scope))
    }
    func retainedView(pane: Int, scope: DocumentScope) -> NativeDocumentView? {
        guard panes.indices.contains(pane) else { return nil }
        return panes[pane].tabs.first { $0.scope == scope }?.view
    }
    func retainedElementPage(pane: Int, scope: ElementScope) -> MacElementPageView? {
        guard panes.indices.contains(pane) else { return nil }
        return panes[pane].tabs.first { $0.scope == .element(scope) }?.page
    }
    /// Tab titles in display order, for accessibility checks and acceptance.
    func tabTitles(pane: Int) -> [String] {
        panes.indices.contains(pane) ? panes[pane].tabs.map(\.title) : []
    }

    func activate(pane: Int) {
        guard panes.indices.contains(pane), !isBusy, !externallyLocked else { return }
        guard activePane != pane else { return }
        activePane = pane
        refreshTabs()
        onChange?()
    }

    func open(project: WorkspaceProject, chapter: WorkspaceChapter, in pane: Int? = nil,
              completion: @escaping (Result<NativeDocumentView, Error>) -> Void) {
        open(project: project, target: .chapter(chapter), in: pane, completion: completion)
    }

    /// Opens an element page as a tab. Its body is an ordinary document owner.
    func open(project: WorkspaceProject, element: WorkspaceElement, in pane: Int? = nil,
              completion: @escaping (Result<NativeDocumentView, Error>) -> Void) {
        open(project: project, target: .element(element), in: pane, completion: completion)
    }

    private func openCore(_ project: WorkspaceProject, _ target: WorkspaceTabTarget, reopen: Bool,
                          completion: @escaping (Result<LabCore, Error>) -> Void) {
        switch (target, reopen) {
        case (.chapter(let chapter), false): workspace.openChapter(projectID: project.id, chapterID: chapter.id, completion: completion)
        case (.chapter(let chapter), true): workspace.reopenChapter(projectID: project.id, chapterID: chapter.id, completion: completion)
        case (.element(let element), false): workspace.openElement(projectID: project.id, elementID: element.id, completion: completion)
        case (.element(let element), true): workspace.reopenElement(projectID: project.id, elementID: element.id, completion: completion)
        }
    }

    private func open(project: WorkspaceProject, target: WorkspaceTabTarget, in pane: Int?,
                      completion: @escaping (Result<NativeDocumentView, Error>) -> Void) {
        let index = pane ?? activePane
        guard panes.indices.contains(index), canNavigate else { completion(.failure(blocked())); return }
        setBusy(true)
        openCore(project, target, reopen: false) { [weak self] result in
            guard let self else { return }
            switch result {
            case .success(let core):
                let scope = Tab.scope(of: target, projectID: project.id)
                let tab: Tab
                let isNew: Bool
                if let retained = self.panes[index].tabs.first(where: { $0.scope == scope }) {
                    isNew = false
                    tab = retained
                    tab.project = project
                    // A retained element page keeps its own, newer fields:
                    // library replies already updated it after each save.
                    if case .chapter = target { tab.target = target }
                } else {
                    isNew = true
                    // Another view of this element may hold newer fields.
                    let current = self.allTabs.first { $0.scope == scope }?.target ?? target
                    tab = Tab(project: project, target: current, core: core, categories: self.elementCategories[project.id] ?? [])
                    self.panes[index].tabs.append(tab)
                    self.connect(tab, pane: index)
                }
                self.panes[index].selected = scope
                self.activePane = index
                self.showSelected(in: index)
                self.pendingFocus = tab.view
                // A new binding can adopt an already-loaded shared store
                // before its view installs callbacks. Always render it once.
                if isNew { tab.view.binding.load() }
                self.setBusy(false)
                self.onChange?()
                self.focusWhenReady()
                if isNew { self.ensureLinkSources(projectID: project.id) }
                completion(.success(tab.view))
            case .failure(let error): self.setBusy(false); completion(.failure(error))
            }
        }
    }

    /// A page opened before any library reply still needs the category
    /// list, and links need names; chapters are read the same way.
    private func ensureLinkSources(projectID: String) {
        if linkSources[projectID]?.library == nil, loadingLibraries.insert(projectID).inserted {
            workspace.elementLibrary(projectID: projectID) { [weak self] result in
                guard let self else { return }
                self.loadingLibraries.remove(projectID)
                guard case .success(let library) = result, self.linkSources[projectID]?.library == nil else { return }
                self.applyElementLibrary(projectID: projectID, library: library)
            }
        }
        if linkSources[projectID]?.chapters == nil { chaptersChanged(projectID: projectID) }
    }

    func split(completion: @escaping (Result<NativeDocumentView, Error>) -> Void) {
        guard canNavigate, let tab = panes[activePane].active else { completion(.failure(blocked())); return }
        let added = panes.count == 1
        if added { addPane() }
        let other = activePane == 0 ? 1 : 0
        open(project: tab.project, target: tab.target, in: other) { result in
            if case .failure = result, added { self.removeSecondPane() }
            completion(result)
        }
    }

    func closeTab(pane: Int, scope: ChapterScope, completion: @escaping (Result<Bool, Error>) -> Void) {
        closeTab(pane: pane, scope: .chapter(scope), completion: completion)
    }

    func closeTab(pane: Int, scope: DocumentScope, completion: @escaping (Result<Bool, Error>) -> Void) {
        guard canNavigate, panes.indices.contains(pane),
              let tab = panes[pane].tabs.first(where: { $0.scope == scope }) else { completion(.failure(blocked())); return }
        // A header edit in progress is saved; it needs no document owner.
        tab.page?.endEditing()
        if allTabs.filter({ $0.scope == scope }).count > 1 {
            remove(tab, from: pane)
            completion(.success(true)); return
        }
        setBusy(true)
        let finish: (Result<Bool, Error>) -> Void = { [weak self] result in
            guard let self else { return }
            if case .success = result { self.remove(tab, from: pane) }
            self.setBusy(false)
            completion(result)
        }
        switch scope {
        case .chapter(let chapter): workspace.closeChapter(projectID: chapter.projectID, chapterID: chapter.chapterID, completion: finish)
        case .element(let element): workspace.closeElement(projectID: element.projectID, elementID: element.elementID, completion: finish)
        }
    }

    func trash(projectID: String, chapterID: String,
               completion: @escaping (Result<WorkspaceChapterTrashReply, Error>) -> Void) {
        guard canNavigate else { completion(.failure(blocked())); return }
        setBusy(true)
        let scope = DocumentScope.chapter(ChapterScope(projectID: projectID, chapterID: chapterID))
        workspace.trashChapter(projectID: projectID, chapterID: chapterID) { [weak self] result in
            guard let self else { return }
            if case .success = result { self.removeAll(scope) }
            self.setBusy(false)
            self.onChange?()
            completion(result)
        }
    }

    /// Trash commits first; only then are this element's tabs removed.
    func trashElement(projectID: String, elementID: String,
                      completion: @escaping (Result<WorkspaceElementReply<WorkspaceElement>, Error>) -> Void) {
        guard canNavigate else { completion(.failure(blocked())); return }
        setBusy(true)
        let scope = DocumentScope.element(ElementScope(projectID: projectID, elementID: elementID))
        workspace.trashElement(projectID: projectID, elementID: elementID) { [weak self] result in
            guard let self else { return }
            if case .success(let reply) = result {
                self.removeAll(scope)
                self.applyElementLibrary(projectID: projectID, library: reply.library)
                self.onElementLibrary?(projectID, reply.library)
            }
            self.setBusy(false)
            self.onChange?()
            completion(result)
        }
    }

    /// Include hidden tabs and both panes. Do not close the Rust owner again
    /// after it has entered the trash lifecycle; unsaved header text of a
    /// trashed element is not committed after the fact.
    private func removeAll(_ scope: DocumentScope) {
        for index in panes.indices {
            for tab in panes[index].tabs.filter({ $0.scope == scope }) { remove(tab, from: index, commitHeader: false) }
        }
    }

    func closeSecondPane(completion: @escaping (Result<Bool, Error>) -> Void) {
        guard canNavigate, panes.count == 2 else { completion(.failure(blocked())); return }
        // Each successful close is durable. A later failure keeps that tab and
        // the pane visible for retry; no unsubmitted view is discarded.
        func next() {
            guard let tab = self.panes[1].tabs.first else {
                self.removeSecondPane(); completion(.success(true)); return
            }
            self.closeTab(pane: 1, scope: tab.scope) { result in
                switch result {
                case .success: next()
                case .failure(let error): completion(.failure(error))
                }
            }
        }
        next()
    }

    func reopenActive(completion: @escaping (Result<NativeDocumentView, Error>) -> Void) {
        guard canReopenActive, let old = panes[activePane].active else { completion(.failure(blocked())); return }
        let pane = activePane
        old.page?.endEditing()
        setBusy(true)
        openCore(old.project, old.target, reopen: true) { [weak self] result in
            guard let self else { return }
            switch result {
            case .success(let core):
                let tab = Tab(project: old.project, target: old.target, core: core,
                              categories: self.elementCategories[old.project.id] ?? [])
                self.disconnect(old)
                if let at = self.panes[pane].tabs.firstIndex(where: { $0 === old }) { self.panes[pane].tabs[at] = tab }
                self.connect(tab, pane: pane)
                self.showSelected(in: pane)
                self.pendingFocus = tab.view
                tab.view.binding.load()
                self.setBusy(false)
                self.onChange?()
                self.focusWhenReady()
                completion(.success(tab.view))
            case .failure(let error): self.setBusy(false); completion(.failure(error))
            }
        }
    }

    func close(completion: @escaping (Result<Bool, Error>) -> Void) {
        guard canNavigate else { completion(.failure(blocked())); return }
        for tab in allTabs { tab.page?.endEditing() }
        setBusy(true)
        workspace.close { [weak self] result in
            guard let self else { return }
            if case .success = result {
                for pane in self.panes {
                    for tab in pane.tabs { self.disconnect(tab) }
                    pane.tabs.removeAll(); pane.selected = nil
                }
            }
            self.setBusy(false); self.onChange?(); completion(result)
        }
    }

    func rename(project: WorkspaceProject) {
        for tab in allTabs where tab.project.id == project.id { tab.project = project }
        refreshTabs(); onChange?()
    }
    func rename(chapter: WorkspaceChapter, projectID: String) {
        for tab in allTabs where tab.project.id == projectID && tab.chapter?.id == chapter.id { tab.target = .chapter(chapter) }
        refreshTabs(); onChange?()
        chaptersChanged(projectID: projectID)
    }

    /// Adopt a project's complete library: element tab titles and page fields
    /// follow stored names; uncommitted header text is kept. Links follow
    /// the new names, colours and trash states; changed names or aliases
    /// link every open body again (retroactive linking).
    func applyElementLibrary(projectID: String, library: WorkspaceElementLibrary) {
        elementCategories[projectID] = library.categories
        for tab in allTabs where tab.project.id == projectID {
            guard let element = tab.element, let stored = library.elements.first(where: { $0.id == element.id }) else { continue }
            tab.target = .element(stored)
            tab.page?.apply(element: stored, categories: library.categories)
        }
        refreshTabs(); onChange?()
        let previous = linkSources[projectID]?.library
        linkSources[projectID, default: LinkSources()].library = library
        updateLinkDirectory(projectID: projectID)
        if previous.map(EntityLinkDirectory.linkNames) != EntityLinkDirectory.linkNames(library) {
            requestEntityLinks(projectID: projectID)
        }
    }

    // MARK: Entity links

    /// The directory views of this project resolve links against, once both
    /// the library and the chapter list have been read.
    func linkDirectory(projectID: String) -> EntityLinkDirectory? { linkDirectories[projectID] }

    /// Re-reads the project's live and trashed chapters, e.g. after a
    /// chapter was created, renamed, trashed or restored.
    func chaptersChanged(projectID: String) {
        // A change during a read is read again afterwards, never dropped.
        guard loadingChapters.insert(projectID).inserted else { chapterRereads.insert(projectID); return }
        workspace.chapters(projectID: projectID) { [weak self] live in
            guard let self else { return }
            self.workspace.trashedChapters(projectID: projectID) { [weak self] trashed in
                guard let self else { return }
                self.loadingChapters.remove(projectID)
                if case .success(let chapters) = live {
                    self.applyChapters(projectID: projectID, chapters: chapters, trashed: try? trashed.get())
                }
                if self.chapterRereads.remove(projectID) != nil { self.chaptersChanged(projectID: projectID) }
            }
        }
    }

    /// Adopt the project's chapter list. A nil trash keeps the last one
    /// read. New or changed titles link every open body again.
    func applyChapters(projectID: String, chapters: [WorkspaceChapter], trashed: [WorkspaceChapter]?) {
        func titles(_ list: [WorkspaceChapter]) -> [[String]] { list.map { [$0.id, $0.title] }.sorted { $0[0] < $1[0] } }
        let previous = linkSources[projectID]?.chapters
        linkSources[projectID, default: LinkSources()].chapters = chapters
        if let trashed { linkSources[projectID]?.trashedChapters = trashed }
        updateLinkDirectory(projectID: projectID)
        if previous.map(titles) != titles(chapters) { requestEntityLinks(projectID: projectID) }
        scheduleBacklinks(projectID: projectID)
    }

    private func updateLinkDirectory(projectID: String) {
        guard let sources = linkSources[projectID], let library = sources.library, let chapters = sources.chapters else { return }
        let directory = EntityLinkDirectory(library: library, chapters: chapters, trashedChapters: sources.trashedChapters ?? [])
        guard linkDirectories[projectID] != directory else { return }
        linkDirectories[projectID] = directory
        for tab in allTabs where tab.project.id == projectID { tab.view.linkDirectory = directory }
    }

    /// Every open body of the project links once it is idle. Queued input,
    /// composition and drafts defer the pass; nothing is interrupted.
    private func requestEntityLinks(projectID: String) {
        var seen = Set<ObjectIdentifier>()
        for tab in allTabs where tab.project.id == projectID {
            let store = tab.view.binding.store
            if seen.insert(ObjectIdentifier(store)).inserted { store.requestEntityLinks() }
        }
    }

    private func pane(of tab: Tab) -> Int? { panes.firstIndex { $0.tabs.contains { $0 === tab } } }

    /// ⌘-click or 打开「名称」: an element opens as its page tab, a chapter as
    /// its chapter tab, in the pane that showed the link.
    private func openLink(_ target: EntityLinkTarget, from tab: Tab) {
        guard let index = pane(of: tab) else { return }
        let project = tab.project
        let done: (Result<NativeDocumentView, Error>) -> Void = { [weak self] result in
            if case .failure(let error) = result { self?.onError?(error) }
        }
        switch target.kind {
        case .element:
            guard let element = linkSources[project.id]?.library?.elements.first(where: { $0.id == target.id }) else {
                onError?(LabError.message("「\(target.name)」已不可用，请刷新设定库。")); return
            }
            open(project: project, element: element, in: index, completion: done)
        case .chapter:
            open(project: project, chapter: WorkspaceChapter(id: target.id, title: target.name), in: index, completion: done)
        }
    }

    /// A 被引用 row: open the chapter in the page's pane and select its first
    /// link when that range still links the element; otherwise just open it.
    private func openBacklink(_ chapter: WorkspaceElementBacklinks.Chapter, elementID: String, from tab: Tab) {
        guard let index = pane(of: tab) else { return }
        pendingLinkReveal = nil
        open(project: tab.project, chapter: WorkspaceChapter(id: chapter.chapterId, title: chapter.chapterTitle), in: index) { [weak self] result in
            guard let self else { return }
            switch result {
            case .success(let view):
                self.pendingLinkReveal = (view, chapter.first, elementID)
                self.resolveLinkReveal()
            case .failure(let error): self.onError?(error)
            }
        }
    }

    private func resolveLinkReveal() {
        guard let pending = pendingLinkReveal, !isBusy else { return }
        guard pending.view === activeView else { pendingLinkReveal = nil; return }
        let binding = pending.view.binding
        guard binding.canEdit, !binding.hasPendingWork, let projection = binding.store.projection,
              NativeText.identical(pending.view.textView.string, projection.text) else { return }
        pendingLinkReveal = nil
        if projection.links(element: pending.elementID, cover: pending.range) {
            pending.view.reveal(range: pending.range, revision: projection.revision)
        }
    }

    /// Visible element pages of the project read 被引用 again shortly, after
    /// chapter edits, link passes or chapter list changes settle.
    private func scheduleBacklinks(projectID: String) {
        guard panes.contains(where: { $0.active?.page != nil && $0.active?.project.id == projectID }) else { return }
        backlinkRefresh[projectID]?.cancel()
        let refresh = DispatchWorkItem { [weak self] in
            guard let self else { return }
            self.backlinkRefresh[projectID] = nil
            for pane in self.panes where pane.active?.project.id == projectID { pane.active?.page?.reloadBacklinks() }
        }
        backlinkRefresh[projectID] = refresh
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.backlinkDelay, execute: refresh)
    }

    /// Moves the keyboard to the active element page's name field, e.g. after
    /// creating an element with a default name.
    func focusActiveElementName() {
        guard let page = activeElementPage else { return }
        pendingFocus = nil
        page.focusName()
    }

    /// Header fields and facts are metadata writes: the body owner, its queued
    /// input and history are untouched. Every open view adopts the library.
    private func commitElement(_ tab: Tab, completion: @escaping (Result<WorkspaceElement, Error>) -> Void,
                               write: (_ projectID: String, _ elementID: String,
                                       _ done: @escaping (Result<WorkspaceElementReply<WorkspaceElement>, Error>) -> Void) -> Void) {
        guard let element = tab.element else { completion(.failure(LabError.message("这个标签不是设定页面。"))); return }
        let projectID = tab.project.id
        write(projectID, element.id) { [weak self] result in
            switch result {
            case .success(let reply):
                guard let stored = reply.result else { completion(.failure(LabError.message("设定结果缺失"))); return }
                if let self {
                    self.applyElementLibrary(projectID: projectID, library: reply.library)
                    self.onElementLibrary?(projectID, reply.library)
                }
                completion(.success(stored))
            case .failure(let error): completion(.failure(error))
            }
        }
    }

    private func blocked() -> LabError { .message("请先完成所有标签中的输入，并保存或处理待恢复草稿。") }
    private func connect(_ tab: Tab, pane: Int) {
        tab.view.isInteractionLocked = isBusy || externallyLocked
        tab.view.onFocus = { [weak self] in self?.activate(pane: pane) }
        tab.view.linkDirectory = linkDirectories[tab.project.id]
        tab.view.onOpenLink = { [weak self, weak tab] target in
            if let self, let tab { self.openLink(target, from: tab) }
        }
        tab.view.onEntityLinks = { [weak self, weak tab] in
            if let self, let tab { self.scheduleBacklinks(projectID: tab.project.id) }
        }
        if let page = tab.page {
            page.onLoadBacklinks = { [weak self, weak tab] done in
                guard let self, let tab, let element = tab.element else { done(.failure(LabError.message("设定页面已关闭。"))); return }
                self.workspace.elementBacklinks(projectID: tab.project.id, elementID: element.id, completion: done)
            }
            page.onOpenBacklink = { [weak self, weak tab] chapter in
                guard let self, let tab, let element = tab.element else { return }
                self.openBacklink(chapter, elementID: element.id, from: tab)
            }
            page.onFocus = { [weak self] in self?.activate(pane: pane) }
            page.onCommit = { [weak self, weak tab] changes, done in
                guard let self, let tab else { done(.failure(LabError.message("设定页面已关闭，修改未保存。"))); return }
                self.commitElement(tab, completion: done) {
                    self.workspace.updateElement(projectID: $0, elementID: $1, changes: changes, completion: $2)
                }
            }
            page.onCommitFacts = { [weak self, weak tab] facts, done in
                guard let self, let tab else { done(.failure(LabError.message("设定页面已关闭，字段未保存。"))); return }
                self.commitElement(tab, completion: done) {
                    self.workspace.setElementFacts(projectID: $0, elementID: $1, facts: facts, completion: $2)
                }
            }
        } else {
            tab.view.onComments = { [weak self, weak view = tab.view] in
                if let self, let view { self.onComments?(view) }
            }
            tab.view.onCommentCreated = { [weak self, weak view = tab.view] comment in
                if let self, let view { self.onCommentCreated?(view, comment) }
            }
        }
        tab.view.onActivity = { [weak self, weak tab] busy in
            guard let self else { return }
            self.updateTabAvailability()
            self.focusWhenReady()
            self.resolveLinkReveal()
            // Settled chapter prose may add or remove references.
            if !busy, let tab, tab.chapter != nil { self.scheduleBacklinks(projectID: tab.project.id) }
            self.onActivity?(!self.canNavigate)
        }
    }
    private func disconnect(_ tab: Tab) {
        tab.view.onActivity = nil; tab.view.onFocus = nil; tab.view.onComments = nil; tab.view.onCommentCreated = nil
        tab.view.onOpenLink = nil; tab.view.onEntityLinks = nil
        tab.page?.onFocus = nil; tab.page?.onCommit = nil; tab.page?.onCommitFacts = nil
        tab.page?.onLoadBacklinks = nil; tab.page?.onOpenBacklink = nil
        _ = tab.view.binding.detach(); tab.content.removeFromSuperview()
    }
    private func setBusy(_ value: Bool) {
        isBusy = value
        for tab in allTabs {
            tab.view.isInteractionLocked = value || externallyLocked
        }
        updateTabAvailability()
        if !value { focusWhenReady() }
        onActivity?(!canNavigate)
    }
    private func focusWhenReady() {
        guard !isBusy, let view = pendingFocus, view === activeView,
              view.binding.canEdit, !view.binding.hasPendingWork,
              view.binding.store.projection != nil else { return }
        pendingFocus = nil
        window?.makeFirstResponder(view.textView)
    }
    private func updateTabAvailability() {
        let enabled = canNavigate
        for pane in panes {
            for group in pane.tabsBar.arrangedSubviews {
                for view in group.subviews { (view as? NSButton)?.isEnabled = enabled }
            }
        }
    }
    private func addPane() {
        let pane = Pane(), index = panes.count
        pane.root.setAccessibilityIdentifier("editor-pane-\(index)")
        pane.tabsBar.orientation = .horizontal; pane.tabsBar.spacing = 4
        let scroll = NSScrollView()
        scroll.hasHorizontalScroller = true; scroll.autohidesScrollers = true
        scroll.documentView = pane.tabsBar
        pane.tabsBar.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            pane.tabsBar.leadingAnchor.constraint(equalTo: scroll.contentView.leadingAnchor),
            pane.tabsBar.topAnchor.constraint(equalTo: scroll.contentView.topAnchor),
            pane.tabsBar.heightAnchor.constraint(equalTo: scroll.contentView.heightAnchor),
        ])
        let stack = NSStackView(views: [pane.label, scroll, pane.body])
        stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = 6
        stack.translatesAutoresizingMaskIntoConstraints = false
        pane.root.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: pane.root.leadingAnchor, constant: 6),
            stack.trailingAnchor.constraint(equalTo: pane.root.trailingAnchor, constant: -6),
            stack.topAnchor.constraint(equalTo: pane.root.topAnchor), stack.bottomAnchor.constraint(equalTo: pane.root.bottomAnchor),
            scroll.heightAnchor.constraint(equalToConstant: 34), scroll.widthAnchor.constraint(equalTo: stack.widthAnchor),
            pane.body.widthAnchor.constraint(equalTo: stack.widthAnchor),
        ])
        panes.append(pane); splitView.addArrangedSubview(pane.root)
        if panes.count == 2 { needsInitialSplitLayout = true; needsLayout = true }
        splitView.adjustSubviews(); refreshTabs()
        layoutSubtreeIfNeeded()
    }
    private func removeSecondPane() {
        guard panes.count == 2 else { return }
        needsInitialSplitLayout = false
        panes.removeLast().root.removeFromSuperview()
        activePane = 0; pendingFocus = activeView
        splitView.adjustSubviews(); refreshTabs(); focusWhenReady(); onChange?()
    }
    private func remove(_ tab: Tab, from index: Int, commitHeader: Bool = true) {
        if commitHeader { tab.page?.endEditing() }
        disconnect(tab)
        let pane = panes[index]
        pane.tabs.removeAll { $0 === tab }
        if pane.selected == tab.scope { pane.selected = pane.tabs.last?.scope }
        showSelected(in: index)
        if index == activePane { pendingFocus = activeView; focusWhenReady() }
        refreshTabs(); onChange?()
    }
    private func showSelected(in index: Int) {
        let pane = panes[index]
        // Leaving an element page saves its header edit before the view is hidden.
        for child in pane.body.subviews where child !== pane.active?.content {
            (child as? MacElementPageView)?.endEditing()
        }
        for child in pane.body.subviews { child.removeFromSuperview() }
        if let view = pane.active?.content {
            view.translatesAutoresizingMaskIntoConstraints = false; pane.body.addSubview(view)
            NSLayoutConstraint.activate([
                view.leadingAnchor.constraint(equalTo: pane.body.leadingAnchor), view.trailingAnchor.constraint(equalTo: pane.body.trailingAnchor),
                view.topAnchor.constraint(equalTo: pane.body.topAnchor), view.bottomAnchor.constraint(equalTo: pane.body.bottomAnchor),
            ])
        }
        // An element page reads 被引用 each time it is shown.
        pane.active?.page?.reloadBacklinks()
        refreshTabs()
    }
    private func refreshTabs() {
        for (index, pane) in panes.enumerated() {
            pane.label.stringValue = panes.count == 1 ? "标签" : "\(index == 0 ? "左栏" : "右栏")\(index == activePane ? " · 当前" : "")"
            pane.label.textColor = index == activePane ? .labelColor : .secondaryLabelColor
            for child in pane.tabsBar.arrangedSubviews { pane.tabsBar.removeArrangedSubview(child); child.removeFromSuperview() }
            for tab in pane.tabs {
                let kind = tab.element == nil ? "chapter" : "element"
                let id = tab.chapter?.id ?? tab.element?.id ?? ""
                let title = tab.element == nil ? tab.title : "设定 · \(tab.title)"
                let select = ChapterTabButton(title: title) { [weak self] in
                    guard let self else { return }
                    self.open(project: tab.project, target: tab.target, in: index) { result in
                        if case .failure(let error) = result { self.onError?(error) }
                    }
                }
                select.setAccessibilityIdentifier("\(kind)-tab-\(id)")
                select.state = pane.selected == tab.scope ? .on : .off
                select.isEnabled = canNavigate
                let close = ChapterTabButton(title: "×") { [weak self] in
                    self?.closeTab(pane: index, scope: tab.scope) { result in
                        if case .failure(let error) = result { self?.onError?(error) }
                    }
                }
                close.setAccessibilityIdentifier("close-\(kind)-tab-\(id)")
                close.setAccessibilityLabel("关闭 \(tab.title)")
                close.isEnabled = canNavigate
                pane.tabsBar.addArrangedSubview(NSStackView(views: [select, close]))
            }
        }
    }
}

extension NativeProjection {
    /// Whether every UTF-16 unit of a range is linked to the element.
    func links(element elementID: String, cover range: NativeRange) -> Bool {
        let length = (text as NSString).length
        guard range.location >= 0, range.length > 0, range.location <= length, range.length <= length - range.location else { return false }
        let link = NativeEntityLink(kind: "element", id: elementID)
        let covered = blocks.flatMap(\.runs).filter { $0.attributes.links.contains(link) }
            .reduce(0) { $0 + NSIntersectionRange($1.range.nsRange, range.nsRange).length }
        return covered == range.length
    }
}

private final class ChapterTabButton: NSButton {
    private let pressed: () -> Void
    init(title: String, pressed: @escaping () -> Void) {
        self.pressed = pressed
        super.init(frame: .zero)
        self.title = title; bezelStyle = .recessed
        target = self; action = #selector(press)
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
    @objc private func press() { pressed() }
}
