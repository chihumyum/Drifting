import Foundation
#if os(macOS)
import AppKit
private typealias PlatformFont = NSFont
private typealias PlatformColor = NSColor
#else
import UIKit
private typealias PlatformFont = UIFont
private typealias PlatformColor = UIColor
#endif

enum DocumentStyle {
    enum Update: Equatable {
        case unchanged
        case block(Int)
        case full
    }

    /// Only a TextKit edit already present in storage may reuse shifted styles.
    /// Structural edits and replacement of the entire string keep the full path.
    @discardableResult
    static func update(_ projection: NativeProjection, previous: NativeProjection?,
                       localChange: NativeTextChange?, to storage: NSTextStorage) -> Update {
        if let previous {
            if NativeText.identical(previous.text, projection.text) && sameDisplay(previous, projection) { return .unchanged }
            if let localChange, let index = localBlock(previous, projection, change: localChange) {
                let block = projection.blocks[index]
                let end = NSMaxRange(block.range.nsRange)
                // The separator has the default font/color, even after a heading.
                let separator = end < storage.length && (projection.text as NSString).character(at: end) == 10 ? 1 : 0
                let range = NSRange(location: block.range.location, length: block.range.length + separator)
                apply(projection, to: storage, range: range, blocks: [block])
                return .block(index)
            }
        }
        apply(projection, to: storage)
        return .full
    }

    static func apply(_ projection: NativeProjection, to storage: NSTextStorage) {
        apply(projection, to: storage, range: NSRange(location: 0, length: storage.length), blocks: projection.blocks)
    }

    private static func apply(_ projection: NativeProjection, to storage: NSTextStorage,
                              range: NSRange, blocks: [NativeBlock]) {
        storage.beginEditing()
        storage.setAttributes([.font: PlatformFont.systemFont(ofSize: 17), .foregroundColor: PlatformColor.labelColorForDocument], range: range)
        for block in blocks {
            let paragraph = NSMutableParagraphStyle()
            paragraph.lineSpacing = 6; paragraph.paragraphSpacing = 12
            paragraph.headIndent = CGFloat(block.depth) * 12
            paragraph.firstLineHeadIndent = paragraph.headIndent
            var base: [NSAttributedString.Key: Any] = [.paragraphStyle: paragraph]
            if block.kind == "heading" { base[.font] = PlatformFont.systemFont(ofSize: 24, weight: .semibold) }
            if block.kind == "codeBlock" { base[.font] = PlatformFont.monospacedSystemFont(ofSize: 15, weight: .regular) }
            if !block.editable { base[.foregroundColor] = PlatformColor.secondaryLabelColorForDocument }
            storage.addAttributes(base, range: block.range.nsRange)
            for run in block.runs {
                var attrs: [NSAttributedString.Key: Any] = [:]
                let size: CGFloat = block.kind == "heading" ? 24 : 17
                var font = PlatformFont.systemFont(ofSize: size, weight: run.attributes.bold ? .bold : .regular)
                if run.attributes.italic {
                    #if os(macOS)
                    font = NSFontManager.shared.convert(font, toHaveTrait: .italicFontMask)
                    #else
                    if let descriptor = font.fontDescriptor.withSymbolicTraits(font.fontDescriptor.symbolicTraits.union(.traitItalic)) {
                        font = UIFont(descriptor: descriptor, size: size)
                    }
                    #endif
                }
                if run.attributes.bold || run.attributes.italic { attrs[.font] = font }
                if run.attributes.strike { attrs[.strikethroughStyle] = NSUnderlineStyle.single.rawValue }
                if run.attributes.entityLink {
                    attrs[.foregroundColor] = PlatformColor.systemBlue
                    attrs[.underlineStyle] = NSUnderlineStyle.single.rawValue
                }
                storage.addAttributes(attrs, range: run.range.nsRange)
            }
        }
        for comment in projection.comments {
            for highlight in comment.ranges where highlight.location >= 0 && highlight.length > 0
                && highlight.location <= storage.length && highlight.length <= storage.length - highlight.location {
                let intersection = NSIntersectionRange(highlight.nsRange, range)
                if intersection.length > 0 {
                    storage.addAttribute(.backgroundColor, value: PlatformColor.systemYellow.withAlphaComponent(0.22), range: intersection)
                }
            }
        }
        storage.endEditing()
    }

