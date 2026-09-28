import AppKit

/// One drift's page: 标题 with its word count, 情节规划格 and 操作 (转为章节…,
/// 转为设定…), 摘要, 状态 and 分组 on a neutral wash, the act whose notes it is
/// (幕笔记), then 关系, the drift's prose body and the 情节规划格 dock when
/// shown. The title commits on
/// end-editing or Return and the group on a popup choice, through `onCommit`;
/// 摘要 and 状态 commit through `metadataEditor`. A refusal keeps the typed
/// text and shows the reason. The body is an ordinary native editor bound to
/// the drift's own document owner.
final class MacDriftPageView: NSView, NSTextFieldDelegate {
    enum Field: CaseIterable { case title, group }

    let documentView: NativeDocumentView
    let titleField = NSTextField()
    let groupPopup = NSPopUpButton(frame: .zero, pullsDown: false)
    let metadataEditor = NodeMetadataEditor(kind: "drift", prefix: "drift", summaryHeight: 48)
    /// The drift's word count after its title, set by the tab host.
    let wordCountLabel = MacWordCount.headerLabel(identifier: "drift-word-count")
    /// The bound act's name, or a hint when the drift is not an act's notes.
    let actLabel = NSTextField(labelWithString: "")
    /// 关系, filled and driven by the tab host's relation coordinator.
    let relationsView = RelationsSectionView()
    /// Shows or hides the 情节规划格 dock below the body.
    let plotPlannerButton = PlotPlannerToggle()
    /// 操作: 转为章节… and 转为设定….
    let actionsButton = NSPopUpButton(frame: .zero, pullsDown: true)
    private let message = NSTextField(wrappingLabelWithString: "")
    private let header = ElementHeaderWash()
    private let stack = NSStackView()
    /// The 情节规划格 dock, while shown.
    private(set) var plotDock: MacPlotPlannerDock?
    private(set) var drift: WorkspaceDrift
    private(set) var library: WorkspaceDriftLibrary
    private(set) var actName: String?
    private(set) var isCommitting = false
    private var queued: [Field] = []
    /// Receives one field's changes; reports the stored drift or the refusal.
    var onCommit: ((WorkspaceDriftChanges, @escaping (Result<WorkspaceDrift, Error>) -> Void) -> Void)?
    var onFocus: (() -> Void)?
    /// 转为章节… or 转为设定… from 操作.
    var onConvert: ((DriftConversionKind) -> Void)?

    var errorMessage: String? { message.isHidden ? nil : message.stringValue }

