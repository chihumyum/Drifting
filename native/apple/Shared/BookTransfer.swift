import Foundation

/// A bold or italic range of an imported block, in UTF-16 units of its text.
struct BookImportMark: Equatable {
    enum Kind: String { case bold, italic }
    let kind: Kind
    let location: Int
    let length: Int

    var payload: [String: Any] { ["mark": kind.rawValue, "location": location, "length": length] }

    /// Clipped to the text, with overlapping or touching ranges of one kind
    /// merged: Rust applies each mark as a format command, which would
    /// toggle a range formatted twice.
    static func normalized(_ marks: [BookImportMark], length: Int) -> [BookImportMark] {
        var result: [BookImportMark] = []
        for kind in [Kind.bold, .italic] {
            let ranges = marks.filter { $0.kind == kind }
                .map { (max(0, $0.location), min(length, $0.location + $0.length)) }
                .filter { $0.0 < $0.1 }.sorted { $0.0 < $1.0 }
            var merged: [(Int, Int)] = []
            for range in ranges {
                if let last = merged.last, range.0 <= last.1 { merged[merged.count - 1].1 = max(last.1, range.1) }
                else { merged.append(range) }
            }
            result += merged.map { BookImportMark(kind: kind, location: $0.0, length: $0.1 - $0.0) }
        }
        return result
    }
}

/// Text with bold and italic ranges that stay on their characters while
/// delimiters are removed and whitespace is trimmed.
struct MarkedText: Equatable {
    var text: String
    var marks: [BookImportMark] = []

    /// Leading and trailing whitespace go, as `BookImportParser.trim`.
    func trimmed() -> MarkedText {
        let units = text as NSString
        var start = 0, end = units.length
        let blank = CharacterSet.whitespacesAndNewlines
        while start < end, let scalar = UnicodeScalar(units.character(at: start)), blank.contains(scalar) { start += 1 }
        while end > start, let scalar = UnicodeScalar(units.character(at: end - 1)), blank.contains(scalar) { end -= 1 }
        return sliced(start, end)
    }

    /// The UTF-16 range `start..<end`, with marks clipped to it.
    func sliced(_ start: Int, _ end: Int) -> MarkedText {
        let marks = self.marks.compactMap { mark -> BookImportMark? in
            let from = max(mark.location, start), to = min(mark.location + mark.length, end)
            return from < to ? BookImportMark(kind: mark.kind, location: from - start, length: to - from) : nil
        }
        return MarkedText(text: (text as NSString).substring(with: NSRange(location: start, length: end - start)), marks: marks)
    }

    /// Parsing runs every pattern on every line; each compiles once.
    private static let lock = NSLock()
    private static var expressions: [String: NSRegularExpression] = [:]
    private static func expression(_ pattern: String) -> NSRegularExpression? {
        lock.lock(); defer { lock.unlock() }
        if let expression = expressions[pattern] { return expression }
        let expression = try? NSRegularExpression(pattern: pattern)
        expressions[pattern] = expression
        return expression
    }

    mutating func append(_ other: MarkedText) {
        let offset = (text as NSString).length
        text += other.text
        marks += other.marks.map { BookImportMark(kind: $0.kind, location: $0.location + offset, length: $0.length) }
    }

    func prefixed(_ prefix: String) -> MarkedText {
        var result = MarkedText(text: prefix)
        result.append(self)
        return result
    }

    /// Replaces every match by the concatenation of the capture groups in
    /// `keep` (in order); everything else in the match is removed. Existing
    /// marks move with their text; `marking` marks one kept group.
    mutating func replace(_ pattern: String, keep: [Int], marking: (group: Int, kinds: [BookImportMark.Kind])? = nil) {
        guard let expression = Self.expression(pattern) else { return }
        let source = text as NSString
        let matches = expression.matches(in: text, range: NSRange(location: 0, length: source.length))
        guard !matches.isEmpty else { return }
        let output = NSMutableString()
        var removed: [NSRange] = []
        var added: [BookImportMark] = []
        var cursor = 0
        for match in matches {
            output.append(source.substring(with: NSRange(location: cursor, length: match.range.location - cursor)))
            var position = match.range.location
            for group in keep {
                let range = match.range(at: group)
                guard range.location != NSNotFound else { continue }
                if range.location > position { removed.append(NSRange(location: position, length: range.location - position)) }
                if let marking, marking.group == group, range.length > 0 {
                    added += marking.kinds.map { BookImportMark(kind: $0, location: output.length, length: range.length) }
                }
                output.append(source.substring(with: range))
                position = NSMaxRange(range)
            }
            if NSMaxRange(match.range) > position {
                removed.append(NSRange(location: position, length: NSMaxRange(match.range) - position))
            }
            cursor = NSMaxRange(match.range)
        }
        output.append(source.substring(from: cursor))
        // An offset moves back by the removed units before it.
        func moved(_ offset: Int) -> Int {
            offset - removed.reduce(0) { sum, range in sum + max(0, min(offset, NSMaxRange(range)) - range.location) }
        }
        marks = marks.compactMap { mark in
            let from = moved(mark.location), to = moved(mark.location + mark.length)
            return from < to ? BookImportMark(kind: mark.kind, location: from, length: to - from) : nil
        } + added
        text = output as String
    }
}

