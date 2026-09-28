import AppKit

/// What a tab shows: a chapter page (title, 摘要, 状态 and body), or an
/// element, storyline, drift or category page (fields and body).
enum WorkspaceTabTarget {
    case chapter(WorkspaceChapter)
    case element(WorkspaceElement)
    case storyline(WorkspaceStoryline)
    case drift(WorkspaceDrift)
    case category(WorkspaceElementCategory)
}

/// Two panes own their tab views; the shared workspace owns chapter, element,
/// storyline, drift and category cores. Removing a view from the hierarchy
/// never detaches its input/history binding.
final class MacChapterWorkspace: NSView, NSSplitViewDelegate {
    private final class Tab {
        var project: WorkspaceProject
        var target: WorkspaceTabTarget
        let core: LabCore
        let view: NativeDocumentView
        /// Every tab shows its page; the body is the page's document view.
        let page: MacElementPageView?
        let storylinePage: MacStorylinePageView?
        let driftPage: MacDriftPageView?
        let chapterPage: MacChapterPageView?
        let categoryPage: MacCategoryPageView?
        var content: NSView { page ?? storylinePage ?? driftPage ?? chapterPage ?? categoryPage ?? view }
        /// The 摘要 and 状态 of a chapter or drift tab.
        var metadataEditor: NodeMetadataEditor? { chapterPage?.metadataEditor ?? driftPage?.metadataEditor }
        /// A chapter's or drift's 情节规划格 toggle and dock.
        var plotToggle: PlotPlannerToggle? { chapterPage?.plotPlannerButton ?? driftPage?.plotPlannerButton }
        var plotDock: MacPlotPlannerDock? { chapterPage?.plotDock ?? driftPage?.plotDock }
        func showPlotDock(_ dock: MacPlotPlannerDock?) { chapterPage?.showPlotDock(dock); driftPage?.showPlotDock(dock) }
        var nodeID: String? { chapter?.id ?? drift?.id }
        var chapter: WorkspaceChapter? { if case .chapter(let chapter) = target { return chapter }; return nil }
        var element: WorkspaceElement? { if case .element(let element) = target { return element }; return nil }
        var storyline: WorkspaceStoryline? { if case .storyline(let storyline) = target { return storyline }; return nil }
        var drift: WorkspaceDrift? { if case .drift(let drift) = target { return drift }; return nil }
        var category: WorkspaceElementCategory? { if case .category(let category) = target { return category }; return nil }
        var title: String { chapter?.title ?? element?.name ?? storyline?.name ?? drift?.title ?? category?.name ?? "" }
        /// Every page kind shows 关系.
        var relationsView: RelationsSectionView? {
            page?.relationsView ?? storylinePage?.relationsView ?? driftPage?.relationsView ?? chapterPage?.relationsView
                ?? categoryPage?.relationsView
        }
        /// Chapters and drifts are `node` ends.
        var relationEndpoint: RelationEndpoint {
            switch target {
            case .chapter(let chapter): return RelationEndpoint(kind: "node", id: chapter.id)
            case .element(let element): return RelationEndpoint(kind: "element", id: element.id)
            case .storyline(let storyline): return RelationEndpoint(kind: "storyline", id: storyline.id)
            case .drift(let drift): return RelationEndpoint(kind: "node", id: drift.id)
            case .category(let category): return RelationEndpoint(kind: "category", id: category.id)
            }
        }
        var scope: DocumentScope { Tab.scope(of: target, projectID: project.id) }
        static func scope(of target: WorkspaceTabTarget, projectID: String) -> DocumentScope {
            switch target {
            case .chapter(let chapter): return .chapter(ChapterScope(projectID: projectID, chapterID: chapter.id))
            case .element(let element): return .element(ElementScope(projectID: projectID, elementID: element.id))
            case .storyline(let storyline): return .storyline(StorylineScope(projectID: projectID, storylineID: storyline.id))
            case .drift(let drift): return .drift(DriftScope(projectID: projectID, driftID: drift.id))
            case .category(let category): return .category(CategoryScope(projectID: projectID, categoryID: category.id))
            }
        }
        init(project: WorkspaceProject, target: WorkspaceTabTarget, core: LabCore, categories: [WorkspaceElementCategory],
             drifts: WorkspaceDriftLibrary?) {
            self.project = project; self.target = target; self.core = core
            switch target {
            case .chapter(let chapter):
                let page = MacChapterPageView(chapter: chapter, core: core)
                self.page = nil; storylinePage = nil; driftPage = nil; chapterPage = page; categoryPage = nil; view = page.documentView
            case .element(let element):
                let page = MacElementPageView(element: element, categories: categories, core: core)
                self.page = page; storylinePage = nil; driftPage = nil; chapterPage = nil; categoryPage = nil; view = page.documentView
            case .storyline(let storyline):
                let page = MacStorylinePageView(storyline: storyline, core: core)
                self.page = nil; storylinePage = page; driftPage = nil; chapterPage = nil; categoryPage = nil; view = page.documentView
            case .drift(let drift):
                let page = MacDriftPageView(drift: drift, library: drifts ?? .empty, core: core)
                self.page = nil; storylinePage = nil; driftPage = page; chapterPage = nil; categoryPage = nil; view = page.documentView
            case .category(let category):
                let page = MacCategoryPageView(category: category, core: core)
                self.page = nil; storylinePage = nil; driftPage = nil; chapterPage = nil; categoryPage = page; view = page.documentView
            }
        }
        /// Ends an uncommitted header edit of any page kind, and a 情节规划格
        /// cell being edited.
        func endEditing() {
            page?.endEditing(); storylinePage?.endEditing(); driftPage?.endEditing(); chapterPage?.endEditing(); categoryPage?.endEditing()
            plotDock?.canvas.commitEditing()
        }
    }
    /// 项目主页: a page without a body, one per project.
    private final class HomeTab {
        var project: WorkspaceProject
        let model: ProjectHomeModel
        let page: MacProjectHomeView
        init(project: WorkspaceProject, model: ProjectHomeModel) {
            self.project = project; self.model = model
            page = MacProjectHomeView(model: model)
        }
    }
    private final class Pane {
        let root = NSView()
        let tabsBar = NSStackView()
        let body = NSView()
        let label = NSTextField(labelWithString: "")
        /// 历史版本… of the pane's active page.
        let historyButton = NSButton(title: "历史版本…", target: nil, action: nil)
        /// Copilot's quiet status, in the active pane only.
        let copilotLabel = NSTextField(labelWithString: "")
        var tabs: [Tab] = []
        var selected: DocumentScope?
        /// 项目主页 tabs, shown before the body tabs.
        var homes: [HomeTab] = []
        /// The project whose 项目主页 is shown instead of `selected`.
        var shownHome: String?
        var home: HomeTab? { homes.first { $0.project.id == shownHome } }
        /// The body tab shown; nil while a 项目主页 is.
        var active: Tab? { shownHome == nil ? tabs.first { $0.scope == selected } : nil }
        var content: NSView? { home?.page ?? active?.content }
    }

