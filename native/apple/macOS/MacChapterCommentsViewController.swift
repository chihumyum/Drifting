import AppKit

/// A sheet for writing or editing one comment body. A failed command keeps the
/// typed text and shows the reason; only success or 取消 dismisses it.
final class MacCommentComposerViewController: NSViewController {
    private let heading: String
    private let confirmTitle: String
    private let quote: String
    private let initialText: String
    private let field = NSTextView()
    private let message = NSTextField(wrappingLabelWithString: "")
    private let confirm = NSButton(title: "", target: nil, action: nil)
    private let cancel = NSButton(title: "取消", target: nil, action: nil)
    private(set) var isSubmitting = false
    /// Receives the body and reports nil on success or the refusal.
    var onSubmit: ((String, @escaping (Error?) -> Void) -> Void)?
    var onFinish: (() -> Void)?

    var text: String {
        get { _ = view; return field.string }
        set { _ = view; field.string = newValue }
    }
    var errorMessage: String { _ = view; return message.stringValue }

    init(title: String, confirmTitle: String, quote: String, text: String = "") {
        heading = title; self.confirmTitle = confirmTitle; self.quote = quote; initialText = text
        super.init(nibName: nil, bundle: nil)
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func loadView() {
        view = NSView()
        let title = NSTextField(labelWithString: heading)
        title.font = .systemFont(ofSize: 15, weight: .semibold)
        let excerpt = NSTextField(wrappingLabelWithString: "「\(MacChapterCommentsViewController.flatten(quote))」")
        excerpt.textColor = .secondaryLabelColor
        excerpt.maximumNumberOfLines = 3
        excerpt.lineBreakMode = .byTruncatingTail
        excerpt.setAccessibilityIdentifier("comment-composer-quote")
        excerpt.isHidden = quote.isEmpty
        field.isRichText = false
        field.allowsUndo = true
        field.font = .systemFont(ofSize: 13)
        field.string = initialText
        field.isVerticallyResizable = true
        field.autoresizingMask = [.width]
        field.textContainer?.widthTracksTextView = true
        field.textContainerInset = NSSize(width: 4, height: 6)
        field.setAccessibilityIdentifier("comment-composer-body")
        field.setAccessibilityLabel("批注内容")
        let scroll = NSScrollView()
        scroll.hasVerticalScroller = true; scroll.borderType = .bezelBorder
        scroll.documentView = field
        message.textColor = .systemRed
        message.isHidden = true
        message.setAccessibilityIdentifier("comment-composer-error")
        confirm.title = confirmTitle
        confirm.target = self; confirm.action = #selector(submit)
        confirm.keyEquivalent = "\r"; confirm.keyEquivalentModifierMask = [.command]
        confirm.setAccessibilityIdentifier("comment-composer-confirm")
        cancel.target = self; cancel.action = #selector(cancelComposer)
        cancel.keyEquivalent = "\u{1b}"
        cancel.setAccessibilityIdentifier("comment-composer-cancel")
        let hint = NSTextField(labelWithString: "⌘↩ 确认 · 空一行分段")
        hint.textColor = .tertiaryLabelColor; hint.font = .systemFont(ofSize: 11)
        let buttons = NSStackView(views: [hint, NSView(), cancel, confirm])
        buttons.spacing = 8
        let stack = NSStackView(views: [title, excerpt, scroll, message, buttons])
        stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = 10
        stack.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 20),
            stack.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -20),
            stack.topAnchor.constraint(equalTo: view.topAnchor, constant: 18),
            stack.bottomAnchor.constraint(equalTo: view.bottomAnchor, constant: -18),
            stack.widthAnchor.constraint(equalToConstant: 400),
            excerpt.widthAnchor.constraint(equalTo: stack.widthAnchor),
            scroll.widthAnchor.constraint(equalTo: stack.widthAnchor),
            scroll.heightAnchor.constraint(equalToConstant: 132),
            message.widthAnchor.constraint(equalTo: stack.widthAnchor),
            buttons.widthAnchor.constraint(equalTo: stack.widthAnchor),
        ])
    }

    func present(on window: NSWindow) {
        let sheet = NSWindow(contentViewController: self)
        sheet.styleMask = [.titled]
        window.beginSheet(sheet)
        sheet.makeFirstResponder(field)
    }

    @objc func submit() {
        guard !isSubmitting else { return }
        let body = field.string
        guard !body.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { show("请输入批注内容。"); return }
        guard let onSubmit else { return }
        isSubmitting = true; updateButtons(); show(nil)
        onSubmit(body) { [weak self] error in
            guard let self else { return }
            self.isSubmitting = false; self.updateButtons()
            if let error { self.show(error.localizedDescription) } else { self.finish() }
        }
    }

    @objc func cancelComposer() {
        guard !isSubmitting else { return }
        finish()
    }

    private func show(_ text: String?) {
        message.stringValue = text ?? ""
        message.isHidden = text == nil
    }
    private func updateButtons() {
        confirm.isEnabled = !isSubmitting; cancel.isEnabled = !isSubmitting
        field.isEditable = !isSubmitting
    }
    private func finish() {
        if let sheet = view.window, let parent = sheet.sheetParent { parent.endSheet(sheet) }
        onFinish?()
    }
}

