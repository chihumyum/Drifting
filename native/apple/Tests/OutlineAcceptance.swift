import AppKit

extension BindingAcceptance {
    static func outlineAcceptance() throws -> [String] {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let core = LabCore(directory: directory.appendingPathComponent("apple-native-lab"))
        var opened: Result<LabState, Error>?
        core.open { opened = $0 }; try wait { opened != nil }; _ = try opened!.get()
        let view = NativeDocumentView(core: core), passive = NativeDocumentView(core: core)
        view.binding.load(); passive.binding.load()
        try wait { view.binding.state != nil && !view.binding.hasPendingWork }
        let original = try read(core).projection
        let paragraph = original.blocks.first { $0.id == "fixture-paragraph" }!
        view.binding.format(.heading2, range: NSRange(location: paragraph.range.location, length: 0))
        try wait { !view.binding.hasPendingWork }
        let firstOutline = try read(core).projection.outline
        try require(firstOutline.map(\.blockId) == ["fixture-heading", "fixture-paragraph"], "Outline missed authoritative headings")
        try require(firstOutline[1].parentId == "fixture-heading" && firstOutline[1].label.hasPrefix("拍 · "), "Outline lost scene/beat semantics")
        view.textView.insertText("前言 👩🏽‍🚀 ", replacementRange: NSRange(location: 0, length: 0))
        try wait { !view.binding.hasPendingWork }
        passive.textView.setSelectedRange(NSRange(location: 2, length: 0))
        try wait { passive.binding.selectionIsAnchored }
        let before = try read(core).projection
        let target = before.outline.first { $0.blockId == "fixture-paragraph" }!
        try require(target.range.location > firstOutline[1].range.location, "Prefix input did not shift the heading range")
        try require(view.reveal(blockId: target.blockId), "Current heading could not be revealed")
        try wait { view.binding.selectionIsAnchored }
        try require(view.textView.selectedRange() == NSRange(location: target.range.location, length: 0), "Navigation used a stale offset")
        try require(passive.textView.selectedRange() == NSRange(location: 2, length: 0), "Navigation moved another view")
        let after = try read(core).projection
        try require(after.revision == before.revision && after.text == before.text && after.canUndo == before.canUndo, "Navigation authored prose or history")
        try require(!view.reveal(blockId: "missing-synthetic-heading"), "Missing heading was navigable")
        view.undoProse(); try wait { !view.binding.hasPendingWork }
        try require(try read(core).projection.text == original.text, "Navigation added an undo unit")
        opened = nil; core.reopen { opened = $0 }; try wait { opened != nil }; _ = try opened!.get()
        view.binding.load(); try wait { !view.binding.hasPendingWork }
        try require(view.reveal(blockId: "fixture-paragraph"), "Reopened heading could not be revealed")
        try require(view.textView.selectedRange().location == paragraph.range.location, "Reopen did not refresh navigation ranges")
        view.textView.setMarkedText("zhong", selectedRange: NSRange(location: 5, length: 0), replacementRange: NSRange(location: 0, length: 0))
        try require(!view.reveal(blockId: "fixture-heading") && !passive.reveal(blockId: "fixture-paragraph"), "Navigation disturbed composition")
        view.textView.insertText("", replacementRange: NSRange(location: NSNotFound, length: 0))
        try wait { !view.binding.hasPendingWork }
        return ["AppKit outline resolves current heading identity without moving passive views or authoring history",
            "AppKit outline survives prefix edits history and reopening while guarding marked input"]
    }
}
