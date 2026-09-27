import AppKit

/// Creates or edits one relation type in a sheet: 名称, 方向, the roles, 说明
/// and the kinds each end allows. A symmetric type has one 端点角色 and the
/// same structural kinds at both ends. Kinds the native client cannot address
/// are shown disabled and keep their stored state. Nothing is written until
/// 保存; a refusal keeps the typed values and shows the reason.
final class RelationTypeEditorSheet: NSObject {
    let original: WorkspaceRelationType?
    let window: NSWindow
    let nameField = NSTextField()
    let orientationPopup = NSPopUpButton(frame: .zero, pullsDown: false)
    let sourceRoleLabel = NSTextField(labelWithString: "源角色")
    let sourceRoleField = NSTextField()
    let targetRoleField = NSTextField()
    let descriptionField = NSTextField()
    let sourceKindsLabel = NSTextField(labelWithString: "允许源实体")
    /// One checkbox per kind, in canonical order.
    private(set) var sourceBoxes: [(kind: String, box: NSButton)] = []
    private(set) var targetBoxes: [(kind: String, box: NSButton)] = []
    let saveButton = NSButton(title: "保存", target: nil, action: nil)
    let cancelButton = NSButton(title: "取消", target: nil, action: nil)
    private let grid: NSGridView
    private let message = NSTextField(wrappingLabelWithString: "")
    private(set) var isSaving = false
    /// Receives the definition as typed; reports the stored type or the refusal.
    var onSave: ((RelationTypeDefinition, @escaping (Result<WorkspaceRelationType, Error>) -> Void) -> Void)?
    var onCancel: (() -> Void)?

    var errorMessage: String? { message.isHidden ? nil : message.stringValue }
    var isSymmetric: Bool { orientationPopup.selectedItem?.representedObject as? String == "symmetric" }

    /// The definition as typed. A symmetric type sends its one role for both
    /// ends and its structural kinds as the target kinds.
    var definition: RelationTypeDefinition {
        let sources = sourceBoxes.filter { $0.box.state == .on }.map(\.kind)
        let symmetric = isSymmetric
        return RelationTypeDefinition(name: nameField.stringValue, description: descriptionField.stringValue,
            orientation: symmetric ? "symmetric" : "directed", sourceRole: sourceRoleField.stringValue,
            targetRole: symmetric ? sourceRoleField.stringValue : targetRoleField.stringValue, sourceKinds: sources,
            targetKinds: symmetric ? sources.filter { RelationKind.structural.contains($0) }
                                   : targetBoxes.filter { $0.box.state == .on }.map(\.kind))
    }

