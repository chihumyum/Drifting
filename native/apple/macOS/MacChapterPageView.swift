import AppKit

/// 摘要 and 状态 of one chapter or drift, placed by its page. The summary is
/// trimmed and commits on end-editing when it changed; Escape restores the
/// stored text. The status commits on a popup choice; choosing the current
/// status writes nothing. Commands run one at a time. A refusal keeps the
/// typed summary, shows the stored status again and reports the reason
/// through `onMessage`. Until the stored values are read both are disabled.
final class NodeMetadataEditor: NSObject, NSTextViewDelegate {
    enum Change: Equatable { case summary(String), status(String) }
    private enum Field { case summary, status }

    let kind: String
    let summaryView = NSTextView()
    let summaryScroll = NSScrollView()
    let statusPopup = NSPopUpButton(frame: .zero, pullsDown: false)
    private(set) var metadata: WorkspaceNodeMetadata?
    private(set) var isCommitting = false
    private var queued: [Field] = []
    /// Receives one change; reports the stored metadata or the refusal.
    var onCommit: ((Change, @escaping (Result<WorkspaceNodeMetadata, Error>) -> Void) -> Void)?
    /// A refusal's reason, or nil once a command succeeded.
    var onMessage: ((String?) -> Void)?
    var onFocus: (() -> Void)?

    /// `prefix` scopes accessibility identifiers, e.g. `chapter-summary`.
    init(kind: String, prefix: String, summaryHeight: CGFloat) {
        self.kind = kind
        super.init()
        summaryView.isRichText = false
        summaryView.allowsUndo = true
        summaryView.font = .systemFont(ofSize: 13)
        summaryView.isVerticallyResizable = true
        summaryView.autoresizingMask = [.width]
        summaryView.textContainer?.widthTracksTextView = true
        summaryView.textContainerInset = NSSize(width: 2, height: 4)
        summaryView.isEditable = false
        summaryView.delegate = self
        summaryView.setAccessibilityIdentifier("\(prefix)-summary"); summaryView.setAccessibilityLabel("摘要")
        summaryView.toolTip = kind == "drift" ? "一两句话概括这条漂流" : "一两句话概括这一章"
        summaryScroll.hasVerticalScroller = true; summaryScroll.borderType = .bezelBorder
        summaryScroll.documentView = summaryView
        summaryScroll.heightAnchor.constraint(equalToConstant: summaryHeight).isActive = true
        for status in WritingStatus.options(kind: kind) {
            statusPopup.addItem(withTitle: status.label)
            statusPopup.lastItem?.representedObject = status.rawValue
            statusPopup.lastItem?.setAccessibilityIdentifier("\(prefix)-status-\(status.rawValue)")
        }
        statusPopup.isEnabled = false
        statusPopup.target = self; statusPopup.action = #selector(statusChosen)
        statusPopup.setAccessibilityIdentifier("\(prefix)-status"); statusPopup.setAccessibilityLabel("状态")
    }

    // MARK: Values

    var summaryText: String { summaryView.string }
    /// The chosen status value, e.g. `finished`.
    var statusValue: String? { statusPopup.selectedItem?.representedObject as? String }

    private var isEditingSummary: Bool { summaryView.window?.firstResponder === summaryView }

    private func showStatus(_ value: String) {
        let index = statusPopup.itemArray.firstIndex { $0.representedObject as? String == value }
        statusPopup.selectItem(at: index ?? -1)
    }

    /// Adopt newer stored values, e.g. after another view or a menu wrote
    /// them. A summary with uncommitted text keeps it.
    func show(_ updated: WorkspaceNodeMetadata) {
        let clean = metadata.map { summaryView.string == $0.summary } ?? true
        metadata = updated
        if clean, summaryView.string != updated.summary { summaryView.string = updated.summary }
        showStatus(updated.writingStatus)
        summaryView.isEditable = true
        statusPopup.isEnabled = true
    }

    // MARK: Commit

