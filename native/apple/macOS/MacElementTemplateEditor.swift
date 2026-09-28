import AppKit

/// How an element template reads while it is edited and previewed. Row text
/// carries bold as a font trait and italic as a font trait plus a slant, so
/// what the author sees in a row is what is saved: the text system replaces
/// fonts that lack CJK glyphs, which keeps bold but drops italic, while the
/// slant stays. The preview sets headings and paragraphs as body editors do.
enum ElementTemplateStyle {
    static let rowSize: CGFloat = 13

    static func rowFont(bold: Bool, italic: Bool) -> NSFont {
        var font = NSFont.systemFont(ofSize: rowSize, weight: bold ? .bold : .regular)
        if italic { font = NSFontManager.shared.convert(font, toHaveTrait: .italicFontMask) }
        return font
    }

    static func traits(_ font: NSFont?) -> (bold: Bool, italic: Bool) {
        guard let font else { return (false, false) }
        let traits = font.fontDescriptor.symbolicTraits
        return (traits.contains(.bold), traits.contains(.italic))
    }

    /// Bold and italic of one run of row text.
    static func style(_ attributes: [NSAttributedString.Key: Any]) -> (bold: Bool, italic: Bool) {
        let font = traits(attributes[.font] as? NSFont)
        let slanted = ((attributes[.obliqueness] as? NSNumber)?.doubleValue ?? 0) > 0
        return (font.bold, font.italic || slanted)
    }

    /// A block as row text: the row font with its bold and italic ranges.
    static func rowText(_ block: BookImportBlock) -> NSAttributedString {
        let text = NSMutableAttributedString(string: block.text,
            attributes: [.font: rowFont(bold: false, italic: false), .foregroundColor: NSColor.labelColor])
        let length = text.length
        for mark in block.marks where mark.location >= 0 && mark.length > 0 && mark.location + mark.length <= length {
            set(mark.kind, true, in: text, range: NSRange(location: mark.location, length: mark.length))
        }
        return text
    }

    /// Whether every character of the range already has the mark.
    static func covers(_ text: NSAttributedString, _ range: NSRange, _ mark: BookImportMark.Kind) -> Bool {
        guard range.length > 0 else { return false }
        var all = true
        text.enumerateAttributes(in: range) { attributes, _, stop in
            let style = style(attributes)
            if !(mark == .bold ? style.bold : style.italic) { all = false; stop.pointee = true }
        }
        return all
    }

    /// Rows slant italic text: CJK faces have no italic glyphs, so the font
    /// trait alone would not show which text is italic.
    static let italicSlant: CGFloat = 0.2

    /// Adds or removes one mark over a range and keeps the other.
    static func set(_ mark: BookImportMark.Kind, _ on: Bool, in text: NSMutableAttributedString, range: NSRange) {
        var runs: [(NSRange, NSFont, Bool)] = []
        text.enumerateAttributes(in: range) { attributes, run, _ in
            let current = style(attributes)
            let bold = mark == .bold ? on : current.bold, italic = mark == .italic ? on : current.italic
            runs.append((run, rowFont(bold: bold, italic: italic), italic))
        }
        for (run, font, italic) in runs {
            text.addAttribute(.font, value: font, range: run)
            if italic { text.addAttribute(.obliqueness, value: italicSlant, range: run) } else { text.removeAttribute(.obliqueness, range: run) }
        }
    }

    /// The bold and italic ranges of row text, normalized.
    static func marks(in text: NSAttributedString) -> [BookImportMark] {
        var marks: [BookImportMark] = []
        text.enumerateAttributes(in: NSRange(location: 0, length: text.length)) { attributes, run, _ in
            let traits = style(attributes)
            if traits.bold { marks.append(BookImportMark(kind: .bold, location: run.location, length: run.length)) }
            if traits.italic { marks.append(BookImportMark(kind: .italic, location: run.location, length: run.length)) }
        }
        return BookImportMark.normalized(marks, length: text.length)
    }