    private let workspace: LabWorkspaceCore
    private let splitView = NSSplitView()
    private var panes: [Pane] = []
    private weak var pendingFocus: NativeDocumentView?
    private var externallyLocked = false
    private var needsInitialSplitLayout = false
    private var elementCategories: [String: [WorkspaceElementCategory]] = [:]
    /// Per project, what entity links resolve against: the element library,
    /// the live and trashed chapters and the drift library. All come from the
    /// workspace store.
    private struct LinkSources {
        var library: WorkspaceElementLibrary?
        var chapters: [WorkspaceChapter]?
        var trashedChapters: [WorkspaceChapter]?
        var drifts: WorkspaceDriftLibrary?
    }
    private var linkSources: [String: LinkSources] = [:]
    private var loadingLibraries: Set<String> = []
    private var loadingChapters: Set<String> = []
    private var chapterRereads: Set<String> = []
    private var linkDirectories: [String: EntityLinkDirectory] = [:]
    /// Per project, the storylines and memberships storyline pages list.
    private var storylineLibraries: [String: WorkspaceStorylineLibrary] = [:]
    private var loadingStorylines: Set<String> = []
    private var storylineRereads: Set<String> = []
    private var loadingDrifts: Set<String> = []
    private var driftRereads: Set<String> = []
    /// Per project, act names by identity; drift pages name their act.
    private var actNames: [String: [String: String]] = [:]
    private var loadingActs: Set<String> = []
    private var actRereads: Set<String> = []
    private var backlinkRefresh: [String: DispatchWorkItem] = [:]
    /// A backlink row opened a chapter; select its first link once shown.
    private var pendingLinkReveal: (view: NativeDocumentView, range: NativeRange, elementID: String)?
    /// Debounce before visible 被引用 sections read again after edits.
    static var backlinkDelay: TimeInterval = 0.3
    /// Per project, the 素材库 and element portraits element pages show.
    private var materialLibraries: [String: WorkspaceMaterialLibrary] = [:]
    private var loadingMaterials: Set<String> = []
    private var materialRereads: Set<String> = []
    private var loadingElements: Set<String> = []
    private var elementRereads: Set<String> = []
    /// Per project, the word counts pages, lists and the status line show.
    private var wordCountModels: [String: WordCountModel] = [:]
    /// The body revision each chapter or drift scope was last counted at.
    private var countedRevisions: [DocumentScope: UInt64] = [:]
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
    /// A storyline page edit, storyline trash or membership re-read returned
    /// this project's complete storyline library.
    var onStorylineLibrary: ((String, WorkspaceStorylineLibrary) -> Void)?
    /// A drift page edit, drift trash or re-read returned this project's
    /// complete drift library.
    var onDriftLibrary: ((String, WorkspaceDriftLibrary) -> Void)?
    /// A chapter's or drift's 摘要 or 状态 was written through a page or
    /// `setNodeStatus`; the panel, the outline and the chapter list follow.
    var onNodeMetadata: ((String, WorkspaceNodeMetadata) -> Void)?
    /// Act rows were read again (act names for the drift panel).
    var onOutline: ((String, [WorkspaceOutlineEntry]) -> Void)?
    /// A portrait change or re-read returned this project's complete 素材库.
    var onMaterialLibrary: ((String, WorkspaceMaterialLibrary) -> Void)?
    /// A project's word counts changed: lists, the outline, the 漂流 panel,
    /// the project sheet and the status line follow.
    var onWordCounts: ((String, WordCountLibrary) -> Void)?
    /// Each project's relation library and every page's 关系 section.
    let relations: RelationCoordinator
    /// Every element page's 补丁 and 新建补丁… from chapter and drift selections.
    let patches: PatchCoordinator
    /// The project's Copilot, which chapter (and drift) tabs report their
    /// edits, 分析 requests and closing to; nil leaves Copilot out.
    var copilot: ((String) -> CopilotController?)?
    /// Copilot's quiet status (正在分析… / 已提出 N 条建议 / 出错：…) beside
    /// 历史版本… of the active pane; nil hides it.
    var copilotStatus: String? { didSet { if copilotStatus != oldValue { showCopilotStatus() } } }
    /// A patch's source link opened a chapter or drift; select its anchored
    /// text once shown, while it is still there.
    private var pendingPatchReveal: (view: NativeDocumentView, patch: WorkspacePatch)?
    /// 关系类型… from a page's 关系 section.
    var onManageRelationTypes: ((WorkspaceProject) -> Void)?
    /// 历史版本… from a pane's header; the pane is active by then.
    var onShowHistory: (() -> Void)?
    /// A remote original was accepted for this project, after counts were
    /// reconciled; views that show the whole project read it again.
    var onRemoteOriginal: ((String) -> Void)?
    /// A library or the chapter lists naming trashed content arrived, from
    /// any command: the 回收站 panel and the chapter list's trash follow.
    var onTrash: ((String, WorkspaceTrashSource) -> Void)?
    /// Content was purged from the trash: notes, TODOs and anything else
    /// that could name it are read again.
    var onPurged: ((String, [WorkspaceTrashPurgeReply.Purged]) -> Void)?
    /// Presents conversion pickers and 情节规划格 confirmations; nil uses a
    /// sheet on the given window.
    var presentAlert: ((NSAlert, NSWindow?, @escaping (NSApplication.ModalResponse) -> Void) -> Void)?
    /// Where each chapter's and drift's 情节规划格 dock is remembered (shown
    /// or hidden, and its height); nil remembers them for the session only.
    var plotPlannerSettings: LabSettingsStore?
    /// A page's 情节规划格 was shown or hidden (视图 › 情节规划格 follows).
    var onPlotPlanner: (() -> Void)?
    /// A drift became a chapter or an element. Its tabs were already
    /// replaced and the drift, chapter, storyline and element lists read;
    /// views outside the tabs follow.
    var onDriftConverted: ((String, DriftConversionOutcome) -> Void)?
    /// 转为设定 stopped after the element was created: the drift, element and
    /// relation lists were read again here; notes and TODOs outside the tabs
    /// may have moved to the element.
    var onDriftConversionStopped: ((String) -> Void)?
    var paneCount: Int { panes.count }
    var activeView: NativeDocumentView? { panes[activePane].active?.view }
    var activeCore: LabCore? { panes[activePane].active?.core }
    /// Nil while an element page is active: chapter features stay disabled.
    var activeChapter: WorkspaceChapter? { panes[activePane].active?.chapter }
    var activeElement: WorkspaceElement? { panes[activePane].active?.element }
    var activeElementPage: MacElementPageView? { panes[activePane].active?.page }
    var activeStoryline: WorkspaceStoryline? { panes[activePane].active?.storyline }
    var activeStorylinePage: MacStorylinePageView? { panes[activePane].active?.storylinePage }
    var activeDrift: WorkspaceDrift? { panes[activePane].active?.drift }
    var activeDriftPage: MacDriftPageView? { panes[activePane].active?.driftPage }
    var activeChapterPage: MacChapterPageView? { panes[activePane].active?.chapterPage }
    var activeCategory: WorkspaceElementCategory? { panes[activePane].active?.category }
    var activeCategoryPage: MacCategoryPageView? { panes[activePane].active?.categoryPage }
    /// The active view only when it shows a chapter; comments bind to this.
    var activeChapterView: NativeDocumentView? { activeChapter == nil ? nil : activeView }
    var activeProject: WorkspaceProject? { panes[activePane].active?.project ?? panes[activePane].home?.project }
    /// The project whose 项目主页 the active pane shows.
    var activeHome: WorkspaceProject? { panes[activePane].home?.project }
    /// No body input in flight and no 情节规划格 gesture queued or sent.
    var canNavigate: Bool { canNavigateAfterPlotGrids && !plotGridsWriting() }
    /// Everything `canNavigate` asks except 情节规划格 gestures: closing,
    /// quitting, converting and trashing check this, then wait for the
    /// gestures (`settlePlotGrids`).
    var canNavigateAfterPlotGrids: Bool {
        !isBusy && !externallyLocked && !workspace.isChangingOwners && allTabs.allSatisfy {
            !$0.view.binding.hasPendingWork && !$0.view.textView.hasMarkedText()
        }
    }
    var canReopenActive: Bool {
        // The storyline, drift and category commands have no reopen from disk.
        guard canNavigate, let tab = panes[activePane].active, tab.storyline == nil, tab.drift == nil, tab.category == nil else {
            return false
        }
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
        relations = RelationCoordinator(workspace: workspace)
        patches = PatchCoordinator(workspace: workspace)
        super.init(frame: .zero)
        patches.library = { [weak self] projectID in self?.linkSources[projectID]?.library }
        patches.onElementLibrary = { [weak self] projectID, library in
            self?.applyElementLibrary(projectID: projectID, library: library)
            self?.onElementLibrary?(projectID, library)
        }
        patches.onOpenSource = { [weak self] projectID, patch, section in
            self?.openPatchSource(patch, projectID: projectID, from: section)
        }
        // The selected tab's title takes a chosen 界面强调色.
        NotificationCenter.default.addObserver(self, selector: #selector(accentChanged), name: MacEditorPreferences.didChange, object: nil)
        relations.names = { [weak self] projectID in self?.relationNames(projectID: projectID) ?? .empty }
        relations.requestNames = { [weak self] projectID in
            guard let self, self.storylineLibraries[projectID] == nil, !self.loadingStorylines.contains(projectID) else { return }
            self.storylinesChanged(projectID: projectID)
        }
        relations.onOpen = { [weak self] projectID, endpoint, section in
            self?.openRelationTarget(endpoint, projectID: projectID, from: section)
        }
        relations.onManageTypes = { [weak self] projectID in
            guard let self, let project = self.allTabs.first(where: { $0.project.id == projectID })?.project else { return }
            self.onManageRelationTypes?(project)
        }
        // A remote original may change bodies without an open owner, whose
        // projections only a reconcile writes.
        workspace.onRemoteOriginal = { [weak self] projectID in
            self?.wordCountModels[projectID]?.reconcile()
            self?.refreshPlotGrids(projectID: projectID)
            self?.onRemoteOriginal?(projectID)
        }
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
    func retainedStorylinePage(pane: Int, scope: StorylineScope) -> MacStorylinePageView? {
        guard panes.indices.contains(pane) else { return nil }
        return panes[pane].tabs.first { $0.scope == .storyline(scope) }?.storylinePage
    }
    func retainedDriftPage(pane: Int, scope: DriftScope) -> MacDriftPageView? {
        guard panes.indices.contains(pane) else { return nil }
        return panes[pane].tabs.first { $0.scope == .drift(scope) }?.driftPage
    }
    func retainedChapterPage(pane: Int, scope: ChapterScope) -> MacChapterPageView? {
        guard panes.indices.contains(pane) else { return nil }
        return panes[pane].tabs.first { $0.scope == .chapter(scope) }?.chapterPage
    }
    func retainedCategoryPage(pane: Int, scope: CategoryScope) -> MacCategoryPageView? {
        guard panes.indices.contains(pane) else { return nil }
        return panes[pane].tabs.first { $0.scope == .category(scope) }?.categoryPage
    }
    /// Tab titles in display order, for accessibility checks and acceptance.
    func tabTitles(pane: Int) -> [String] {
        panes.indices.contains(pane) ? panes[pane].tabs.map(\.title) : []
    }
    /// The projects whose 项目主页 the pane has as tabs, in display order.
    func homeProjects(pane: Int) -> [WorkspaceProject] {
        panes.indices.contains(pane) ? panes[pane].homes.map(\.project) : []
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

    /// Opens a storyline page as a tab. Its body is an ordinary document owner.
    func open(project: WorkspaceProject, storyline: WorkspaceStoryline, in pane: Int? = nil,
              completion: @escaping (Result<NativeDocumentView, Error>) -> Void) {
        open(project: project, target: .storyline(storyline), in: pane, completion: completion)
    }

    /// Opens a drift page as a tab. Its body is an ordinary document owner.
    func open(project: WorkspaceProject, drift: WorkspaceDrift, in pane: Int? = nil,
              completion: @escaping (Result<NativeDocumentView, Error>) -> Void) {
        open(project: project, target: .drift(drift), in: pane, completion: completion)
    }

    /// Opens a category page (分类页) as a tab. Its body is an ordinary
    /// document owner.
    func open(project: WorkspaceProject, category: WorkspaceElementCategory, in pane: Int? = nil,
              completion: @escaping (Result<NativeDocumentView, Error>) -> Void) {
        open(project: project, target: .category(category), in: pane, completion: completion)
    }

    private func openCore(_ project: WorkspaceProject, _ target: WorkspaceTabTarget, reopen: Bool,
                          completion: @escaping (Result<LabCore, Error>) -> Void) {
        switch (target, reopen) {
        case (.chapter(let chapter), false): workspace.openChapter(projectID: project.id, chapterID: chapter.id, completion: completion)
        case (.chapter(let chapter), true): workspace.reopenChapter(projectID: project.id, chapterID: chapter.id, completion: completion)
        case (.element(let element), false): workspace.openElement(projectID: project.id, elementID: element.id, completion: completion)
        case (.element(let element), true): workspace.reopenElement(projectID: project.id, elementID: element.id, completion: completion)
        case (.storyline(let storyline), false):
            workspace.openStoryline(projectID: project.id, storylineID: storyline.id, completion: completion)
        case (.storyline, true): completion(.failure(LabError.message("故事线页面暂不支持从磁盘重新打开")))
        case (.drift(let drift), false): workspace.openDrift(projectID: project.id, driftID: drift.id, completion: completion)
        case (.drift, true): completion(.failure(LabError.message("漂流页面暂不支持从磁盘重新打开")))
        case (.category(let category), false):
            workspace.openCategory(projectID: project.id, categoryID: category.id, completion: completion)
        case (.category, true): completion(.failure(LabError.message("分类页面暂不支持从磁盘重新打开")))
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
                let (tab, isNew) = self.install(core, project: project, target: target, in: index)
                self.setBusy(false)
                self.recordRecent(tab.target, projectID: project.id)
                self.onChange?()
                self.focusWhenReady()
                if isNew { self.prepare(tab) }
                completion(.success(tab.view))
            case .failure(let error): self.setBusy(false); completion(.failure(error))
            }
        }
    }

    /// Shows the body's tab in the pane, selected and active: the pane's
    /// tab of it when there is one, else a new tab on the opened core.
    private func install(_ core: LabCore, project: WorkspaceProject, target: WorkspaceTabTarget, in index: Int) -> (Tab, Bool) {
        let scope = Tab.scope(of: target, projectID: project.id)
        let tab: Tab
        let isNew: Bool
        if let retained = panes[index].tabs.first(where: { $0.scope == scope }) {
            isNew = false
            tab = retained
            tab.project = project
            // A retained element, storyline or drift page keeps its
            // own, newer fields: library replies already updated it.
            if case .chapter(let chapter) = target { tab.target = target; tab.chapterPage?.apply(chapter: chapter) }
        } else {
            isNew = true
            // Another view of this element may hold newer fields.
            let current = allTabs.first { $0.scope == scope }?.target ?? target
            tab = Tab(project: project, target: current, core: core, categories: elementCategories[project.id] ?? [],
                      drifts: linkSources[project.id]?.drifts)
            panes[index].tabs.append(tab)
            connect(tab, pane: index)
        }
        panes[index].selected = scope
        panes[index].shownHome = nil
        activePane = index
        showSelected(in: index)
        pendingFocus = tab.view
        // A new binding can adopt an already-loaded shared store
        // before its view installs callbacks. Always render it once.
        if isNew { tab.view.binding.load() }
        return (tab, isNew)
    }

    /// A new tab reads what its page shows beside the body.
    private func prepare(_ tab: Tab) {
        let projectID = tab.project.id
        ensureLinkSources(projectID: projectID)
        if let page = tab.storylinePage { showChapters(of: page, projectID: projectID) }
        if let page = tab.driftPage { showAct(of: page, projectID: projectID) }
        loadMetadata(of: tab); showWordCount(of: tab); showPlotDock(of: tab)
        if tab.page != nil { showPortrait(of: tab) }
        if tab.categoryPage != nil { showCategory(of: tab); loadTemplate(of: tab) }
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
        if linkSources[projectID]?.drifts == nil { driftsChanged(projectID: projectID) }
        if actNames[projectID] == nil, allTabs.contains(where: { $0.project.id == projectID && $0.drift != nil }) {
            actsChanged(projectID: projectID)
        }
        if storylineLibraries[projectID] == nil, allTabs.contains(where: { $0.project.id == projectID && $0.storyline != nil }) {
            storylinesChanged(projectID: projectID)
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
        guard canNavigateAfterPlotGrids, panes.indices.contains(pane),
              let tab = panes[pane].tabs.first(where: { $0.scope == scope }) else { completion(.failure(blocked())); return }
        // A header edit in progress is saved; it needs no document owner.
        tab.endEditing()
        // The page's 情节规划格 gestures are written before its tab goes.
        guard let nodeID = tab.nodeID else { closeTab(tab, pane: pane, completion: completion); return }
        settlePlotGrids(projectID: tab.project.id, nodeID: nodeID, purpose: "关闭") { [weak self, weak tab] error in
            guard let self else { return }
            if let error { completion(.failure(error)); return }
            guard let tab, self.panes.indices.contains(pane), self.panes[pane].tabs.contains(where: { $0 === tab }),
                  self.canNavigateAfterPlotGrids else {
                completion(.failure(self.blocked())); return
            }
            self.closeTab(tab, pane: pane, completion: completion)
        }
    }

    private func closeTab(_ tab: Tab, pane: Int, completion: @escaping (Result<Bool, Error>) -> Void) {
        let scope = tab.scope
        // Another tab or the 全书长卷 still shows this body: keep its owner.
        if allTabs.filter({ $0.scope == scope }).count > 1 || holdsExternally(scope) {
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
        case .storyline(let storyline):
            workspace.closeStoryline(projectID: storyline.projectID, storylineID: storyline.storylineID, completion: finish)
        case .drift(let drift):
            workspace.closeDrift(projectID: drift.projectID, driftID: drift.driftID, completion: finish)
        case .category(let category):
            workspace.closeCategory(projectID: category.projectID, categoryID: category.categoryID, completion: finish)
        }
    }

    /// A 情节规划格 cell being edited on the chapter is committed and its
    /// gestures answered first; a refused one keeps the chapter.
    func trash(projectID: String, chapterID: String,
               completion: @escaping (Result<WorkspaceChapterTrashReply, Error>) -> Void) {
        guard canNavigateAfterPlotGrids else { completion(.failure(blocked())); return }
        settlePlotGrids(projectID: projectID, nodeID: chapterID, purpose: "移到回收站") { [weak self] error in
            guard let self else { return }
            if let error { completion(.failure(error)); return }
            guard self.canNavigateAfterPlotGrids else { completion(.failure(self.blocked())); return }
            self.trashNow(projectID: projectID, chapterID: chapterID, completion: completion)
        }
    }

    private func trashNow(projectID: String, chapterID: String,
                          completion: @escaping (Result<WorkspaceChapterTrashReply, Error>) -> Void) {
        setBusy(true)
        let scope = DocumentScope.chapter(ChapterScope(projectID: projectID, chapterID: chapterID))
        workspace.trashChapter(projectID: projectID, chapterID: chapterID) { [weak self] result in
            guard let self else { return }
            // Rust removed the chapter's relations inside the trash; the
            // chapter leaves the counts and the book total.
            if case .success = result {
                self.removeAll(scope); self.relations.reload(projectID: projectID)
                self.wordCountModels[projectID]?.scheduleRefresh()
            }
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
                self.relations.reload(projectID: projectID)
            }
            self.setBusy(false)
            self.onChange?()
            completion(result)
        }
    }

    /// Trash commits first; only then are this storyline's tabs removed.
    /// Chapters whose 主线 it was lose all their storylines.
    func trashStoryline(projectID: String, storylineID: String,
                        completion: @escaping (Result<WorkspaceStorylineReply<WorkspaceStoryline>, Error>) -> Void) {
        guard canNavigate else { completion(.failure(blocked())); return }
        setBusy(true)
        let scope = DocumentScope.storyline(StorylineScope(projectID: projectID, storylineID: storylineID))
        workspace.trashStoryline(projectID: projectID, storylineID: storylineID) { [weak self] result in
            guard let self else { return }
            if case .success(let reply) = result {
                self.removeAll(scope)
                self.applyStorylineLibrary(projectID: projectID, library: reply.library)
                self.onStorylineLibrary?(projectID, reply.library)
                self.relations.reload(projectID: projectID)
            }
            self.setBusy(false)
            self.onChange?()
            completion(result)
        }
    }

    /// Trash commits first (Rust unbinds its act); only then are this drift's
    /// tabs removed. Its 情节规划格 gestures are answered before, as for chapters.
    func trashDrift(projectID: String, driftID: String,
                    completion: @escaping (Result<WorkspaceDriftReply<WorkspaceDrift>, Error>) -> Void) {
        guard canNavigateAfterPlotGrids else { completion(.failure(blocked())); return }
        settlePlotGrids(projectID: projectID, nodeID: driftID, purpose: "移到回收站") { [weak self] error in
            guard let self else { return }
            if let error { completion(.failure(error)); return }
            guard self.canNavigateAfterPlotGrids else { completion(.failure(self.blocked())); return }
            self.trashDriftNow(projectID: projectID, driftID: driftID, completion: completion)
        }
    }

    private func trashDriftNow(projectID: String, driftID: String,
                               completion: @escaping (Result<WorkspaceDriftReply<WorkspaceDrift>, Error>) -> Void) {
        setBusy(true)
        let scope = DocumentScope.drift(DriftScope(projectID: projectID, driftID: driftID))
        workspace.trashDrift(projectID: projectID, driftID: driftID) { [weak self] result in
            guard let self else { return }
            if case .success(let reply) = result {
                self.removeAll(scope)
                self.applyDriftLibrary(projectID: projectID, library: reply.library)
                self.onDriftLibrary?(projectID, reply.library)
                self.relations.reload(projectID: projectID)
            }
            self.setBusy(false)
            self.onChange?()
            completion(result)
        }
    }

    /// Trash commits first (Rust saves and retires an open category body);
    /// only then are this category's tabs removed. Its elements move to 未分类
    /// and their pages stay open.
    func trashCategory(projectID: String, categoryID: String,
                       completion: @escaping (Result<WorkspaceElementReply<WorkspaceElementCategory>, Error>) -> Void) {
        guard canNavigate else { completion(.failure(blocked())); return }
        setBusy(true)
        let scope = DocumentScope.category(CategoryScope(projectID: projectID, categoryID: categoryID))
        workspace.trashElementCategory(projectID: projectID, categoryID: categoryID) { [weak self] result in
            guard let self else { return }
            if case .success(let reply) = result {
                self.removeAll(scope)
                self.applyElementLibrary(projectID: projectID, library: reply.library)
                self.onElementLibrary?(projectID, reply.library)
                self.relations.reload(projectID: projectID)
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
        countedRevisions.removeValue(forKey: scope)
        for index in panes.indices {
            for tab in panes[index].tabs.filter({ $0.scope == scope }) { remove(tab, from: index, commitHeader: false) }
        }
    }

    func closeSecondPane(completion: @escaping (Result<Bool, Error>) -> Void) {
        // Each tab's close waits for its 情节规划格 gestures.
        guard canNavigateAfterPlotGrids, panes.count == 2 else { completion(.failure(blocked())); return }
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
        old.endEditing()
        setBusy(true)
        openCore(old.project, old.target, reopen: true) { [weak self] result in
            guard let self else { return }
            switch result {
            case .success(let core):
                let tab = Tab(project: old.project, target: old.target, core: core,
                              categories: self.elementCategories[old.project.id] ?? [], drifts: self.linkSources[old.project.id]?.drifts)
                self.disconnect(old)
                if let at = self.panes[pane].tabs.firstIndex(where: { $0 === old }) { self.panes[pane].tabs[at] = tab }
                self.connect(tab, pane: pane)
                self.showSelected(in: pane)
                self.pendingFocus = tab.view
                tab.view.binding.load()
                self.loadMetadata(of: tab)
                self.showWordCount(of: tab)
                self.showPlotDock(of: tab)
                self.setBusy(false)
                self.onChange?()
                self.focusWhenReady()
                completion(.success(tab.view))
            case .failure(let error): self.setBusy(false); completion(.failure(error))
            }
        }
    }

    /// Closes every owner once header edits are saved and every
    /// 情节规划格 gesture was answered (quitting and closing the window).
    func close(completion: @escaping (Result<Bool, Error>) -> Void) {
        guard canNavigateAfterPlotGrids else { completion(.failure(blocked())); return }
        for tab in allTabs { tab.endEditing() }
        settlePlotGrids(purpose: "关闭") { [weak self] error in
            guard let self else { return }
            if let error { completion(.failure(error)); return }
            guard self.canNavigate else { completion(.failure(self.blocked())); return }
            self.closeNow(completion: completion)
        }
    }

    private func closeNow(completion: @escaping (Result<Bool, Error>) -> Void) {
        setBusy(true)
        workspace.close { [weak self] result in
            guard let self else { return }
            if case .success = result {
                self.wordCountModels.values.forEach { $0.cancel() }
                self.countedRevisions.removeAll()
                self.externalViews.removeAll()
                for pane in self.panes {
                    for tab in pane.tabs { self.disconnect(tab) }
                    pane.tabs.removeAll(); pane.selected = nil
                    pane.homes.forEach { $0.page.removeFromSuperview() }
                    pane.homes.removeAll(); pane.shownHome = nil
                }
            }
            self.setBusy(false); self.onChange?(); completion(result)
        }
    }

    func rename(project: WorkspaceProject) {
        for tab in allTabs where tab.project.id == project.id { tab.project = project }
        for home in homes(projectID: project.id) { home.project = project; home.model.rename(project.name) }
        refreshTabs(); onChange?()
    }
    func rename(chapter: WorkspaceChapter, projectID: String) {
        for tab in allTabs where tab.project.id == projectID && tab.chapter?.id == chapter.id {
            tab.target = .chapter(chapter)
            tab.chapterPage?.apply(chapter: chapter)
        }
        refreshTabs(); onChange?()
        chaptersChanged(projectID: projectID)
    }

    // MARK: Version history

    /// The active page's body, for 历史版本….
    var activeHistoryTarget: VersionHistoryTarget? {
        guard let tab = panes[activePane].active else { return nil }
        switch tab.target {
        case .chapter(let chapter): return VersionHistoryTarget(projectID: tab.project.id, kind: "chapter", id: chapter.id, title: chapter.title)
        case .drift(let drift): return VersionHistoryTarget(projectID: tab.project.id, kind: "drift", id: drift.id, title: drift.title)
        case .element(let element): return VersionHistoryTarget(projectID: tab.project.id, kind: "element", id: element.id, title: element.name)
        case .storyline(let storyline):
            return VersionHistoryTarget(projectID: tab.project.id, kind: "storyline", id: storyline.id, title: storyline.name)
        case .category(let category):
            return VersionHistoryTarget(projectID: tab.project.id, kind: "category", id: category.id, title: category.name)
        }
    }

    /// A restored version: an open owner already adopted it, and its text
    /// links entity names like typed text; a closed chapter or drift is
    /// counted again.
    func adoptRestoredVersion(_ target: VersionHistoryTarget, live: Bool) {
        if live, let view = openView(scope: target.scope) {
            view.binding.store.requestEntityLinks()
        }
        if target.kind == "chapter" || target.kind == "drift" { wordCounts(projectID: target.projectID, refresh: true) }
        // Restored chapter prose may add or remove element references.
        if target.kind == "chapter" { scheduleBacklinks(projectID: target.projectID) }
    }

    // MARK: Summary and status

    /// Every open page of the node shows its stored 摘要 and 状态; a summary
    /// being typed is kept.
    func applyNodeMetadata(projectID: String, metadata: WorkspaceNodeMetadata) {
        for tab in allTabs where tab.project.id == projectID && tab.nodeID == metadata.id {
            tab.metadataEditor?.show(metadata)
        }
        for home in homes(projectID: projectID) { home.model.applyNodeMetadata(metadata) }
    }

    /// Writes a chapter's or drift's status from a panel, the outline or the
    /// chapter list. Rust refuses a status of the other kind before writing.
    func setNodeStatus(projectID: String, nodeID: String, status: String,
                       completion: @escaping (Result<WorkspaceNodeMetadata, Error>) -> Void) {
        workspace.setNodeStatus(projectID: projectID, nodeID: nodeID, status: status) { [weak self] result in
            if case .success(let metadata) = result { self?.adopt(metadata, projectID: projectID, summaryChanged: false) }
            completion(result)
        }
    }

    /// A new page reads its node's stored summary and status once.
    private func loadMetadata(of tab: Tab) {
        guard let nodeID = tab.nodeID, let editor = tab.metadataEditor else { return }
        workspace.nodeMetadata(projectID: tab.project.id, nodeID: nodeID) { [weak editor] result in
            switch result {
            case .success(let metadata): editor?.show(metadata)
            case .failure(let error): editor?.showUnavailable(error)
            }
        }
    }

    /// 摘要 and 状态 are metadata writes: the body owner, its queued input and
    /// history are untouched.
    private func commitMetadata(_ tab: Tab, _ change: NodeMetadataEditor.Change,
                                completion: @escaping (Result<WorkspaceNodeMetadata, Error>) -> Void) {
        guard let nodeID = tab.nodeID else { completion(.failure(LabError.message("这个标签没有摘要和状态。"))); return }
        let projectID = tab.project.id
        let summaryChanged: Bool
        if case .summary = change { summaryChanged = true } else { summaryChanged = false }
        let done: (Result<WorkspaceNodeMetadata, Error>) -> Void = { [weak self] result in
            if case .success(let metadata) = result { self?.adopt(metadata, projectID: projectID, summaryChanged: summaryChanged) }
            completion(result)
        }
        switch change {
        case .summary(let summary):
            workspace.setNodeSummary(projectID: projectID, nodeID: nodeID, summary: summary, completion: done)
        case .status(let status):
            workspace.setNodeStatus(projectID: projectID, nodeID: nodeID, status: status, completion: done)
        }
    }

    private func adopt(_ metadata: WorkspaceNodeMetadata, projectID: String, summaryChanged: Bool) {
        applyNodeMetadata(projectID: projectID, metadata: metadata)
        onNodeMetadata?(projectID, metadata)
        // A drift's summary is also in the drift library (link previews).
        if summaryChanged, metadata.kind == "drift" { driftsChanged(projectID: projectID) }
    }

    // MARK: Word counts

    /// The project's counts. The first call reconciles every live chapter and
    /// drift, as opening a project does in the renderer; `refresh` reads the
    /// counts again when the model already exists.
    @discardableResult
    func wordCounts(projectID: String, refresh: Bool = false) -> WordCountModel {
        if let model = wordCountModels[projectID] {
            if refresh { model.scheduleRefresh() }
            return model
        }
        let model = WordCountModel(workspace: workspace, projectID: projectID)
        wordCountModels[projectID] = model
        model.onLibrary = { [weak self] library in self?.applyWordCounts(projectID: projectID, library: library) }
        model.load()
        return model
    }

    /// The project's last counts, if read; never starts a read.
    func wordCountLibrary(projectID: String) -> WordCountLibrary? { wordCountModels[projectID]?.library }

    /// Every open chapter and drift page of the project shows its count.
    private func applyWordCounts(projectID: String, library: WordCountLibrary) {
        for tab in allTabs where tab.project.id == projectID { showWordCount(of: tab) }
        for home in homes(projectID: projectID) { home.model.applyWordCounts(library) }
        onWordCounts?(projectID, library)
    }

    private func showWordCount(of tab: Tab) {
        guard let nodeID = tab.nodeID else { return }
        let model = wordCounts(projectID: tab.project.id)
        let count = model.library?.count(nodeID: nodeID)
        tab.chapterPage?.showWordCount(count, loaded: model.loaded)
        tab.driftPage?.showWordCount(count, loaded: model.loaded)
    }

    /// Rust stores a chapter's or drift's count with every body save (and
    /// when a body opens). Once its owner settles at a revision not yet
    /// counted, the counts are read again, debounced; idle moments that keep
    /// the revision read nothing.
    private func countSavedBody(of tab: Tab) {
        guard tab.nodeID != nil, let revision = tab.view.binding.state?.projection.revision,
              countedRevisions[tab.scope] != revision else { return }
        countedRevisions[tab.scope] = revision
        wordCounts(projectID: tab.project.id).scheduleRefresh()
        // Rust rechecked the body's anchored patches with the save.
        patches.bodySaved(projectID: tab.project.id)
    }

    // MARK: Storylines

    /// The last storyline library read for the project, if any.
    func storylineLibrary(projectID: String) -> WorkspaceStorylineLibrary? { storylineLibraries[projectID] }

    /// Adopt a project's complete storyline library: storyline tab titles and
    /// page fields follow stored values (uncommitted text is kept), and every
    /// storyline page lists its chapters again.
    func applyStorylineLibrary(projectID: String, library: WorkspaceStorylineLibrary) {
        let lost = lostIDs(storylineLibraries[projectID]?.storylines.map(\.id), library.storylines.map(\.id))
        storylineLibraries[projectID] = library
        defer { relationSourcesChanged(projectID: projectID, lost: lost) }
        onTrash?(projectID, .storylines(library))
        for home in homes(projectID: projectID) { home.model.applyStorylines(library) }
        for tab in allTabs where tab.project.id == projectID {
            guard let storyline = tab.storyline, let page = tab.storylinePage else { continue }
            if let stored = library.storyline(id: storyline.id) {
                tab.target = .storyline(stored)
                page.apply(storyline: stored)
            }
            showChapters(of: page, projectID: projectID)
        }
        refreshTabs(); onChange?()
    }

    /// Re-reads the project's storylines and memberships, e.g. after a
    /// chapter was created, moved, trashed or restored. Observers receive the
    /// library through `onStorylineLibrary`.
    func storylinesChanged(projectID: String) {
        guard loadingStorylines.insert(projectID).inserted else { storylineRereads.insert(projectID); return }
        workspace.storylineLibrary(projectID: projectID) { [weak self] result in
            guard let self else { return }
            self.loadingStorylines.remove(projectID)
            if case .success(let library) = result {
                self.applyStorylineLibrary(projectID: projectID, library: library)
                self.onStorylineLibrary?(projectID, library)
            }
            if self.storylineRereads.remove(projectID) != nil { self.storylinesChanged(projectID: projectID) }
        }
    }

    /// Lists the page's chapters in book order once both the storyline
    /// library and the chapter titles are known.
    private func showChapters(of page: MacStorylinePageView, projectID: String) {
        guard let library = storylineLibraries[projectID], let chapters = linkSources[projectID]?.chapters else {
            page.showChapters(nil); return
        }
        let titles = Dictionary(chapters.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        let id = page.storyline.id
        page.showChapters(library.chapters(storylineID: id).compactMap { membership in
            titles[membership.chapterId].map { StorylineChaptersView.Entry(chapter: $0, primary: membership.primary == id) }
        })
    }

    // MARK: Drifts

    /// The last drift library read for the project, if any.
    func driftLibrary(projectID: String) -> WorkspaceDriftLibrary? { linkSources[projectID]?.drifts }

    /// Adopt a project's complete drift library: drift tab titles and page
    /// fields follow stored values (an uncommitted title is kept), links
    /// follow drift titles and trash states, and changed titles link every
    /// open body again.
    func applyDriftLibrary(projectID: String, library: WorkspaceDriftLibrary) {
        let lost = lostIDs(linkSources[projectID]?.drifts?.drifts.map(\.id), library.drifts.map(\.id))
        defer { relationSourcesChanged(projectID: projectID, lost: lost) }
        onTrash?(projectID, .drifts(library))
        for home in homes(projectID: projectID) { home.model.applyDrifts(library) }
        // A created, trashed or restored drift changes the counted nodes.
        if linkSources[projectID]?.drifts?.drifts.map(\.id) != library.drifts.map(\.id) {
            wordCountModels[projectID]?.scheduleRefresh()
        }
        for tab in allTabs where tab.project.id == projectID {
            guard let drift = tab.drift, let page = tab.driftPage else { continue }
            if let stored = library.drift(id: drift.id) {
                tab.target = .drift(stored)
                page.apply(drift: stored, library: library)
            }
            showAct(of: page, projectID: projectID)
        }
        refreshTabs(); onChange?()
        let previous = linkSources[projectID]?.drifts
        linkSources[projectID, default: LinkSources()].drifts = library
        updateLinkDirectory(projectID: projectID)
        // Rust links drift titles in every pass; a first read with drifts, or
        // changed titles, link open bodies again (retroactive linking).
        if previous.map(EntityLinkDirectory.linkNames) ?? [] != EntityLinkDirectory.linkNames(library) {
            requestEntityLinks(projectID: projectID)
        }
    }

    /// Re-reads the project's drifts, e.g. after an act was removed (which
    /// releases its notes). Observers receive it through `onDriftLibrary`.
    func driftsChanged(projectID: String) {
        guard loadingDrifts.insert(projectID).inserted else { driftRereads.insert(projectID); return }
        workspace.driftLibrary(projectID: projectID) { [weak self] result in
            guard let self else { return }
            self.loadingDrifts.remove(projectID)
            if case .success(let library) = result {
                self.applyDriftLibrary(projectID: projectID, library: library)
                self.onDriftLibrary?(projectID, library)
            }
            if self.driftRereads.remove(projectID) != nil { self.driftsChanged(projectID: projectID) }
        }
    }

    /// Adopt the project's outline rows: drift pages name their bound act.
    func applyOutline(projectID: String, entries: [WorkspaceOutlineEntry]) {
        actNames[projectID] = Dictionary(entries.filter { $0.kind == "act" }.map { ($0.id, $0.title) },
                                         uniquingKeysWith: { first, _ in first })
        for tab in allTabs where tab.project.id == projectID {
            if let page = tab.driftPage { showAct(of: page, projectID: projectID) }
        }
        onOutline?(projectID, entries)
    }

    /// Re-reads act names, e.g. when a drift page opens or acts change.
    func actsChanged(projectID: String) {
        guard loadingActs.insert(projectID).inserted else { actRereads.insert(projectID); return }
        workspace.outline(projectID: projectID) { [weak self] result in
            guard let self else { return }
            self.loadingActs.remove(projectID)
            if case .success(let entries) = result { self.applyOutline(projectID: projectID, entries: entries) }
            if self.actRereads.remove(projectID) != nil { self.actsChanged(projectID: projectID) }
        }
    }

    /// Nil while act names are still being read; an act missing from the
    /// last outline read is named generically until the next reply.
    private func showAct(of page: MacDriftPageView, projectID: String) {
        page.show(actName: page.drift.actId.flatMap { id in actNames[projectID].map { $0[id] ?? "已绑定的幕" } })
    }

    /// Moves the keyboard to the active drift page's title, e.g. after
    /// creating a drift from the panel.
    func focusActiveDriftTitle() {
        guard let page = activeDriftPage else { return }
        pendingFocus = nil
        page.focusTitle()
    }

    /// Drift titles and groups are metadata writes. Every open view, the
    /// panel and the outline adopt the returned library.
    private func commitDrift(_ tab: Tab, changes: WorkspaceDriftChanges, completion: @escaping (Result<WorkspaceDrift, Error>) -> Void) {
        guard let drift = tab.drift else { completion(.failure(LabError.message("这个标签不是漂流页面。"))); return }
        let projectID = tab.project.id
        workspace.updateDrift(projectID: projectID, driftID: drift.id, changes: changes) { [weak self] result in
            switch result {
            case .success(let reply):
                guard let stored = reply.result else { completion(.failure(LabError.message("漂流结果缺失"))); return }
                if let self {
                    self.applyDriftLibrary(projectID: projectID, library: reply.library)
                    self.onDriftLibrary?(projectID, reply.library)
                }
                completion(.success(stored))
            case .failure(let error): completion(.failure(error))
            }
        }
    }

    /// Adopt a project's complete library: element tab titles and page fields
    /// follow stored names; uncommitted header text is kept. Links follow
    /// the new names, colours and trash states; changed names or aliases
    /// link every open body again (retroactive linking).
    func applyElementLibrary(projectID: String, library: WorkspaceElementLibrary) {
        let previousLibrary = linkSources[projectID]?.library
        let lost = lostIDs(previousLibrary.map { $0.elements.map(\.id) + $0.categories.map(\.id) },
                           library.elements.map(\.id) + library.categories.map(\.id))
        defer { relationSourcesChanged(projectID: projectID, lost: lost) }
        onTrash?(projectID, .elements(library))
        for home in homes(projectID: projectID) { home.model.applyElements(library) }
        elementCategories[projectID] = library.categories
        // Rust retired the body of a trashed category; its tabs go without
        // closing the owner again.
        let trashed = Set(library.trashedCategories.map(\.id))
        for tab in allTabs where tab.project.id == projectID && tab.category.map({ trashed.contains($0.id) }) == true {
            removeAll(tab.scope)
        }
        for tab in allTabs where tab.project.id == projectID {
            if let category = tab.category, let stored = library.categories.first(where: { $0.id == category.id }) {
                tab.target = .category(stored)
                tab.categoryPage?.apply(category: stored, elementCount: library.elements.filter { $0.categoryId == stored.id }.count)
                continue
            }
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

    /// Re-reads the project's element library, e.g. after an import created
    /// an element. Observers receive it through `onElementLibrary`.
    func elementsChanged(projectID: String) {
        guard loadingElements.insert(projectID).inserted else { elementRereads.insert(projectID); return }
        workspace.elementLibrary(projectID: projectID) { [weak self] result in
            guard let self else { return }
            self.loadingElements.remove(projectID)
            if case .success(let library) = result {
                self.applyElementLibrary(projectID: projectID, library: library)
                self.onElementLibrary?(projectID, library)
            }
            if self.elementRereads.remove(projectID) != nil { self.elementsChanged(projectID: projectID) }
        }
    }

    // MARK: Materials and portraits

    /// The last 素材库 read for the project, if any.
    func materialLibrary(projectID: String) -> WorkspaceMaterialLibrary? { materialLibraries[projectID] }

    /// Adopt a project's complete 素材库: element pages show their portraits.
    func applyMaterialLibrary(projectID: String, library: WorkspaceMaterialLibrary) {
        materialLibraries[projectID] = library
        for tab in allTabs where tab.project.id == projectID && tab.page != nil { showPortrait(of: tab) }
    }

    /// Re-reads the project's 素材库. Observers receive it through `onMaterialLibrary`.
    func materialsChanged(projectID: String) {
        guard loadingMaterials.insert(projectID).inserted else { materialRereads.insert(projectID); return }
        workspace.materialLibrary(projectID: projectID) { [weak self] result in
            guard let self else { return }
            self.loadingMaterials.remove(projectID)
            if case .success(let library) = result {
                self.applyMaterialLibrary(projectID: projectID, library: library)
                self.onMaterialLibrary?(projectID, library)
            }
            if self.materialRereads.remove(projectID) != nil { self.materialsChanged(projectID: projectID) }
        }
    }

    // MARK: Category pages

    /// A new category page shows the stored fields and element count once
    /// the library was read.
    private func showCategory(of tab: Tab) {
        guard let page = tab.categoryPage, let category = tab.category,
              let library = linkSources[tab.project.id]?.library else { return }
        let stored = library.categories.first { $0.id == category.id } ?? category
        tab.target = .category(stored)
        page.apply(category: stored, elementCount: library.elements.filter { $0.categoryId == stored.id }.count)
    }

    /// Reads the category's element template into its page.
    private func loadTemplate(of tab: Tab) {
        guard let category = tab.category, let page = tab.categoryPage else { return }
        workspace.elementTemplate(projectID: tab.project.id, categoryID: category.id) { [weak page] result in
            switch result {
            case .success(let blocks): page?.showTemplate(blocks)
            case .failure(let error): page?.showTemplateUnavailable(error)
            }
        }
    }

    /// Writes the template, then reads it back as stored: every open page of
    /// the category shows it (the blocks as sent if the read fails, since
    /// the write committed), and the 设定库 adopts the reply's library.
    private func saveTemplate(_ tab: Tab, blocks: [BookImportBlock],
                              completion: @escaping (Result<[BookImportBlock], Error>) -> Void) {
        guard let category = tab.category else { completion(.failure(LabError.message("这个标签不是分类页面。"))); return }
        let projectID = tab.project.id
        workspace.setElementTemplate(projectID: projectID, categoryID: category.id, blocks: blocks) { [weak self] result in
            switch result {
            case .failure(let error): completion(.failure(error))
            case .success(let reply):
                guard let self else { completion(.failure(LabError.message("分类页面已关闭。"))); return }
                self.applyElementLibrary(projectID: projectID, library: reply.library)
                self.onElementLibrary?(projectID, reply.library)
                self.workspace.elementTemplate(projectID: projectID, categoryID: category.id) { [weak self] stored in
                    let shown = (try? stored.get()) ?? blocks
                    for tab in self?.allTabs ?? [] where tab.project.id == projectID && tab.category?.id == category.id {
                        tab.categoryPage?.showTemplate(shown)
                    }
                    completion(.success(shown))
                }
            }
        }
    }

    /// Header fields and 模板字段 are metadata writes: the body owner, its
    /// queued input and history are untouched. Every open view adopts the library.
    private func commitCategory(_ tab: Tab, completion: @escaping (Result<WorkspaceElementCategory, Error>) -> Void,
                                write: (_ projectID: String, _ categoryID: String,
                                        _ done: @escaping (Result<WorkspaceElementReply<WorkspaceElementCategory>, Error>) -> Void) -> Void) {
        guard let category = tab.category else { completion(.failure(LabError.message("这个标签不是分类页面。"))); return }
        let projectID = tab.project.id
        write(projectID, category.id) { [weak self] result in
            switch result {
            case .success(let reply):
                guard let stored = reply.result else { completion(.failure(LabError.message("分类结果缺失"))); return }
                if let self {
                    self.applyElementLibrary(projectID: projectID, library: reply.library)
                    self.onElementLibrary?(projectID, reply.library)
                }
                completion(.success(stored))
            case .failure(let error): completion(.failure(error))
            }
        }
    }

    /// 新建设定 on a category page: Rust fills the new body from the
    /// category's template; the element opens in the page's pane with its
    /// name selected.
    private func createElement(from tab: Tab) {
        guard let category = tab.category, let index = pane(of: tab) else { return }
        guard canNavigate else { tab.categoryPage?.showMessage("请先完成输入，并等待正文保存后再新建设定。"); return }
        let project = tab.project
        workspace.createElement(projectID: project.id, categoryID: category.id) { [weak self, weak tab] result in
            guard let self else { return }
            switch result {
            case .failure(let error): tab?.categoryPage?.showMessage(error.localizedDescription); self.onError?(error)
            case .success(let reply):
                self.applyElementLibrary(projectID: project.id, library: reply.library)
                self.onElementLibrary?(project.id, reply.library)
                guard let element = reply.result else { return }
                self.open(project: project, element: element, in: index) { [weak self] opened in
                    switch opened {
                    case .success: self?.focusActiveElementName()
                    case .failure(let error): self?.onError?(error)
                    }
                }
            }
        }
    }

    private func showPortrait(of tab: Tab) {
        guard let page = tab.page, let element = tab.element else { return }
        guard let library = materialLibraries[tab.project.id] else { materialsChanged(projectID: tab.project.id); return }
        page.showPortrait(path: library.portrait(elementID: element.id)?.assetPath)
    }

    /// Imports or clears the portrait. Metadata only: the body owner, its
    /// input and history are untouched. Every element page and the 素材库 follow.
    private func setPortrait(_ tab: Tab, file url: URL?, completion: @escaping (Result<String?, Error>) -> Void) {
        guard let element = tab.element else { completion(.failure(LabError.message("这个标签不是设定页面。"))); return }
        let file: MaterialSourceFile?
        do { file = try url.map { try MaterialSourceFile.inspect($0, imagesOnly: true) } } catch {
            completion(.failure(error)); return
        }
        let projectID = tab.project.id
        workspace.setElementPortrait(projectID: projectID, elementID: element.id, file: file) { [weak self] result in
            switch result {
            case .success(let reply):
                if let self {
                    self.applyMaterialLibrary(projectID: projectID, library: reply.library)
                    self.onMaterialLibrary?(projectID, reply.library)
                }
                completion(.success(reply.library.portrait(elementID: element.id)?.assetPath))
            case .failure(let error): completion(.failure(error))
            }
        }
    }

    // MARK: Relations

    /// The names relation rows and the add sheet resolve against.
    func relationNames(projectID: String) -> RelationNameDirectory {
        let sources = linkSources[projectID]
        return RelationNameDirectory(elements: sources?.library, chapters: sources?.chapters, drifts: sources?.drifts,
                                     storylines: storylineLibraries[projectID])
    }

    /// Identities live before and missing now, e.g. after a trash; nil
    /// before the first read.
    private func lostIDs(_ previous: [String]?, _ current: [String]) -> Set<String> {
        previous.map { Set($0).subtracting(current) } ?? []
    }

    /// Names follow renames. An entity that left its live list may have
    /// taken relations with it (trash purges them), so the library is read again.
    private func relationSourcesChanged(projectID: String, lost: Set<String>) {
        if !lost.isEmpty { relations.reload(projectID: projectID) }
        relations.refresh(projectID: projectID)
    }

    /// A 关系 row's other end opens in the pane that showed the row: an
    /// element, storyline, drift or category as its page, a chapter as its tab.
    private func openRelationTarget(_ endpoint: RelationEndpoint, projectID: String, from section: RelationsSectionView) {
        let tab = allTabs.first { $0.relationsView === section }
        guard let project = tab?.project ?? allTabs.first(where: { $0.project.id == projectID })?.project else { return }
        let index = tab.flatMap { pane(of: $0) } ?? activePane
        switch tabTarget(for: endpoint, projectID: projectID) {
        case .failure(let refusal): section.showMessage(refusal.localizedDescription)
        case .success(let target):
            open(project: project, target: target, in: index) { [weak self, weak section] result in
                guard case .failure(let error) = result else { return }
                section?.showMessage(error.localizedDescription)
                self?.onError?(error)
            }
        }
    }

    /// The live page a relation endpoint names, or why it is not available.
    private func tabTarget(for endpoint: RelationEndpoint, projectID: String) -> Result<WorkspaceTabTarget, LabError> {
        let sources = linkSources[projectID]
        switch endpoint.kind {
        case "element":
            guard let element = sources?.library?.elements.first(where: { $0.id == endpoint.id }) else {
                return .failure(.message("这个设定已不可用，请刷新设定库。"))
            }
            return .success(.element(element))
        case "node":
            if let chapter = sources?.chapters?.first(where: { $0.id == endpoint.id }) { return .success(.chapter(chapter)) }
            if let drift = sources?.drifts?.drift(id: endpoint.id) { return .success(.drift(drift)) }
            return .failure(.message("这一章或这条漂流已不可用，请刷新列表。"))
        case "storyline":
            guard let storyline = storylineLibraries[projectID]?.storyline(id: endpoint.id) else {
                return .failure(.message("这条故事线已不可用，请刷新故事线列表。"))
            }
            return .success(.storyline(storyline))
        case "category":
            guard let category = sources?.library?.categories.first(where: { $0.id == endpoint.id }) else {
                return .failure(.message("这个分类已不可用，请刷新设定库。"))
            }
            return .success(.category(category))
        default:
            return .failure(.message("原生版本暂不支持打开这种关系端点。"))
        }
    }

    /// Opens a chapter, drift, element, category or storyline by its
    /// relation endpoint: pages as their tabs, a chapter as its tab. An end
    /// that is not live is refused in Chinese.
    func open(endpoint: RelationEndpoint, project: WorkspaceProject, in pane: Int? = nil,
              completion: @escaping (Result<NativeDocumentView, Error>) -> Void) {
        switch tabTarget(for: endpoint, projectID: project.id) {
        case .failure(let refusal): completion(.failure(refusal))
        case .success(let target): open(project: project, target: target, in: pane, completion: completion)
        }
    }

    // MARK: Global search

    /// A global search hit opens its page as a tab in the active pane: a
    /// chapter (for its 摘要), drift, element, category or storyline. A body
    /// hit then selects its match once the owner is idle, resolved again by
    /// `workspaceResolveEntityHit` against current prose. An entity not yet
    /// in the project's libraries is read first. Reports nil, or why not.
    func reveal(searchHit hit: WorkspaceEntitySearchHit, project: WorkspaceProject, completion: @escaping (String?) -> Void) {
        pendingSearchReveal?.done("已选择另一条搜索结果。")
        pendingSearchReveal = nil
        let endpoint: RelationEndpoint
        switch hit.kind {
        case "chapter", "drift": endpoint = RelationEndpoint(kind: "node", id: hit.id)
        case "element", "category", "storyline": endpoint = RelationEndpoint(kind: hit.kind, id: hit.id)
        default: completion("这种搜索结果不在页面中打开。"); return
        }
        let open: () -> Void = { [weak self] in
            guard let self else { return }
            let opened: (Result<NativeDocumentView, Error>) -> Void = { [weak self] result in
                guard let self else { return }
                switch result {
                case .success(let view):
                    guard hit.isBody else { completion(nil); return }
                    self.pendingSearchReveal = (view, hit, project.id, completion)
                    self.resolveSearchReveal()
                case .failure(let error): completion(error.localizedDescription)
                }
            }
            if hit.kind == "chapter" {
                self.open(project: project, chapter: WorkspaceChapter(id: hit.id, title: hit.title), completion: opened)
            } else {
                self.open(endpoint: endpoint, project: project, completion: opened)
            }
        }
        guard hit.kind != "chapter", case .failure = tabTarget(for: endpoint, projectID: project.id) else { open(); return }
        // Not in the libraries read so far: read the one it belongs to.
        switch hit.kind {
        case "element", "category":
            workspace.elementLibrary(projectID: project.id) { [weak self] result in
                if case .success(let library) = result { self?.applyElementLibrary(projectID: project.id, library: library) }
                open()
            }
        case "drift":
            workspace.driftLibrary(projectID: project.id) { [weak self] result in
                if case .success(let library) = result { self?.applyDriftLibrary(projectID: project.id, library: library) }
                open()
            }
        default:
            workspace.storylineLibrary(projectID: project.id) { [weak self] result in
                if case .success(let library) = result { self?.applyStorylineLibrary(projectID: project.id, library: library) }
                open()
            }
        }
    }

    private var pendingSearchReveal: (view: NativeDocumentView, hit: WorkspaceEntitySearchHit, projectID: String, done: (String?) -> Void)?
    private var resolvingSearchReveal = false

    /// Waits for the opened page's owner to be idle (no queued or marked
    /// input, the view showing current prose), then resolves the anchors and
    /// selects the match only if nothing changed in between.
    private func resolveSearchReveal() {
        guard !resolvingSearchReveal, let pending = pendingSearchReveal, !isBusy else { return }
        guard pending.view === activeView else {
            pendingSearchReveal = nil; pending.done("当前编辑栏已变化，请重新选择搜索结果。"); return
        }
        let binding = pending.view.binding
        guard binding.canEdit, !binding.hasPendingWork, !pending.view.textView.hasMarkedText(),
              let projection = binding.store.projection,
              NativeText.identical(pending.view.textView.string, projection.text) else { return }
        pendingSearchReveal = nil
        resolvingSearchReveal = true
        workspace.resolveEntityHit(projectID: pending.projectID, hit: pending.hit) { [weak self] result in
            guard let self else { return }
            self.resolvingSearchReveal = false
            switch result {
            case .success(let location):
                guard pending.view === self.activeView else { pending.done("当前编辑栏已变化，请重新选择搜索结果。"); return }
                guard let range = location.range, pending.view.reveal(range: range, revision: location.revision) else {
                    pending.done("正文已变化，请重新搜索后再定位。"); return
                }
                pending.done(nil)
            case .failure(let error): pending.done(error.localizedDescription)
            }
            // Another hit may have been chosen meanwhile.
            self.resolveSearchReveal()
        }
    }

    // MARK: Review

    /// The active tab's page for 审阅's 当前: a chapter, drift, element,
    /// category or storyline, named as “章节「雨夜」”.
    var activeFocus: ReviewFocus? {
        guard let tab = panes[activePane].active else { return nil }
        let kind = tab.chapter != nil ? "章节" : tab.drift != nil ? "漂流" : tab.element != nil ? "设定"
            : tab.category != nil ? "分类" : "故事线"
        return ReviewFocus(endpoint: tab.relationEndpoint, label: "\(kind)「\(tab.title)」")
    }

    /// Reads the element library, chapters, drifts and storylines of a
    /// project once, so relation and association names resolve without a tab.
    func loadNames(projectID: String) {
        ensureLinkSources(projectID: projectID)
        if storylineLibraries[projectID] == nil, !loadingStorylines.contains(projectID) { storylinesChanged(projectID: projectID) }
    }

    /// 定位: opens the comment's page as a tab; a passage note then selects
    /// its current anchor in that tab, as the comment panel does. Reports
    /// nil, or why it could not.
    func locate(comment: WorkspaceComment, project: WorkspaceProject, completion: @escaping (String?) -> Void) {
        guard let target = comment.target else { completion("浮动待办没有所在的页面。"); return }
        pendingCommentLocate = nil
        open(endpoint: target, project: project) { [weak self] result in
            guard let self else { return }
            switch result {
            case .success(let view):
                guard comment.isBlock, target.kind == "node" else { completion(nil); return }
                self.pendingCommentLocate = (view, comment.id, completion)
                self.resolveCommentLocate()
            case .failure(let error): completion(error.localizedDescription)
            }
        }
    }

    private var pendingCommentLocate: (view: NativeDocumentView, commentID: String, done: (String?) -> Void)?

    private func resolveCommentLocate() {
        guard let pending = pendingCommentLocate, !isBusy else { return }
        guard pending.view === activeView else { pendingCommentLocate = nil; pending.done("当前编辑栏已变化，请重新定位。"); return }
        let binding = pending.view.binding
        guard binding.canEdit, !binding.hasPendingWork, let projection = binding.store.projection,
              NativeText.identical(pending.view.textView.string, projection.text) else { return }
        pendingCommentLocate = nil
        pending.done(pending.view.locateComment(id: pending.commentID))
    }

    /// A note or TODO changed outside its chapter's owner. A deleted
    /// passage note's highlight leaves every view of an open chapter: the
    /// owner reads its anchors again once idle.
    func commentsChanged(_ change: ReviewChange, projectID: String) {
        let comment = change.comment
        guard case .deleted = change, comment.isBlock, comment.targetKind == "node", let chapter = comment.targetId,
              let view = openView(scope: .chapter(ChapterScope(projectID: projectID, chapterID: chapter))) else { return }
        view.binding.store.load()
    }

    // MARK: 回收站

    /// 恢复 from the 回收站 through the kind's existing restore command. The
    /// reply's library or chapter lists reach every list, page and link as
    /// a restore from its own panel does; nothing is opened.
    func restore(_ item: WorkspaceTrashItem, projectID: String, completion: @escaping (Result<Void, Error>) -> Void) {
        guard item.kind != .unknown else { completion(.failure(LabError.message(WorkspaceTrashText.unknownRefusal))); return }
        guard canNavigate else { completion(.failure(blocked())); return }
        setBusy(true)
        let finish: (Error?) -> Void = { [weak self] error in
            self?.setBusy(false)
            completion(error.map { .failure($0) } ?? .success(()))
        }
        switch item.kind {
        case .chapter:
            workspace.restoreChapter(projectID: projectID, chapterID: item.id) { [weak self] result in
                if case .success(let reply) = result {
                    self?.applyChapters(projectID: projectID, chapters: reply.chapters, trashed: reply.trashedChapters)
                }
                finish(result.error)
            }
        case .drift:
            workspace.restoreDrift(projectID: projectID, driftID: item.id) { [weak self] result in
                if let self, case .success(let reply) = result {
                    self.applyDriftLibrary(projectID: projectID, library: reply.library)
                    self.onDriftLibrary?(projectID, reply.library)
                }
                finish(result.error)
            }
        case .element, .category:
            let done: (Result<WorkspaceElementLibrary, Error>) -> Void = { [weak self] result in
                if let self, case .success(let library) = result {
                    self.applyElementLibrary(projectID: projectID, library: library)
                    self.onElementLibrary?(projectID, library)
                }
                finish(result.error)
            }
            if item.kind == .element {
                workspace.restoreElement(projectID: projectID, elementID: item.id) { done($0.map(\.library)) }
            } else {
                workspace.restoreElementCategory(projectID: projectID, categoryID: item.id) { done($0.map(\.library)) }
            }
        case .storyline:
            workspace.restoreStoryline(projectID: projectID, storylineID: item.id) { [weak self] result in
                if let self, case .success(let reply) = result {
                    self.applyStorylineLibrary(projectID: projectID, library: reply.library)
                    self.onStorylineLibrary?(projectID, reply.library)
                }
                finish(result.error)
            }
        case .unknown:
            finish(LabError.message(WorkspaceTrashText.unknownRefusal))
        }
    }

    /// 彻底删除 one trashed entity. Nothing of it is open (trash retired its
    /// owner; Rust refuses an open page). Afterwards the kind's list is read
    /// again, so links to it read as plain prose and every list follows.
    func purge(_ item: WorkspaceTrashItem, projectID: String,
               completion: @escaping (Result<WorkspaceTrashPurgeReply, Error>) -> Void) {
        guard item.kind != .unknown else { completion(.failure(LabError.message(WorkspaceTrashText.unknownRefusal))); return }
        guard canNavigate else { completion(.failure(blocked())); return }
        setBusy(true)
        workspace.purgeTrashed(projectID: projectID, kind: item.rawKind, id: item.id) { [weak self] result in
            guard let self else { return }
            if case .success(let reply) = result { self.adoptPurge(reply, projectID: projectID) }
            self.setBusy(false)
            completion(result)
        }
    }

    /// 清空回收站: every trashed entity of the project in one original,
    /// only while the trash holds exactly the `confirmed` entries.
    func emptyTrash(projectID: String, confirmed: [WorkspaceTrashItem],
                    completion: @escaping (Result<WorkspaceTrashPurgeReply, Error>) -> Void) {
        guard canNavigate else { completion(.failure(blocked())); return }
        setBusy(true)
        workspace.emptyTrash(projectID: projectID, confirmed: confirmed) { [weak self] result in
            guard let self else { return }
            if case .success(let reply) = result { self.adoptPurge(reply, projectID: projectID) }
            self.setBusy(false)
            completion(result)
        }
    }

    private func adoptPurge(_ reply: WorkspaceTrashPurgeReply, projectID: String) {
        guard !reply.purged.isEmpty else { return }
        let kinds = Set(reply.purged.compactMap { WorkspaceTrashKind(rawValue: $0.kind) })
        if kinds.contains(.chapter) { chaptersChanged(projectID: projectID) }
        if kinds.contains(.drift) { driftsChanged(projectID: projectID) }
        if kinds.contains(.element) || kinds.contains(.category) { elementsChanged(projectID: projectID) }
        if kinds.contains(.storyline) { storylinesChanged(projectID: projectID) }
        // A purged chapter or drift took its 情节规划格 with it.
        for purged in reply.purged where purged.kind == "chapter" || purged.kind == "drift" {
            let key = PlotNodeKey(projectID: projectID, nodeID: purged.id)
            plotGridModels.removeValue(forKey: key)
            plotPlannerSession.removeValue(forKey: key)
            plotPlannerSettings?.forgetPlotPlanner(projectID: projectID, nodeID: purged.id)
        }
        // Purged pages leave 最近 for good; trashed ones only hide.
        homeSettings?.forgetRecentPages(ids: Set(reply.purged.map(\.id)), projectID: projectID)
        relations.reload(projectID: projectID)
        // An element's patches went with it; patch sources may name a purged chapter.
        patches.reload(projectID: projectID)
        scheduleBacklinks(projectID: projectID)
        onPurged?(projectID, reply.purged)
    }

    // MARK: 情节规划格

    private var plotGridModels: [PlotNodeKey: PlotGridModel] = [:]
    /// Dock states remembered for the session when there is no settings store.
    private var plotPlannerSession: [PlotNodeKey: PlotPlannerSetting] = [:]

    /// The node's grid, shared by every dock that shows the page.
    func plotGridModel(projectID: String, nodeID: String) -> PlotGridModel {
        let key = PlotNodeKey(projectID: projectID, nodeID: nodeID)
        if let model = plotGridModels[key] { return model }
        let model = PlotGridModel(workspace: workspace, projectID: projectID, nodeID: nodeID)
        plotGridModels[key] = model
        // Queued gestures hold navigation as queued input does.
        model.observe(self) { [weak self] in self?.plotGridActivity() }
        return model
    }

    /// How long queued 情节规划格 gestures may take before an action that
    /// waits for them refuses, as printing waits for queued input.
    static var plotGridWait: TimeInterval = 3
    private var plotGridsWereWriting = false

    /// Whether a 情节规划格 gesture of the project (or node) is queued or
    /// on its way to Rust.
    func plotGridsWriting(projectID: String? = nil, nodeID: String? = nil) -> Bool {
        plotGridModels.values.contains { ($0.projectID == projectID || projectID == nil) && ($0.nodeID == nodeID || nodeID == nil) && $0.writing }
    }

    private func plotGridActivity() {
        let writing = plotGridsWriting()
        guard writing != plotGridsWereWriting else { return }
        plotGridsWereWriting = writing
        updateTabAvailability()
        onActivity?(!canNavigate)
    }

    /// Commits the 情节规划格 cells being edited on the matching pages and
    /// calls `run` once their gestures were answered: nil when all were
    /// written, a Chinese refusal naming Rust's reason when one was refused,
    /// or one when they are still unanswered after `plotGridWait`. With
    /// nothing queued it runs at once.
    func settlePlotGrids(projectID: String? = nil, nodeID: String? = nil, purpose: String, _ run: @escaping (Error?) -> Void) {
        for tab in allTabs where (projectID == nil || tab.project.id == projectID) && (nodeID == nil || tab.nodeID == nodeID) {
            tab.plotDock?.canvas.commitEditing()
        }
        let models = plotGridModels.values.filter { ($0.projectID == projectID || projectID == nil) && ($0.nodeID == nodeID || nodeID == nil) }
        let refusals = models.map(\.refusals)
        let deadline = Date().addingTimeInterval(Self.plotGridWait)
        func check() {
            if let refused = models.indices.first(where: { models[$0].refusals != refusals[$0] }) {
                let reason = models[refused].message ?? "情节规划格未能保存。"
                run(LabError.message("情节规划格的修改没有保存：\(reason) 没有\(purpose)，请处理后再试。")); return
            }
            guard models.contains(where: \.writing) else { run(nil); return }
            guard Date() < deadline else { run(LabError.message("情节规划格还在保存，没有\(purpose)。请稍后再试。")); return }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { check() }
        }
        check()
    }

    /// Whether the page's dock was left shown, and its height.
    func plotPlannerSetting(projectID: String, nodeID: String) -> PlotPlannerSetting {
        plotPlannerSettings?.plotPlanner(projectID: projectID, nodeID: nodeID)
            ?? plotPlannerSession[PlotNodeKey(projectID: projectID, nodeID: nodeID)] ?? PlotPlannerSetting(shown: false)
    }

    private func storePlotPlanner(_ setting: PlotPlannerSetting, projectID: String, nodeID: String) {
        if let store = plotPlannerSettings { store.setPlotPlanner(setting, projectID: projectID, nodeID: nodeID) }
        else { plotPlannerSession[PlotNodeKey(projectID: projectID, nodeID: nodeID)] = setting }
    }

    /// Shows or hides the page's dock in every pane and remembers it.
    func setPlotPlanner(shown: Bool, projectID: String, nodeID: String) {
        var setting = plotPlannerSetting(projectID: projectID, nodeID: nodeID)
        setting.shown = shown
        storePlotPlanner(setting, projectID: projectID, nodeID: nodeID)
        for tab in allTabs where tab.project.id == projectID && tab.nodeID == nodeID { showPlotDock(of: tab) }
        onPlotPlanner?()
    }

    /// 视图 › 情节规划格 works on the active chapter or drift page.
    var canTogglePlotPlanner: Bool { panes[activePane].active?.nodeID != nil }
    var isActivePlotPlannerShown: Bool { panes[activePane].active?.plotDock != nil }

    func toggleActivePlotPlanner() {
        guard let tab = panes[activePane].active, let nodeID = tab.nodeID else { return }
        setPlotPlanner(shown: tab.plotDock == nil, projectID: tab.project.id, nodeID: nodeID)
    }

    /// A tab's dock of the node, e.g. for acceptance.
    func retainedPlotDock(pane: Int, nodeID: String) -> MacPlotPlannerDock? {
        guard panes.indices.contains(pane) else { return nil }
        return panes[pane].tabs.first { $0.nodeID == nodeID }?.plotDock
    }

    /// Grids changed outside the docks (a received original, or anything
    /// done while the window was not key): every model of the project, or of
    /// every project, reads its grid again.
    func refreshPlotGrids(projectID: String? = nil) {
        for model in plotGridModels.values where projectID == nil || model.projectID == projectID { model.load() }
    }

    /// Attaches or removes the tab's dock as the page's setting says.
    private func showPlotDock(of tab: Tab) {
        guard let nodeID = tab.nodeID else { return }
        let projectID = tab.project.id
        let setting = plotPlannerSetting(projectID: projectID, nodeID: nodeID)
        guard setting.shown else {
            // Hiding keeps a cell being edited.
            tab.plotDock?.canvas.commitEditing()
            if tab.plotDock != nil { tab.showPlotDock(nil) }
            return
        }
        if let dock = tab.plotDock { dock.setHeight(CGFloat(setting.height)); return }
        let dock = MacPlotPlannerDock(model: plotGridModel(projectID: projectID, nodeID: nodeID), height: CGFloat(setting.height))
        dock.presentAlert = { [weak self, weak dock] alert, done in self?.present(alert, from: dock?.window, completion: done) }
        dock.onHide = { [weak self] in self?.setPlotPlanner(shown: false, projectID: projectID, nodeID: nodeID) }
        dock.onResized = { [weak self] height in
            guard let self else { return }
            var stored = self.plotPlannerSetting(projectID: projectID, nodeID: nodeID)
            stored.height = PlotPlannerSetting.clamped(Double(height))
            self.storePlotPlanner(stored, projectID: projectID, nodeID: nodeID)
            for other in self.allTabs where other.project.id == projectID && other.nodeID == nodeID {
                other.plotDock?.setHeight(CGFloat(stored.height))
            }
        }
        dock.onFocus = { [weak self, weak tab] in
            guard let self, let tab, let index = self.pane(of: tab) else { return }
            self.activate(pane: index)
        }
        tab.showPlotDock(dock)
        dock.model.load()
    }

    private func present(_ alert: NSAlert, from window: NSWindow?, completion: @escaping (NSApplication.ModalResponse) -> Void) {
        if let presentAlert { presentAlert(alert, window, completion); return }
        if let window = window ?? self.window { alert.beginSheetModal(for: window, completionHandler: completion) }
        else { completion(alert.runModal()) }
    }

    // MARK: 漂流转为章节 / 转为设定

    /// 转为章节… or 转为设定… from a drift page or the 漂流 panel: asks for
    /// the primary storyline (or none) or the category, then converts.
    /// Completes with nil when the author cancels.
    func beginConversion(_ kind: DriftConversionKind, driftID: String, project: WorkspaceProject, from window: NSWindow?,
                         completion: @escaping (Result<DriftConversionOutcome, Error>?) -> Void) {
        guard canNavigateAfterPlotGrids else { completion(.failure(blocked())); return }
        let projectID = project.id
        let ask: (WorkspaceDrift) -> Void = { [weak self] drift in
            guard let self else { return }
            let actName = drift.actId.flatMap { self.actNames[projectID]?[$0] }
            switch kind {
            case .chapter:
                self.withStorylines(projectID: projectID) { storylines in
                    let (alert, popup) = DriftConversionPicker.chapter(drift: drift, storylines: storylines, actName: actName)
                    self.present(alert, from: window) { response in
                        guard response == .alertFirstButtonReturn else { completion(nil); return }
                        let chosen = popup.selectedItem?.representedObject as? String ?? ""
                        self.convertDriftToChapter(project: project, driftID: drift.id, storylineID: chosen.isEmpty ? nil : chosen) { result in
                            completion(result.map { chapter in DriftConversionOutcome.chapter(chapter, driftID: drift.id) })
                        }
                    }
                }
            case .element:
                self.withCategories(projectID: projectID) { categories in
                    guard let (alert, popup) = DriftConversionPicker.element(drift: drift, categories: categories, actName: actName) else {
                        completion(.failure(LabError.message("还没有分类。请先在设定库新建一个分类，再把漂流转为设定。"))); return
                    }
                    self.present(alert, from: window) { response in
                        guard response == .alertFirstButtonReturn, let category = popup.selectedItem?.representedObject as? String else {
                            completion(nil); return
                        }
                        self.convertDriftToElement(project: project, driftID: drift.id, categoryID: category) { result in
                            completion(result.map { DriftConversionOutcome.element($0.element, driftID: drift.id, carried: $0.carried) })
                        }
                    }
                }
            }
        }
        if let drift = linkSources[projectID]?.drifts?.drift(id: driftID) { ask(drift); return }
        workspace.driftLibrary(projectID: projectID) { [weak self] result in
            guard let self else { return }
            guard case .success(let library) = result, let drift = library.drift(id: driftID) else {
                completion(.failure(LabError.message("这条漂流已不可用，请刷新漂流列表。"))); return
            }
            self.applyDriftLibrary(projectID: projectID, library: library)
            ask(drift)
        }
    }

    private func withStorylines(projectID: String, _ body: @escaping ([WorkspaceStoryline]) -> Void) {
        if let library = storylineLibraries[projectID] { body(library.storylines); return }
        workspace.storylineLibrary(projectID: projectID) { [weak self] result in
            let library = try? result.get()
            if let self, let library { self.applyStorylineLibrary(projectID: projectID, library: library) }
            body(library?.storylines ?? [])
        }
    }

    private func withCategories(projectID: String, _ body: @escaping ([WorkspaceElementCategory]) -> Void) {
        if let library = linkSources[projectID]?.library { body(library.categories); return }
        workspace.elementLibrary(projectID: projectID) { [weak self] result in
            let library = try? result.get()
            if let self, let library { self.applyElementLibrary(projectID: projectID, library: library) }
            body(library?.categories ?? [])
        }
    }

    /// Where a body's tabs are: each pane's position and whether selected.
    private struct TabPlace { let pane: Int; let index: Int; let selected: Bool }
    private func places(of scope: DocumentScope) -> [TabPlace] {
        panes.indices.compactMap { index in
            panes[index].tabs.firstIndex { $0.scope == scope }.map {
                TabPlace(pane: index, index: $0, selected: panes[index].selected == scope && panes[index].shownHome == nil)
            }
        }
    }

    /// 转为章节: one Rust original; the drift's tabs become the chapter's in
    /// the same places (the same body, now its own chapter owner). The
    /// drift, chapter and storyline lists and act names are read again.
    func convertDriftToChapter(project: WorkspaceProject, driftID: String, storylineID: String?,
                               completion: @escaping (Result<WorkspaceChapter, Error>) -> Void) {
        guard canNavigateAfterPlotGrids else { completion(.failure(blocked())); return }
        let projectID = project.id
        let scope = DocumentScope.drift(DriftScope(projectID: projectID, driftID: driftID))
        // A title being typed is saved first; it is ahead on the queue.
        for tab in allTabs where tab.scope == scope { tab.endEditing() }
        // So are the drift's 情节规划格 gestures, answered before it converts.
        settlePlotGrids(projectID: projectID, nodeID: driftID, purpose: "转换") { [weak self] error in
            guard let self else { return }
            if let error { completion(.failure(error)); return }
            guard self.canNavigateAfterPlotGrids else { completion(.failure(self.blocked())); return }
            self.convertToChapterNow(project: project, driftID: driftID, storylineID: storylineID, completion: completion)
        }
    }

    private func convertToChapterNow(project: WorkspaceProject, driftID: String, storylineID: String?,
                                     completion: @escaping (Result<WorkspaceChapter, Error>) -> Void) {
        let projectID = project.id
        let scope = DocumentScope.drift(DriftScope(projectID: projectID, driftID: driftID))
        let places = self.places(of: scope), active = activePane
        setBusy(true)
        workspace.convertDriftToChapter(projectID: projectID, driftID: driftID, storylineID: storylineID) { [weak self] result in
            guard let self else { return }
            switch result {
            case .failure(let error):
                self.setBusy(false); self.onChange?(); completion(.failure(error))
            case .success(let reply):
                guard let chapter = reply.result else {
                    self.setBusy(false); completion(.failure(LabError.message("转换结果缺失，请刷新章节列表。"))); return
                }
                // Rust released the drift's owner; its tabs go without closing it again.
                self.removeAll(scope)
                self.applyDriftLibrary(projectID: projectID, library: reply.library)
                self.onDriftLibrary?(projectID, reply.library)
                self.chaptersChanged(projectID: projectID)
                self.storylinesChanged(projectID: projectID)
                self.actsChanged(projectID: projectID)
                self.wordCountModels[projectID]?.scheduleRefresh()
                self.setBusy(false)
                let target = WorkspaceTabTarget.chapter(chapter)
                let placed = places.isEmpty ? [TabPlace(pane: active, index: .max, selected: true)] : places
                self.replaceTabs(at: placed, with: target, project: project, active: active) { error in
                    self.onDriftConverted?(projectID, .chapter(chapter, driftID: driftID))
                    if let error { self.onError?(error) }
                    completion(.success(chapter))
                }
            }
        }
    }

    /// Acceptance only: an error standing in for Rust's 转为设定 reply, sent
    /// instead of the command. Rust's failures after the element was created
    /// cannot be provoked from the app, so their handling is driven this way.
    var injectedElementConversionFailure: ((String) -> Error?)?

    /// 转为设定: Rust creates the element from the drift's title, summary
    /// and body, carries its relations and whole-drift notes over and
    /// trashes the drift. The drift's tabs close and the element opens where
    /// the drift was shown. The drift's 情节规划格 gestures are answered first.
    func convertDriftToElement(project: WorkspaceProject, driftID: String, categoryID: String,
                               completion: @escaping (Result<WorkspaceDriftElementConversion, Error>) -> Void) {
        guard canNavigateAfterPlotGrids else { completion(.failure(blocked())); return }
        let projectID = project.id
        let scope = DocumentScope.drift(DriftScope(projectID: projectID, driftID: driftID))
        for tab in allTabs where tab.scope == scope { tab.endEditing() }
        settlePlotGrids(projectID: projectID, nodeID: driftID, purpose: "转换") { [weak self] error in
            guard let self else { return }
            if let error { completion(.failure(error)); return }
            guard self.canNavigateAfterPlotGrids else { completion(.failure(self.blocked())); return }
            self.convertToElementNow(project: project, driftID: driftID, categoryID: categoryID, completion: completion)
        }
    }

    private func convertToElementNow(project: WorkspaceProject, driftID: String, categoryID: String,
                                     completion: @escaping (Result<WorkspaceDriftElementConversion, Error>) -> Void) {
        let projectID = project.id
        let scope = DocumentScope.drift(DriftScope(projectID: projectID, driftID: driftID))
        let places = self.places(of: scope)
        let place = places.first { $0.selected } ?? places.first
        let active = activePane
        setBusy(true)
        let adopt: (Result<WorkspaceDriftReply<WorkspaceDriftElementConversion>, Error>) -> Void = { [weak self] result in
            guard let self else { return }
            switch result {
            case .failure(let error):
                self.adoptFailedElementConversion(error, project: project, driftID: driftID, places: places, active: active) {
                    completion(.failure(error))
                }
            case .success(let reply):
                guard let conversion = reply.result else {
                    self.setBusy(false); completion(.failure(LabError.message("转换结果缺失，请刷新设定库。"))); return
                }
                let element = conversion.element
                self.removeAll(scope)
                self.applyDriftLibrary(projectID: projectID, library: reply.library)
                self.onDriftLibrary?(projectID, reply.library)
                self.elementsChanged(projectID: projectID)
                self.actsChanged(projectID: projectID)
                // Carried relations: every 关系 section and the 设定总览 read them.
                self.relations.reload(projectID: projectID)
                self.setBusy(false)
                let target = WorkspaceTabTarget.element(element)
                let placed = [TabPlace(pane: place?.pane ?? active, index: place?.index ?? .max, selected: true)]
                self.replaceTabs(at: placed, with: target, project: project, active: place?.pane ?? active) { error in
                    self.onDriftConverted?(projectID, .element(element, driftID: driftID, carried: conversion.carried))
                    if let error { self.onError?(error) }
                    completion(.success(conversion))
                }
            }
        }
        if let injected = injectedElementConversionFailure?(driftID) {
            DispatchQueue.main.async { adopt(.failure(injected)) }
            return
        }
        workspace.convertDriftToElement(projectID: projectID, driftID: driftID, categoryID: categoryID, completion: adopt)
    }

    /// A refused 转为设定 changed nothing. One that stopped after Rust
    /// created the element (“设定「…」已创建…”) did: the element, drift,
    /// trash and relation lists are read again, and whoever asked shows
    /// Rust's message as it is. The drift's tabs stay unless the drift is in
    /// the trash; when Rust already released its body (a failed trash), they
    /// show a freshly opened body in the same places.
    private func adoptFailedElementConversion(_ error: Error, project: WorkspaceProject, driftID: String, places: [TabPlace], active: Int,
                                              completion: @escaping () -> Void) {
        let projectID = project.id
        let scope = DocumentScope.drift(DriftScope(projectID: projectID, driftID: driftID))
        let partial = LabError.isPartialElementConversion(error)
        if partial {
            elementsChanged(projectID: projectID)
            relations.reload(projectID: projectID)
            onDriftConversionStopped?(projectID)
        }
        guard partial || !workspace.hasOpenDocument(scope) else {
            setBusy(false); onChange?(); completion(); return
        }
        workspace.driftLibrary(projectID: projectID) { [weak self] result in
            guard let self else { return }
            let library = try? result.get()
            if let library {
                self.applyDriftLibrary(projectID: projectID, library: library)
                self.onDriftLibrary?(projectID, library)
            }
            guard !self.workspace.hasOpenDocument(scope) else { self.setBusy(false); self.onChange?(); completion(); return }
            self.removeAll(scope)
            guard let drift = library?.drift(id: driftID), !places.isEmpty else { self.setBusy(false); self.onChange?(); completion(); return }
            self.setBusy(false)
            self.replaceTabs(at: places, with: .drift(drift), project: project, active: active) { reopenError in
                if let reopenError { self.onError?(reopenError) }
                completion()
            }
        }
    }

    /// Opens `target` once and shows it in each place, at the same
    /// position, selected where the old tab was selected; `active` stays the
    /// active pane.
    private func replaceTabs(at places: [TabPlace], with target: WorkspaceTabTarget, project: WorkspaceProject, active: Int,
                             completion: @escaping (Error?) -> Void) {
        setBusy(true)
        openCore(project, target, reopen: false) { [weak self] result in
            guard let self else { return }
            guard case .success(let core) = result else {
                self.setBusy(false); self.onChange?()
                if case .failure(let error) = result { completion(error) }
                return
            }
            var created: [Tab] = []
            for place in places where self.panes.indices.contains(place.pane) {
                let pane = self.panes[place.pane]
                let previous = pane.selected, previousHome = pane.shownHome
                let (tab, isNew) = self.install(core, project: project, target: target, in: place.pane)
                if isNew { created.append(tab) }
                if let from = pane.tabs.firstIndex(where: { $0 === tab }) {
                    pane.tabs.remove(at: from)
                    pane.tabs.insert(tab, at: min(place.index, pane.tabs.count))
                }
                if !place.selected, let previous, pane.tabs.contains(where: { $0.scope == previous }) {
                    pane.selected = previous
                    self.showSelected(in: place.pane)
                }
                if !place.selected, let previousHome, pane.homes.contains(where: { $0.project.id == previousHome }) {
                    pane.shownHome = previousHome
                    self.showSelected(in: place.pane)
                }
            }
            if self.panes.indices.contains(active) { self.activePane = active }
            self.pendingFocus = self.activeView
            self.refreshTabs()
            self.setBusy(false)
            self.onChange?()
            self.focusWhenReady()
            created.forEach { self.prepare($0) }
            completion(nil)
        }
    }

    // MARK: 项目主页

    /// Where 项目主页 reads the 写作计划, 今日字数 and 最近, and where opened
    /// pages are remembered for 最近; nil offers no 项目主页 and remembers nothing.
    var homeSettings: LabSettingsStore?
    /// 编辑资料… on a 项目主页.
    var onEditProjectProfile: ((WorkspaceProject) -> Void)?

    private func homes(projectID: String) -> [HomeTab] { panes.flatMap(\.homes).filter { $0.project.id == projectID } }

    /// The project's 项目主页 page, if a pane has one.
    func homePage(projectID: String) -> MacProjectHomeView? { homes(projectID: projectID).first?.page }

    /// Opens the project's 项目主页: the one already open (in either pane)
    /// is shown and read again; otherwise a new tab in `pane` or the active
    /// pane. One per project.
    @discardableResult
    func openHome(project: WorkspaceProject, in pane: Int? = nil) -> MacProjectHomeView? {
        guard let settings = homeSettings else { onError?(LabError.message("项目主页暂不可用。")); return nil }
        guard canNavigate else { onError?(blocked()); return nil }
        let index: Int
        let home: HomeTab
        if let existing = panes.indices.first(where: { panes[$0].homes.contains { $0.project.id == project.id } }),
           let open = panes[existing].homes.first(where: { $0.project.id == project.id }) {
            index = existing; home = open
            home.project = project
        } else {
            index = pane.map { panes.indices.contains($0) ? $0 : activePane } ?? activePane
            let model = ProjectHomeModel(workspace: workspace, settings: settings, project: project)
            home = HomeTab(project: project, model: model)
            connect(home)
            panes[index].homes.append(home)
        }
        // Leaving a body tab saves its header edit, as switching tabs does.
        panes[index].active?.endEditing()
        panes[index].shownHome = project.id
        activePane = index
        showSelected(in: index)
        // The keyboard leaves the body the page replaced.
        window?.makeFirstResponder(nil)
        // Counts come from the host's model; everything else is read now.
        if let counts = wordCounts(projectID: project.id).library { home.model.applyWordCounts(counts) }
        home.model.load()
        onChange?()
        return home.page
    }

    /// Closes a 项目主页; the pane shows its selected body tab again.
    func closeHome(projectID: String, pane index: Int) {
        guard panes.indices.contains(index), let home = panes[index].homes.first(where: { $0.project.id == projectID }) else { return }
        panes[index].homes.removeAll { $0 === home }
        home.page.removeFromSuperview()
        if panes[index].shownHome == projectID { panes[index].shownHome = nil }
        showSelected(in: index)
        if index == activePane { pendingFocus = activeView; focusWhenReady() }
        onChange?()
    }

    /// 项目资料 was saved: open 项目主页 read the summary again.
    func projectDetailsChanged(projectID: String) {
        for home in homes(projectID: projectID) { home.model.reloadDetails() }
    }

    private func connect(_ home: HomeTab) {
        home.model.isShown = { [weak self, weak home] in
            guard let self, let home else { return false }
            return self.panes.contains { $0.home === home }
        }
        home.page.onEditProfile = { [weak self, weak home] in
            guard let self, let home else { return }
            self.onEditProjectProfile?(home.project)
        }
        let open: (WorkspaceTabTarget) -> Void = { [weak self, weak home] target in
            guard let self, let home else { return }
            let index = self.panes.firstIndex { $0.homes.contains { $0 === home } } ?? self.activePane
            self.open(project: home.project, target: target, in: index) { [weak self] result in
                if case .failure(let error) = result { self?.onError?(error) }
            }
        }
        home.page.onOpenChapter = { open(.chapter($0)) }
        home.page.onOpenCategory = { open(.category($0)) }
        home.page.onOpenRecent = { open($0.target) }
    }

    /// Every page opened in a tab joins the project's 最近.
    private func recordRecent(_ target: WorkspaceTabTarget, projectID: String) {
        let page: RecentPage
        switch target {
        case .chapter(let chapter): page = RecentPage(kind: .chapter, id: chapter.id)
        case .drift(let drift): page = RecentPage(kind: .drift, id: drift.id)
        case .element(let element): page = RecentPage(kind: .element, id: element.id)
        case .category(let category): page = RecentPage(kind: .category, id: category.id)
        case .storyline(let storyline): page = RecentPage(kind: .storyline, id: storyline.id)
        }
        homeSettings?.recordRecentPage(page, projectID: projectID)
    }

    // MARK: Project deletion

    /// Closes every tab of the project in both panes, one at a time, saving
    /// each as closing a tab does. The first tab that cannot close stops it
    /// with the reason; tabs already closed stay closed.
    func closeTabs(projectID: String, completion: @escaping (Result<Void, Error>) -> Void) {
        // A 项目主页 holds no body: it closes at once.
        for index in panes.indices where panes[index].homes.contains(where: { $0.project.id == projectID }) {
            closeHome(projectID: projectID, pane: index)
        }
        guard let (index, tab) = panes.enumerated().lazy.compactMap({ entry in
            entry.element.tabs.first { $0.project.id == projectID }.map { (entry.offset, $0) }
        }).first else {
            completion(.success(())); return
        }
        let title = tab.title
        closeTab(pane: index, scope: tab.scope) { [weak self] result in
            switch result {
            case .success: self?.closeTabs(projectID: projectID, completion: completion)
            case .failure(let error):
                completion(.failure(LabError.message("“\(title)”无法关闭：\(error.localizedDescription)")))
            }
        }
    }

    /// Whether any tab shows a page of the project.
    func hasTabs(projectID: String) -> Bool {
        allTabs.contains { $0.project.id == projectID } || !homes(projectID: projectID).isEmpty
    }

    /// Drops everything read for a deleted project.
    func forget(projectID: String) {
        linkSources.removeValue(forKey: projectID)
        linkDirectories.removeValue(forKey: projectID)
        storylineLibraries.removeValue(forKey: projectID)
        materialLibraries.removeValue(forKey: projectID)
        elementCategories.removeValue(forKey: projectID)
        actNames.removeValue(forKey: projectID)
        backlinkRefresh.removeValue(forKey: projectID)?.cancel()
        wordCountModels.removeValue(forKey: projectID)?.cancel()
        countedRevisions = countedRevisions.filter { $0.key.projectID != projectID }
        relations.forget(projectID: projectID)
        patches.forget(projectID: projectID)
        plotGridModels = plotGridModels.filter { $0.value.projectID != projectID }
        plotPlannerSession = plotPlannerSession.filter { $0.key.projectID != projectID }
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
        defer { relationSourcesChanged(projectID: projectID, lost: lostIDs(previous?.map(\.id), chapters.map(\.id))) }
        // A created, trashed or restored chapter changes the book total.
        if previous?.map(\.id) != chapters.map(\.id) { wordCountModels[projectID]?.scheduleRefresh() }
        linkSources[projectID, default: LinkSources()].chapters = chapters
        for home in homes(projectID: projectID) { home.model.applyChapters(chapters) }
        if let trashed {
            linkSources[projectID]?.trashedChapters = trashed
            onTrash?(projectID, .chapters(live: chapters, trashed: trashed))
        }
        updateLinkDirectory(projectID: projectID)
        if previous.map(titles) != titles(chapters) {
            requestEntityLinks(projectID: projectID)
            // Patches name their source chapter while it is live.
            if previous != nil { patches.reload(projectID: projectID) }
        }
        scheduleBacklinks(projectID: projectID)
        for tab in allTabs where tab.project.id == projectID {
            if let page = tab.storylinePage { showChapters(of: page, projectID: projectID) }
        }
        // Memberships list live chapters in book order: a created, moved,
        // trashed or restored chapter changes them.
        if previous?.map(\.id) != chapters.map(\.id), storylineLibraries[projectID] != nil || onStorylineLibrary != nil {
            storylinesChanged(projectID: projectID)
        }
    }

    private func updateLinkDirectory(projectID: String) {
        guard let sources = linkSources[projectID], let library = sources.library, let chapters = sources.chapters,
              let drifts = sources.drifts else { return }
        let directory = EntityLinkDirectory(library: library, chapters: chapters, trashedChapters: sources.trashedChapters ?? [],
                                            drifts: drifts)
        guard linkDirectories[projectID] != directory else { return }
        linkDirectories[projectID] = directory
        for tab in allTabs where tab.project.id == projectID { tab.view.linkDirectory = directory }
        for external in externalViews.values where external.project.id == projectID { external.view?.linkDirectory = directory }
    }

    /// Every open body of the project links once it is idle. Queued input,
    /// composition and drafts defer the pass; nothing is interrupted.
    private func requestEntityLinks(projectID: String) {
        var seen = Set<ObjectIdentifier>()
        let views = allTabs.filter { $0.project.id == projectID }.map(\.view)
            + externalViews.values.filter { $0.project.id == projectID }.compactMap(\.view)
        for view in views {
            let store = view.binding.store
            if seen.insert(ObjectIdentifier(store)).inserted { store.requestEntityLinks() }
        }
    }

    // MARK: @ picker

    /// The @ picker's names for one body: the project's live element names
    /// and aliases, then its live chapter titles, without the body's own.
    func mentionSource(projectID: String, excludingElement: String?, excludingChapter: String?) -> ProseMentionSource {
        let sources = linkSources[projectID]
        return ProseMentionSource(library: sources?.library, chapters: sources?.chapters ?? [],
                                  excludingElement: excludingElement, excludingChapter: excludingChapter)
    }

    /// ＋ 新建设定「…」 from the @ picker: one element named as typed in the
    /// chosen category. Every open view adopts the library, and names that
    /// changed link again, as after 新建设定 in the 设定库.
    func createElementFromPicker(projectID: String, name: String, categoryID: String,
                                 completion: @escaping (Result<WorkspaceElement, Error>) -> Void) {
        workspace.createElement(projectID: projectID, categoryID: categoryID, name: name) { [weak self] result in
            switch result {
            case .success(let reply):
                if let self {
                    self.applyElementLibrary(projectID: projectID, library: reply.library)
                    self.onElementLibrary?(projectID, reply.library)
                }
                completion(reply.result.map { .success($0) } ?? .failure(LabError.message("设定结果缺失")))
            case .failure(let error): completion(.failure(error))
            }
        }
    }

    // MARK: 悬停卡片

    /// The project's element library as last read.
    func elementLibrary(projectID: String) -> WorkspaceElementLibrary? { linkSources[projectID]?.library }

    /// A live link's 悬停卡片: what the library knows at once, then the
    /// element's valid patches, the pages linking it and its portrait, or a
    /// chapter's or drift's status, summary and words. Reads only.
    func hoverCard(for target: EntityLinkTarget, projectID: String, completion: @escaping (EntityHoverCardContent) -> Void) {
        var content = EntityHoverCardContent(target: target)
        guard !target.trashed else { completion(content); return }
        switch target.kind {
        case .element:
            if let element = linkSources[projectID]?.library?.elements.first(where: { $0.id == target.id }) {
                if let group = element.groupName?.trimmingCharacters(in: .whitespacesAndNewlines), !group.isEmpty {
                    content.meta.append(group)
                }
                content.aliases = EntityHoverCardContent.aliases(element.aliases)
                content.summary = element.summary
                content.facts = EntityHoverCardContent.facts(element.facts)
            }
            let workspace = self.workspace, cached = materialLibraries[projectID]
            workspace.elementPatches(projectID: projectID, elementID: target.id) { patches in
                workspace.elementBacklinks(projectID: projectID, elementID: target.id) { backlinks in
                    var counts: [String] = []
                    if case .success(let list) = patches { counts.append("有效补丁 \(list.filter { !$0.isInvalid }.count)") }
                    if case .success(let links) = backlinks {
                        counts.append("被 \(links.chapters.count + links.sources.count) 个章节和页面引用")
                    }
                    content.counts = counts.isEmpty ? nil : counts.joined(separator: " · ")
                    if let cached {
                        content.portraitPath = cached.portrait(elementID: target.id)?.assetPath
                        completion(content); return
                    }
                    workspace.materialLibrary(projectID: projectID) { library in
                        content.portraitPath = (try? library.get())?.portrait(elementID: target.id)?.assetPath
                        completion(content)
                    }
                }
            }
        case .chapter, .drift:
            let counted = wordCountLibrary(projectID: projectID)
            workspace.nodeMetadata(projectID: projectID, nodeID: target.id) { [weak self] result in
                if case .success(let metadata) = result {
                    content.title = metadata.title
                    content.meta.append(WritingStatus.label(metadata.writingStatus))
                    content.summary = metadata.summary
                }
                let words: (Int?) -> Void = { count in
                    content.meta.append(count.map(WordCountText.full) ?? "字数统计中")
                    completion(content)
                }
                if let counted, counted.contains(nodeID: target.id) { words(counted.count(nodeID: target.id)); return }
                guard let self else { words(nil); return }
                self.workspace.wordCounts(projectID: projectID) { counts in
                    words((try? counts.get())?.counts.first { $0.nodeId == target.id }?.wordCount)
                }
            }
        }
    }

    // MARK: Views outside the tabs

    /// A chapter view shown outside the tabs by the 全书长卷. It shares the
    /// chapter's owner with any tab of that chapter, and closing such a tab
    /// leaves the owner open for it; the 全书长卷 closes the owner when it
    /// lets go. Weak: a released view drops out.
    private struct ExternalView {
        weak var view: NativeDocumentView?
        let project: WorkspaceProject
        let scope: DocumentScope
    }
    private var externalViews: [ObjectIdentifier: ExternalView] = [:]

    /// Whether a tab in either pane shows this body.
    func hasTab(_ scope: DocumentScope) -> Bool { allTabs.contains { $0.scope == scope } }

    private func holdsExternally(_ scope: DocumentScope) -> Bool {
        externalViews.values.contains { $0.scope == scope && $0.view != nil }
    }

    /// A tab's view of the body, else one outside the tabs; nil when none is open.
    func openView(scope: DocumentScope) -> NativeDocumentView? {
        (0..<paneCount).compactMap { retainedView(pane: $0, scope: scope) }.first
            ?? externalViews.values.first { $0.scope == scope && $0.view != nil }?.view
    }

    /// Links in the view follow the project's names and link passes run as
    /// in tabs; a comment created there is reported like a tab's.
    func adoptExternal(_ view: NativeDocumentView, project: WorkspaceProject, chapterID: String) {
        let scope = DocumentScope.chapter(ChapterScope(projectID: project.id, chapterID: chapterID))
        externalViews = externalViews.filter { $0.value.view != nil }
        externalViews[ObjectIdentifier(view)] = ExternalView(view: view, project: project, scope: scope)
        view.linkDirectory = linkDirectories[project.id]
        view.onEntityLinks = { [weak self] in self?.scheduleBacklinks(projectID: project.id) }
        view.hoverCardSource = { [weak self] target, done in self?.hoverCard(for: target, projectID: project.id, completion: done) }
        view.onCommentCreated = { [weak self, weak view] comment in
            if let self, let view { self.onCommentCreated?(view, comment) }
        }
        view.patchNodeID = chapterID
        view.onCreatePatch = { [weak self, weak view] source in
            guard let self else { return }
            self.patches.beginCreate(projectID: project.id, source: source, from: view?.window ?? self.window)
        }
        view.mentionSource = { [weak self] in
            self?.mentionSource(projectID: project.id, excludingElement: nil, excludingChapter: chapterID) ?? .empty
        }
        view.onCreateElement = { [weak self] name, categoryID, done in
            guard let self else { done(.failure(LabError.message("全书长卷已关闭，设定未创建。"))); return }
            self.createElementFromPicker(projectID: project.id, name: name, categoryID: categoryID, completion: done)
        }
        ensureLinkSources(projectID: project.id)
    }

    /// The view's binding was detached; it no longer holds the owner.
    func releaseExternal(_ view: NativeDocumentView) {
        externalViews.removeValue(forKey: ObjectIdentifier(view))
        view.onEntityLinks = nil; view.onCommentCreated = nil; view.hoverCardSource = nil
        view.onCreatePatch = nil; view.patchNodeID = nil
        view.mentionSource = nil; view.onCreateElement = nil
    }

    /// The view's owner settled: a body saved at a new revision is counted,
    /// and visible 被引用 sections read again, as for tabs.
    func externalBodySettled(_ view: NativeDocumentView) {
        guard let external = externalViews[ObjectIdentifier(view)] else { return }
        scheduleBacklinks(projectID: external.project.id)
        guard let revision = view.binding.state?.projection.revision, countedRevisions[external.scope] != revision else { return }
        countedRevisions[external.scope] = revision
        wordCounts(projectID: external.project.id).scheduleRefresh()
        patches.bodySaved(projectID: external.project.id)
    }

    private func pane(of tab: Tab) -> Int? { panes.firstIndex { $0.tabs.contains { $0 === tab } } }

    /// ⌘-click or 打开「名称」: an element or drift opens as its page tab, a
    /// chapter as its chapter tab, in the pane that showed the link.
    private func openLink(_ target: EntityLinkTarget, from tab: Tab) {
        guard let index = pane(of: tab) else { return }
        openLink(target, project: tab.project, in: index)
    }

    /// Opens a link target as a tab, e.g. one ⌘-clicked in the 全书长卷; the
    /// active pane by default.
    func openLink(_ target: EntityLinkTarget, project: WorkspaceProject, in pane: Int? = nil) {
        let index = pane ?? activePane
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
        case .drift:
            guard let drift = linkSources[project.id]?.drifts?.drift(id: target.id) else {
                onError?(LabError.message("「\(target.name)」已不可用，请刷新漂流列表。")); return
            }
            open(project: project, drift: drift, in: index, completion: done)
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

    /// A 被引用 page row: open the drift, element, category or storyline page
    /// in the element page's pane and select its first link when that range
    /// still links the element; otherwise just open it.
    private func openBacklink(_ source: WorkspaceElementBacklinks.Source, elementID: String, from tab: Tab) {
        guard let index = pane(of: tab) else { return }
        pendingLinkReveal = nil
        open(endpoint: source.endpoint, project: tab.project, in: index) { [weak self, weak tab] result in
            guard let self else { return }
            switch result {
            case .success(let view):
                self.pendingLinkReveal = (view, source.first, elementID)
                self.resolveLinkReveal()
            case .failure(let error):
                // The page may have left since the list was read.
                tab?.page?.reloadBacklinks()
                self.onError?(error)
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

    /// A patch's source link: open its chapter (or drift) in the section's
    /// pane and select the anchored text while it is still there; otherwise
    /// just open it.
    private func openPatchSource(_ patch: WorkspacePatch, projectID: String, from section: ElementPatchesView) {
        guard let nodeID = patch.sourceNodeId,
              let tab = allTabs.first(where: { $0.page?.patchesView === section }), let index = pane(of: tab) else { return }
        pendingPatchReveal = nil
        let done: (Result<NativeDocumentView, Error>) -> Void = { [weak self] result in
            guard let self else { return }
            switch result {
            case .success(let view):
                self.pendingPatchReveal = (view, patch)
                self.resolvePatchReveal()
            case .failure(let error): section.showMessage(error.localizedDescription)
            }
        }
        if let chapter = linkSources[projectID]?.chapters?.first(where: { $0.id == nodeID }) {
            open(project: tab.project, chapter: chapter, in: index, completion: done)
        } else if let drift = linkSources[projectID]?.drifts?.drift(id: nodeID) {
            open(project: tab.project, drift: drift, in: index, completion: done)
        } else if linkSources[projectID]?.chapters == nil {
            open(project: tab.project, chapter: WorkspaceChapter(id: nodeID, title: patch.sourceNodeTitle ?? ""), in: index, completion: done)
        } else {
            section.showMessage("补丁的来源章节已不可用（可能已移到回收站）。")
        }
    }

    private func resolvePatchReveal() {
        guard let pending = pendingPatchReveal, !isBusy else { return }
        guard pending.view === activeView else { pendingPatchReveal = nil; return }
        let binding = pending.view.binding
        guard binding.canEdit, !binding.hasPendingWork, let projection = binding.store.projection,
              NativeText.identical(pending.view.textView.string, projection.text) else { return }
        pendingPatchReveal = nil
        guard let anchor = pending.patch.anchorText else { return }
        let block = pending.patch.sourceBlockId.flatMap { id in projection.blocks.first { $0.id == id }?.range }
        if let range = PatchText.anchorRange(in: projection.text, anchor: anchor, block: block) {
            pending.view.reveal(range: NativeRange(location: range.location, length: range.length), revision: projection.revision)
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

    /// Moves the keyboard to the active storyline page's name field, e.g.
    /// after creating a storyline from the panel.
    func focusActiveStorylineName() {
        guard let page = activeStorylinePage else { return }
        pendingFocus = nil
        page.focusName()
    }

    /// Storyline header fields and facts are metadata writes like element
    /// ones. Every open view and the panel adopt the returned library.
    private func commitStoryline(_ tab: Tab, completion: @escaping (Result<WorkspaceStoryline, Error>) -> Void,
                                 write: (_ projectID: String, _ storylineID: String,
                                         _ done: @escaping (Result<WorkspaceStorylineReply<WorkspaceStoryline>, Error>) -> Void) -> Void) {
        guard let storyline = tab.storyline else { completion(.failure(LabError.message("这个标签不是故事线页面。"))); return }
        let projectID = tab.project.id
        write(projectID, storyline.id) { [weak self] result in
            switch result {
            case .success(let reply):
                guard let stored = reply.result else { completion(.failure(LabError.message("故事线结果缺失"))); return }
                if let self {
                    self.applyStorylineLibrary(projectID: projectID, library: reply.library)
                    self.onStorylineLibrary?(projectID, reply.library)
                }
                completion(.success(stored))
            case .failure(let error): completion(.failure(error))
            }
        }
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
        if let section = tab.relationsView {
            relations.attach(section, projectID: tab.project.id, endpoint: tab.relationEndpoint)
        }
        tab.view.isInteractionLocked = isBusy || externallyLocked
        tab.view.onFocus = { [weak self] in self?.activate(pane: pane) }
        tab.view.linkDirectory = linkDirectories[tab.project.id]
        tab.view.onOpenLink = { [weak self, weak tab] target in
            if let self, let tab { self.openLink(target, from: tab) }
        }
        tab.view.hoverCardSource = { [weak self, weak tab] target, done in
            if let self, let tab { self.hoverCard(for: target, projectID: tab.project.id, completion: done) }
        }
        tab.view.onEntityLinks = { [weak self, weak tab] in
            if let self, let tab { self.scheduleBacklinks(projectID: tab.project.id) }
        }
        let ownElement = tab.element?.id, ownChapter = tab.chapter?.id
        tab.view.mentionSource = { [weak self, weak tab] in
            guard let self, let tab else { return .empty }
            return self.mentionSource(projectID: tab.project.id, excludingElement: ownElement, excludingChapter: ownChapter)
        }
        tab.view.onCreateElement = { [weak self, weak tab] name, categoryID, done in
            guard let self, let tab else { done(.failure(LabError.message("标签已关闭，设定未创建。"))); return }
            self.createElementFromPicker(projectID: tab.project.id, name: name, categoryID: categoryID, completion: done)
        }
        if let page = tab.page, let element = tab.element {
            patches.attach(page.patchesView, projectID: tab.project.id, elementID: element.id)
        }
        if let (kind, id) = copilotBody(of: tab) {
            // Copilot hears the author's edits, 分析 and the body closing.
            let projectID = tab.project.id
            tab.view.onEdited = { [weak self, weak view = tab.view] in
                guard let self, let view else { return }
                self.copilot?(projectID)?.edited(kind: kind, id: id, store: view.binding.store)
            }
            tab.view.canCopilotAnalyze = { [weak self] in self?.copilot?(projectID)?.canAnalyze(kind) == true }
            tab.view.onCopilotAnalyze = { [weak self, weak view = tab.view] selection in
                guard let self, let view else { return }
                self.copilot?(projectID)?.analyze(kind: kind, id: id, store: view.binding.store, selection: selection)
            }
        }
        if let nodeID = tab.nodeID {
            // 新建补丁… from a chapter or drift selection.
            tab.view.patchNodeID = nodeID
            tab.view.onCreatePatch = { [weak self, weak tab] source in
                guard let self, let tab else { return }
                self.patches.beginCreate(projectID: tab.project.id, source: source, from: self.window)
            }
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
            page.onOpenBacklinkSource = { [weak self, weak tab] source in
                guard let self, let tab, let element = tab.element else { return }
                self.openBacklink(source, elementID: element.id, from: tab)
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
            page.onSetPortrait = { [weak self, weak tab] url, done in
                guard let self, let tab else { done(.failure(LabError.message("设定页面已关闭，肖像未保存。"))); return }
                self.setPortrait(tab, file: url, completion: done)
            }
        } else if let page = tab.storylinePage {
            page.onFocus = { [weak self] in self?.activate(pane: pane) }
            page.onOpenChapter = { [weak self, weak tab] chapter in
                guard let self, let tab, let index = self.pane(of: tab) else { return }
                self.open(project: tab.project, chapter: chapter, in: index) { [weak self] result in
                    if case .failure(let error) = result { self?.onError?(error) }
                }
            }
            page.onCommit = { [weak self, weak tab] changes, done in
                guard let self, let tab else { done(.failure(LabError.message("故事线页面已关闭，修改未保存。"))); return }
                self.commitStoryline(tab, completion: done) {
                    self.workspace.updateStoryline(projectID: $0, storylineID: $1, changes: changes, completion: $2)
                }
            }
            page.onCommitFacts = { [weak self, weak tab] facts, done in
                guard let self, let tab else { done(.failure(LabError.message("故事线页面已关闭，字段未保存。"))); return }
                self.commitStoryline(tab, completion: done) {
                    self.workspace.setStorylineFacts(projectID: $0, storylineID: $1, facts: facts, completion: $2)
                }
            }
        } else if let page = tab.driftPage {
            page.onFocus = { [weak self] in self?.activate(pane: pane) }
            page.onCommit = { [weak self, weak tab] changes, done in
                guard let self, let tab else { done(.failure(LabError.message("漂流页面已关闭，修改未保存。"))); return }
                self.commitDrift(tab, changes: changes, completion: done)
            }
            page.onConvert = { [weak self, weak tab, weak page] kind in
                guard let self, let tab, let drift = tab.drift else { return }
                page?.showMessage(nil)
                let projectID = tab.project.id
                self.beginConversion(kind, driftID: drift.id, project: tab.project, from: self.window) { [weak self] result in
                    guard let self, case .failure(let error)? = result else { return }
                    // The drift's pages say why; after a failed trash they are new pages of a reopened body.
                    let pages = self.allTabs.filter { $0.project.id == projectID && $0.drift?.id == drift.id }.compactMap(\.driftPage)
                    for shown in pages.isEmpty ? [page].compactMap({ $0 }) : pages { shown.showMessage(error.localizedDescription) }
                    self.onError?(error)
                }
            }
        } else if let page = tab.categoryPage {
            page.onFocus = { [weak self] in self?.activate(pane: pane) }
            page.onCommit = { [weak self, weak tab] changes, done in
                guard let self, let tab else { done(.failure(LabError.message("分类页面已关闭，修改未保存。"))); return }
                self.commitCategory(tab, completion: done) {
                    self.workspace.updateElementCategory(projectID: $0, categoryID: $1, name: changes.name, color: changes.color, completion: $2)
                }
            }
            page.onCommitFacts = { [weak self, weak tab] facts, done in
                guard let self, let tab else { done(.failure(LabError.message("分类页面已关闭，模板字段未保存。"))); return }
                self.commitCategory(tab, completion: done) {
                    self.workspace.setCategoryTemplateFacts(projectID: $0, categoryID: $1, facts: facts, completion: $2)
                }
            }
            page.onSaveTemplate = { [weak self, weak tab] blocks, done in
                guard let self, let tab else { done(.failure(LabError.message("分类页面已关闭，模版未保存。"))); return }
                self.saveTemplate(tab, blocks: blocks, completion: done)
            }
            page.onCreateElement = { [weak self, weak tab] in
                if let self, let tab { self.createElement(from: tab) }
            }
        } else {
            tab.chapterPage?.metadataEditor.onFocus = { [weak self] in self?.activate(pane: pane) }
            tab.view.onComments = { [weak self, weak view = tab.view] in
                if let self, let view { self.onComments?(view) }
            }
            tab.view.onCommentCreated = { [weak self, weak view = tab.view] comment in
                if let self, let view { self.onCommentCreated?(view, comment) }
            }
        }
        tab.plotToggle?.onToggle = { [weak self, weak tab] in
            guard let self, let tab, let nodeID = tab.nodeID else { return }
            self.activate(pane: pane)
            let shown = self.plotPlannerSetting(projectID: tab.project.id, nodeID: nodeID).shown
            self.setPlotPlanner(shown: !shown, projectID: tab.project.id, nodeID: nodeID)
        }
        tab.metadataEditor?.onCommit = { [weak self, weak tab] change, done in
            guard let self, let tab else { done(.failure(LabError.message("页面已关闭，摘要和状态未保存。"))); return }
            self.commitMetadata(tab, change, completion: done)
        }
        tab.view.onActivity = { [weak self, weak tab] busy in
            guard let self else { return }
            self.updateTabAvailability()
            self.focusWhenReady()
            self.resolveLinkReveal()
            self.resolvePatchReveal()
            self.resolveCommentLocate()
            self.resolveSearchReveal()
            // Settled chapter prose may add or remove references.
            if !busy, let tab, tab.chapter != nil { self.scheduleBacklinks(projectID: tab.project.id) }
            if !busy, let tab { self.countSavedBody(of: tab) }
            self.onActivity?(!self.canNavigate)
        }
    }
    /// The body Copilot knows a chapter or drift tab by.
    private func copilotBody(of tab: Tab) -> (CopilotBodyKind, String)? {
        if let chapter = tab.chapter { return (.chapter, chapter.id) }
        if let drift = tab.drift { return (.drift, drift.id) }
        return nil
    }

    private func showCopilotStatus() {
        for (index, pane) in panes.enumerated() {
            let text = index == activePane ? copilotStatus ?? "" : ""
            pane.copilotLabel.stringValue = text
            pane.copilotLabel.isHidden = text.isEmpty
        }
    }

    private func disconnect(_ tab: Tab) {
        if let (kind, id) = copilotBody(of: tab), !allTabs.contains(where: { $0 !== tab && $0.scope == tab.scope }) {
            // The body's last tab: a Copilot run reading it stops.
            copilot?(tab.project.id)?.closed(kind: kind, id: id)
        }
        tab.view.onEdited = nil; tab.view.canCopilotAnalyze = nil; tab.view.onCopilotAnalyze = nil
        if let section = tab.relationsView { relations.detach(section) }
        if let page = tab.page { patches.detach(page.patchesView) }
        tab.view.onCreatePatch = nil; tab.view.patchNodeID = nil
        tab.view.onActivity = nil; tab.view.onFocus = nil; tab.view.onComments = nil; tab.view.onCommentCreated = nil
        tab.view.onOpenLink = nil; tab.view.onEntityLinks = nil; tab.view.hoverCardSource = nil
        tab.view.mentionSource = nil; tab.view.onCreateElement = nil
        tab.page?.onFocus = nil; tab.page?.onCommit = nil; tab.page?.onCommitFacts = nil
        tab.page?.onLoadBacklinks = nil; tab.page?.onOpenBacklink = nil; tab.page?.onOpenBacklinkSource = nil; tab.page?.onSetPortrait = nil
        tab.storylinePage?.onFocus = nil; tab.storylinePage?.onCommit = nil; tab.storylinePage?.onCommitFacts = nil
        tab.storylinePage?.onOpenChapter = nil
        tab.driftPage?.onFocus = nil; tab.driftPage?.onCommit = nil; tab.driftPage?.onConvert = nil
        tab.plotToggle?.onToggle = nil
        tab.showPlotDock(nil)
        tab.categoryPage?.endTemplateSheet()
        tab.categoryPage?.onFocus = nil; tab.categoryPage?.onCommit = nil; tab.categoryPage?.onCommitFacts = nil
        tab.categoryPage?.onSaveTemplate = nil; tab.categoryPage?.onCreateElement = nil
        tab.metadataEditor?.onCommit = nil; tab.chapterPage?.metadataEditor.onFocus = nil
        _ = tab.view.binding.detach(); tab.content.removeFromSuperview()
    }
    private func setBusy(_ value: Bool) {
        isBusy = value
        for tab in allTabs {
            tab.view.isInteractionLocked = value || externallyLocked
        }
        updateTabAvailability()
        if !value { focusWhenReady(); resolvePatchReveal(); resolveCommentLocate(); resolveSearchReveal() }
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
            pane.historyButton.isEnabled = enabled && pane.active != nil
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
        pane.historyButton.bezelStyle = .recessed
        pane.historyButton.controlSize = .small
        pane.historyButton.font = .systemFont(ofSize: NSFont.smallSystemFontSize)
        pane.historyButton.target = self; pane.historyButton.action = #selector(historyPressed(_:))
        pane.historyButton.setAccessibilityIdentifier("show-history-\(index)")
        pane.historyButton.toolTip = "查看并恢复这一页正文的历史版本（⌥⌘Y）"
        pane.copilotLabel.font = .systemFont(ofSize: NSFont.smallSystemFontSize)
        pane.copilotLabel.textColor = .secondaryLabelColor
        pane.copilotLabel.lineBreakMode = .byTruncatingTail
        pane.copilotLabel.setContentCompressionResistancePriority(.init(1), for: .horizontal)
        pane.copilotLabel.setAccessibilityIdentifier("copilot-status-\(index)")
        pane.copilotLabel.isHidden = true
        let header = NSStackView(views: [pane.label, NSView(), pane.copilotLabel, pane.historyButton])
        let stack = NSStackView(views: [header, scroll, pane.body])
        stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = 6
        stack.translatesAutoresizingMaskIntoConstraints = false
        pane.root.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: pane.root.leadingAnchor, constant: 6),
            stack.trailingAnchor.constraint(equalTo: pane.root.trailingAnchor, constant: -6),
            stack.topAnchor.constraint(equalTo: pane.root.topAnchor), stack.bottomAnchor.constraint(equalTo: pane.root.bottomAnchor),
            scroll.heightAnchor.constraint(equalToConstant: 34), scroll.widthAnchor.constraint(equalTo: stack.widthAnchor),
            header.widthAnchor.constraint(equalTo: stack.widthAnchor),
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
        let removed = panes.removeLast()
        removed.homes.forEach { $0.page.removeFromSuperview() }
        removed.homes.removeAll()
        removed.root.removeFromSuperview()
        activePane = 0; pendingFocus = activeView
        splitView.adjustSubviews(); refreshTabs(); focusWhenReady(); onChange?()
    }
    private func remove(_ tab: Tab, from index: Int, commitHeader: Bool = true) {
        if commitHeader { tab.endEditing() }
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
        // Leaving a page saves its header edit before the view is hidden.
        for child in pane.body.subviews where child !== pane.content {
            (child as? MacElementPageView)?.endEditing()
            (child as? MacStorylinePageView)?.endEditing()
            (child as? MacDriftPageView)?.endEditing()
            (child as? MacChapterPageView)?.endEditing()
            (child as? MacCategoryPageView)?.endEditing()
        }
        for child in pane.body.subviews { child.removeFromSuperview() }
        if let view = pane.content {
            view.translatesAutoresizingMaskIntoConstraints = false; pane.body.addSubview(view)
            NSLayoutConstraint.activate([
                view.leadingAnchor.constraint(equalTo: pane.body.leadingAnchor), view.trailingAnchor.constraint(equalTo: pane.body.trailingAnchor),
                view.topAnchor.constraint(equalTo: pane.body.topAnchor), view.bottomAnchor.constraint(equalTo: pane.body.bottomAnchor),
            ])
        }
        // An element page reads 被引用 each time it is shown, a 情节规划格 its grid.
        pane.active?.page?.reloadBacklinks()
        pane.active?.plotDock?.model.load()
        refreshTabs()
    }
    @objc private func historyPressed(_ sender: NSButton) {
        guard let index = panes.firstIndex(where: { $0.historyButton === sender }), panes[index].active != nil else { return }
        activate(pane: index)
        guard activePane == index else { return }
        onShowHistory?()
    }

    @objc private func accentChanged() { refreshTabs() }

    private func refreshTabs() {
        for (index, pane) in panes.enumerated() {
            pane.label.stringValue = panes.count == 1 ? "标签" : "\(index == 0 ? "左栏" : "右栏")\(index == activePane ? " · 当前" : "")"
            pane.label.textColor = index == activePane ? .labelColor : .secondaryLabelColor
            pane.historyButton.isEnabled = canNavigate && pane.active != nil
            let copilotText = index == activePane ? copilotStatus ?? "" : ""
            pane.copilotLabel.stringValue = copilotText
            pane.copilotLabel.isHidden = copilotText.isEmpty
            for child in pane.tabsBar.arrangedSubviews { pane.tabsBar.removeArrangedSubview(child); child.removeFromSuperview() }
            for home in pane.homes {
                let projectID = home.project.id
                let select = ChapterTabButton(title: "项目主页 · \(home.project.name)") { [weak self] in
                    self?.openHome(project: home.project, in: index)
                }
                select.setAccessibilityIdentifier("home-tab-\(projectID)")
                select.state = pane.shownHome == projectID ? .on : .off
                select.contentTintColor = pane.shownHome == projectID ? MacEditorPreferences.accentColor : nil
                select.isEnabled = canNavigate
                let close = ChapterTabButton(title: "×") { [weak self] in self?.closeHome(projectID: projectID, pane: index) }
                close.setAccessibilityIdentifier("close-home-tab-\(projectID)")
                close.setAccessibilityLabel("关闭 项目主页 · \(home.project.name)")
                close.isEnabled = canNavigate
                pane.tabsBar.addArrangedSubview(NSStackView(views: [select, close]))
            }
            for tab in pane.tabs {
                let kind = tab.element != nil ? "element" : tab.storyline != nil ? "storyline" : tab.drift != nil ? "drift"
                    : tab.category != nil ? "category" : "chapter"
                let id = tab.chapter?.id ?? tab.element?.id ?? tab.storyline?.id ?? tab.drift?.id ?? tab.category?.id ?? ""
                let title = tab.element != nil ? "设定 · \(tab.title)" : tab.storyline != nil ? "故事线 · \(tab.title)"
                    : tab.drift != nil ? "漂流 · \(tab.title)" : tab.category != nil ? "分类 · \(tab.title)" : tab.title
                let select = ChapterTabButton(title: title) { [weak self] in
                    guard let self else { return }
                    self.open(project: tab.project, target: tab.target, in: index) { result in
                        if case .failure(let error) = result { self.onError?(error) }
                    }
                }
                select.setAccessibilityIdentifier("\(kind)-tab-\(id)")
                select.state = pane.selected == tab.scope ? .on : .off
                select.contentTintColor = pane.selected == tab.scope ? MacEditorPreferences.accentColor : nil
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

/// A chapter or drift of a project, for its 情节规划格.
struct PlotNodeKey: Hashable {
    let projectID: String
    let nodeID: String
}

/// What a drift became.
enum DriftConversionOutcome {
    case chapter(WorkspaceChapter, driftID: String)
    case element(WorkspaceElement, driftID: String, carried: WorkspaceDriftCarry)

    /// What the status line and the 漂流 panel say.
    var message: String {
        switch self {
        case .chapter(let chapter, _): return "漂流已转为章节《\(chapter.title)》，加在全书最后。"
        case .element(let element, _, let carried): return carried.report(elementName: element.name)
        }
    }
}