final class ChapterCommentsPanel: NSPanel {
    var onClose: (() -> Void)?
    override func close() { super.close(); onClose?() }
}

/// Lists the active pane's chapter comments. Anchor placement and review state
/// are shown separately; locating is delegated to the active editor view.
final class MacChapterCommentsViewController: NSViewController {
    let model: ChapterCommentsModel
    var onLocate: ((String) -> Void)?
    var onClose: (() -> Void)?
    /// 接受 and 拒绝 of open Copilot suggestions; nil leaves them read-only.
    var copilot: CopilotSuggestionCommands?
    private let status = NSTextField(wrappingLabelWithString: "")
    private let resolvedToggle = NSButton(checkboxWithTitle: "显示已解决", target: nil, action: nil)
    private let list = NSStackView()
    private let empty = NSTextField(wrappingLabelWithString: "")
    private(set) var renderedIDs: [String] = []

    init(model: ChapterCommentsModel) {
        self.model = model
        super.init(nibName: nil, bundle: nil)
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    static func flatten(_ text: String) -> String {
        text.components(separatedBy: .newlines).filter { !$0.isEmpty }.joined(separator: " ")
    }

    override func loadView() {
        view = NSView()
        status.textColor = .secondaryLabelColor
        status.setAccessibilityIdentifier("comments-status")
        resolvedToggle.target = self; resolvedToggle.action = #selector(toggleResolved)
        resolvedToggle.setAccessibilityIdentifier("show-resolved-comments")
        list.orientation = .vertical; list.alignment = .leading; list.spacing = 10
        list.translatesAutoresizingMaskIntoConstraints = false
        list.setAccessibilityIdentifier("comment-list")
        empty.textColor = .secondaryLabelColor
        let document = FlippedView()
        document.translatesAutoresizingMaskIntoConstraints = false
        document.addSubview(list)
        let scroll = NSScrollView()
        scroll.hasVerticalScroller = true; scroll.drawsBackground = false
        scroll.documentView = document
        let close = NSButton(title: "关闭批注", target: self, action: #selector(closeComments))
        close.setAccessibilityIdentifier("close-comments")
        let stack = NSStackView(views: [status, resolvedToggle, scroll, close])
        stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = 12
        stack.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 16),
            stack.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -16),
            stack.topAnchor.constraint(equalTo: view.topAnchor, constant: 16),
            stack.bottomAnchor.constraint(equalTo: view.bottomAnchor, constant: -16),
            status.widthAnchor.constraint(equalTo: stack.widthAnchor),
            scroll.widthAnchor.constraint(equalTo: stack.widthAnchor),
            scroll.heightAnchor.constraint(greaterThanOrEqualToConstant: 200),
            document.leadingAnchor.constraint(equalTo: scroll.contentView.leadingAnchor),
            document.trailingAnchor.constraint(equalTo: scroll.contentView.trailingAnchor),
            document.topAnchor.constraint(equalTo: scroll.contentView.topAnchor),
            list.leadingAnchor.constraint(equalTo: document.leadingAnchor),
            list.trailingAnchor.constraint(equalTo: document.trailingAnchor),
            list.topAnchor.constraint(equalTo: document.topAnchor),
            list.bottomAnchor.constraint(equalTo: document.bottomAnchor),
        ])
        model.onChange = { [weak self] in self?.reload() }
        reload()
    }

    func reload() {
        guard isViewLoaded else { return }
        status.stringValue = model.status
        resolvedToggle.state = model.showResolved ? .on : .off
        for child in list.arrangedSubviews { list.removeArrangedSubview(child); child.removeFromSuperview() }
        let entries = model.entries
        renderedIDs = entries.map(\.id)
        if entries.isEmpty {
            empty.stringValue = model.busy ? "" : (model.comments.isEmpty
                ? "选中正文后，用“编辑 › 添加批注…”（⌥⌘M）或右键菜单添加批注。"
                : "已解决的批注已隐藏。")
            list.addArrangedSubview(empty)
            empty.widthAnchor.constraint(equalTo: list.widthAnchor).isActive = true
            return
        }
        for entry in entries {
            var actions = CommentRowView.Actions(
                locate: { [weak self] in self?.onLocate?(entry.id) },
                edit: { [weak self] in self?.edit(entry) },
                resolve: { [weak self] in self?.changeResolution(entry) })
            if entry.comment.isOpenSuggestion, let copilot {
                let comment = entry.comment
                actions.suggestion = CommentRowView.Suggestion(
                    message: copilot.failure(comment.id), deciding: copilot.isDeciding(comment.id),
                    accept: { [weak copilot] button in copilot?.pressAccept(comment, from: button, prefix: "comment") },
                    reject: { [weak copilot] in copilot?.reject(comment) })
            }
            let row = CommentRowView(entry: entry, actions: actions)
            list.addArrangedSubview(row)
            row.widthAnchor.constraint(equalTo: list.widthAnchor).isActive = true
        }
    }

    @objc private func toggleResolved() { model.showResolved = resolvedToggle.state == .on }
    @objc private func closeComments() { onClose?() }

    func changeResolution(_ entry: ChapterCommentEntry) {
        model.setResolved(entry.id, resolved: entry.comment.review != .resolved) { _ in }
    }

    private func edit(_ entry: ChapterCommentEntry) {
        guard entry.comment.canEditBody, let window = view.window else { return }
        let composer = MacCommentComposerViewController(title: "编辑批注", confirmTitle: "保存",
            quote: entry.quote, text: entry.comment.bodyText)
        composer.onSubmit = { [weak self] body, done in
            guard let self else { done(LabError.message("批注面板已关闭。")); return }
            self.model.updateBody(entry.id, body: body) { result in
                switch result {
                case .success: done(nil)
                case .failure(let error): done(error)
                }
            }
        }
        composer.present(on: window)
    }
}