    /// How a new element's body starts: headings and paragraphs in the body
    /// editor's typography, scaled for a compact preview.
    static func preview(_ blocks: [BookImportBlock], scale: CGFloat = 1) -> NSAttributedString {
        guard !blocks.isEmpty else {
            return NSAttributedString(string: "没有模版：新设定的正文从一个空白段落开始。",
                attributes: [.font: NSFont.systemFont(ofSize: 12), .foregroundColor: NSColor.secondaryLabelColor])
        }
        let typography = DocumentStyle.typography
        let result = NSMutableAttributedString()
        for (index, block) in blocks.enumerated() {
            let heading = block.kind == .heading
            let size = (heading ? typography.headingSize(block.level ?? 1) : typography.size) * scale
            let paragraph = NSMutableParagraphStyle()
            paragraph.setParagraphStyle(DocumentStyle.paragraphStyle(kind: heading ? "heading" : "paragraph", depth: 0))
            paragraph.lineSpacing *= scale; paragraph.paragraphSpacing *= scale
            paragraph.firstLineHeadIndent *= scale
            var attributes: [NSAttributedString.Key: Any] = [.paragraphStyle: paragraph, .foregroundColor: NSColor.labelColor,
                .font: DocumentStyle.font(size: size, weight: heading ? .semibold : .regular)]
            if let language = typography.language { attributes[DocumentStyle.languageKey] = language }
            let text = NSMutableAttributedString(string: block.text + (index < blocks.count - 1 ? "\n" : ""), attributes: attributes)
            let length = (block.text as NSString).length
            var bold = [Bool](repeating: false, count: length), italic = bold
            for mark in block.marks where mark.location >= 0 && mark.location + mark.length <= length {
                for offset in mark.location..<(mark.location + mark.length) {
                    if mark.kind == .bold { bold[offset] = true } else { italic[offset] = true }
                }
            }
            var start = 0
            while start < length {
                var end = start + 1
                while end < length, bold[end] == bold[start], italic[end] == italic[start] { end += 1 }
                if bold[start] || italic[start] {
                    text.addAttribute(.font, value: DocumentStyle.font(size: size,
                        weight: bold[start] ? .bold : (heading ? .semibold : .regular), italic: italic[start]),
                        range: NSRange(location: start, length: end - start))
                }
                start = end
            }
            result.append(text)
        }
        return result
    }

    /// “标题 2 · 3 段” style summary for the page.
    static func summary(_ blocks: [BookImportBlock]) -> String {
        let headings = blocks.filter { $0.kind == .heading }.count
        let paragraphs = blocks.count - headings
        return [headings > 0 ? "\(headings) 个标题" : nil, paragraphs > 0 ? "\(paragraphs) 个段落" : nil]
            .compactMap { $0 }.joined(separator: "、")
    }
}

/// The blocks of an element template as editable rows: each row has 正文 or
/// 标题 1–3, its text, and B and I that set bold or italic on the selected
/// text of that row (the whole row when nothing is selected). Return adds a
/// paragraph below. Nothing is written here; the owner saves `blocks`.
final class ElementTemplateEditor: NSView, NSTextFieldDelegate {
    final class Row {
        let root = NSStackView()
        let kindPopup = NSPopUpButton(frame: .zero, pullsDown: false)
        let textField = NSTextField()
        let boldButton: NSButton
        let italicButton: NSButton
        let upButton: NSButton
        let downButton: NSButton
        let deleteButton: NSButton

        init(boldButton: NSButton, italicButton: NSButton, upButton: NSButton, downButton: NSButton, deleteButton: NSButton) {
            self.boldButton = boldButton; self.italicButton = italicButton
            self.upButton = upButton; self.downButton = downButton; self.deleteButton = deleteButton
        }
    }

    /// Popup order: 正文, then 标题 1–3 (the tag is the level, 0 for 正文).
    static let kindTitles = ["正文", "标题 1", "标题 2", "标题 3"]
    private static let ringInset: CGFloat = 4
    private let rowsStack = NSStackView()
    private let scroll = NSScrollView()
    private let emptyLabel = NSTextField(wrappingLabelWithString: "还没有段落。点“添加段落”写下新设定正文的骨架，例如“外貌”“性格”“经历”这样的标题。")
    let addButton = NSButton(title: "添加段落", target: nil, action: nil)
    private(set) var rows: [Row] = []
    private var isApplying = false
    /// Any typed, restyled, added, removed or moved block; the preview follows.
    var onChange: (() -> Void)?