    /// Writes one field. Commands run one at a time in the order requested.
    private func commit(_ field: Field) {
        guard !isCommitting else {
            if !queued.contains(field) { queued.append(field) }
            return
        }
        guard let metadata, let onCommit else { commitNext(); return }
        switch field {
        case .summary:
            let submitted = summaryView.string
            let summary = ElementText.trimmed(submitted)
            guard summary != metadata.summary else {
                // Nothing to write: show the stored form (spacing trimmed)
                // once the text view has finished ending its edit.
                DispatchQueue.main.async { [weak self] in
                    guard let self, let stored = self.metadata, self.summaryView.string == submitted, !self.isEditingSummary else { return }
                    self.summaryView.string = stored.summary
                }
                commitNext(); return
            }
            send(.summary(summary), with: onCommit) { [weak self] stored in
                guard let self else { return }
                // Show the stored form unless the author typed on meanwhile.
                if self.summaryView.string == submitted, !self.isEditingSummary { self.summaryView.string = stored.summary }
            }
        case .status:
            guard let value = statusValue, value != metadata.writingStatus else { commitNext(); return }
            send(.status(value), with: onCommit) { _ in }
        }
    }

    private func send(_ change: Change, with onCommit: (Change, @escaping (Result<WorkspaceNodeMetadata, Error>) -> Void) -> Void,
                      stored: @escaping (WorkspaceNodeMetadata) -> Void) {
        isCommitting = true
        onCommit(change) { [weak self] result in
            guard let self else { return }
            self.isCommitting = false
            switch result {
            case .success(let metadata):
                self.onMessage?(nil)
                self.show(metadata)
                stored(metadata)
            case .failure(let error):
                self.onMessage?(error.localizedDescription)
                // A refused status shows the stored one again; typed text stays.
                if let metadata = self.metadata { self.showStatus(metadata.writingStatus) }
            }
            self.commitNext()
        }
    }

    private func commitNext() {
        guard !isCommitting, !queued.isEmpty else { return }
        commit(queued.removeFirst())
    }

    /// Restores the stored summary and leaves the field without writing.
    func revertSummary() {
        guard let metadata else { return }
        summaryView.string = metadata.summary
        if isEditingSummary { summaryView.window?.makeFirstResponder(nil) }
    }

    /// A failed read of the stored values: fields stay disabled.
    func showUnavailable(_ error: Error) {
        guard metadata == nil else { return }
        onMessage?("摘要和状态暂时无法读取：\(error.localizedDescription)")
    }

    func textDidBeginEditing(_ notification: Notification) { onFocus?() }
    func textDidEndEditing(_ notification: Notification) { commit(.summary) }
    func textView(_ textView: NSTextView, doCommandBy selector: Selector) -> Bool {
        guard selector == #selector(NSResponder.cancelOperation(_:)) else { return false }
        revertSummary()
        return true
    }
    @objc private func statusChosen() { onFocus?(); commit(.status) }
}

/// One chapter's page: its title and word count with 情节规划格 and 状态 beside
/// them and 摘要 below on a neutral wash, then 关系, above the chapter's prose
/// body, and the 情节规划格 dock below the body when shown. The title is
/// renamed from the chapter list; the body is the chapter's ordinary native
/// editor with comments.
final class MacChapterPageView: NSView {
    let documentView: NativeDocumentView
    let titleLabel = NSTextField(labelWithString: "")
    let metadataEditor = NodeMetadataEditor(kind: "chapter", prefix: "chapter", summaryHeight: 40)
    /// The chapter's word count after its title, set by the tab host.
    let wordCountLabel = MacWordCount.headerLabel(identifier: "chapter-word-count")
    /// 关系, filled and driven by the tab host's relation coordinator.
    let relationsView = RelationsSectionView()
    /// Shows or hides the 情节规划格 dock below the body.
    let plotPlannerButton = PlotPlannerToggle()
    private let message = NSTextField(wrappingLabelWithString: "")
    private let header = ElementHeaderWash()
    private let stack = NSStackView()
    private(set) var chapter: WorkspaceChapter
    /// The 情节规划格 dock, while shown.
    private(set) var plotDock: MacPlotPlannerDock?