private final class FlippedView: NSView {
    override var isFlipped: Bool { true }
}

/// One comment: quote, placement, review state and body on a soft wash.
private final class CommentRowView: NSView {
    struct Suggestion {
        let message: String?
        let deciding: Bool
        let accept: (NSView) -> Void
        let reject: () -> Void
    }
    struct Actions {
        let locate: () -> Void
        let edit: () -> Void
        let resolve: () -> Void
        /// An open Copilot suggestion's 接受 and 拒绝.
        var suggestion: Suggestion?
    }
    private let resolved: Bool

    init(entry: ChapterCommentEntry, actions: Actions) {
        let comment = entry.comment
        resolved = comment.review != .open
        super.init(frame: .zero)
        wantsLayer = true
        setAccessibilityElement(true)
        setAccessibilityRole(.group)
        setAccessibilityIdentifier("comment-row-\(comment.id)")

        let quote = NSTextField(wrappingLabelWithString: entry.isWholePage ? "整章" : entry.quote.isEmpty ? "段落批注"
            : "「\(MacChapterCommentsViewController.flatten(entry.quote))」")
        quote.font = .systemFont(ofSize: 12)
        quote.textColor = .secondaryLabelColor
        quote.maximumNumberOfLines = 2
        quote.lineBreakMode = .byTruncatingTail
        quote.setAccessibilityIdentifier("comment-quote-\(comment.id)")
        var facts = [entry.isWholePage ? "整章" : entry.anchorStatus.label, comment.review.label]
        if comment.kind == "todo" { facts.insert("待办", at: 0) }
        if comment.isByAssistant { facts.append("写作助手") }
        else if comment.isOpenSuggestion { facts.insert("Copilot 建议", at: 0) }
        else if !comment.canEditBody { facts.append(comment.source == "copilot" ? "来自 Copilot · 只读" : "外部来源 · 只读") }
        let meta = NSTextField(labelWithString: facts.joined(separator: " · "))
        meta.font = .systemFont(ofSize: 11, weight: .medium)
        meta.textColor = entry.isWholePage || entry.anchorStatus == .anchored || entry.anchorStatus == .wholeBlock
            ? .secondaryLabelColor : .systemOrange
        meta.setAccessibilityIdentifier("comment-state-\(comment.id)")
        let body = NSTextField(wrappingLabelWithString: comment.bodyText)
        body.font = .systemFont(ofSize: 13)
        body.textColor = resolved ? .secondaryLabelColor : .labelColor
        body.setAccessibilityIdentifier("comment-body-\(comment.id)")

        let locate = ClosureButton(title: "定位", identifier: "locate-comment-\(comment.id)", action: actions.locate)
        locate.isEnabled = entry.canLocate
        locate.toolTip = entry.canLocate ? "在当前编辑栏中选中批注的原文" : entry.isWholePage ? "写在整章上的批注没有原文" : "原文已不在正文中"
        let edit = ClosureButton(title: "编辑", identifier: "edit-comment-\(comment.id)", action: actions.edit)
        edit.isHidden = !comment.canEditBody
        let resolve = ClosureButton(title: comment.review == .resolved ? "重新打开" : "解决",
                                    identifier: "resolve-comment-\(comment.id)", action: actions.resolve)
        resolve.isHidden = !comment.canChangeResolution
        var suggestionViews: [NSView] = []
        if let suggestion = actions.suggestion {
            // The button hands itself over, so a category menu opens below it.
            var acceptPressed: (() -> Void)?
            let accept = ClosureButton(title: "接受", identifier: "accept-comment-\(comment.id)") { acceptPressed?() }
            acceptPressed = { [weak accept] in if let accept { suggestion.accept(accept) } }
            let reject = ClosureButton(title: "拒绝", identifier: "reject-comment-\(comment.id)", action: suggestion.reject)
            accept.isEnabled = !suggestion.deciding; reject.isEnabled = !suggestion.deciding
            suggestionViews = [accept, reject]
            if let message = suggestion.message {
                let label = NSTextField(wrappingLabelWithString: message)
                label.font = .systemFont(ofSize: 12); label.textColor = .systemRed
                label.setAccessibilityIdentifier("comment-suggestion-message-\(comment.id)")
                failureLabel = label
            }
        }
        let buttons = NSStackView(views: [locate, edit, resolve] + suggestionViews)
        buttons.spacing = 6

        let stack = NSStackView(views: [quote, meta, body] + (failureLabel.map { [$0] } ?? []) + [buttons])
        stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = 6
        stack.setCustomSpacing(10, after: body)
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 12),
            stack.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -12),
            stack.topAnchor.constraint(equalTo: topAnchor, constant: 10),
            stack.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -10),
            quote.widthAnchor.constraint(equalTo: stack.widthAnchor),
            body.widthAnchor.constraint(equalTo: stack.widthAnchor),
        ])
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
    private var failureLabel: NSTextField?

    override var wantsUpdateLayer: Bool { true }
    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        needsDisplay = true
    }
    override func updateLayer() {
        layer?.cornerRadius = 8
        // Open notes share the editor's highlight hue; settled ones recede.
        layer?.backgroundColor = (resolved ? NSColor.secondaryLabelColor.withAlphaComponent(0.08)
            : NSColor.systemYellow.withAlphaComponent(0.14)).cgColor
    }
}

private final class ClosureButton: NSButton {
    private let pressed: () -> Void
    init(title: String, identifier: String, action pressed: @escaping () -> Void) {
        self.pressed = pressed
        super.init(frame: .zero)
        self.title = title
        bezelStyle = .rounded; controlSize = .small
        font = .systemFont(ofSize: NSFont.systemFontSize(for: .small))
        target = self; action = #selector(press)
        setAccessibilityIdentifier(identifier)
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
    @objc private func press() { pressed() }
}
