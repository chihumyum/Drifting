import AppKit

/// A chapter's 主线 as a small leading dot in the storyline colour and,
/// optionally, its name; a hollow dot reads “未归属”. No edge accent.
final class StorylineChip: NSStackView {
    let dotView = NSImageView()
    let nameLabel = NSTextField(labelWithString: "")
    private(set) var storyline: WorkspaceStoryline?

    init(storyline: WorkspaceStoryline?, showsName: Bool) {
        self.storyline = storyline
        super.init(frame: .zero)
        spacing = 4
        dotView.image = storyline.map { Self.dot(hex: $0.color) } ?? Self.hollowDot()
        nameLabel.stringValue = text
        nameLabel.font = .systemFont(ofSize: 11)
        nameLabel.textColor = storyline == nil ? .tertiaryLabelColor : .secondaryLabelColor
        nameLabel.lineBreakMode = .byTruncatingTail
        setViews(showsName ? [dotView, nameLabel] : [dotView], in: .leading)
        setContentHuggingPriority(.required, for: .horizontal)
        setAccessibilityElement(true)
        setAccessibilityRole(.staticText)
        setAccessibilityLabel(storyline.map { "主线 \($0.name)" } ?? "未归属")
        toolTip = storyline.map { "主线：\($0.name)" } ?? "未归属任何故事线"
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    /// The storyline's name, or “未归属”.
    var text: String { storyline?.name ?? "未归属" }
    var colorHex: String? { storyline?.color }

    static func dot(hex: String) -> NSImage {
        let color = ElementSwatch.color(hex: hex)
        return NSImage(size: NSSize(width: 10, height: 10), flipped: false) { rect in
            (color ?? .secondaryLabelColor).setFill()
            NSBezierPath(ovalIn: rect.insetBy(dx: 1, dy: 1)).fill()
            return true
        }
    }

    static func hollowDot() -> NSImage {
        NSImage(size: NSSize(width: 10, height: 10), flipped: false) { rect in
            NSColor.tertiaryLabelColor.setStroke()
            let path = NSBezierPath(ovalIn: rect.insetBy(dx: 1.5, dy: 1.5))
            path.lineWidth = 1
            path.stroke()
            return true
        }
    }
}

/// Edits one chapter's storylines in a sheet: a checkbox per live storyline
/// and a 主线 choice among the checked ones. Nothing is written until 保存,
/// which replaces the chapter's storylines; a refusal keeps the choice and
/// shows the reason.
final class ChapterStorylinesSheet: NSObject {
    final class Row {
        let storyline: WorkspaceStoryline
        let checkbox: NSButton
        let primaryButton: NSButton
        init(storyline: WorkspaceStoryline, checkbox: NSButton, primaryButton: NSButton) {
            self.storyline = storyline; self.checkbox = checkbox; self.primaryButton = primaryButton
        }
    }

    let chapter: WorkspaceChapter
    let model: StorylineLibraryModel
    let window: NSWindow
    let saveButton = NSButton(title: "保存", target: nil, action: nil)
    let cancelButton = NSButton(title: "取消", target: nil, action: nil)
    private(set) var rows: [Row] = []
    private(set) var selection: ChapterStorylineSelection
    private let message = NSTextField(wrappingLabelWithString: "")
    /// Called once the sheet ends, saved or cancelled.
    var onFinish: ((_ saved: Bool) -> Void)?

    var errorMessage: String? { message.isHidden ? nil : message.stringValue }