/// One imported block: Rust writes each as one paragraph, applies its bold
/// and italic marks and then the heading level (1–3; deeper levels become 3).
struct BookImportBlock: Equatable {
    enum Kind: String { case paragraph, heading }
    let kind: Kind
    let level: Int?
    let text: String
    var marks: [BookImportMark] = []

    static func paragraph(_ text: String, marks: [BookImportMark] = []) -> BookImportBlock {
        BookImportBlock(kind: .paragraph, level: nil, text: text, marks: BookImportMark.normalized(marks, length: (text as NSString).length))
    }
    static func heading(_ text: String, level: Int, marks: [BookImportMark] = []) -> BookImportBlock {
        BookImportBlock(kind: .heading, level: min(max(level, 1), 3), text: text,
                        marks: BookImportMark.normalized(marks, length: (text as NSString).length))
    }
    static func paragraph(_ text: MarkedText) -> BookImportBlock { paragraph(text.text, marks: text.marks) }
    static func heading(_ text: MarkedText, level: Int) -> BookImportBlock { heading(text.text, level: level, marks: text.marks) }

    var payload: [String: Any] {
        var payload: [String: Any] = ["kind": kind.rawValue, "text": text]
        if let level { payload["level"] = level }
        if !marks.isEmpty { payload["marks"] = marks.map(\.payload) }
        return payload
    }
}

/// A parsed source file: the guessed title and its blocks.
struct BookImportDocument: Equatable {
    enum Format: String { case markdown, text, docx }
    let format: Format
    let fileName: String
    let title: String
    let blocks: [BookImportBlock]

    var formatName: String {
        switch format {
        case .markdown: return "Markdown"
        case .text: return "纯文本"
        case .docx: return "Word 文档"
        }
    }
}

/// Where an import lands: a new chapter, a new drift, or a new element in a
/// category.
enum BookImportTarget: Equatable {
    case chapter
    case drift
    case element(categoryID: String)

    var kind: String {
        switch self {
        case .chapter: return "chapter"
        case .drift: return "drift"
        case .element: return "element"
        }
    }
    var label: String {
        switch self {
        case .chapter: return "章节"
        case .drift: return "漂流"
        case .element: return "设定"
        }
    }
    func payload(title: String) -> [String: Any] {
        var payload: [String: Any] = ["kind": kind, "title": title]
        if case .element(let categoryID) = self { payload["categoryId"] = categoryID }
        return payload
    }
}

/// The entity an import created, already holding the imported body.
enum WorkspaceImportedEntity: Decodable {
    case chapter(WorkspaceChapter)
    case drift(WorkspaceDrift)
    case element(WorkspaceElement)

    private enum CodingKeys: String, CodingKey { case kind, entity }
    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        switch try values.decode(String.self, forKey: .kind) {
        case "chapter": self = .chapter(try values.decode(WorkspaceChapter.self, forKey: .entity))
        case "drift": self = .drift(try values.decode(WorkspaceDrift.self, forKey: .entity))
        case "element": self = .element(try values.decode(WorkspaceElement.self, forKey: .entity))
        case let kind:
            throw DecodingError.dataCorruptedError(forKey: .kind, in: values, debugDescription: "Unknown import kind \(kind)")
        }
    }

    var id: String {
        switch self {
        case .chapter(let chapter): return chapter.id
        case .drift(let drift): return drift.id
        case .element(let element): return element.id
        }
    }
    var title: String {
        switch self {
        case .chapter(let chapter): return chapter.title
        case .drift(let drift): return drift.title
        case .element(let element): return element.name
        }
    }
}

