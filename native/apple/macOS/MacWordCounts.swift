import AppKit

/// Word counts in AppKit: small secondary text after a title, never an edge
/// accent. Rows use the chapter panel's compact count, headers and the status
/// line the full grouped number.
enum MacWordCount {
    /// A list row's compact count (“1.2k 字”); nil for a node without a
    /// canonical count, which shows nothing.
    static func rowLabel(_ count: Int?, identifier: String) -> NSTextField? {
        guard let count else { return nil }
        let label = NSTextField(labelWithString: WordCountText.compact(count))
        label.font = .monospacedDigitSystemFont(ofSize: 11, weight: .regular)
        label.textColor = .tertiaryLabelColor
        label.setContentHuggingPriority(.required, for: .horizontal)
        label.setContentCompressionResistancePriority(.required, for: .horizontal)
        label.setAccessibilityIdentifier(identifier)
        label.setAccessibilityLabel(WordCountText.full(count))
        return label
    }

    /// A page header's count label, 统计中… until counts are read.
    static func headerLabel(identifier: String) -> NSTextField {
        let label = NSTextField(labelWithString: WordCountText.counting)
        label.font = .monospacedDigitSystemFont(ofSize: 12, weight: .regular)
        label.textColor = .tertiaryLabelColor
        label.setContentHuggingPriority(.required, for: .horizontal)
        label.setContentCompressionResistancePriority(.required, for: .horizontal)
        label.setAccessibilityIdentifier(identifier)
        return label
    }

    /// “1,234 字” once read; hidden for a node without a canonical count.
    static func show(_ count: Int?, loaded: Bool, in label: NSTextField) {
        switch (loaded, count) {
        case (false, _):
            label.stringValue = WordCountText.counting
            label.textColor = .tertiaryLabelColor
            label.isHidden = false
        case (true, let count?):
            label.stringValue = WordCountText.full(count)
            label.textColor = .secondaryLabelColor
            label.isHidden = false
        case (true, nil):
            label.stringValue = ""
            label.isHidden = true
        }
        label.setAccessibilityLabel(label.isHidden ? nil : "字数 \(label.stringValue)")
    }
}
