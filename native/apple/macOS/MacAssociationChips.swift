import AppKit

/// 关联 chips: each association as “章节 · 雨夜” on a soft wash with a ×
/// that removes it. The name opens the entity. Typography and spacing only.
final class AssociationChipsView: NSView {
    final class Chip {
        let entry: AssociationEntry
        let nameButton: ChipButton
        let removeButton: ChipButton
        init(entry: AssociationEntry, nameButton: ChipButton, removeButton: ChipButton) {
            self.entry = entry; self.nameButton = nameButton; self.removeButton = removeButton
        }
    }

    private let prefix: String
    private let stack = NSStackView()
    private(set) var chips: [Chip] = []
    var onOpen: ((AssociationEntry) -> Void)?
    var onRemove: ((AssociationEntry) -> Void)?
    /// Chips are shown up to this many, then “+n”.
    static let visibleCount = 4

    init(prefix: String) {
        self.prefix = prefix
        super.init(frame: .zero)
        stack.orientation = .horizontal
        stack.spacing = 6
        stack.alignment = .centerY
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: leadingAnchor),
            stack.trailingAnchor.constraint(lessThanOrEqualTo: trailingAnchor),
            stack.topAnchor.constraint(equalTo: topAnchor),
            stack.bottomAnchor.constraint(equalTo: bottomAnchor),
        ])
        setAccessibilityElement(true)
        setAccessibilityRole(.group)
        setAccessibilityLabel("关联")
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    /// The chips' labels in order, e.g. for acceptance.
    var labels: [String] { chips.map(\.entry.label) }

    func show(_ entries: [AssociationEntry]) {
        for view in stack.arrangedSubviews { stack.removeArrangedSubview(view); view.removeFromSuperview() }
        chips = []
        for entry in entries {
            let name = ChipButton(title: entry.label) { [weak self] in self?.onOpen?(entry) }
            name.font = .systemFont(ofSize: 11)
            name.contentTintColor = entry.name.available ? .labelColor : .secondaryLabelColor
            name.isEnabled = entry.name.available
            name.lineBreakMode = .byTruncatingTail
            name.setContentCompressionResistancePriority(.init(1), for: .horizontal)
            name.toolTip = entry.name.available ? "打开\(entry.name.name)" : entry.name.name
            name.setAccessibilityIdentifier("\(prefix)-chip-\(entry.target.kind)-\(entry.target.id)")
            let remove = ChipButton(title: "×") { [weak self] in self?.onRemove?(entry) }
            remove.font = .systemFont(ofSize: 11)
            remove.contentTintColor = .secondaryLabelColor
            remove.toolTip = "移除关联"
            remove.setAccessibilityIdentifier("\(prefix)-unchip-\(entry.target.kind)-\(entry.target.id)")
            remove.setAccessibilityLabel("移除关联 \(entry.label)")
            let chip = ChipWash(chipViews: [name, remove])
            chip.spacing = 2
            chip.edgeInsets = NSEdgeInsets(top: 1, left: 6, bottom: 1, right: 4)
            chips.append(Chip(entry: entry, nameButton: name, removeButton: remove))
            if chips.count <= Self.visibleCount { stack.addArrangedSubview(chip) }
        }
        if entries.count > Self.visibleCount {
            let more = NSTextField(labelWithString: "+\(entries.count - Self.visibleCount)")
            more.font = .systemFont(ofSize: 11)
            more.textColor = .secondaryLabelColor
            more.toolTip = entries.dropFirst(Self.visibleCount).map(\.label).joined(separator: "\n")
            stack.addArrangedSubview(more)
        }
        isHidden = entries.isEmpty
    }

    func chip(_ target: RelationEndpoint) -> Chip? { chips.first { $0.entry.target == target } }
}

/// A chip's soft wash; no edge accent.
private final class ChipWash: NSStackView {
    override var wantsUpdateLayer: Bool { true }
    override func viewDidChangeEffectiveAppearance() { super.viewDidChangeEffectiveAppearance(); needsDisplay = true }
    override func updateLayer() {
        layer?.cornerRadius = 9
        layer?.backgroundColor = NSColor.secondaryLabelColor.withAlphaComponent(0.1).cgColor
    }
    convenience init(chipViews views: [NSView]) {
        self.init(frame: .zero)
        wantsLayer = true
        orientation = .horizontal
        alignment = .centerY
        setViews(views, in: .leading)
    }
}

final class ChipButton: NSButton {
    private let pressed: () -> Void
    init(title: String, pressed: @escaping () -> Void) {
        self.pressed = pressed
        super.init(frame: .zero)
        self.title = title
        isBordered = false
        bezelStyle = .inline
        target = self; action = #selector(press)
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
    @objc func press() { pressed() }
}

/// 关联: the project's live chapters, drifts, elements, categories and
/// storylines grouped by kind, leaving out those already associated.
enum AssociationMenu {
    static func make(candidates: [RelationNameDirectory.Candidate], prefix: String,
                     choose: @escaping (RelationEndpoint) -> Void) -> NSMenu {
        let menu = NSMenu(title: "关联")
        menu.autoenablesItems = false
        for group in RelationNameDirectory.Group.allCases {
            let members = candidates.filter { $0.group == group }
            guard !members.isEmpty else { continue }
            let item = NSMenuItem(title: group.rawValue, action: nil, keyEquivalent: "")
            item.setAccessibilityIdentifier("\(prefix)-group-\(group.kind)-\(group.rawValue)")
            let submenu = NSMenu(title: group.rawValue)
            submenu.autoenablesItems = false
            for candidate in members {
                submenu.addItem(LibraryMenuItem(title: candidate.name,
                                                identifier: "\(prefix)-\(candidate.endpoint.kind)-\(candidate.endpoint.id)") {
                    choose(candidate.endpoint)
                })
            }
            item.submenu = submenu
            menu.addItem(item)
        }
        if menu.items.isEmpty {
            let none = NSMenuItem(title: "没有可关联的页面", action: nil, keyEquivalent: "")
            none.isEnabled = false
            menu.addItem(none)
        }
        return menu
    }

    /// Every candidate item of a menu made by `make`, for acceptance.
    static func item(_ menu: NSMenu, _ target: RelationEndpoint) -> LibraryMenuItem? {
        for group in menu.items {
            if let found = group.submenu?.items.compactMap({ $0 as? LibraryMenuItem })
                .first(where: { $0.accessibilityIdentifier().hasSuffix("-\(target.kind)-\(target.id)") }) { return found }
        }
        return nil
    }
}