    /// `sourceKinds`/`targetKinds` preset a new type, e.g. from the ends of
    /// the relation being added; otherwise a new type allows the native kinds.
    init(type: WorkspaceRelationType?, sourceKinds: [String]? = nil, targetKinds: [String]? = nil) {
        original = type
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 520, height: 360), styleMask: [.titled],
                          backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.title = type == nil ? "新建关系类型" : "编辑关系类型"
        let label = { (text: String) -> NSTextField in
            let value = NSTextField(labelWithString: text)
            value.textColor = .secondaryLabelColor
            return value
        }
        let sourceRow = NSStackView(), targetRow = NSStackView()
        let targetRoleLabel = label("目标角色"), targetKindsLabel = label("允许目标实体")
        sourceRoleLabel.textColor = .secondaryLabelColor
        sourceKindsLabel.textColor = .secondaryLabelColor
        grid = NSGridView(views: [
            [label("名称"), nameField],
            [label("方向"), orientationPopup],
            [sourceRoleLabel, sourceRoleField],
            [targetRoleLabel, targetRoleField],
            [label("说明"), descriptionField],
            [sourceKindsLabel, sourceRow],
            [targetKindsLabel, targetRow],
        ])
        super.init()
        let title = NSTextField(labelWithString: type.map { "编辑“\($0.name)”" } ?? "新建关系类型")
        title.font = .systemFont(ofSize: 15, weight: .semibold)
        title.lineBreakMode = .byTruncatingTail
        let explanation = NSTextField(wrappingLabelWithString:
            "有向关系分源端和目标端，例如“师父 → 徒弟”；对称关系两端地位相同，例如“盟友”。灰色的实体类型原生版本暂不支持，保存时保留原有设置。")
        explanation.textColor = .secondaryLabelColor
        nameField.placeholderString = "例如 师徒"
        nameField.setAccessibilityIdentifier("relation-type-name")
        for (title, value) in [("有向", "directed"), ("对称", "symmetric")] {
            orientationPopup.addItem(withTitle: title)
            orientationPopup.lastItem?.representedObject = value
            orientationPopup.lastItem?.setAccessibilityIdentifier("relation-type-orientation-\(value)")
        }
        orientationPopup.target = self; orientationPopup.action = #selector(orientationChosen)
        orientationPopup.setAccessibilityIdentifier("relation-type-orientation")
        sourceRoleField.placeholderString = "例如 师父"
        sourceRoleField.setAccessibilityIdentifier("relation-type-source-role")
        targetRoleField.placeholderString = "例如 徒弟"
        targetRoleField.setAccessibilityIdentifier("relation-type-target-role")
        descriptionField.placeholderString = "可选"
        descriptionField.setAccessibilityIdentifier("relation-type-description")
        let initialSources = type?.sourceKinds ?? sourceKinds ?? RelationKind.native
        let initialTargets = type?.targetKinds ?? targetKinds ?? RelationKind.native
        sourceBoxes = Self.boxes(RelationKind.all, checked: initialSources, side: "source", in: sourceRow, target: self,
                                 action: #selector(sourceToggled(_:)))
        targetBoxes = Self.boxes(RelationKind.structural, checked: initialTargets, side: "target", in: targetRow, target: self,
                                 action: #selector(targetToggled(_:)))
        nameField.stringValue = type?.name ?? ""
        descriptionField.stringValue = type?.description ?? ""
        sourceRoleField.stringValue = type?.sourceRole ?? "源端"
        targetRoleField.stringValue = type?.targetRole ?? "目标端"
        orientationPopup.selectItem(at: type?.isSymmetric == true ? 1 : 0)
        grid.rowSpacing = 8; grid.columnSpacing = 10
        grid.column(at: 0).xPlacement = .trailing
        grid.row(at: 5).yPlacement = .top
        grid.row(at: 6).yPlacement = .top
        for field in [nameField, sourceRoleField, targetRoleField, descriptionField] { grid.cell(for: field)?.xPlacement = .fill }
        message.textColor = .systemRed
        message.isHidden = true
        message.setAccessibilityIdentifier("relation-type-error")
        saveButton.target = self; saveButton.action = #selector(save)
        saveButton.keyEquivalent = "\r"
        saveButton.setAccessibilityIdentifier("save-relation-type")
        cancelButton.target = self; cancelButton.action = #selector(cancel)
        cancelButton.keyEquivalent = "\u{1b}"
        cancelButton.setAccessibilityIdentifier("cancel-relation-type")
        let buttons = NSStackView(views: [NSView(), cancelButton, saveButton])
        let stack = NSStackView(views: [title, explanation, grid, message, buttons])
        stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = 12
        stack.setCustomSpacing(6, after: title)
        stack.translatesAutoresizingMaskIntoConstraints = false
        let content = NSView()
        content.addSubview(stack)
        window.contentView = content
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 20),
            stack.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -20),
            stack.topAnchor.constraint(equalTo: content.topAnchor, constant: 18),
            stack.bottomAnchor.constraint(equalTo: content.bottomAnchor, constant: -16),
            content.widthAnchor.constraint(equalToConstant: 560),
            title.widthAnchor.constraint(equalTo: stack.widthAnchor),
            explanation.widthAnchor.constraint(equalTo: stack.widthAnchor),
            grid.widthAnchor.constraint(equalTo: stack.widthAnchor),
            message.widthAnchor.constraint(equalTo: stack.widthAnchor),
            buttons.widthAnchor.constraint(equalTo: stack.widthAnchor),
        ])
        applyOrientation()
        content.layoutSubtreeIfNeeded()
        window.setContentSize(content.fittingSize)
        window.initialFirstResponder = nameField
    }

    /// Native kinds first, then the kinds only the renderer addresses, disabled.
    private static func boxes(_ kinds: [String], checked: [String], side: String, in row: NSStackView, target: AnyObject,
                              action: Selector) -> [(kind: String, box: NSButton)] {
        row.orientation = .vertical; row.alignment = .leading; row.spacing = 4
        let native = NSStackView(), other = NSStackView()
        native.spacing = 10; other.spacing = 10
        var result: [(String, NSButton)] = []
        for kind in kinds {
            let box = NSButton(checkboxWithTitle: RelationKind.label(kind), target: target, action: action)
            box.state = checked.contains(kind) ? .on : .off
            box.setAccessibilityIdentifier("relation-type-\(side)-\(kind)")
            let isNative = RelationKind.native.contains(kind)
            box.isEnabled = isNative
            if !isNative { box.toolTip = "原生版本暂不支持这种实体，保存时保留原有设置。" }
            (isNative ? native : other).addArrangedSubview(box)
            result.append((kind, box))
        }
        row.addArrangedSubview(native)
        if !other.arrangedSubviews.isEmpty { row.addArrangedSubview(other) }
        return result
    }

    /// Symmetric: one role and one row of kinds, structural only, mirrored
    /// to the target (the renderer editor's rule).
    private func applyOrientation() {
        let symmetric = isSymmetric
        sourceRoleLabel.stringValue = symmetric ? "端点角色" : "源角色"
        sourceKindsLabel.stringValue = symmetric ? "允许实体" : "允许源实体"
        grid.row(at: 3).isHidden = symmetric
        grid.row(at: 6).isHidden = symmetric
        for (kind, box) in sourceBoxes where !RelationKind.structural.contains(kind) {
            if symmetric { box.state = .off }
        }
    }

    @objc private func orientationChosen() {
        if isSymmetric {
            let shared = RelationKind.structural.filter { kind in
                sourceBoxes.contains { $0.kind == kind && $0.box.state == .on } || targetBoxes.contains { $0.kind == kind && $0.box.state == .on }
            }
            for (kind, box) in sourceBoxes { box.state = shared.contains(kind) ? .on : .off }
            for (kind, box) in targetBoxes { box.state = shared.contains(kind) ? .on : .off }
        }
        applyOrientation()
    }

    @objc private func sourceToggled(_ sender: NSButton) {
        guard isSymmetric, let kind = sourceBoxes.first(where: { $0.box === sender })?.kind else { return }
        targetBoxes.first { $0.kind == kind }?.box.state = sender.state
    }

    @objc private func targetToggled(_ sender: NSButton) {}

    /// Chooses 有向 or 对称, as the popup would.
    func chooseOrientation(_ value: String) {
        guard let index = orientationPopup.itemArray.firstIndex(where: { $0.representedObject as? String == value }) else { return }
        orientationPopup.selectItem(at: index)
        orientationChosen()
    }

    /// Checks or clears one kind, as a click would.
    func set(kind: String, side: String, checked: Bool) {
        guard let box = (side == "target" ? targetBoxes : sourceBoxes).first(where: { $0.kind == kind })?.box, box.isEnabled else { return }
        box.state = checked ? .on : .off
        box.sendAction(box.action, to: box.target)
    }

    func showError(_ text: String?) {
        message.stringValue = text ?? ""
        message.isHidden = text == nil
    }

    func setSaving(_ saving: Bool) {
        isSaving = saving
        saveButton.isEnabled = !saving
    }

    @objc func save() {
        guard !isSaving, let onSave else { return }
        window.makeFirstResponder(nil)
        showError(nil)
        setSaving(true)
        onSave(definition) { [weak self] result in
            guard let self else { return }
            self.setSaving(false)
            // The typed values stay in the sheet for another try.
            if case .failure(let error) = result { self.showError(error.localizedDescription) }
        }
    }

    @objc func cancel() { onCancel?() }
}