    init(maximumHeight: CGFloat = 260) {
        super.init(frame: .zero)
        setAccessibilityIdentifier("template-blocks")
        rowsStack.orientation = .vertical; rowsStack.alignment = .leading; rowsStack.spacing = 4
        rowsStack.edgeInsets = NSEdgeInsets(top: 3, left: Self.ringInset, bottom: 3, right: Self.ringInset)
        rowsStack.translatesAutoresizingMaskIntoConstraints = false
        let document = TemplateDocumentView()
        document.translatesAutoresizingMaskIntoConstraints = false
        document.addSubview(rowsStack)
        scroll.drawsBackground = false; scroll.borderType = .noBorder
        scroll.hasVerticalScroller = true; scroll.autohidesScrollers = true
        scroll.documentView = document
        emptyLabel.textColor = .tertiaryLabelColor
        emptyLabel.font = .systemFont(ofSize: 12)
        emptyLabel.setAccessibilityIdentifier("template-blocks-empty")
        addButton.bezelStyle = .rounded; addButton.controlSize = .small
        addButton.font = .systemFont(ofSize: NSFont.systemFontSize(for: .small))
        addButton.image = NSImage(systemSymbolName: "plus", accessibilityDescription: nil)
        addButton.imagePosition = .imageLeading
        addButton.target = self; addButton.action = #selector(addPressed)
        addButton.setAccessibilityIdentifier("template-block-add")
        let stack = NSStackView(views: [scroll, emptyLabel, addButton])
        stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = 6
        stack.translatesAutoresizingMaskIntoConstraints = false
        for view in [stack, rowsStack] { view.setHuggingPriority(.init(1), for: .horizontal) }
        addSubview(stack)
        let fitContent = scroll.heightAnchor.constraint(equalTo: document.heightAnchor)
        fitContent.priority = .defaultHigh
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: leadingAnchor, constant: -Self.ringInset),
            stack.trailingAnchor.constraint(equalTo: trailingAnchor, constant: Self.ringInset),
            stack.topAnchor.constraint(equalTo: topAnchor), stack.bottomAnchor.constraint(equalTo: bottomAnchor),
            scroll.widthAnchor.constraint(equalTo: stack.widthAnchor),
            emptyLabel.leadingAnchor.constraint(equalTo: stack.leadingAnchor, constant: Self.ringInset),
            emptyLabel.trailingAnchor.constraint(equalTo: stack.trailingAnchor, constant: -Self.ringInset),
            addButton.leadingAnchor.constraint(equalTo: stack.leadingAnchor, constant: Self.ringInset),
            document.leadingAnchor.constraint(equalTo: scroll.contentView.leadingAnchor),
            document.topAnchor.constraint(equalTo: scroll.contentView.topAnchor),
            document.widthAnchor.constraint(equalTo: scroll.contentView.widthAnchor),
            rowsStack.leadingAnchor.constraint(equalTo: document.leadingAnchor),
            rowsStack.trailingAnchor.constraint(equalTo: document.trailingAnchor),
            rowsStack.topAnchor.constraint(equalTo: document.topAnchor),
            rowsStack.bottomAnchor.constraint(equalTo: document.bottomAnchor),
            fitContent,
            scroll.heightAnchor.constraint(lessThanOrEqualToConstant: maximumHeight),
        ])
        refreshState()
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    // MARK: Values

    /// The row's text as typed, including an active field editor.
    func text(at index: Int) -> NSAttributedString {
        let field = rows[index].textField
        if let editor = field.currentEditor() as? NSTextView, let storage = editor.textStorage {
            return NSAttributedString(attributedString: storage)
        }
        return field.attributedStringValue
    }

    /// The blocks as typed. Line breaks inside a row read as spaces.
    var blocks: [BookImportBlock] {
        rows.indices.map { index in
            let text = text(at: index)
            let plain = text.string.replacingOccurrences(of: "\r\n", with: " ")
                .replacingOccurrences(of: "\n", with: " ").replacingOccurrences(of: "\r", with: " ")
                .replacingOccurrences(of: "\u{2029}", with: " ").replacingOccurrences(of: "\u{2028}", with: " ")
            let marks = ElementTemplateStyle.marks(in: text)
            let level = rows[index].kindPopup.selectedTag()
            return level == 0 ? BookImportBlock(kind: .paragraph, level: nil, text: plain, marks: marks)
                : BookImportBlock(kind: .heading, level: level, text: plain, marks: marks)
        }
    }

    var isEditing: Bool {
        guard let window, let responder = window.firstResponder as? NSView else { return false }
        return responder.isDescendant(of: self)
    }

    /// Shows exactly these blocks, reusing row views.
    func show(_ blocks: [BookImportBlock]) {
        isApplying = true
        defer { isApplying = false }
        if isEditing { window?.makeFirstResponder(nil) }
        while rows.count > blocks.count {
            let row = rows.removeLast()
            rowsStack.removeArrangedSubview(row.root); row.root.removeFromSuperview()
        }
        while rows.count < blocks.count { appendRow() }
        for (row, block) in zip(rows, blocks) {
            row.kindPopup.selectItem(withTag: block.kind == .heading ? (block.level ?? 1) : 0)
            row.textField.attributedStringValue = ElementTemplateStyle.rowText(block)
        }
        refreshState()
    }

    // MARK: Row actions

    /// Inserts a paragraph after `index` (at the end for nil) and moves the
    /// keyboard to it.
    func insertBlock(after index: Int? = nil) {
        var next = blocks
        let at = index.map { min($0 + 1, next.count) } ?? next.count
        next.insert(BookImportBlock(kind: .paragraph, level: nil, text: ""), at: at)
        change(to: next)
        window?.makeFirstResponder(rows[at].textField)
    }

    func removeBlock(at index: Int) {
        guard rows.indices.contains(index) else { return }
        var next = blocks
        next.remove(at: index)
        change(to: next)
    }

    func moveBlock(at index: Int, by offset: Int) {
        let target = index + offset
        guard rows.indices.contains(index), rows.indices.contains(target) else { return }
        var next = blocks
        next.swapAt(index, target)
        change(to: next)
    }

    /// 正文 for 0, otherwise 标题 of that level.
    func setLevel(_ level: Int, at index: Int) {
        guard rows.indices.contains(index) else { return }
        rows[index].kindPopup.selectItem(withTag: min(max(level, 0), 3))
        onChange?()
    }

    /// Sets or clears bold or italic on the row's selected text, or on the
    /// whole row when it is not being edited or nothing is selected. A range
    /// already entirely in the style loses it.
    func toggle(_ mark: BookImportMark.Kind, at index: Int) {
        guard rows.indices.contains(index) else { return }
        let field = rows[index].textField
        if let editor = field.currentEditor() as? NSTextView, let storage = editor.textStorage {
            let selected = editor.selectedRange()
            let range = selected.length > 0 ? selected : NSRange(location: 0, length: storage.length)
            guard range.length > 0, editor.shouldChangeText(in: range, replacementString: nil) else { return }
            let on = !ElementTemplateStyle.covers(storage, range, mark)
            storage.beginEditing()
            ElementTemplateStyle.set(mark, on, in: storage, range: range)
            storage.endEditing()
            editor.didChangeText()
            editor.setSelectedRange(selected)
        } else {
            let text = NSMutableAttributedString(attributedString: field.attributedStringValue)
            let range = NSRange(location: 0, length: text.length)
            guard range.length > 0 else { return }
            ElementTemplateStyle.set(mark, !ElementTemplateStyle.covers(text, range, mark), in: text, range: range)
            field.attributedStringValue = text
        }
        onChange?()
    }

    /// Structural changes read the typed text first, so an active edit moves
    /// with its row.
    private func change(to next: [BookImportBlock]) {
        show(next)
        onChange?()
    }

    private func index(of sender: NSView, in keyPath: KeyPath<Row, NSButton>) -> Int? {
        rows.firstIndex { $0[keyPath: keyPath] === sender }
    }
    @objc private func addPressed() { insertBlock() }
    @objc private func boldPressed(_ sender: NSButton) { if let index = index(of: sender, in: \.boldButton) { toggle(.bold, at: index) } }
    @objc private func italicPressed(_ sender: NSButton) { if let index = index(of: sender, in: \.italicButton) { toggle(.italic, at: index) } }
    @objc private func upPressed(_ sender: NSButton) { if let index = index(of: sender, in: \.upButton) { moveBlock(at: index, by: -1) } }
    @objc private func downPressed(_ sender: NSButton) { if let index = index(of: sender, in: \.downButton) { moveBlock(at: index, by: 1) } }
    @objc private func deletePressed(_ sender: NSButton) { if let index = index(of: sender, in: \.deleteButton) { removeBlock(at: index) } }
    @objc private func kindChosen(_ sender: NSPopUpButton) { onChange?() }

    // MARK: Row views

    private func symbolButton(_ symbol: String, label: String, action: Selector) -> NSButton {
        let image = NSImage(systemSymbolName: symbol, accessibilityDescription: label) ?? NSImage()
        let button = NSButton(image: image, target: self, action: action)
        button.isBordered = false
        button.contentTintColor = .secondaryLabelColor
        button.toolTip = label
        button.setAccessibilityLabel(label)
        // Clicking keeps the row's text selection and field editor.
        button.refusesFirstResponder = true
        button.widthAnchor.constraint(equalToConstant: 20).isActive = true
        return button
    }

    private func appendRow() {
        let row = Row(boldButton: symbolButton("bold", label: "加粗", action: #selector(boldPressed(_:))),
                      italicButton: symbolButton("italic", label: "斜体", action: #selector(italicPressed(_:))),
                      upButton: symbolButton("chevron.up", label: "上移", action: #selector(upPressed(_:))),
                      downButton: symbolButton("chevron.down", label: "下移", action: #selector(downPressed(_:))),
                      deleteButton: symbolButton("minus.circle", label: "删除段落", action: #selector(deletePressed(_:))))
        for (tag, title) in Self.kindTitles.enumerated() {
            row.kindPopup.addItem(withTitle: title)
            row.kindPopup.lastItem?.tag = tag
        }
        row.kindPopup.controlSize = .small
        row.kindPopup.font = .systemFont(ofSize: NSFont.systemFontSize(for: .small))
        row.kindPopup.target = self; row.kindPopup.action = #selector(kindChosen(_:))
        row.textField.placeholderString = "段落文字"
        row.textField.delegate = self
        row.textField.allowsEditingTextAttributes = true
        row.textField.importsGraphics = false
        row.textField.font = ElementTemplateStyle.rowFont(bold: false, italic: false)
        row.textField.cell?.isScrollable = true; row.textField.cell?.wraps = false
        row.textField.lineBreakMode = .byTruncatingTail
        row.root.setViews([row.kindPopup, row.textField, row.boldButton, row.italicButton, row.upButton, row.downButton, row.deleteButton],
                          in: .leading)
        row.root.spacing = 6
        row.root.setHuggingPriority(.init(1), for: .horizontal)
        rowsStack.addArrangedSubview(row.root)
        NSLayoutConstraint.activate([
            row.root.widthAnchor.constraint(equalTo: rowsStack.widthAnchor, constant: -2 * Self.ringInset),
            row.kindPopup.widthAnchor.constraint(equalToConstant: 76),
            row.textField.widthAnchor.constraint(greaterThanOrEqualToConstant: 120),
        ])
        row.textField.setContentHuggingPriority(.init(1), for: .horizontal)
        for button in [row.boldButton, row.italicButton, row.upButton, row.downButton, row.deleteButton] {
            button.setContentHuggingPriority(.required, for: .horizontal)
        }
        rows.append(row)
    }

    private func refreshState() {
        for (index, row) in rows.enumerated() {
            row.root.setAccessibilityIdentifier("template-block-\(index)")
            row.kindPopup.setAccessibilityIdentifier("template-block-kind-\(index)")
            row.kindPopup.setAccessibilityLabel("第 \(index + 1) 段的样式")
            row.textField.setAccessibilityIdentifier("template-block-text-\(index)")
            row.textField.setAccessibilityLabel("第 \(index + 1) 段")
            row.boldButton.setAccessibilityIdentifier("template-block-bold-\(index)")
            row.italicButton.setAccessibilityIdentifier("template-block-italic-\(index)")
            row.upButton.setAccessibilityIdentifier("template-block-up-\(index)")
            row.downButton.setAccessibilityIdentifier("template-block-down-\(index)")
            row.deleteButton.setAccessibilityIdentifier("template-block-delete-\(index)")
            row.upButton.isEnabled = index > 0
            row.downButton.isEnabled = index < rows.count - 1
        }
        scroll.isHidden = rows.isEmpty
        emptyLabel.isHidden = !rows.isEmpty
    }

    func controlTextDidChange(_ notification: Notification) { if !isApplying { onChange?() } }
    func controlTextDidEndEditing(_ notification: Notification) { if !isApplying { onChange?() } }

    /// Return adds a paragraph below the row, as in a body editor.
    func control(_ control: NSControl, textView: NSTextView, doCommandBy selector: Selector) -> Bool {
        guard selector == #selector(NSResponder.insertNewline(_:)),
              let index = rows.firstIndex(where: { $0.textField === control }) else { return false }
        insertBlock(after: index)
        return true
    }
}

private final class TemplateDocumentView: NSView {
    override var isFlipped: Bool { true }
}

/// A read-only rendering of a template on a soft wash, as tall as its text
/// up to a maximum; longer templates scroll.
final class ElementTemplatePreviewView: NSView {
    let textView = NSTextView()
    private let scroll = NSScrollView()
    private let height: NSLayoutConstraint
    private let scale: CGFloat
    private let maximumHeight: CGFloat
    private(set) var blocks: [BookImportBlock] = []

    init(scale: CGFloat, maximumHeight: CGFloat) {
        self.scale = scale
        self.maximumHeight = maximumHeight
        height = scroll.heightAnchor.constraint(equalToConstant: 28)
        super.init(frame: .zero)
        wantsLayer = true
        textView.isEditable = false; textView.isSelectable = true
        textView.drawsBackground = false
        textView.isVerticallyResizable = true
        textView.autoresizingMask = [.width]
        textView.textContainer?.widthTracksTextView = true
        textView.textContainerInset = NSSize(width: 6, height: 6)
        textView.setAccessibilityLabel("新设定正文预览")
        scroll.drawsBackground = false; scroll.borderType = .noBorder
        scroll.hasVerticalScroller = true; scroll.autohidesScrollers = true
        scroll.documentView = textView
        scroll.translatesAutoresizingMaskIntoConstraints = false
        addSubview(scroll)
        NSLayoutConstraint.activate([
            scroll.leadingAnchor.constraint(equalTo: leadingAnchor), scroll.trailingAnchor.constraint(equalTo: trailingAnchor),
            scroll.topAnchor.constraint(equalTo: topAnchor), scroll.bottomAnchor.constraint(equalTo: bottomAnchor), self.height,
        ])
        show([])
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override var wantsUpdateLayer: Bool { true }
    override func viewDidChangeEffectiveAppearance() { super.viewDidChangeEffectiveAppearance(); needsDisplay = true }
    override func updateLayer() {
        layer?.cornerRadius = 6
        layer?.backgroundColor = NSColor.secondaryLabelColor.withAlphaComponent(0.06).cgColor
    }

    /// The text shown, for acceptance and accessibility.
    var text: String { textView.string }

    func show(_ blocks: [BookImportBlock]) {
        self.blocks = blocks
        textView.textStorage?.setAttributedString(ElementTemplateStyle.preview(blocks, scale: scale))
        needsLayout = true
    }

    func showMessage(_ text: String) {
        blocks = []
        textView.textStorage?.setAttributedString(NSAttributedString(string: text,
            attributes: [.font: NSFont.systemFont(ofSize: 12), .foregroundColor: NSColor.secondaryLabelColor]))
        needsLayout = true
    }

    /// The height follows the laid-out text at the current width.
    override func layout() {
        super.layout()
        guard let manager = textView.layoutManager, let container = textView.textContainer, scroll.bounds.width > 0 else { return }
        manager.ensureLayout(for: container)
        let used = manager.usedRect(for: container).height + textView.textContainerInset.height * 2
        let target = min(max(ceil(used), 28), maximumHeight)
        if abs(height.constant - target) > 0.5 { height.constant = target }
    }
}

/// Edits a body template in a sheet: a category's 新设定模版 or a storyline's
/// 章节模版. The block rows, a live preview of how a new body starts, and
/// 清空模版. Nothing is written until 保存; a refusal keeps the rows and
/// shows the reason.
final class ElementTemplateSheet: NSObject {
    /// What the sheet says: its title, the explanation and the preview's caption.
    struct Texts {
        var windowTitle: String
        var title: String
        var explanation: String
        var previewTitle: String
        var clearTooltip: String

        /// A category's 新设定模版.
        static func category(_ name: String) -> Texts {
            Texts(windowTitle: "新设定模版", title: "“\(name)”的新设定模版",
                  explanation: "之后在“\(name)”中新建的设定，正文会从这份模版开始。已有的设定不会改变。",
                  previewTitle: "预览 · 新设定的正文", clearTooltip: "移除所有段落；保存后新设定的正文从空白开始")
        }

        /// A storyline's 章节模版.
        static func storyline(_ name: String) -> Texts {
            Texts(windowTitle: "章节模版", title: "“\(name)”的章节模版",
                  explanation: "之后在“\(name)”中新建的章节会加入这条故事线，正文从这份模版开始。已有的章节不会改变。",
                  previewTitle: "预览 · 新章节的正文", clearTooltip: "移除所有段落；保存后新章节的正文从空白开始")
        }
    }

    let texts: Texts
    let window: NSWindow
    let editor = ElementTemplateEditor()
    let preview = ElementTemplatePreviewView(scale: 1, maximumHeight: 220)
    let saveButton = NSButton(title: "保存", target: nil, action: nil)
    let cancelButton = NSButton(title: "取消", target: nil, action: nil)
    let clearButton = NSButton(title: "清空模版", target: nil, action: nil)
    let explanation: NSTextField
    private let message = NSTextField(wrappingLabelWithString: "")
    var onSave: (([BookImportBlock]) -> Void)?
    var onCancel: (() -> Void)?

    var errorMessage: String? { message.isHidden ? nil : message.stringValue }

    convenience init(category: WorkspaceElementCategory, blocks: [BookImportBlock]) {
        self.init(texts: .category(category.name), blocks: blocks)
    }

    init(texts: Texts, blocks: [BookImportBlock]) {
        self.texts = texts
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 580, height: 520), styleMask: [.titled],
                          backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.title = texts.windowTitle
        explanation = NSTextField(wrappingLabelWithString: texts.explanation)
        super.init()
        let title = NSTextField(labelWithString: texts.title)
        title.font = .systemFont(ofSize: 15, weight: .semibold)
        title.lineBreakMode = .byTruncatingTail
        explanation.textColor = .secondaryLabelColor
        explanation.setAccessibilityIdentifier("element-template-explanation")
        let hint = NSTextField(wrappingLabelWithString: "选中一段中的文字后点加粗或斜体；没有选中时作用于整段。回车在下方添加段落。")
        hint.font = .systemFont(ofSize: 11)
        hint.textColor = .tertiaryLabelColor
        let previewTitle = NSTextField(labelWithString: texts.previewTitle)
        previewTitle.font = .systemFont(ofSize: 12, weight: .semibold)
        previewTitle.textColor = .secondaryLabelColor
        preview.setAccessibilityIdentifier("element-template-sheet-preview")
        message.textColor = .systemRed
        message.isHidden = true
        message.setAccessibilityIdentifier("element-template-error")
        editor.show(blocks)
        preview.show(blocks)
        editor.onChange = { [weak self] in self?.refreshPreview() }
        saveButton.target = self; saveButton.action = #selector(save)
        saveButton.keyEquivalent = "\r"
        saveButton.setAccessibilityIdentifier("save-element-template")
        cancelButton.target = self; cancelButton.action = #selector(cancel)
        cancelButton.keyEquivalent = "\u{1b}"
        cancelButton.setAccessibilityIdentifier("cancel-element-template")
        clearButton.target = self; clearButton.action = #selector(clear)
        clearButton.setAccessibilityIdentifier("clear-element-template")
        clearButton.toolTip = texts.clearTooltip
        let buttons = NSStackView(views: [clearButton, NSView(), cancelButton, saveButton])
        let stack = NSStackView(views: [title, explanation, editor, hint, previewTitle, preview, message, buttons])
        stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = 10
        stack.setCustomSpacing(6, after: title)
        stack.setCustomSpacing(4, after: editor)
        stack.setCustomSpacing(14, after: hint)
        stack.setCustomSpacing(6, after: previewTitle)
        stack.translatesAutoresizingMaskIntoConstraints = false
        let content = NSView()
        content.addSubview(stack)
        window.contentView = content
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 20),
            stack.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -20),
            stack.topAnchor.constraint(equalTo: content.topAnchor, constant: 18),
            stack.bottomAnchor.constraint(equalTo: content.bottomAnchor, constant: -16),
            content.widthAnchor.constraint(equalToConstant: 580),
            title.widthAnchor.constraint(equalTo: stack.widthAnchor),
            explanation.widthAnchor.constraint(equalTo: stack.widthAnchor),
            editor.widthAnchor.constraint(equalTo: stack.widthAnchor),
            hint.widthAnchor.constraint(equalTo: stack.widthAnchor),
            preview.widthAnchor.constraint(equalTo: stack.widthAnchor),
            message.widthAnchor.constraint(equalTo: stack.widthAnchor),
            buttons.widthAnchor.constraint(equalTo: stack.widthAnchor),
        ])
        content.layoutSubtreeIfNeeded()
        window.setContentSize(content.fittingSize)
    }

    func refreshPreview() { preview.show(editor.blocks) }

    func showError(_ text: String?) {
        message.stringValue = text ?? ""
        message.isHidden = text == nil
    }

    func setSaving(_ saving: Bool) {
        saveButton.isEnabled = !saving
        clearButton.isEnabled = !saving
        editor.addButton.isEnabled = !saving
    }

    @objc private func save() { onSave?(editor.blocks) }
    @objc private func cancel() { onCancel?() }
    @objc private func clear() {
        editor.show([])
        refreshPreview()
        showError(nil)
    }
}

/// 新设定模版 on a category page, or 章节模版 on a storyline page: a
/// preview of how a new body starts, with 编辑模版… opening the sheet.
/// Typography and spacing only.
final class ElementTemplateSectionView: NSView {
    private let title: NSTextField
    let detail = NSTextField(labelWithString: "")
    let editButton = NSButton(title: "编辑模版…", target: nil, action: nil)
    let preview = ElementTemplatePreviewView(scale: 0.8, maximumHeight: 150)
    var onEdit: (() -> Void)?
    /// What a set template's detail says before its summary.
    private let setDetail: String

    /// A category's 新设定模版, with the `element-template` identifiers.
    convenience override init(frame: NSRect) {
        self.init(title: "新设定模版", identifier: "element-template", setDetail: "新建设定时正文从这里开始",
                  editTooltip: "编辑之后新建的设定正文从哪里开始")
    }

    init(title text: String, identifier: String, setDetail: String, editTooltip: String) {
        title = NSTextField(labelWithString: text)
        self.setDetail = setDetail
        super.init(frame: .zero)
        setAccessibilityIdentifier("\(identifier)-section")
        title.font = .systemFont(ofSize: 12, weight: .semibold)
        title.textColor = .secondaryLabelColor
        detail.font = .systemFont(ofSize: 11)
        detail.textColor = .tertiaryLabelColor
        detail.lineBreakMode = .byTruncatingTail
        detail.setAccessibilityIdentifier("\(identifier)-detail")
        editButton.isBordered = false
        editButton.font = .systemFont(ofSize: 12)
        editButton.contentTintColor = .labAccent
        editButton.target = self; editButton.action = #selector(edit)
        editButton.setAccessibilityIdentifier("edit-\(identifier)")
        editButton.toolTip = editTooltip
        preview.setAccessibilityIdentifier("\(identifier)-preview")
        let header = NSStackView(views: [title, detail, NSView(), editButton])
        header.spacing = 8
        let stack = NSStackView(views: [header, preview])
        stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = 4
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: leadingAnchor), stack.trailingAnchor.constraint(equalTo: trailingAnchor),
            stack.topAnchor.constraint(equalTo: topAnchor), stack.bottomAnchor.constraint(equalTo: bottomAnchor),
            header.widthAnchor.constraint(equalTo: stack.widthAnchor),
            preview.widthAnchor.constraint(equalTo: stack.widthAnchor),
        ])
        showLoading()
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    func showLoading() {
        detail.stringValue = ""
        preview.showMessage("正在读取模版…")
    }

    func show(_ blocks: [BookImportBlock]) {
        detail.stringValue = blocks.isEmpty ? "未设置" : "\(setDetail) · \(ElementTemplateStyle.summary(blocks))"
        preview.show(blocks)
    }

    func showUnavailable(_ text: String) {
        detail.stringValue = ""
        preview.showMessage(text)
    }

    @objc private func edit() { onEdit?() }
}