    var errorMessage: String? { message.isHidden ? nil : message.stringValue }
    var isCommitting: Bool { metadataEditor.isCommitting }

    init(chapter: WorkspaceChapter, core: LabCore) {
        self.chapter = chapter
        documentView = NativeDocumentView(core: core)
        super.init(frame: .zero)
        setAccessibilityIdentifier("chapter-page-\(chapter.id)")
        titleLabel.font = .systemFont(ofSize: 18, weight: .semibold)
        titleLabel.lineBreakMode = .byTruncatingTail
        titleLabel.setContentCompressionResistancePriority(.init(1), for: .horizontal)
        titleLabel.setAccessibilityIdentifier("chapter-title")
        titleLabel.stringValue = chapter.title
        message.textColor = .systemRed
        message.isHidden = true
        message.setAccessibilityIdentifier("chapter-page-error")
        metadataEditor.onMessage = { [weak self] in self?.showMessage($0) }

        let statusLabel = label("状态")
        let titleRow = NSStackView(views: [titleLabel, wordCountLabel, NSView(), plotPlannerButton, statusLabel, metadataEditor.statusPopup])
        titleRow.spacing = 8
        titleRow.setCustomSpacing(10, after: titleLabel)
        let summaryLabel = label("摘要")
        let summaryRow = NSStackView(views: [summaryLabel, metadataEditor.summaryScroll])
        summaryRow.alignment = .top; summaryRow.spacing = 10
        let headerStack = NSStackView(views: [titleRow, summaryRow, message])
        headerStack.orientation = .vertical; headerStack.alignment = .leading; headerStack.spacing = 8
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
            headerStack.topAnchor.constraint(equalTo: header.topAnchor, constant: 10),
            headerStack.bottomAnchor.constraint(equalTo: header.bottomAnchor, constant: -10),
            titleRow.widthAnchor.constraint(equalTo: headerStack.widthAnchor),
            summaryRow.widthAnchor.constraint(equalTo: headerStack.widthAnchor),
            message.widthAnchor.constraint(equalTo: headerStack.widthAnchor),
            summaryLabel.topAnchor.constraint(equalTo: metadataEditor.summaryScroll.topAnchor, constant: 4),
            metadataEditor.statusPopup.widthAnchor.constraint(greaterThanOrEqualToConstant: 96),
        ])
        metadataEditor.summaryScroll.setContentHuggingPriority(.init(1), for: .horizontal)
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    private func label(_ text: String) -> NSTextField {
        let value = NSTextField(labelWithString: text)
        value.textColor = .secondaryLabelColor
        value.setContentHuggingPriority(.required, for: .horizontal)
        return value
    }

    /// Places the 情节规划格 dock below the body, or removes it with nil.
    func showPlotDock(_ dock: MacPlotPlannerDock?) {
        plotDock = PlotPlannerToggle.place(dock, replacing: plotDock, in: stack)
        plotPlannerButton.state = dock == nil ? .off : .on
    }

    /// A renamed chapter shows its new title.
    func apply(chapter updated: WorkspaceChapter) {
        chapter = updated
        if titleLabel.stringValue != updated.title { titleLabel.stringValue = updated.title }
    }

    func show(metadata: WorkspaceNodeMetadata) { metadataEditor.show(metadata) }

    /// 统计中… until counts are read, then “1,234 字”; nothing without a count.
    func showWordCount(_ count: Int?, loaded: Bool) { MacWordCount.show(count, loaded: loaded, in: wordCountLabel) }

    /// Shown when the stored summary and status could not be read.
    func showMessage(_ text: String?) {
        message.stringValue = text ?? ""
        message.isHidden = text == nil
    }

    /// Ends an active summary edit so its end-editing commit is sent now.
    func endEditing() {
        guard let window, let responder = window.firstResponder as? NSView,
              responder !== documentView.textView, responder.isDescendant(of: self) else { return }
        window.makeFirstResponder(nil)
    }
}