    init(drift: WorkspaceDrift, library: WorkspaceDriftLibrary, core: LabCore) {
        self.drift = drift
        self.library = library
        documentView = NativeDocumentView(core: core, allowsComments: false, minimumTextHeight: 150)
        super.init(frame: .zero)
        setAccessibilityIdentifier("drift-page-\(drift.id)")

        titleField.font = .systemFont(ofSize: 18, weight: .semibold)
        titleField.placeholderString = "漂流标题"
        titleField.isBordered = false; titleField.drawsBackground = false; titleField.focusRingType = .none
        titleField.lineBreakMode = .byTruncatingTail
        titleField.delegate = self
        titleField.cell?.isScrollable = true; titleField.cell?.wraps = false
        titleField.setAccessibilityIdentifier("drift-title"); titleField.setAccessibilityLabel("标题")
        groupPopup.target = self; groupPopup.action = #selector(groupChosen)
        groupPopup.setAccessibilityIdentifier("drift-group"); groupPopup.setAccessibilityLabel("分组")
        actLabel.lineBreakMode = .byTruncatingTail
        actLabel.setAccessibilityIdentifier("drift-act"); actLabel.setAccessibilityLabel("幕笔记")
        message.textColor = .systemRed
        message.isHidden = true
        message.setAccessibilityIdentifier("drift-page-error")
        metadataEditor.onMessage = { [weak self] in self?.showMessage($0) }
        metadataEditor.onFocus = { [weak self] in self?.onFocus?() }

        let grid = NSGridView(views: [
            [label("摘要"), metadataEditor.summaryScroll],
            [label("状态"), metadataEditor.statusPopup],
            [label("分组"), groupPopup],
            [label("幕笔记"), actLabel],
        ])
        grid.rowSpacing = 8; grid.columnSpacing = 10
        grid.column(at: 0).xPlacement = .trailing
        grid.row(at: 0).yPlacement = .top
        grid.cell(for: metadataEditor.summaryScroll)?.xPlacement = .fill
        grid.cell(for: metadataEditor.statusPopup)?.xPlacement = .leading
        grid.cell(for: groupPopup)?.xPlacement = .leading
        grid.cell(for: actLabel)?.xPlacement = .leading
        titleField.setContentHuggingPriority(.init(1), for: .horizontal)
        titleField.setContentCompressionResistancePriority(.init(1), for: .horizontal)
        actionsButton.addItem(withTitle: "操作")
        actionsButton.setAccessibilityIdentifier("drift-page-actions"); actionsButton.setAccessibilityLabel("操作")
        for kind in [DriftConversionKind.chapter, .element] {
            actionsButton.menu?.addItem(LibraryMenuItem(title: kind.title, identifier: "page-\(kind.identifier)") { [weak self] in
                self?.onConvert?(kind)
            })
        }
        actionsButton.setContentHuggingPriority(.required, for: .horizontal)
        let titleRow = NSStackView(views: [titleField, wordCountLabel, plotPlannerButton, actionsButton])
        titleRow.spacing = 10
        let headerStack = NSStackView(views: [titleRow, grid, message])
        headerStack.orientation = .vertical; headerStack.alignment = .leading; headerStack.spacing = 10
        headerStack.translatesAutoresizingMaskIntoConstraints = false
        header.addSubview(headerStack)
        let relationsRow = relationsView.inset()
        stack.setViews([header, relationsRow, documentView], in: .leading)
        stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = 10
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: leadingAnchor), stack.trailingAnchor.constraint(equalTo: trailingAnchor),
            stack.topAnchor.constraint(equalTo: topAnchor), stack.bottomAnchor.constraint(equalTo: bottomAnchor),
            header.widthAnchor.constraint(equalTo: stack.widthAnchor),
            relationsRow.widthAnchor.constraint(equalTo: stack.widthAnchor),
            documentView.widthAnchor.constraint(equalTo: stack.widthAnchor),
            headerStack.leadingAnchor.constraint(equalTo: header.leadingAnchor, constant: 14),
            headerStack.trailingAnchor.constraint(equalTo: header.trailingAnchor, constant: -14),
            headerStack.topAnchor.constraint(equalTo: header.topAnchor, constant: 12),
            headerStack.bottomAnchor.constraint(equalTo: header.bottomAnchor, constant: -12),
            titleRow.widthAnchor.constraint(equalTo: headerStack.widthAnchor),
            grid.widthAnchor.constraint(equalTo: headerStack.widthAnchor),
            message.widthAnchor.constraint(equalTo: headerStack.widthAnchor),
            groupPopup.widthAnchor.constraint(greaterThanOrEqualToConstant: 160),
        ])
        rebuildGroups()
        show(drift.title, in: .title)
        showAct()
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    private func label(_ text: String) -> NSTextField {
        let value = NSTextField(labelWithString: text)
        value.textColor = .secondaryLabelColor
        return value
    }

    // MARK: Values

    /// The field's current value, including an active field editor. The
    /// group is its identity, or "" for 未分组.
    func text(of field: Field) -> String {
        switch field {
        case .title: return titleField.currentEditor()?.string ?? titleField.stringValue
        case .group: return (groupPopup.selectedItem?.representedObject as? String) ?? ""
        }
    }

    private func display(_ field: Field, of drift: WorkspaceDrift) -> String {
        switch field {
        case .title: return drift.title
        case .group: return drift.driftGroupId.flatMap { library.group(id: $0)?.id } ?? ""
        }
    }

    private func show(_ value: String, in field: Field) {
        switch field {
        case .title:
            // Keep an active editing session: its text becomes the field's
            // value when editing ends, so no end-editing is simulated here.
            if let editor = titleField.currentEditor() {
                if editor.string != value { editor.string = value }
            } else if titleField.stringValue != value { titleField.stringValue = value }
        case .group:
            let index = groupPopup.itemArray.firstIndex { ($0.representedObject as? String ?? "") == value }
            groupPopup.selectItem(at: index ?? 0)
        }
    }

    /// 未分组, then every group in display order, subgroups named with their parent.
    private func rebuildGroups() {
        groupPopup.removeAllItems()
        groupPopup.addItem(withTitle: "未分组")
        groupPopup.lastItem?.representedObject = ""
        groupPopup.lastItem?.setAccessibilityIdentifier("drift-group-none")
        for (group, _) in library.orderedGroups {
            groupPopup.addItem(withTitle: library.path(groupID: group.id) ?? group.name)
            groupPopup.lastItem?.representedObject = group.id
            groupPopup.lastItem?.setAccessibilityIdentifier("drift-group-\(group.id)")
        }
        show(display(.group, of: drift), in: .group)
    }

    private func showAct() {
        if drift.actId == nil {
            actLabel.stringValue = "未绑定。可以在整书大纲中幕的“操作”里绑定为幕笔记。"
            actLabel.textColor = .tertiaryLabelColor
            actLabel.font = .systemFont(ofSize: 12)
        } else {
            actLabel.stringValue = actName ?? "正在读取幕…"
            actLabel.textColor = actName == nil ? .tertiaryLabelColor : .labelColor
            actLabel.font = .systemFont(ofSize: 13, weight: .medium)
        }
    }

    /// Adopt a newer stored drift and library, e.g. after the panel or
    /// another view saved. A title with uncommitted text keeps it.
    func apply(drift updated: WorkspaceDrift, library: WorkspaceDriftLibrary) {
        let cleanTitle = text(of: .title) == drift.title
        drift = updated
        if self.library != library { self.library = library; rebuildGroups() } else { show(display(.group, of: updated), in: .group) }
        if cleanTitle { show(updated.title, in: .title) }
        showAct()
    }

    /// Places the 情节规划格 dock below the body, or removes it with nil.
    func showPlotDock(_ dock: MacPlotPlannerDock?) {
        plotDock = PlotPlannerToggle.place(dock, replacing: plotDock, in: stack)
        plotPlannerButton.state = dock == nil ? .off : .on
    }

    /// 转为章节… or 转为设定… from 操作, e.g. for acceptance.
    func conversionItem(_ kind: DriftConversionKind) -> LibraryMenuItem? {
        actionsButton.menu?.items.first { $0.accessibilityIdentifier() == "page-\(kind.identifier)" } as? LibraryMenuItem
    }

    func showMessage(_ text: String?) {
        message.stringValue = text ?? ""
        message.isHidden = text == nil
    }

    /// The stored 摘要 and 状态; a summary being typed is kept.
    func show(metadata: WorkspaceNodeMetadata) { metadataEditor.show(metadata) }

    /// 统计中… until counts are read, then “1,234 字”; nothing without a count.
    func showWordCount(_ count: Int?, loaded: Bool) { MacWordCount.show(count, loaded: loaded, in: wordCountLabel) }

    /// The bound act's current name; nil while acts are being read.
    func show(actName: String?) {
        self.actName = actName
        showAct()
    }

    // MARK: Commit

    /// The changes this field would write, or nil when it matches the stored value.
    private func changes(for field: Field) -> WorkspaceDriftChanges? {
        var changes = WorkspaceDriftChanges()
        switch field {
        case .title:
            let title = ElementText.trimmed(text(of: .title))
            guard !title.isEmpty else { showMessage("标题不能为空，已恢复原标题。"); return nil }
            guard title != drift.title else { return nil }
            changes.title = title
        case .group:
            let value = text(of: .group)
            guard value != display(.group, of: drift) else { return nil }
            changes.groupID = .some(value.isEmpty ? nil : value)
        }
        return changes
    }

    /// Writes one field. Commands run one at a time in the order requested.
    func commit(_ field: Field) {
        guard !isCommitting else {
            if !queued.contains(field) { queued.append(field) }
            return
        }
        let submitted = text(of: field)
        guard let changes = changes(for: field), let onCommit else {
            // Nothing to write: show the stored form (an empty title restored,
            // spacing trimmed) once end-editing has stored the typed text.
            DispatchQueue.main.async { [weak self] in
                guard let self, self.text(of: field) == submitted else { return }
                self.show(self.display(field, of: self.drift), in: field)
            }
            commitNext(); return
        }
        isCommitting = true
        onCommit(changes) { [weak self] result in
            guard let self else { return }
            self.isCommitting = false
            switch result {
            case .success(let stored):
                self.showMessage(nil)
                self.apply(drift: stored, library: self.library)
                // Show the stored form (a trimmed or suffixed unique title)
                // unless the author has typed on since this command was sent.
                if self.text(of: field) == submitted { self.show(self.display(field, of: stored), in: field) }
            case .failure(let error):
                self.showMessage(error.localizedDescription)
                // A refused group choice shows the stored group again.
                if field == .group { self.show(self.display(.group, of: self.drift), in: .group) }
            }
            self.commitNext()
        }
    }

    private func commitNext() {
        guard !isCommitting, !queued.isEmpty else { return }
        commit(queued.removeFirst())
    }

    /// Ends an active header edit so its end-editing commit is sent now.
    func endEditing() {
        guard let window, let responder = window.firstResponder as? NSView,
              responder !== documentView.textView, responder.isDescendant(of: self) else { return }
        window.makeFirstResponder(nil)
    }

    func focusTitle() {
        window?.makeFirstResponder(titleField)
        titleField.currentEditor()?.selectAll(nil)
    }


    func controlTextDidBeginEditing(_ notification: Notification) { onFocus?() }
    func controlTextDidEndEditing(_ notification: Notification) {
        if notification.object as AnyObject? === titleField { commit(.title) }
    }
    @objc private func groupChosen() { onFocus?(); commit(.group) }
}