    init(chapter: WorkspaceChapter, model: StorylineLibraryModel) {
        self.chapter = chapter
        self.model = model
        let storylines = model.library.storylines
        selection = ChapterStorylineSelection(order: storylines.map(\.id), membership: model.library.membership(chapterID: chapter.id))
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 420, height: 240), styleMask: [.titled],
                          backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.title = "故事线"
        super.init()
        let title = NSTextField(labelWithString: "“\(chapter.title)”的故事线")
        title.font = .systemFont(ofSize: 15, weight: .semibold)
        title.lineBreakMode = .byTruncatingTail
        let explanation = NSTextField(wrappingLabelWithString: storylines.isEmpty
            ? "还没有故事线。先在“故事线”面板中新建一条。"
            : "勾选这一章所属的故事线，并选择其中一条作为主线。主线的颜色会显示在大纲和章节列表中；不勾选任何故事线时，这一章为“未归属”。")
        explanation.textColor = .secondaryLabelColor
        explanation.setAccessibilityIdentifier("chapter-storylines-explanation")
        let list = NSStackView()
        list.orientation = .vertical; list.alignment = .leading; list.spacing = 6
        for storyline in storylines {
            let checkbox = NSButton(checkboxWithTitle: storyline.name, target: self, action: #selector(toggled(_:)))
            checkbox.image = StorylineChip.dot(hex: storyline.color)
            checkbox.imagePosition = .imageTrailing
            checkbox.setAccessibilityIdentifier("chapter-storyline-\(storyline.id)")
            let primary = NSButton(radioButtonWithTitle: "主线", target: self, action: #selector(primaryChosen(_:)))
            primary.setAccessibilityIdentifier("chapter-storyline-primary-\(storyline.id)")
            primary.setAccessibilityLabel("\(storyline.name) 设为主线")
            let row = NSStackView(views: [checkbox, NSView(), primary])
            row.setHuggingPriority(.init(1), for: .horizontal)
            list.addArrangedSubview(row)
            row.widthAnchor.constraint(equalTo: list.widthAnchor).isActive = true
            rows.append(Row(storyline: storyline, checkbox: checkbox, primaryButton: primary))
        }
        let scroll = NSScrollView()
        scroll.drawsBackground = false; scroll.borderType = .noBorder
        scroll.hasVerticalScroller = true; scroll.autohidesScrollers = true
        let document = FlippedView()
        document.translatesAutoresizingMaskIntoConstraints = false
        list.translatesAutoresizingMaskIntoConstraints = false
        document.addSubview(list)
        scroll.documentView = document
        scroll.isHidden = storylines.isEmpty
        message.textColor = .systemRed
        message.isHidden = true
        message.setAccessibilityIdentifier("chapter-storylines-error")
        saveButton.target = self; saveButton.action = #selector(save)
        saveButton.keyEquivalent = "\r"
        saveButton.setAccessibilityIdentifier("save-chapter-storylines")
        saveButton.isEnabled = !storylines.isEmpty
        cancelButton.target = self; cancelButton.action = #selector(cancel)
        cancelButton.keyEquivalent = "\u{1b}"
        cancelButton.setAccessibilityIdentifier("cancel-chapter-storylines")
        let buttons = NSStackView(views: [NSView(), cancelButton, saveButton])
        let stack = NSStackView(views: [title, explanation, scroll, message, buttons])
        stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = 12
        stack.setCustomSpacing(6, after: title)
        stack.translatesAutoresizingMaskIntoConstraints = false
        let content = NSView()
        content.addSubview(stack)
        window.contentView = content
        let fitList = scroll.heightAnchor.constraint(equalTo: document.heightAnchor)
        fitList.priority = .defaultHigh
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 20),
            stack.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -20),
            stack.topAnchor.constraint(equalTo: content.topAnchor, constant: 18),
            stack.bottomAnchor.constraint(equalTo: content.bottomAnchor, constant: -16),
            content.widthAnchor.constraint(equalToConstant: 420),
            title.widthAnchor.constraint(equalTo: stack.widthAnchor),
            explanation.widthAnchor.constraint(equalTo: stack.widthAnchor),
            scroll.widthAnchor.constraint(equalTo: stack.widthAnchor),
            message.widthAnchor.constraint(equalTo: stack.widthAnchor),
            buttons.widthAnchor.constraint(equalTo: stack.widthAnchor),
            document.leadingAnchor.constraint(equalTo: scroll.contentView.leadingAnchor),
            document.topAnchor.constraint(equalTo: scroll.contentView.topAnchor),
            document.widthAnchor.constraint(equalTo: scroll.contentView.widthAnchor),
            list.leadingAnchor.constraint(equalTo: document.leadingAnchor, constant: 2),
            list.trailingAnchor.constraint(equalTo: document.trailingAnchor, constant: -2),
            list.topAnchor.constraint(equalTo: document.topAnchor, constant: 2),
            list.bottomAnchor.constraint(equalTo: document.bottomAnchor, constant: -2),
            fitList,
            scroll.heightAnchor.constraint(lessThanOrEqualToConstant: 260),
        ])
        refresh()
        content.layoutSubtreeIfNeeded()
        window.setContentSize(content.fittingSize)
    }

    func row(for storylineID: String) -> Row? { rows.first { $0.storyline.id == storylineID } }

    /// Checkboxes show the checked set; 主线 is enabled only for checked rows.
    private func refresh() {
        for row in rows {
            let checked = selection.isChecked(row.storyline.id)
            row.checkbox.state = checked ? .on : .off
            row.primaryButton.isEnabled = checked
            row.primaryButton.state = selection.primary == row.storyline.id ? .on : .off
        }
    }

    func showError(_ text: String?) {
        message.stringValue = text ?? ""
        message.isHidden = text == nil
    }

    private func setSaving(_ saving: Bool) {
        saveButton.isEnabled = !saving && !rows.isEmpty
        for row in rows { row.checkbox.isEnabled = !saving }
    }

    /// Presents the sheet on a window; without one it stays ready for
    /// programmatic use (acceptance).
    func begin(in parent: NSWindow?) {
        if let parent { parent.beginSheet(window) }
    }

    @objc private func toggled(_ sender: NSButton) {
        guard let row = rows.first(where: { $0.checkbox === sender }) else { return }
        selection.set(row.storyline.id, checked: sender.state == .on)
        refresh()
    }

    @objc private func primaryChosen(_ sender: NSButton) {
        guard let row = rows.first(where: { $0.primaryButton === sender }) else { return }
        selection.choosePrimary(row.storyline.id)
        refresh()
    }

    @objc private func save() {
        showError(nil)
        setSaving(true)
        model.setChapterStorylines(chapterID: chapter.id, storylineIDs: selection.checked, primary: selection.primary) { [weak self] result in
            guard let self else { return }
            self.setSaving(false)
            switch result {
            case .success: self.finish(saved: true)
            // The choice stays in the sheet for another try.
            case .failure(let error): self.showError(error.localizedDescription)
            }
        }
    }

    @objc private func cancel() { finish(saved: false) }

    private func finish(saved: Bool) {
        if let parent = window.sheetParent { parent.endSheet(window) } else { window.orderOut(nil) }
        onFinish?(saved)
    }
}

private final class FlippedView: NSView {
    override var isFlipped: Bool { true }
}
