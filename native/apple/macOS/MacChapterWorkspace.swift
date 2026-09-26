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
                if isNew, tab.page != nil, self.elementCategories[project.id] == nil { self.loadElementLibrary(projectID: project.id) }
                completion(.success(tab.view))
            case .failure(let error): self.setBusy(false); completion(.failure(error))
            }
        }
    }

    /// A page opened before any library reply still needs the category list.
    private func loadElementLibrary(projectID: String) {
        workspace.elementLibrary(projectID: projectID) { [weak self] result in
            guard let self, case .success(let library) = result, self.elementCategories[projectID] == nil else { return }
            self.applyElementLibrary(projectID: projectID, library: library)
        }
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
    }

    /// Adopt a project's complete library: element tab titles and page fields
    /// follow stored names; uncommitted header text is kept.
    func applyElementLibrary(projectID: String, library: WorkspaceElementLibrary) {
        elementCategories[projectID] = library.categories
        for tab in allTabs where tab.project.id == projectID {
            guard let element = tab.element, let stored = library.elements.first(where: { $0.id == element.id }) else { continue }
            tab.target = .element(stored)
            tab.page?.apply(element: stored, categories: library.categories)
        }
        refreshTabs(); onChange?()
    }

    /// Moves the keyboard to the active element page's name field, e.g. after
    /// creating an element with a default name.
    func focusActiveElementName() {
        guard let page = activeElementPage else { return }
        pendingFocus = nil
        page.focusName()
    }

    private func commitElement(_ tab: Tab, changes: WorkspaceElementChanges,
                               completion: @escaping (Result<WorkspaceElement, Error>) -> Void) {
        guard let element = tab.element else { completion(.failure(LabError.message("这个标签不是设定页面。"))); return }
        let projectID = tab.project.id
        workspace.updateElement(projectID: projectID, elementID: element.id, changes: changes) { [weak self] result in
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
        if let page = tab.page {
            page.onFocus = { [weak self] in self?.activate(pane: pane) }
            page.onCommit = { [weak self, weak tab] changes, done in
                guard let self, let tab else { done(.failure(LabError.message("设定页面已关闭，修改未保存。"))); return }
                self.commitElement(tab, changes: changes, completion: done)
            }
        } else {
            tab.view.onComments = { [weak self, weak view = tab.view] in
                if let self, let view { self.onComments?(view) }
            }
            tab.view.onCommentCreated = { [weak self, weak view = tab.view] comment in
                if let self, let view { self.onCommentCreated?(view, comment) }
            }
        }
        tab.view.onActivity = { [weak self] _ in
            guard let self else { return }
            self.updateTabAvailability()
            self.focusWhenReady()
            self.onActivity?(!self.canNavigate)
        }
    }
    private func disconnect(_ tab: Tab) {
        tab.view.onActivity = nil; tab.view.onFocus = nil; tab.view.onComments = nil; tab.view.onCommentCreated = nil
        tab.page?.onFocus = nil; tab.page?.onCommit = nil
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
