import Foundation

/// One imported block: Rust writes each as one paragraph and applies the
/// heading level (1–3; deeper levels become 3).
struct BookImportBlock: Equatable {
    enum Kind: String { case paragraph, heading }
    let kind: Kind
    let level: Int?
    let text: String

    static func paragraph(_ text: String) -> BookImportBlock { BookImportBlock(kind: .paragraph, level: nil, text: text) }
    static func heading(_ text: String, level: Int) -> BookImportBlock {
        BookImportBlock(kind: .heading, level: min(max(level, 1), 3), text: text)
    }

    var payload: [String: Any] {
        var payload: [String: Any] = ["kind": kind.rawValue, "text": text]
        if let level { payload["level"] = level }
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

/// Markdown and plain-text sources become blocks line by line. Inline marks
/// are dropped: the body keeps text and heading levels only.
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
            let text = trim(joinLines(paragraph.map(stripInline)))
            if !text.isEmpty { blocks.append(.paragraph(text)) }
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
                let text = trim(stripInline(paragraph[0]))
                paragraph = []
                if !text.isEmpty {
                    let level = trimmed.hasPrefix("=") ? 1 : 2
                    if level == 1, firstHeading == nil { firstHeading = text }
                    blocks.append(.heading(text, level: level))
                }
                continue
            }
            if let heading = match(#"^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$"#, trimmed) ?? match(#"^\s{0,3}(#{1,6})$"#, trimmed) {
                flush()
                let text = trim(stripInline(heading.count > 2 ? heading[2] : ""))
                guard !text.isEmpty else { continue }
                if heading[1].count == 1, firstHeading == nil { firstHeading = text }
                blocks.append(.heading(text, level: heading[1].count))
                continue
            }
            if match(#"^\s{0,3}([-*_])(\s*\1){2,}\s*$"#, line) != nil { flush(); continue }
            if match(#"^\s{0,3}\[[^\]]+\]:\s*\S+"#, line) != nil { flush(); continue }
            if let item = match(#"^\s*([-*+]|\d{1,9}[.)])\s+(.*)$"#, line) {
                flush()
                let marker = item[1].first.map { "-*+".contains($0) } == true ? "-" : item[1]
                let text = trim(stripInline(item[2]))
                if !text.isEmpty { blocks.append(.paragraph("\(marker) \(text)")) }
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

    /// Images keep their alt text, links their text, autolinks their
    /// address; emphasis, strike and code marks and backslash escapes go.
    static func stripInline(_ text: String) -> String {
        var value = text
        let replacements: [(String, String)] = [
            (#"`([^`]*)`"#, "$1"),
            (#"!\[([^\]]*)\]\([^)]*\)"#, "$1"),
            (#"\[([^\]]+)\]\([^)]*\)"#, "$1"),
            (#"\[([^\]]+)\]\[[^\]]*\]"#, "$1"),
            (#"<((?:https?|mailto):[^>\s]+)>"#, "$1"),
            (#"<\/?[A-Za-z][^>]*>"#, ""),
            (#"(\*\*\*|___)(.+?)\1"#, "$2"),
            (#"(\*\*|__)(.+?)\1"#, "$2"),
            (#"~~(.+?)~~"#, "$1"),
            (#"\*(\S(?:.*?\S)?)\*"#, "$1"),
            (#"(^|[^\p{L}\p{N}_])_(\S(?:.*?\S)?)_(?=$|[^\p{L}\p{N}_])"#, "$1$2"),
            (#"\\([\\`*_{}\[\]()#+\-.!>~|])"#, "$1"),
        ]
        for (pattern, template) in replacements {
            value = value.replacingOccurrences(of: pattern, with: template, options: .regularExpression)
        }
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
    static func joinLines(_ lines: [String]) -> String {
        var result = ""
        for line in lines.map(trim) where !line.isEmpty {
            if let last = result.unicodeScalars.last, let first = line.unicodeScalars.first,
               !(isWide(last) && isWide(first)) {
                result += " "
            }
            result += line
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
