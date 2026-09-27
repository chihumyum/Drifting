import AppKit

/// 关系: an entity's curated relations on either side, newest first, each
/// read as “类型 · 角色 → 对方名称” with the other entity's kind beside it
/// (← when this entity is the target, ↔ for symmetric types). The name opens
/// the other entity; the row menu changes the type, swaps a directed relation
/// or removes it. Typography and spacing only.
final class RelationsSectionView: NSView {
    final class Row {
        let entry: RelationEntry
        let view: NSStackView
        let leadLabel: NSTextField
        let nameButton: NSButton
        let kindLabel: NSTextField
        let menuButton: NSPopUpButton
        init(entry: RelationEntry, view: NSStackView, leadLabel: NSTextField, nameButton: NSButton, kindLabel: NSTextField,
             menuButton: NSPopUpButton) {
            self.entry = entry; self.view = view; self.leadLabel = leadLabel; self.nameButton = nameButton
            self.kindLabel = kindLabel; self.menuButton = menuButton
        }
    }

    private let title = NSTextField(labelWithString: "关系")
    let addButton = NSButton(title: "添加关系…", target: nil, action: nil)
    let typesButton = NSButton(title: "关系类型…", target: nil, action: nil)
    private let rowsStack = NSStackView()
    private let message = NSTextField(wrappingLabelWithString: "")
    /// Long lists show this many relations until expanded, so the body stays in view.
    static let collapsedCount = 5
    static let emptyText = "还没有关系。可以用“添加关系…”把它与章节、漂流、设定、分类或故事线关联起来。"
    private static let staleNote = "关系暂时无法刷新，显示的是上次读取的结果。"
    private(set) var expanded = false
    /// The relations listed, newest first, including collapsed ones.
    private(set) var entries: [RelationEntry] = []
    /// One row per shown relation.
    private(set) var rows: [Row] = []
    /// Muted lines: the empty state, a read in progress or a read failure.
    private(set) var mutedLines: [String] = []
    var onOpen: ((RelationEntry) -> Void)?
    var onAdd: (() -> Void)?
    var onManageTypes: (() -> Void)?
    var onRetype: ((RelationEntry) -> Void)?
    var onSwap: ((RelationEntry) -> Void)?
    var onRemove: ((RelationEntry) -> Void)?

    /// The last refusal of a row action or read, until the next success.
    var errorMessage: String? { message.isHidden ? nil : message.stringValue }