final class RelationTypesPanel: NSPanel {
    var onClose: (() -> Void)?
    override func close() { super.close(); onClose?() }
}

/// 关系类型: the project's relation types, author types by name and then the
/// built-in type, each with its roles and how many relations use it. Author
/// types are created, edited and deleted here; the built-in type is shown
/// locked. Rust refuses a duplicate name, an edit existing relations would
/// not fit and deleting a type still in use; the refusal is shown and nothing
/// is written.
final class MacRelationTypesViewController: NSViewController, NSTableViewDataSource, NSTableViewDelegate, NSMenuDelegate {
    let model: RelationLibraryModel
    var onClose: (() -> Void)?
    /// Presents the delete confirmation. Nil uses a sheet on the panel;
    /// acceptance answers here without a window.
    var presentAlert: ((NSAlert, @escaping (NSApplication.ModalResponse) -> Void) -> Void)?
    /// Presents the editor sheet. Nil begins a sheet on the panel.
    var presentSheet: ((NSWindow) -> Void)?
    /// The open editor, and the type it edits (nil for a new type).
    private(set) var editor: RelationTypeEditorSheet?
    private let table = NSTableView()
    private let status = NSTextField(wrappingLabelWithString: "")
    let createButton = NSButton(title: "新建关系类型", target: nil, action: nil)
    private(set) var rows: [WorkspaceRelationType] = []
    private var statusOverride: String?