    private static func sameMarks(_ left: NativeMarks, _ right: NativeMarks) -> Bool {
        left.bold == right.bold && left.italic == right.italic
            && left.entityLink == right.entityLink && left.strike == right.strike
    }

    private static func sameBlock(_ left: NativeBlock, _ right: NativeBlock) -> Bool {
        left.id == right.id && left.kind == right.kind && left.depth == right.depth
            && left.container == right.container && left.editable == right.editable
            && left.structuralAttributes == right.structuralAttributes
    }

    private static func sameRuns(_ left: [NativeRun], _ right: [NativeRun], offset: Int = 0) -> Bool {
        left.count == right.count && zip(left, right).allSatisfy { old, new in
            old.range.location + offset == new.range.location && old.range.length == new.range.length
                && sameMarks(old.attributes, new.attributes)
        }
    }

    private static func sameComments(_ left: [NativeComment], _ right: [NativeComment], change: NativeTextChange? = nil) -> Bool {
        left.count == right.count && zip(left, right).allSatisfy { old, new in
            old.ranges.count == new.ranges.count && zip(old.ranges, new.ranges).allSatisfy { before, after in
                (change?.mapSelection(before.nsRange) ?? before.nsRange) == after.nsRange
            }
        }
    }

    private static func sameDisplay(_ left: NativeProjection, _ right: NativeProjection) -> Bool {
        left.blocks.count == right.blocks.count && zip(left.blocks, right.blocks).allSatisfy { old, new in
            sameBlock(old, new) && old.range.nsRange == new.range.nsRange && sameRuns(old.runs, new.runs)
        } && sameComments(left.comments, right.comments)
    }

    private static func localBlock(_ before: NativeProjection, _ after: NativeProjection, change: NativeTextChange) -> Int? {
        let oldText = before.text as NSString
        guard change.range.location >= 0, change.range.length >= 0,
              change.range.location <= oldText.length, change.range.length <= oldText.length - change.range.location,
              NativeText.identical(change.target, after.text),
              NativeText.identical(oldText.replacingCharacters(in: change.range, with: change.text), after.text),
              !change.text.contains(where: isSeparator),
              !oldText.substring(with: change.range).contains(where: isSeparator),
              before.blocks.count == after.blocks.count,
              let index = NativeLayout.index(change.range.location, blocks: before.blocks),
              NativeLayout.index(NSMaxRange(change.range), blocks: before.blocks) == index,
              before.blocks[index].editable, before.blocks[index].range.length > 0,
              after.blocks[index].range.length > 0,
              sameComments(before.comments, after.comments, change: change) else { return nil }
        let delta = (change.text as NSString).length - change.range.length
        for at in before.blocks.indices {
            let old = before.blocks[at], new = after.blocks[at]
            let offset = at > index ? delta : 0
            guard sameBlock(old, new), old.range.location + offset == new.range.location,
                  old.range.length + (at == index ? delta : 0) == new.range.length,
                  at == index || sameRuns(old.runs, new.runs, offset: offset) else { return nil }
        }
        return index
    }

    private static func isSeparator(_ character: Character) -> Bool {
        character == "\n" || character == "\r" || character == "\r\n" || character == "\u{2028}" || character == "\u{2029}"
    }
}

private extension PlatformColor {
    static var labelColorForDocument: PlatformColor {
        #if os(macOS)
        return .labelColor
        #else
        return .label
        #endif
    }
    static var secondaryLabelColorForDocument: PlatformColor {
        #if os(macOS)
        return .secondaryLabelColor
        #else
        return .secondaryLabel
        #endif
    }
}