    override init(frame: NSRect) {
        super.init(frame: frame)
        setAccessibilityIdentifier("relations-section")
        title.font = .systemFont(ofSize: 12, weight: .semibold)
        title.textColor = .secondaryLabelColor
        title.setAccessibilityIdentifier("relations-title")
        for (button, identifier, action) in [(addButton, "add-relation", #selector(add)), (typesButton, "manage-relation-types", #selector(manageTypes))] {
            button.isBordered = false
            button.font = .systemFont(ofSize: 12)
            button.target = self; button.action = action
            button.setAccessibilityIdentifier(identifier)
        }
        addButton.contentTintColor = .labAccent
        typesButton.contentTintColor = .secondaryLabelColor
        NotificationCenter.default.addObserver(self, selector: #selector(accentChanged), name: MacEditorPreferences.didChange, object: nil)
        let header = NSStackView(views: [title, NSView(), addButton, typesButton])
        header.spacing = 10
        rowsStack.orientation = .vertical; rowsStack.alignment = .leading; rowsStack.spacing = 2
        message.font = .systemFont(ofSize: 12)
        message.textColor = .systemRed
        message.isHidden = true
        message.setAccessibilityIdentifier("relations-error")
        let stack = NSStackView(views: [header, rowsStack, message])
        stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = 4
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: leadingAnchor), stack.trailingAnchor.constraint(equalTo: trailingAnchor),
            stack.topAnchor.constraint(equalTo: topAnchor), stack.bottomAnchor.constraint(equalTo: bottomAnchor),
            header.widthAnchor.constraint(equalTo: stack.widthAnchor),
            rowsStack.widthAnchor.constraint(equalTo: stack.widthAnchor),
            message.widthAnchor.constraint(equalTo: stack.widthAnchor),
        ])
        show(nil)
    }
    @objc private func accentChanged() { addButton.contentTintColor = .labAccent }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    /// Wraps the section with the page's side margins, like 被引用.
    func inset() -> NSView {
        let row = NSView()
        translatesAutoresizingMaskIntoConstraints = false
        row.addSubview(self)
        NSLayoutConstraint.activate([
            leadingAnchor.constraint(equalTo: row.leadingAnchor, constant: 14),
            trailingAnchor.constraint(equalTo: row.trailingAnchor, constant: -14),
            topAnchor.constraint(equalTo: row.topAnchor, constant: 2),
            bottomAnchor.constraint(equalTo: row.bottomAnchor, constant: -2),
        ])
        return row
    }

    /// The relations newest first; nil while the library is being read.
    /// Unchanged relations and names keep the rows as they are.
    func show(_ entries: [RelationEntry]?) {
        if entries != nil, errorMessage == Self.staleNote { showMessage(nil) }
        if let entries, entries == self.entries, mutedLines == (entries.isEmpty ? [Self.emptyText] : []) { return }
        clear()
        guard let entries else { addMuted("正在读取关系…"); return }
        self.entries = entries
        title.stringValue = entries.isEmpty ? "关系" : "关系 · \(entries.count)"
        if entries.isEmpty { addMuted(Self.emptyText) }
        let shown = expanded ? entries.count : min(entries.count, Self.collapsedCount)
        for entry in entries.prefix(shown) { addRow(entry) }
        if entries.count > Self.collapsedCount {
            let toggle = NSButton(title: expanded ? "收起" : "显示其余 \(entries.count - Self.collapsedCount) 条",
                                  target: self, action: #selector(toggleExpanded))
            toggle.isBordered = false
            toggle.contentTintColor = .secondaryLabelColor
            toggle.font = .systemFont(ofSize: 12)
            toggle.setAccessibilityIdentifier("relations-toggle")
            rowsStack.addArrangedSubview(toggle)
        }
    }

    /// A failed read: the last list stays with a note, or the reason alone.
    func showUnavailable(_ text: String) {
        if entries.isEmpty { clear(); addMuted("关系暂时无法读取：\(text)") }
        else { showMessage(Self.staleNote) }
    }

    func showMessage(_ text: String?) {
        message.stringValue = text ?? ""
        message.isHidden = text == nil
    }

    func row(relationID: String) -> Row? { rows.first { $0.entry.relation.id == relationID } }

    /// The row's actions, also offered by its context menu and used by acceptance.
    func menuItems(for entry: RelationEntry) -> [NSMenuItem] {
        let open = LibraryMenuItem(title: "打开「\(entry.otherName.name)」", identifier: "relation-open") { [weak self] in
            self?.onOpen?(entry)
        }
        open.isEnabled = entry.otherName.available
        let retype = LibraryMenuItem(title: "改为其他类型…", identifier: "relation-retype") { [weak self] in self?.onRetype?(entry) }
        var items: [NSMenuItem] = [open, .separator(), retype]
        if entry.type?.isSymmetric == false {
            let swap = LibraryMenuItem(title: "交换方向", identifier: "relation-swap") { [weak self] in self?.onSwap?(entry) }
            swap.isEnabled = entry.canSwap
            if !entry.canSwap { swap.toolTip = "交换后两端不符合这个关系类型的端点约束。" }
            items.append(swap)
        }
        items.append(.separator())
        items.append(LibraryMenuItem(title: "删除关系", identifier: "relation-remove") { [weak self] in self?.onRemove?(entry) })
        return items
    }

    private func addRow(_ entry: RelationEntry) {
        let id = entry.relation.id
        let lead = NSTextField(labelWithString: "\(entry.lead) \(entry.arrow)")
        lead.font = .systemFont(ofSize: 12)
        lead.textColor = .secondaryLabelColor
        lead.lineBreakMode = .byTruncatingTail
        lead.setContentCompressionResistancePriority(.init(250), for: .horizontal)
        lead.setAccessibilityIdentifier("relation-lead-\(id)")
        let name = NSButton(title: "", target: self, action: #selector(openRow(_:)))
        name.isBordered = false
        name.alignment = .left
        name.attributedTitle = NSAttributedString(string: entry.otherName.name, attributes: [.font: NSFont.systemFont(ofSize: 13),
            .foregroundColor: entry.otherName.available ? NSColor.labelColor : NSColor.tertiaryLabelColor])
        name.isEnabled = entry.otherName.available
        name.lineBreakMode = .byTruncatingTail
        name.setContentCompressionResistancePriority(.init(260), for: .horizontal)
        name.toolTip = entry.otherName.available ? "打开「\(entry.otherName.name)」" : nil
        name.setAccessibilityIdentifier("relation-open-\(id)")
        name.setAccessibilityLabel(entry.text)
        let kind = NSTextField(labelWithString: entry.otherName.kindLabel)
        kind.font = .systemFont(ofSize: 11)
        kind.textColor = .tertiaryLabelColor
        kind.setContentHuggingPriority(.required, for: .horizontal)
        let menu = NSPopUpButton(frame: .zero, pullsDown: true)
        menu.isBordered = false
        (menu.cell as? NSPopUpButtonCell)?.arrowPosition = .noArrow
        menu.setAccessibilityIdentifier("relation-menu-\(id)")
        menu.setAccessibilityLabel("关系操作")
        let placeholder = NSMenuItem(title: "", action: nil, keyEquivalent: "")
        placeholder.image = NSImage(systemSymbolName: "ellipsis", accessibilityDescription: "关系操作")
        menu.menu?.addItem(placeholder)
        for item in menuItems(for: entry) { menu.menu?.addItem(item) }
        menu.setContentHuggingPriority(.required, for: .horizontal)
        let row = NSStackView(views: [lead, name, kind, NSView(), menu])
        row.spacing = 6
        row.setAccessibilityIdentifier("relation-row-\(id)")
        row.toolTip = Self.explanation(entry)
        let context = NSMenu()
        for item in menuItems(for: entry) { context.addItem(item) }
        row.menu = context
        rowsStack.addArrangedSubview(row)
        row.widthAnchor.constraint(equalTo: rowsStack.widthAnchor).isActive = true
        rows.append(Row(entry: entry, view: row, leadLabel: lead, nameButton: name, kindLabel: kind, menuButton: menu))
    }

    /// “师徒：老周（师父）→ 阿岚（徒弟）”, from this entity's side.
    static func explanation(_ entry: RelationEntry) -> String {
        guard entry.type != nil else { return "这条关系的类型已不可用，可以改为其他类型或删除。" }
        let own = "这一项（\(entry.ownRole)）", other = "\(entry.otherName.name)（\(entry.otherRole)）"
        if entry.isSymmetric { return "\(entry.typeName)：\(own) 与 \(other)" }
        return entry.direction == .outgoing ? "\(entry.typeName)：\(own) → \(other)" : "\(entry.typeName)：\(other) → \(own)"
    }

    private func clear() {
        for row in rowsStack.arrangedSubviews { rowsStack.removeArrangedSubview(row); row.removeFromSuperview() }
        entries = []; rows = []; mutedLines = []
        title.stringValue = "关系"
    }

    private func addMuted(_ text: String) {
        let label = NSTextField(wrappingLabelWithString: text)
        label.font = .systemFont(ofSize: 12)
        label.textColor = .secondaryLabelColor
        rowsStack.addArrangedSubview(label)
        label.widthAnchor.constraint(equalTo: rowsStack.widthAnchor).isActive = true
        mutedLines.append(text)
    }

    @objc private func toggleExpanded() {
        expanded.toggle()
        let current = entries
        clear()
        show(current)
    }
    @objc private func openRow(_ sender: NSButton) {
        guard let row = rows.first(where: { $0.nameButton === sender }) else { return }
        onOpen?(row.entry)
    }
    @objc private func add() { onAdd?() }
    @objc private func manageTypes() { onManageTypes?() }
}

/// Owns each project's relation library and every relation section shown for
/// it. Each reply's library reaches every section of the project and the add
/// sheet; names come from the tab host's libraries and follow renames and
/// trash. Row actions write through the project's model; a refusal is shown
/// on the section that asked and writes nothing.
final class RelationCoordinator {
    private final class Binding {
        weak var section: RelationsSectionView?
        let projectID: String
        let endpoint: RelationEndpoint
        init(section: RelationsSectionView, projectID: String, endpoint: RelationEndpoint) {
            self.section = section; self.projectID = projectID; self.endpoint = endpoint
        }
    }

    private let workspace: LabWorkspaceCore
    private var models: [String: RelationLibraryModel] = [:]
    private var bindings: [Binding] = []
    /// The project's current names; set by the tab host.
    var names: ((String) -> RelationNameDirectory)?
    /// Rows name a kind whose library has not been read (storylines are read on demand).
    var requestNames: ((String) -> Void)?
    /// Opens the other end of a relation shown in a section.
    var onOpen: ((String, RelationEndpoint, RelationsSectionView) -> Void)?
    var onManageTypes: ((String) -> Void)?
    /// Presents 改为其他类型…. Nil uses a sheet on the section's window;
    /// acceptance answers here without one.
    var presentAlert: ((NSAlert, @escaping (NSApplication.ModalResponse) -> Void) -> Void)?
    /// Presents a sheet window over a parent. Nil begins a sheet on the parent.
    var presentSheet: ((NSWindow, NSWindow?) -> Void)?
    /// The open 添加关系… sheet, if any.
    private(set) var addSheet: AddRelationSheet?

    init(workspace: LabWorkspaceCore) { self.workspace = workspace }

    private var associationModels: [String: AssociationModel] = [:]

    /// The project's 关联 of notes, TODOs and library items, over the same
    /// relation library; names follow the tab host's.
    func associations(projectID: String) -> AssociationModel {
        if let model = associationModels[projectID] { return model }
        let model = AssociationModel(projectID: projectID, relations: self.model(projectID: projectID)) { [weak self] in
            self?.names?(projectID) ?? .empty
        }
        associationModels[projectID] = model
        return model
    }

    /// Drops a deleted project's models; its sections are gone with its tabs.
    func forget(projectID: String) {
        models.removeValue(forKey: projectID)
        associationModels.removeValue(forKey: projectID)
        bindings.removeAll { $0.section == nil || $0.projectID == projectID }
    }

    /// The project's model, read once when first asked for.
    func model(projectID: String) -> RelationLibraryModel {
        if let model = models[projectID] { return model }
        let model = RelationLibraryModel(workspace: workspace, projectID: projectID)
        models[projectID] = model
        model.onLibrary = { [weak self] _ in self?.refresh(projectID: projectID) }
        model.onReadFailure = { [weak self] reason in
            guard let self else { return }
            for binding in self.bindings where binding.projectID == projectID { binding.section?.showUnavailable(reason) }
        }
        model.load()
        return model
    }

    /// Shows the endpoint's relations in the section and routes its actions.
    func attach(_ section: RelationsSectionView, projectID: String, endpoint: RelationEndpoint) {
        bindings.removeAll { $0.section == nil || $0.section === section }
        bindings.append(Binding(section: section, projectID: projectID, endpoint: endpoint))
        section.onOpen = { [weak self, weak section] entry in
            guard let self, let section else { return }
            section.showMessage(nil)
            self.onOpen?(projectID, entry.other, section)
        }
        section.onAdd = { [weak self, weak section] in
            if let self, let section { self.beginAdd(from: section, projectID: projectID, anchor: endpoint) }
        }
        section.onManageTypes = { [weak self] in self?.onManageTypes?(projectID) }
        section.onRetype = { [weak self, weak section] entry in
            if let self, let section { self.retype(entry, projectID: projectID, from: section) }
        }
        section.onSwap = { [weak self, weak section] entry in
            guard let self, let section else { return }
            self.model(projectID: projectID).retype(relationID: entry.relation.id, typeID: entry.relation.relationTypeId, swap: true) {
                [weak section] result in section?.report(result)
            }
        }
        section.onRemove = { [weak self, weak section] entry in
            guard let self, let section else { return }
            self.model(projectID: projectID).remove(relationID: entry.relation.id) { [weak section] result in section?.report(result) }
        }
        let model = self.model(projectID: projectID)
        show(section, endpoint: endpoint, model: model, names: names?(projectID) ?? .empty)
    }

    func detach(_ section: RelationsSectionView) {
        bindings.removeAll { $0.section == nil || $0.section === section }
        section.onOpen = nil; section.onAdd = nil; section.onManageTypes = nil
        section.onRetype = nil; section.onSwap = nil; section.onRemove = nil
    }

    /// Every section and the add sheet of the project show the current
    /// library with current names.
    func refresh(projectID: String) {
        guard let model = models[projectID] else { return }
        let names = self.names?(projectID) ?? .empty
        associationModels[projectID]?.namesChanged()
        for binding in bindings where binding.projectID == projectID {
            if let section = binding.section { show(section, endpoint: binding.endpoint, model: model, names: names) }
        }
        if let addSheet, addSheet.projectID == projectID { addSheet.reload(names: names) }
        let namesStorylines = model.library.relations.contains { $0.fromKind == "storyline" || $0.toKind == "storyline" }
        if !names.storylinesKnown, namesStorylines || addSheet?.projectID == projectID { requestNames?(projectID) }
    }

    /// Reads the library again, e.g. after a trash purged relations. Nothing
    /// is read for a project whose relations were never shown.
    func reload(projectID: String) { models[projectID]?.load() }

    private func show(_ section: RelationsSectionView, endpoint: RelationEndpoint, model: RelationLibraryModel,
                      names: RelationNameDirectory) {
        if model.loaded { section.show(model.library.entries(for: endpoint, names: names)) }
        else if let error = model.loadError { section.showUnavailable(error) }
        else { section.show(nil) }
    }

    private func beginAdd(from section: RelationsSectionView, projectID: String, anchor: RelationEndpoint) {
        // A sheet needs a window to attach to; one left unshown would block later adds.
        guard addSheet == nil, presentSheet != nil || section.window != nil else { return }
        section.showMessage(nil)
        let sheet = AddRelationSheet(projectID: projectID, anchor: anchor, model: model(projectID: projectID),
                                     names: names?(projectID) ?? .empty)
        addSheet = sheet
        sheet.onFinish = { [weak self, weak sheet] _ in
            if let self, let sheet, self.addSheet === sheet { self.addSheet = nil }
        }
        sheet.presentEditor = { [weak self] editor, parent in self?.present(editor.window, over: parent) }
        present(sheet.window, over: section.window)
        refresh(projectID: projectID)
    }

    private func present(_ sheet: NSWindow, over parent: NSWindow?) {
        if let presentSheet { presentSheet(sheet, parent) } else if let parent { parent.beginSheet(sheet) }
    }

    /// 改为其他类型…: the author types the relation fits, directly or with its
    /// ends swapped (`relationTypeNeedsSwap`); the current type is preselected
    /// and choosing it writes nothing.
    private func retype(_ entry: RelationEntry, projectID: String, from section: RelationsSectionView) {
        let model = self.model(projectID: projectID)
        let options = model.library.retypeOptions(for: entry.relation)
        let alert = NSAlert()
        alert.messageText = "改为其他类型"
        alert.informativeText = options.count > 1
            ? "“\(entry.text)”改为下列类型之一。标注“交换两端”的类型会同时交换关系的方向。"
            : "没有其他适用于这两端的关系类型。可以在“关系类型…”中新建。"
        let popup = NSPopUpButton(frame: NSRect(x: 0, y: 0, width: 320, height: 26), pullsDown: false)
        popup.setAccessibilityIdentifier("relation-retype-type")
        for option in options {
            let item = NSMenuItem(title: "\(option.type.displayName)（\(option.type.summary)）\(option.swap ? " · 交换两端" : "")",
                                  action: nil, keyEquivalent: "")
            item.representedObject = option.type.id
            item.setAccessibilityIdentifier("relation-retype-option-\(option.type.id)")
            popup.menu?.addItem(item)
        }
        if let index = options.firstIndex(where: { $0.type.id == entry.relation.relationTypeId }) { popup.selectItem(at: index) }
        alert.accessoryView = popup
        alert.addButton(withTitle: "更改").setAccessibilityIdentifier("confirm-relation-retype")
        alert.addButton(withTitle: "取消")
        let proceed: (NSApplication.ModalResponse) -> Void = { [weak section] response in
            guard response == .alertFirstButtonReturn, let id = popup.selectedItem?.representedObject as? String,
                  let option = options.first(where: { $0.type.id == id }),
                  id != entry.relation.relationTypeId || option.swap else { return }
            model.retype(relationID: entry.relation.id, typeID: id, swap: option.swap) { [weak section] result in section?.report(result) }
        }
        if let presentAlert { presentAlert(alert, proceed) }
        else if let window = section.window { alert.beginSheetModal(for: window, completionHandler: proceed) }
    }
}

private extension RelationsSectionView {
    func report<Value>(_ result: Result<Value, Error>) {
        switch result {
        case .success: showMessage(nil)
        case .failure(let error): showMessage(error.localizedDescription)
        }
    }
}

/// 添加关系…: the other entity (searched across chapters, drifts, elements,
/// categories and storylines, leaving out this entity and those already
/// related to it), the direction and a type that fits both ends, or a new
/// type created inline. Nothing is written until 添加; a refusal keeps the
/// choice and shows the reason.
final class AddRelationSheet: NSObject, NSTableViewDataSource, NSTableViewDelegate, NSSearchFieldDelegate {
    private static let createType = "create-relation-type"
    let projectID: String
    /// The entity whose page asked.
    let anchor: RelationEndpoint
    let model: RelationLibraryModel
    let window: NSWindow
    let searchField = NSSearchField()
    let groupControl: NSSegmentedControl
    let table = NSTableView()
    let directionLabel = NSTextField(labelWithString: "")
    let swapButton = NSButton(title: "交换方向", target: nil, action: nil)
    let typePopup = NSPopUpButton(frame: .zero, pullsDown: false)
    let addButton = NSButton(title: "添加", target: nil, action: nil)
    let cancelButton = NSButton(title: "取消", target: nil, action: nil)
    let titleLabel = NSTextField(labelWithString: "")
    private let message = NSTextField(wrappingLabelWithString: "")
    private(set) var names: RelationNameDirectory
    /// Entities listed for the current search and kind, in picker order.
    private(set) var candidates: [RelationNameDirectory.Candidate] = []
    private(set) var target: RelationNameDirectory.Candidate?
    /// This entity is the target rather than the source.
    private(set) var reversed = false
    private(set) var typeID: String?
    private(set) var isSaving = false
    /// The inline 新建关系类型 editor, if open.
    private(set) var typeEditor: RelationTypeEditorSheet?
    private var updatingSelection = false
    var presentEditor: ((RelationTypeEditorSheet, NSWindow) -> Void)?
    /// Called once, with the added (or already existing) relation or nil when cancelled.
    var onFinish: ((WorkspaceRelation?) -> Void)?

    var errorMessage: String? { message.isHidden ? nil : message.stringValue }
    var from: RelationEndpoint? { target.map { reversed ? $0.endpoint : anchor } }
    var to: RelationEndpoint? { target.map { reversed ? anchor : $0.endpoint } }
    /// Author types that fit the two ends in either direction.
    var typeOptions: [WorkspaceRelationType] { target.map { model.library.types(between: anchor, and: $0.endpoint) } ?? [] }

    init(projectID: String, anchor: RelationEndpoint, model: RelationLibraryModel, names: RelationNameDirectory) {
        self.projectID = projectID
        self.anchor = anchor
        self.model = model
        self.names = names
        groupControl = NSSegmentedControl(labels: ["全部"] + RelationNameDirectory.Group.allCases.map(\.rawValue),
                                          trackingMode: .selectOne, target: nil, action: nil)
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 480, height: 460), styleMask: [.titled],
                          backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.title = "添加关系"
        super.init()
        titleLabel.font = .systemFont(ofSize: 15, weight: .semibold)
        titleLabel.lineBreakMode = .byTruncatingTail
        let explanation = NSTextField(wrappingLabelWithString:
            "选择对方和关系类型。这里只列出尚未与它建立关系的章节、漂流、设定、分类和故事线。")
        explanation.textColor = .secondaryLabelColor
        searchField.placeholderString = "搜索章节、漂流、设定、分类或故事线"
        searchField.delegate = self
        searchField.target = self; searchField.action = #selector(filterChanged)
        searchField.setAccessibilityIdentifier("relation-candidate-search")
        groupControl.selectedSegment = 0
        groupControl.target = self; groupControl.action = #selector(filterChanged)
        groupControl.setAccessibilityIdentifier("relation-candidate-kind")
        table.addTableColumn(NSTableColumn(identifier: NSUserInterfaceItemIdentifier("candidate")))
        table.headerView = nil
        table.rowHeight = 24
        table.dataSource = self; table.delegate = self
        table.setAccessibilityIdentifier("relation-candidates")
        let scroll = NSScrollView()
        scroll.hasVerticalScroller = true; scroll.borderType = .bezelBorder
        scroll.documentView = table
        directionLabel.lineBreakMode = .byTruncatingMiddle
        directionLabel.setContentCompressionResistancePriority(.init(1), for: .horizontal)
        directionLabel.setAccessibilityIdentifier("relation-direction")
        swapButton.target = self; swapButton.action = #selector(swapDirection)
        swapButton.setAccessibilityIdentifier("relation-direction-swap")
        typePopup.target = self; typePopup.action = #selector(typeChosen)
        typePopup.setAccessibilityIdentifier("relation-type-popup")
        message.textColor = .systemRed
        message.isHidden = true
        message.setAccessibilityIdentifier("relation-add-error")
        addButton.target = self; addButton.action = #selector(add)
        addButton.keyEquivalent = "\r"
        addButton.setAccessibilityIdentifier("confirm-add-relation")
        cancelButton.target = self; cancelButton.action = #selector(cancel)
        cancelButton.keyEquivalent = "\u{1b}"
        cancelButton.setAccessibilityIdentifier("cancel-add-relation")
        let label = { (text: String) -> NSTextField in
            let value = NSTextField(labelWithString: text)
            value.textColor = .secondaryLabelColor
            return value
        }
        let directionTitle = label("方向"), typeTitle = label("类型")
        let directionRow = NSStackView(views: [directionTitle, directionLabel, swapButton, NSView()])
        let typeRow = NSStackView(views: [typeTitle, typePopup])
        for row in [directionRow, typeRow] { row.spacing = 10 }
        typePopup.setContentHuggingPriority(.init(1), for: .horizontal)
        let buttons = NSStackView(views: [NSView(), cancelButton, addButton])
        let stack = NSStackView(views: [titleLabel, explanation, searchField, groupControl, scroll, directionRow, typeRow, message, buttons])
        stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = 10
        stack.setCustomSpacing(6, after: titleLabel)
        stack.translatesAutoresizingMaskIntoConstraints = false
        let content = NSView()
        content.addSubview(stack)
        window.contentView = content
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 20),
            stack.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -20),
            stack.topAnchor.constraint(equalTo: content.topAnchor, constant: 18),
            stack.bottomAnchor.constraint(equalTo: content.bottomAnchor, constant: -16),
            content.widthAnchor.constraint(equalToConstant: 480),
            titleLabel.widthAnchor.constraint(equalTo: stack.widthAnchor),
            explanation.widthAnchor.constraint(equalTo: stack.widthAnchor),
            searchField.widthAnchor.constraint(equalTo: stack.widthAnchor),
            scroll.widthAnchor.constraint(equalTo: stack.widthAnchor),
            scroll.heightAnchor.constraint(equalToConstant: 180),
            directionRow.widthAnchor.constraint(equalTo: stack.widthAnchor),
            typeRow.widthAnchor.constraint(equalTo: stack.widthAnchor),
            directionTitle.widthAnchor.constraint(equalTo: typeTitle.widthAnchor),
            message.widthAnchor.constraint(equalTo: stack.widthAnchor),
            buttons.widthAnchor.constraint(equalTo: stack.widthAnchor),
        ])
        reload(names: names)
        content.layoutSubtreeIfNeeded()
        window.setContentSize(content.fittingSize)
        window.initialFirstResponder = searchField
    }

    /// Adopt newer names or a newer library: listed entities, the chosen
    /// other end and the type choices follow; an end that became related
    /// elsewhere is dropped.
    func reload(names: RelationNameDirectory) {
        self.names = names
        titleLabel.stringValue = "为「\(names.name(of: anchor).name)」添加关系"
        if let current = target {
            target = names.candidate(current.endpoint)
            if model.library.related(to: anchor).contains(current.endpoint) { target = nil }
        }
        filter()
        rebuildTypes()
    }

    // MARK: Candidates

    private func filter() {
        let query = searchField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        let excluded = model.library.related(to: anchor).union([anchor])
        let group = groupControl.selectedSegment > 0 ? RelationNameDirectory.Group.allCases[groupControl.selectedSegment - 1] : nil
        candidates = names.candidates.filter {
            !excluded.contains($0.endpoint) && (group == nil || $0.group == group)
                && (query.isEmpty || $0.name.localizedCaseInsensitiveContains(query))
        }
        updatingSelection = true
        table.reloadData()
        if let target, let index = candidates.firstIndex(of: target) {
            table.selectRowIndexes(IndexSet(integer: index), byExtendingSelection: false)
        } else { table.deselectAll(nil) }
        updatingSelection = false
    }

    /// Chooses a listed entity as the other end, as a click would.
    func choose(_ endpoint: RelationEndpoint) {
        guard let index = candidates.firstIndex(where: { $0.endpoint == endpoint }) else { return }
        table.selectRowIndexes(IndexSet(integer: index), byExtendingSelection: false)
    }

    func numberOfRows(in tableView: NSTableView) -> Int { candidates.count }

    func tableView(_ tableView: NSTableView, viewFor tableColumn: NSTableColumn?, row: Int) -> NSView? {
        let candidate = candidates[row]
        let kind = NSTextField(labelWithString: candidate.group.rawValue)
        kind.font = .systemFont(ofSize: 11)
        kind.textColor = .tertiaryLabelColor
        kind.setContentHuggingPriority(.required, for: .horizontal)
        let name = NSTextField(labelWithString: candidate.name)
        name.lineBreakMode = .byTruncatingTail
        let stack = NSStackView(views: [kind, name])
        stack.spacing = 8
        stack.setAccessibilityIdentifier("relation-candidate-\(candidate.endpoint.kind)-\(candidate.endpoint.id)")
        stack.setAccessibilityLabel("\(candidate.group.rawValue) \(candidate.name)")
        return stack
    }

    func tableViewSelectionDidChange(_ notification: Notification) {
        guard !updatingSelection, candidates.indices.contains(table.selectedRow) else { return }
        target = candidates[table.selectedRow]
        reversed = false
        showError(nil)
        rebuildTypes()
    }

    func controlTextDidChange(_ notification: Notification) { filter() }
    @objc private func filterChanged() { filter() }

    // MARK: Direction and type

    private func updateDirection() {
        guard let from, let to else {
            directionLabel.stringValue = "先在上方选择对方"
            directionLabel.textColor = .tertiaryLabelColor
            swapButton.isEnabled = false
            return
        }
        directionLabel.stringValue = "\(names.name(of: from).name) → \(names.name(of: to).name)"
        directionLabel.textColor = .labelColor
        // Only structural ends can be targets; every native end is one.
        swapButton.isEnabled = !isSaving && RelationKind.structural.contains(anchor.kind)
    }

    private func rebuildTypes() {
        let options = typeOptions
        if let typeID, !options.contains(where: { $0.id == typeID }) { self.typeID = nil }
        typePopup.removeAllItems()
        let placeholder = NSMenuItem(title: target == nil ? "先选择对方" : options.isEmpty ? "没有适用的关系类型，可以新建" : "选择关系类型",
                                     action: nil, keyEquivalent: "")
        typePopup.menu?.addItem(placeholder)
        for type in options {
            let item = NSMenuItem(title: "\(type.displayName)（\(type.summary)）", action: nil, keyEquivalent: "")
            item.representedObject = type.id
            item.setAccessibilityIdentifier("relation-type-option-\(type.id)")
            typePopup.menu?.addItem(item)
        }
        if target != nil {
            typePopup.menu?.addItem(.separator())
            let create = NSMenuItem(title: "新建关系类型…", action: nil, keyEquivalent: "")
            create.representedObject = Self.createType
            create.setAccessibilityIdentifier("relation-type-create")
            typePopup.menu?.addItem(create)
        }
        selectType(typeID)
        typePopup.isEnabled = target != nil && !isSaving
        updateDirection()
        validate()
    }

    private func selectType(_ id: String?) {
        let index = typePopup.itemArray.firstIndex { $0.representedObject as? String == id && id != nil }
        typePopup.selectItem(at: index ?? 0)
    }

    /// Chooses a type in the popup, as a click would.
    func chooseType(_ id: String) {
        guard let index = typePopup.itemArray.firstIndex(where: { $0.representedObject as? String == id }) else { return }
        typePopup.selectItem(at: index)
        typeChosen()
    }

    /// A type that fits only the other way round explains the swap Rust
    /// would ask for; 添加 waits until the ends fit.
    private func validate() {
        guard let from, let to, let typeID, let type = model.library.type(id: typeID) else {
            addButton.isEnabled = false; return
        }
        let check = type.check(from: from, to: to)
        if let refusal = check.message { showError(refusal) }
        addButton.isEnabled = check.isValid && !isSaving
    }

    @objc private func typeChosen() {
        let value = typePopup.selectedItem?.representedObject as? String
        if value == Self.createType { selectType(typeID); beginCreateType(); return }
        typeID = value
        showError(nil)
        validate()
    }

    @objc func swapDirection() {
        guard target != nil, swapButton.isEnabled else { return }
        reversed.toggle()
        showError(nil)
        updateDirection()
        validate()
    }

    // MARK: Inline type

    /// 新建关系类型…: the editor starts from this pair's kinds in the chosen
    /// direction; a definition that would not fit them is refused before
    /// anything is written, and the new type is chosen once stored.
    private func beginCreateType() {
        guard typeEditor == nil, let from, let to else { return }
        let editor = RelationTypeEditorSheet(type: nil, sourceKinds: [from.kind], targetKinds: [to.kind])
        typeEditor = editor
        editor.onCancel = { [weak self] in self?.endTypeEditor() }
        editor.onSave = { [weak self] definition, done in
            guard let self, let from = self.from, let to = self.to else { done(.failure(LabError.message("请先选择对方。"))); return }
            if let refusal = definition.check(from: from, to: to).message { done(.failure(LabError.message(refusal))); return }
            self.model.createType(definition) { [weak self] result in
                done(result)
                guard let self, case .success(let type) = result else { return }
                self.endTypeEditor()
                self.typeID = type.id
                self.showError(nil)
                self.rebuildTypes()
            }
        }
        if let presentEditor { presentEditor(editor, window) } else { window.beginSheet(editor.window) }
    }

    private func endTypeEditor() {
        guard let editor = typeEditor else { return }
        typeEditor = nil
        if let parent = editor.window.sheetParent { parent.endSheet(editor.window) } else { editor.window.orderOut(nil) }
    }

    // MARK: Commit

    func showError(_ text: String?) {
        message.stringValue = text ?? ""
        message.isHidden = text == nil
    }

    private func setSaving(_ saving: Bool) {
        isSaving = saving
        table.isEnabled = !saving
        typePopup.isEnabled = target != nil && !saving
        updateDirection()
        validate()
    }

    @objc func add() {
        guard let from, let to, let typeID, !isSaving, addButton.isEnabled else { return }
        showError(nil)
        setSaving(true)
        model.add(from: from, to: to, typeID: typeID) { [weak self] result in
            guard let self else { return }
            self.setSaving(false)
            switch result {
            case .success(let relation): self.finish(relation)
            // The choice stays in the sheet for another try.
            case .failure(let error): self.showError(error.localizedDescription)
            }
        }
    }

    @objc func cancel() { finish(nil) }

    private func finish(_ relation: WorkspaceRelation?) {
        endTypeEditor()
        if let parent = window.sheetParent { parent.endSheet(window) } else { window.orderOut(nil) }
        onFinish?(relation)
    }
}
