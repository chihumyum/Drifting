import AppKit

/// Two panes own their tab views; the shared workspace owns chapter cores.
/// Removing a view from the hierarchy never detaches its input/history binding.
final class MacChapterWorkspace: NSView, NSSplitViewDelegate {
    private final class Tab {
        var project: WorkspaceProject
        var chapter: WorkspaceChapter
        let core: LabCore
        let view: NativeDocumentView
        var scope: ChapterScope { ChapterScope(projectID: project.id, chapterID: chapter.id) }
        init(project: WorkspaceProject, chapter: WorkspaceChapter, core: LabCore) {
            self.project = project; self.chapter = chapter; self.core = core
            view = NativeDocumentView(core: core)
        }
    }
    private final class Pane {
        let root = NSView()
        let tabsBar = NSStackView()
        let body = NSView()
        let label = NSTextField(labelWithString: "")
        var tabs: [Tab] = []
        var selected: ChapterScope?
        var active: Tab? { tabs.first { $0.scope == selected } }
    }

    private let workspace: LabWorkspaceCore
    private let splitView = NSSplitView()
    private var panes: [Pane] = []
    private weak var pendingFocus: NativeDocumentView?
    private var externallyLocked = false
    private var needsInitialSplitLayout = false
    private(set) var activePane = 0
    private(set) var isBusy = false
    var onChange: (() -> Void)?
    var onActivity: ((Bool) -> Void)?
    var onError: ((Error) -> Void)?
    var paneCount: Int { panes.count }
    var activeView: NativeDocumentView? { panes[activePane].active?.view }
    var activeCore: LabCore? { panes[activePane].active?.core }
    var activeChapter: WorkspaceChapter? { panes[activePane].active?.chapter }
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
        guard panes.indices.contains(pane) else { return nil }
        return panes[pane].tabs.first { $0.scope == scope }?.view
    }

    func activate(pane: Int) {
        guard panes.indices.contains(pane), !isBusy else { return }
        guard activePane != pane else { return }
        activePane = pane
        refreshTabs()
        onChange?()
    }

    func open(project: WorkspaceProject, chapter: WorkspaceChapter, in pane: Int? = nil,
              completion: @escaping (Result<NativeDocumentView, Error>) -> Void) {
        let target = pane ?? activePane
        guard panes.indices.contains(target), canNavigate else { completion(.failure(blocked())); return }
        setBusy(true)
        workspace.openChapter(projectID: project.id, chapterID: chapter.id) { [weak self] result in
            guard let self else { return }
            switch result {
            case .success(let core):
                let scope = ChapterScope(projectID: project.id, chapterID: chapter.id)
                let tab: Tab
                let isNew: Bool
                if let retained = self.panes[target].tabs.first(where: { $0.scope == scope }) {
                    isNew = false
                    tab = retained
                    tab.project = project; tab.chapter = chapter
                } else {
                    isNew = true
                    tab = Tab(project: project, chapter: chapter, core: core)
                    self.panes[target].tabs.append(tab)
                    self.connect(tab, pane: target)
                }
                self.panes[target].selected = scope
                self.activePane = target
                self.showSelected(in: target)
                self.pendingFocus = tab.view
                // A new binding can adopt an already-loaded shared store
                // before its view installs callbacks. Always render it once.
                if isNew { tab.view.binding.load() }
                self.setBusy(false)
                self.onChange?()
                self.focusWhenReady()
                completion(.success(tab.view))
            case .failure(let error): self.setBusy(false); completion(.failure(error))
            }
        }
    }

    func split(completion: @escaping (Result<NativeDocumentView, Error>) -> Void) {
        guard canNavigate, let tab = panes[activePane].active else { completion(.failure(blocked())); return }
        let added = panes.count == 1
        if added { addPane() }
        let other = activePane == 0 ? 1 : 0
        open(project: tab.project, chapter: tab.chapter, in: other) { result in
            if case .failure = result, added { self.removeSecondPane() }
            completion(result)
        }
    }

    func closeTab(pane: Int, scope: ChapterScope, completion: @escaping (Result<Bool, Error>) -> Void) {
        guard canNavigate, panes.indices.contains(pane),
              let tab = panes[pane].tabs.first(where: { $0.scope == scope }) else { completion(.failure(blocked())); return }
        if allTabs.filter({ $0.scope == scope }).count > 1 {
            remove(tab, from: pane)
            completion(.success(true)); return
        }
        setBusy(true)
        workspace.closeChapter(projectID: scope.projectID, chapterID: scope.chapterID) { [weak self] result in
            guard let self else { return }
            if case .success = result { self.remove(tab, from: pane) }
            self.setBusy(false)
            completion(result)
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
        setBusy(true)
        workspace.reopenChapter(projectID: old.project.id, chapterID: old.chapter.id) { [weak self] result in
            guard let self else { return }
            switch result {
            case .success(let core):
                let tab = Tab(project: old.project, chapter: old.chapter, core: core)
                old.view.onActivity = nil; old.view.onFocus = nil; _ = old.view.binding.detach()
                old.view.removeFromSuperview()
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
        setBusy(true)
        workspace.close { [weak self] result in
            guard let self else { return }
            if case .success = result {
                for pane in self.panes {
                    for tab in pane.tabs {
                        tab.view.onActivity = nil; tab.view.onFocus = nil
                        _ = tab.view.binding.detach(); tab.view.removeFromSuperview()
                    }
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
        for tab in allTabs where tab.project.id == projectID && tab.chapter.id == chapter.id { tab.chapter = chapter }
        refreshTabs(); onChange?()
    }

    private func blocked() -> LabError { .message("请先完成所有标签中的输入，并保存或处理待恢复草稿。") }
    private func connect(_ tab: Tab, pane: Int) {
        tab.view.isInteractionLocked = isBusy || externallyLocked
        tab.view.onFocus = { [weak self] in self?.activate(pane: pane) }
        tab.view.onActivity = { [weak self] _ in
            guard let self else { return }
            self.updateTabAvailability()
            self.focusWhenReady()
            self.onActivity?(!self.canNavigate)
        }
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
    private func remove(_ tab: Tab, from index: Int) {
        tab.view.onActivity = nil; tab.view.onFocus = nil
        _ = tab.view.binding.detach(); tab.view.removeFromSuperview()
        let pane = panes[index]
        pane.tabs.removeAll { $0 === tab }
        if pane.selected == tab.scope { pane.selected = pane.tabs.last?.scope }
        showSelected(in: index)
        if index == activePane { pendingFocus = activeView; focusWhenReady() }
        refreshTabs(); onChange?()
    }
    private func showSelected(in index: Int) {
        let pane = panes[index]
        for child in pane.body.subviews { child.removeFromSuperview() }
        if let view = pane.active?.view {
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
            pane.label.stringValue = panes.count == 1 ? "章节标签" : "\(index == 0 ? "左栏" : "右栏")\(index == activePane ? " · 当前" : "")"
            pane.label.textColor = index == activePane ? .labelColor : .secondaryLabelColor
            for child in pane.tabsBar.arrangedSubviews { pane.tabsBar.removeArrangedSubview(child); child.removeFromSuperview() }
            for tab in pane.tabs {
                let select = ChapterTabButton(title: tab.chapter.title) { [weak self] in
                    guard let self else { return }
                    self.open(project: tab.project, chapter: tab.chapter, in: index) { result in
                        if case .failure(let error) = result { self.onError?(error) }
                    }
                }
                select.setAccessibilityIdentifier("chapter-tab-\(tab.chapter.id)")
                select.state = pane.selected == tab.scope ? .on : .off
                select.isEnabled = canNavigate
                let close = ChapterTabButton(title: "×") { [weak self] in
                    self?.closeTab(pane: index, scope: tab.scope) { result in
                        if case .failure(let error) = result { self?.onError?(error) }
                    }
                }
                close.setAccessibilityIdentifier("close-chapter-tab-\(tab.chapter.id)")
                close.setAccessibilityLabel("关闭 \(tab.chapter.title)")
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
