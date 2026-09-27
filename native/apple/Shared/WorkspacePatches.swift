import Foundation

/// A 设定补丁: how an element changes from a point in the story. A patch made
/// from a chapter (or drift) selection keeps the chapter, the block, its text
/// and the selected text; Rust marks it invalid while that text is missing
/// from the chapter and valid again when it returns. Bodies are plain text.
struct WorkspacePatch: Decodable, Equatable {
    let id: String
    let elementId: String
    let sourceNodeId: String?
    /// The source chapter's title while it is live; nil once it is trashed.
    let sourceNodeTitle: String?
    let sourceBlockId: String?
    let sourceBlockText: String?
    /// The selected chapter text the patch was made from.
    let anchorText: String?
    /// Set while the anchored text is missing from the source chapter.
    let invalidatedAt: String?
    let title: String?
    /// Paragraphs joined by blank lines.
    let body: String
    let orderKey: Int
    let createdAt: String
    let updatedAt: String

    var isInvalid: Bool { invalidatedAt != nil }
}

/// Every patch command returns its own result (nil for a move, a deletion
/// and the reads) and the affected element's patches in order.
struct WorkspacePatchReply<Value: Decodable>: Decodable {
    let result: Value?
    let patches: [WorkspacePatch]
}

/// Where a patch made from a selection comes from.
struct WorkspacePatchSource: Equatable {
    let nodeID: String
    let blockID: String?
    let blockText: String?
    let anchorText: String?

    var payload: [String: Any] {
        var payload: [String: Any] = ["nodeId": nodeID]
        if let blockID { payload["blockId"] = blockID }
        if let blockText { payload["blockText"] = blockText }
        if let anchorText { payload["anchorText"] = anchorText }
        return payload
    }
}

/// Present fields are written; `title: .some(nil)` clears the title.
struct WorkspacePatchChanges: Equatable {
    var title: String??
    var body: String?

    var fields: [String: Any] {
        var fields: [String: Any] = [:]
        if let title { fields["title"] = title.map { $0 as Any } ?? NSNull() }
        if let body { fields["body"] = body }
        return fields
    }
    var isEmpty: Bool { title == nil && body == nil }
}

/// The plain-text rules Rust applies to patch titles and bodies, so an
/// unchanged edit is recognised before anything is sent.
enum PatchText {
    /// JavaScript's `trim`: Unicode white space and the byte-order mark.
    static func trim(_ text: String) -> String {
        let scalars = Array(text.unicodeScalars)
        func blank(_ scalar: Unicode.Scalar) -> Bool {
            scalar == "\u{feff}" || (scalar != "\u{85}" && CharacterSet.whitespacesAndNewlines.contains(scalar))
        }
        guard let first = scalars.firstIndex(where: { !blank($0) }), let last = scalars.lastIndex(where: { !blank($0) }) else { return "" }
        var result = String.UnicodeScalarView()
        result.append(contentsOf: scalars[first...last])
        return String(result)
    }

    /// The stored title: trimmed, nil when empty.
    static func title(_ typed: String) -> String? {
        let trimmed = trim(typed)
        return trimmed.isEmpty ? nil : trimmed
    }

    /// The body as Rust stores and reads it back: trimmed paragraphs split at
    /// blank lines, a single line break inside one read as a space.
    static func body(_ typed: String) -> String {
        var paragraphs: [String] = []
        var current = String.UnicodeScalarView(), breaks = 0
        func flush() {
            let paragraph = trim(String(current))
            if !paragraph.isEmpty { paragraphs.append(paragraph) }
            current = String.UnicodeScalarView()
        }
        // Unicode scalars, as Rust iterates characters.
        for scalar in trim(typed).unicodeScalars {
            if scalar == "\n" { breaks += 1; continue }
            if breaks >= 2 { flush() } else if breaks == 1 { current.append(" ") }
            breaks = 0
            current.append(scalar)
        }
        flush()
        return paragraphs.joined(separator: "\n\n")
    }

    /// Where the anchored text is now: inside the source block first, then
    /// anywhere in the chapter. Nil once it is gone.
    static func anchorRange(in text: String, anchor: String, block: NativeRange?) -> NSRange? {
        guard !anchor.isEmpty else { return nil }
        let text = text as NSString
        if let block, block.location >= 0, block.length >= 0, NSMaxRange(block.nsRange) <= text.length {
            let found = text.range(of: anchor, options: .literal, range: block.nsRange)
            if found.location != NSNotFound { return found }
        }
        let found = text.range(of: anchor, options: .literal)
        return found.location == NSNotFound ? nil : found
    }

    /// The selection a patch is made from: the chapter, the block holding the
    /// selection's start, that block's text and the selected text. Nil for an
    /// empty or stale selection.
    static func source(nodeID: String, projection: NativeProjection, shown: String, range: NSRange) -> WorkspacePatchSource? {
        let text = projection.text as NSString
        guard range.length > 0, range.location != NSNotFound, NSMaxRange(range) <= text.length,
              NativeText.identical(shown, projection.text) else { return nil }
        let anchor = text.substring(with: range)
        guard !trim(anchor).isEmpty else { return nil }
        let block = projection.blocks.first {
            range.location >= $0.range.location && range.location < NSMaxRange($0.range.nsRange)
        } ?? projection.blocks.first { range.location == NSMaxRange($0.range.nsRange) }
        let blockText = block.map { text.substring(with: $0.range.nsRange) }
        return WorkspacePatchSource(nodeID: nodeID, blockID: block?.id, blockText: blockText, anchorText: anchor)
    }
}