enum BookExportFormat: String, CaseIterable {
    case markdown, text

    var fileExtension: String { self == .markdown ? "md" : "txt" }
    var label: String { self == .markdown ? "Markdown (.md)" : "纯文本 (.txt)" }
}

/// Markdown and plain-text sources become blocks line by line. Markdown
/// bold and italic become marks; other inline marks reduce to their text.
enum BookImportParser {
    static let titleLimit = 80

    static func stem(_ fileName: String) -> String {
        let stem = (fileName as NSString).deletingPathExtension.trimmingCharacters(in: .whitespacesAndNewlines)
        return stem.isEmpty ? fileName : stem
    }

    /// UTF-8 (with or without a BOM), UTF-16 with a BOM, then GB 18030 for
    /// older Chinese text files.
    static func decode(_ data: Data) -> String? {
        if data.starts(with: [0xEF, 0xBB, 0xBF]) { return String(data: data.dropFirst(3), encoding: .utf8) }
        if data.starts(with: [0xFF, 0xFE]) || data.starts(with: [0xFE, 0xFF]) { return String(data: data, encoding: .utf16) }
        if let text = String(data: data, encoding: .utf8) { return text }
        let gb18030 = CFStringConvertEncodingToNSStringEncoding(CFStringEncoding(CFStringEncodings.GB_18030_2000.rawValue))
        return String(data: data, encoding: String.Encoding(rawValue: gb18030))
    }

    static func read(_ url: URL) throws -> BookImportDocument {
        let data: Data
        do { data = try Data(contentsOf: url) } catch {
            throw LabError.message("无法读取“\(url.lastPathComponent)”，文件可能已被移动或没有读取权限。")
        }
        guard let text = decode(data) else {
            throw LabError.message("无法识别“\(url.lastPathComponent)”的文字编码，请另存为 UTF-8 后再导入。")
        }
        switch url.pathExtension.lowercased() {
        case "md", "markdown", "mdown", "mkd": return markdown(text, fileName: url.lastPathComponent)
        default: return plainText(text, fileName: url.lastPathComponent)
        }
    }

    // MARK: Plain text

    /// Paragraphs are separated by blank lines, and lines inside one are
    /// joined. A file without any blank line keeps one paragraph per line,
    /// as Chinese manuscripts usually are.
    static func plainText(_ raw: String, fileName: String) -> BookImportDocument {
        let lines = normalizedLines(raw)
        // Only blank lines between text separate paragraphs; a trailing
        // newline does not.
        let first = lines.firstIndex { !isBlank($0) }, last = lines.lastIndex { !isBlank($0) }
        let hasBlankLine = first.flatMap { first in last.map { lines[first...$0].contains(where: isBlank) } } ?? false
        var blocks: [BookImportBlock] = []
        if hasBlankLine {
            var current: [String] = []
            for line in lines + [""] {
                if isBlank(line) {
                    let text = trim(joinLines(current))
                    if !text.isEmpty { blocks.append(.paragraph(text)) }
                    current = []
                } else { current.append(line) }
            }
        } else {
            blocks = lines.map(trim).filter { !$0.isEmpty }.map { .paragraph($0) }
        }
        let firstLine = lines.map(trim).first { !$0.isEmpty }
        let title = firstLine.map { String($0.prefix(titleLimit)) } ?? stem(fileName)
        return BookImportDocument(format: .text, fileName: fileName, title: title, blocks: blocks)
    }

    // MARK: Markdown