    var statusText: String { status.stringValue }

    init(model: RelationLibraryModel) {
        self.model = model
        super.init(nibName: nil, bundle: nil)
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func loadView() {
        view = NSView()
        let column = NSTableColumn(identifier: NSUserInterfaceItemIdentifier("type"))
        column.resizingMask = .autoresizingMask
        table.addTableColumn(column)
        table.headerView = nil
        table.rowHeight = 44
        table.columnAutoresizingStyle = .uniformColumnAutoresizingStyle
        table.dataSource = self; table.delegate = self
        table.target = self; table.doubleAction = #selector(rowDoubleClicked)
        table.setAccessibilityIdentifier("relation-type-list")
        let menu = NSMenu()
        menu.delegate = self
        table.menu = menu
        let scroll = NSScrollView()
        scroll.hasVerticalScroller = true
        scroll.documentView = table
        status.textColor = .secondaryLabelColor
        status.setAccessibilityIdentifier("relation-types-status")
        createButton.target = self; createButton.action = #selector(create)
        createButton.setAccessibilityIdentifier("create-relation-type")
        let close = NSButton(title: "关闭", target: self, action: #selector(closePanel))
        close.setAccessibilityIdentifier("close-relation-types")
        let actions = NSStackView(views: [createButton, NSView(), close])
        let stack = NSStackView(views: [status, actions, scroll])
        stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = 12
        stack.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 16),
            stack.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -16),
            stack.topAnchor.constraint(equalTo: view.topAnchor, constant: 16),
            stack.bottomAnchor.constraint(equalTo: view.bottomAnchor, constant: -16),
            status.widthAnchor.constraint(equalTo: stack.widthAnchor),
            actions.widthAnchor.constraint(equalTo: stack.widthAnchor),
            scroll.widthAnchor.constraint(equalTo: stack.widthAnchor),
        ])
        model.onChange = { [weak self] in self?.reload() }
        if !model.loaded, !model.busy { model.load() }
        reload()
    }

    func reload() {
        guard isViewLoaded else { return }
        rows = model.library.authoredTypes + model.library.types.filter { !$0.isAuthored }
        if let statusOverride { status.stringValue = statusOverride }
        else if !model.loaded { status.stringValue = model.loadError.map { "关系类型暂时无法读取：\($0)" } ?? "正在读取关系类型…" }
        else if model.library.authoredTypes.isEmpty { status.stringValue = "还没有关系类型。先新建一个，例如“师徒”或“同盟”。" }
        else { status.stringValue = "双击类型进行编辑；右键查看更多操作。" }
        createButton.isEnabled = model.loaded
        table.reloadData()
    }

    override func viewDidLayout() {
        super.viewDidLayout()
        table.sizeLastColumnToFit()
    }

    private func showStatus(_ text: String?) {
        statusOverride = text
        reload()
    }

    // MARK: Rows

    func numberOfRows(in tableView: NSTableView) -> Int { rows.count }

    func tableView(_ tableView: NSTableView, viewFor tableColumn: NSTableColumn?, row: Int) -> NSView? {
        let type = rows[row]
        let usage = model.library.usage(typeID: type.id)
        let name = NSTextField(labelWithString: type.displayName)
        name.font = .systemFont(ofSize: 13, weight: .semibold)
        name.lineBreakMode = .byTruncatingTail
        name.setContentCompressionResistancePriority(.init(250), for: .horizontal)
        name.textColor = type.isAuthored ? .labelColor : .secondaryLabelColor
        let note = NSTextField(labelWithString: type.isAuthored ? "\(usage) 条关系" : "内建 · 不可修改或删除")
        note.font = .systemFont(ofSize: 11)
        note.textColor = .tertiaryLabelColor
        note.setAccessibilityIdentifier("relation-type-note-\(type.id)")
        let top = NSStackView(views: [name, note])
        top.spacing = 8
        let detail = type.displayDescription.isEmpty ? type.summary : "\(type.summary) · \(type.displayDescription)"
        let summary = NSTextField(labelWithString: detail)
        summary.font = .systemFont(ofSize: 11)
        summary.textColor = .secondaryLabelColor
        summary.lineBreakMode = .byTruncatingTail
        summary.setContentCompressionResistancePriority(.init(250), for: .horizontal)
        let stack = NSStackView(views: [top, summary])
        stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = 2
        stack.edgeInsets = NSEdgeInsets(top: 0, left: 4, bottom: 0, right: 4)
        stack.setAccessibilityIdentifier("relation-type-row-\(type.id)")
        stack.toolTip = type.isAuthored ? nil : "内建关系类型用于批注和素材的一键关联，不可修改或删除。"
        return stack
    }

    func tableView(_ tableView: NSTableView, shouldSelectRow row: Int) -> Bool { true }

    func menuNeedsUpdate(_ menu: NSMenu) {
        menu.removeAllItems()
        let row = table.clickedRow
        guard rows.indices.contains(row) else { return }
        for item in menuItems(for: rows[row]) { menu.addItem(item) }
    }

    /// The row's actions, also used by acceptance. The built-in type offers none enabled.
    func menuItems(for type: WorkspaceRelationType) -> [NSMenuItem] {
        let edit = LibraryMenuItem(title: "编辑…", identifier: "edit-relation-type") { [weak self] in self?.beginEdit(type) }
        let delete = LibraryMenuItem(title: "删除…", identifier: "delete-relation-type") { [weak self] in self?.delete(type) }
        edit.isEnabled = type.isAuthored
        delete.isEnabled = type.isAuthored
        return [edit, .separator(), delete]
    }

    @objc private func rowDoubleClicked() {
        guard rows.indices.contains(table.clickedRow), rows[table.clickedRow].isAuthored else { return }
        beginEdit(rows[table.clickedRow])
    }

    // MARK: Editing

    @objc func create() { begin(nil) }

    func beginEdit(_ type: WorkspaceRelationType) { begin(type) }

    private func begin(_ type: WorkspaceRelationType?) {
        guard editor == nil, model.loaded else { return }
        let current = type.flatMap { model.library.type(id: $0.id) } ?? type
        let sheet = RelationTypeEditorSheet(type: current)
        editor = sheet
        sheet.onCancel = { [weak self] in self?.endEditor() }
        sheet.onSave = { [weak self] definition, done in
            guard let self else { return }
            let finish: (Result<WorkspaceRelationType, Error>) -> Void = { [weak self] result in
                done(result)
                guard let self, case .success(let stored) = result else { return }
                self.endEditor()
                self.showStatus(current == nil ? "关系类型“\(stored.name)”已创建。" : "关系类型“\(stored.name)”已保存。")
            }
            if let current { self.model.updateType(id: current.id, definition: definition, completion: finish) }
            else { self.model.createType(definition, completion: finish) }
        }
        if let presentSheet { presentSheet(sheet.window) } else if let window = view.window { window.beginSheet(sheet.window) }
    }

    private func endEditor() {
        guard let sheet = editor else { return }
        editor = nil
        if let parent = sheet.window.sheetParent { parent.endSheet(sheet.window) } else { sheet.window.orderOut(nil) }
    }

    /// An unused type is deleted after confirmation. A type still in use is
    /// sent as is, so Rust's refusal states how many relations use it.
    func delete(_ type: WorkspaceRelationType) {
        let send = { [weak self] in
            guard let self else { return }
            self.model.deleteType(id: type.id) { [weak self] result in
                switch result {
                case .success: self?.showStatus("关系类型“\(type.displayName)”已删除。")
                case .failure(let error): self?.showStatus(error.localizedDescription)
                }
            }
        }
        guard model.library.usage(typeID: type.id) == 0, type.isAuthored else { send(); return }
        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = "删除关系类型“\(type.displayName)”？"
        alert.informativeText = "目前没有关系使用这个类型。删除后不能恢复。"
        alert.addButton(withTitle: "删除").setAccessibilityIdentifier("confirm-delete-relation-type")
        alert.addButton(withTitle: "取消")
        let proceed: (NSApplication.ModalResponse) -> Void = { response in
            if response == .alertFirstButtonReturn { send() }
        }
        if let presentAlert { presentAlert(alert, proceed) }
        else if let window = view.window { alert.beginSheetModal(for: window, completionHandler: proceed) }
    }

    override func viewDidDisappear() {
        super.viewDidDisappear()
        endEditor()
    }

    @objc private func closePanel() { endEditor(); onClose?() }
}