    /// `#` to `###` become heading levels 1–3 (deeper levels 3), setext
    /// underlines their levels, list items paragraphs that keep their marker,
    /// block quotes and fenced code their text. Front matter, rules and
    /// link definitions are dropped.
    static func markdown(_ raw: String, fileName: String) -> BookImportDocument {
        var lines = normalizedLines(raw)
        // YAML front matter at the very top.
        if lines.first?.trimmingCharacters(in: .whitespaces) == "---",
           let end = lines.dropFirst().prefix(200).firstIndex(where: { $0.trimmingCharacters(in: .whitespaces) == "---" }) {
            lines.removeSubrange(0...end)
        }
        var blocks: [BookImportBlock] = []
        var paragraph: [String] = []
        var firstHeading: String?
        var fence: String?
        func flush() {
            let text = joinLines(paragraph.map(inline)).trimmed()
            if !text.text.isEmpty { blocks.append(.paragraph(text)) }
            paragraph = []
        }
        for line in lines {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if let marker = fence {
                if trimmed.hasPrefix(marker) { fence = nil; continue }
                let text = trim(line)
                if !text.isEmpty { blocks.append(.paragraph(text)) }
                continue
            }
            if trimmed.hasPrefix("```") || trimmed.hasPrefix("~~~") {
                flush(); fence = String(trimmed.prefix(3)); continue
            }
            if trimmed.isEmpty { flush(); continue }
            // Setext: a single paragraph line underlined by === or ---.
            if paragraph.count == 1, !trimmed.isEmpty, trimmed.allSatisfy({ $0 == "=" }) || (trimmed.count >= 2 && trimmed.allSatisfy({ $0 == "-" })) {
                let text = inline(paragraph[0]).trimmed()
                paragraph = []
                if !text.text.isEmpty {
                    let level = trimmed.hasPrefix("=") ? 1 : 2
                    if level == 1, firstHeading == nil { firstHeading = text.text }
                    blocks.append(.heading(text, level: level))
                }
                continue
            }
            if let heading = match(#"^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$"#, trimmed) ?? match(#"^\s{0,3}(#{1,6})$"#, trimmed) {
                flush()
                let text = inline(heading.count > 2 ? heading[2] : "").trimmed()
                guard !text.text.isEmpty else { continue }
                if heading[1].count == 1, firstHeading == nil { firstHeading = text.text }
                blocks.append(.heading(text, level: heading[1].count))
                continue
            }
            if match(#"^\s{0,3}([-*_])(\s*\1){2,}\s*$"#, line) != nil { flush(); continue }
            if match(#"^\s{0,3}\[[^\]]+\]:\s*\S+"#, line) != nil { flush(); continue }
            if let item = match(#"^\s*([-*+]|\d{1,9}[.)])\s+(.*)$"#, line) {
                flush()
                let marker = item[1].first.map { "-*+".contains($0) } == true ? "-" : item[1]
                let text = inline(item[2]).trimmed()
                if !text.text.isEmpty { blocks.append(.paragraph(text.prefixed("\(marker) "))) }
                continue
            }
            if let quote = match(#"^\s{0,3}>\s?(.*)$"#, line) {
                // Nested markers and an empty quoted line end the paragraph.
                var text = quote[1]
                while let inner = match(#"^\s{0,3}>\s?(.*)$"#, text) { text = inner[1] }
                if trim(text).isEmpty { flush() } else { paragraph.append(text) }
                continue
            }
            paragraph.append(line)
        }
        flush()
        let fallback = lines.map { trim(stripInline($0.replacingOccurrences(of: #"^\s*#+\s*"#, with: "", options: .regularExpression))) }
            .first { !$0.isEmpty }
        let title = (firstHeading ?? fallback).map { String($0.prefix(titleLimit)) } ?? stem(fileName)
        return BookImportDocument(format: .markdown, fileName: fileName, title: title, blocks: blocks)
    }

    /// The text of one line without its inline syntax.
    static func stripInline(_ text: String) -> String { inline(text).text }

    /// Characters a backslash escapes, and the private-use stand-ins that
    /// keep escaped and code characters out of the emphasis passes.
    private static let literals = Array("\\`*_{}[]()#+-.!>~|<")
    private static let escapable = Set("\\`*_{}[]()#+-.!>~|")
    private static func standIn(_ character: Character) -> String? {
        literals.firstIndex(of: character).map { String(UnicodeScalar(0xE000 + UInt32($0))!) }
    }

    /// One line of inline Markdown. Bold (`**`, `__`) and italic (`*`, `_`),
    /// nested or combined (`***`), become marks on their text; images keep
    /// their alt text, links their text and autolinks their address; code,
    /// strike, HTML tags and backslash escapes reduce to their text.
    static func inline(_ line: String) -> MarkedText {
        var value = MarkedText(text: line)
        let protects = !line.unicodeScalars.contains { (0xE000..<0xE000 + UInt32(literals.count)).contains($0.value) }
        if protects {
            // Escaped characters and code spans stay literal: each becomes a
            // stand-in of one UTF-16 unit, so no mark moves.
            let characters = Array(line)
            var escaped = "", index = 0
            while index < characters.count {
                if characters[index] == "\\", index + 1 < characters.count, escapable.contains(characters[index + 1]),
                   let standIn = standIn(characters[index + 1]) {
                    escaped += standIn; index += 2
                } else {
                    escaped.append(characters[index]); index += 1
                }
            }
            value.text = escaped
            if let code = try? NSRegularExpression(pattern: #"`([^`]*)`"#) {
                let source = value.text as NSString
                let output = NSMutableString(string: source)
                for match in code.matches(in: value.text, range: NSRange(location: 0, length: source.length)) {
                    let inner = match.range(at: 1)
                    output.replaceCharacters(in: inner, with: source.substring(with: inner).map { standIn($0) ?? String($0) }.joined())
                }
                value.text = output as String
            }
        }
        value.replace(#"`([^`]*)`"#, keep: [1])
        value.replace(#"!\[([^\]]*)\]\([^)]*\)"#, keep: [1])
        value.replace(#"\[([^\]]+)\]\([^)]*\)"#, keep: [1])
        value.replace(#"\[([^\]]+)\]\[[^\]]*\]"#, keep: [1])
        value.replace(#"<((?:https?|mailto):[^>\s]+)>"#, keep: [1])
        value.replace(#"<\/?[A-Za-z][^>]*>"#, keep: [])
        value.replace(#"(\*\*\*|___)(.+?)\1"#, keep: [2], marking: (2, [.bold, .italic]))
        value.replace(#"(\*\*|__)(.+?)\1"#, keep: [2], marking: (2, [.bold]))
        value.replace(#"~~(.+?)~~"#, keep: [1])
        value.replace(#"\*(\S(?:.*?\S)?)\*"#, keep: [1], marking: (1, [.italic]))
        value.replace(#"(^|[^\p{L}\p{N}_])_(\S(?:.*?\S)?)_(?=$|[^\p{L}\p{N}_])"#, keep: [1, 2], marking: (2, [.italic]))
        if !protects {
            value.replace(#"\\([\\`*_{}\[\]()#+\-.!>~|])"#, keep: [1])
        } else {
            // Stand-ins back to their characters: one unit for one unit.
            value.text = String(value.text.map { character -> Character in
                guard let scalar = character.unicodeScalars.first, character.unicodeScalars.count == 1,
                      scalar.value >= 0xE000, scalar.value < 0xE000 + UInt32(literals.count) else { return character }
                return literals[Int(scalar.value - 0xE000)]
            })
        }
        value.marks = BookImportMark.normalized(value.marks, length: (value.text as NSString).length)
        return value
    }

    // MARK: Helpers

    private static func normalizedLines(_ raw: String) -> [String] {
        raw.replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\r", with: "\n")
            .replacingOccurrences(of: "\u{2029}", with: "\n").replacingOccurrences(of: "\u{2028}", with: "\n")
            .components(separatedBy: "\n")
    }

    private static func isBlank(_ line: String) -> Bool { trim(line).isEmpty }

    /// Also trims the full-width indentation of Chinese manuscripts.
    static func trim(_ text: String) -> String { text.trimmingCharacters(in: .whitespacesAndNewlines) }

    /// Soft-wrapped lines join without a space between CJK characters and
    /// with one space otherwise.
    static func joinLines(_ lines: [String]) -> String { joinLines(lines.map { MarkedText(text: $0) }).text }

    static func joinLines(_ lines: [MarkedText]) -> MarkedText {
        var result = MarkedText(text: "")
        for line in lines.map({ $0.trimmed() }) where !line.text.isEmpty {
            if let last = result.text.unicodeScalars.last, let first = line.text.unicodeScalars.first,
               !(isWide(last) && isWide(first)) {
                result.text += " "
            }
            result.append(line)
        }
        return result
    }

    private static func isWide(_ scalar: Unicode.Scalar) -> Bool {
        switch scalar.value {
        case 0x2E80...0x9FFF, 0xAC00...0xD7AF, 0xF900...0xFAFF, 0xFE30...0xFE4F, 0xFF00...0xFFEF, 0x20000...0x3FFFF: return true
        default: return false
        }
    }

    /// Capture groups of the first match, or nil.
    private static func match(_ pattern: String, _ text: String) -> [String]? {
        guard let expression = try? NSRegularExpression(pattern: pattern),
              let result = expression.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)) else { return nil }
        return (0..<result.numberOfRanges).map { index in
            Range(result.range(at: index), in: text).map { String(text[$0]) } ?? ""
        }
    }
}
