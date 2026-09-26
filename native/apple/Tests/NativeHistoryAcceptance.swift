import AppKit

extension BindingAcceptance {
    /// Calls native responder selectors and validates menu items without
    /// synthesizing global key events or claiming a physical keyboard session.
    static func nativeHistoryAcceptance() throws -> [String] {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let core = LabCore(directory: directory.appendingPathComponent("apple-native-lab"))
        var opened: Result<LabState, Error>?
        core.open { opened = $0 }; try wait { opened != nil }; _ = try opened!.get()
        let view = NativeDocumentView(core: core), other = NativeDocumentView(core: core)
        view.binding.load(); other.binding.load()
        try wait { view.binding.state != nil && !view.binding.hasPendingWork }
        let original = try read(core).projection.text
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 500, height: 500),
            styleMask: [.titled], backing: .buffered, defer: false)
        window.contentView = view
        try require(window.makeFirstResponder(view.textView), "Text view could not become the native responder")
        let undo = NSMenuItem(title: "撤销", action: #selector(ProseTextView.undo(_:)), keyEquivalent: "z")
        let redo = NSMenuItem(title: "重做", action: #selector(ProseTextView.redo(_:)), keyEquivalent: "z")
        redo.keyEquivalentModifierMask = [.command, .shift]
        let menu = NSMenu(title: "编辑")
        undo.target = view.textView; redo.target = view.textView
        menu.addItem(undo); menu.addItem(redo); menu.update()
        try require(!undo.isEnabled && !redo.isEnabled, "Native menu enabled empty history")
        try require(!view.textView.validateUserInterfaceItem(undo), "Empty history enabled native undo")
        try require(!view.textView.validateUserInterfaceItem(redo), "Empty history enabled native redo")
        view.textView.insertText("灯", replacementRange: NSRange(location: 0, length: 0))
        try require(!view.textView.validateUserInterfaceItem(undo), "Pending save enabled native undo")
        try wait { !view.binding.hasPendingWork }
        try require(view.textView.validateUserInterfaceItem(undo), "Shared history did not enable the native undo menu")
        menu.update()
        try require(undo.isEnabled && !redo.isEnabled, "NSMenu update did not use CRDT history availability")
        try require(window.firstResponder?.tryToPerform(undo.action!, with: undo) == true,
            "Standard undo action did not resolve through the text responder")
        // A second command arriving before the first reply cannot undo again.
        _ = window.firstResponder?.tryToPerform(undo.action!, with: undo)
        try wait { !view.binding.hasPendingWork }
        try require(try read(core).projection.text == original && other.textView.string == original,
            "Native responder undo did not update the shared document")
        try require(!view.textView.validateUserInterfaceItem(undo) && view.textView.validateUserInterfaceItem(redo),
            "Menu availability did not follow shared undo history")
        menu.update()
        try require(!undo.isEnabled && redo.isEnabled, "NSMenu update did not follow the undo reply")
        try require(NSApp.sendAction(redo.action!, to: view.textView, from: redo), "Redo action dispatch failed")
        try wait { !view.binding.hasPendingWork }
        try require(try read(core).projection.text == "灯" + original && other.textView.string == "灯" + original,
            "Native menu redo did not restore the shared document")

        let revision = try read(core).projection.revision
        view.textView.setMarkedText("zhong", selectedRange: NSRange(location: 5, length: 0),
            replacementRange: NSRange(location: 0, length: 0))
        let marked = view.textView.string
        try require(!view.textView.validateUserInterfaceItem(undo) && !other.textView.validateUserInterfaceItem(undo),
            "Composition did not disable history across native views")
        menu.update()
        try require(!undo.isEnabled && !redo.isEnabled, "Native menu enabled history during marked input")
        _ = view.textView.tryToPerform(undo.action!, with: undo)
        _ = other.textView.tryToPerform(undo.action!, with: undo)
        try require(try read(core).projection.revision == revision && view.textView.string == marked,
            "Native history disturbed an active marked range")
        view.textView.insertText("", replacementRange: NSRange(location: NSNotFound, length: 0))
        try wait { !view.binding.hasPendingWork }
        try require(view.textView.validateUserInterfaceItem(undo), "Cancel did not restore native history availability")
        _ = other.textView.tryToPerform(undo.action!, with: undo)
        try wait { !view.binding.hasPendingWork }
        try require(view.textView.string == original && other.textView.string == original,
            "A second native responder did not use the same undo owner")

        let peer = LabCore(directory: directory.appendingPathComponent("peer/apple-native-lab"))
        opened = nil; peer.open { opened = $0 }; try wait { opened != nil }; _ = try opened!.get()
        let peerProjection = try read(peer).projection
        var remoteEdit: Result<LabDocumentState, Error>?
        peer.document("documentReplace", edit: ["revision": peerProjection.revision,
            "range": ["location": 0, "length": 0], "text": "远端"]) { remoteEdit = $0 }
        try wait { remoteEdit != nil }; _ = try remoteEdit!.get()
        var remote: Result<NativeCheckpoint, Error>?
        peer.exportDocument { remote = $0 }; try wait { remote != nil }
        let beforeSplit = try read(core).projection
        guard let paragraph = beforeSplit.blocks.first(where: { $0.id == "fixture-paragraph" }) else {
            throw LabError.message("Synthetic paragraph is missing")
        }
        let split = paragraph.range.location + 2
        let splitText = (original as NSString).replacingCharacters(in: NSRange(location: split, length: 0), with: "\n")
        let local = (splitText as NSString).replacingCharacters(in: NSRange(location: split + 1, length: 0), with: "续")
        // No main-run-loop yield: both TextKit edits use the visible pre-remote
        // range while the remote heading change is ahead of them in the queue.
        view.textView.setSelectedRange(NSRange(location: split, length: 0))
        view.binding.store.applyRemote(try remote!.get().update)
        view.textView.insertText("\n", replacementRange: NSRange(location: split, length: 0))
        view.textView.insertText("续", replacementRange: NSRange(location: split + 1, length: 0))
        try require(view.binding.canEdit && view.textView.string == local, "Pending structural merge blocked continued input")
        try wait { !view.binding.hasPendingWork }
        let merged = try read(core).projection
        try require(merged.text == "远端" + local && other.textView.string == merged.text,
            "Disjoint remote edit displaced a queued native split or its continued input")
        try require(view.textView.selectedRange() == NSRange(location: split + 4, length: 0),
            "Native split caret did not follow the remote heading prefix: got \(view.textView.selectedRange()), expected \(split + 4)")
        try require(merged.comments[0].quote == "北塔" && merged.comments[0].ranges[0].length == 2,
            "Disjoint split changed the comment's quoted identity")
        _ = view.textView.tryToPerform(undo.action!, with: undo); try wait { !view.binding.hasPendingWork }
        try require(view.textView.string == "远端" + splitText, "Continued-input undo also removed the native split or remote text")
        _ = view.textView.tryToPerform(undo.action!, with: undo); try wait { !view.binding.hasPendingWork }
        try require(view.textView.string == "远端" + original, "Split undo removed disjoint remote text")
        _ = view.textView.tryToPerform(redo.action!, with: redo); try wait { !view.binding.hasPendingWork }
        _ = view.textView.tryToPerform(redo.action!, with: redo); try wait { !view.binding.hasPendingWork }
        try require(view.textView.string == merged.text && other.textView.string == merged.text,
            "Native responder redo did not restore the merged split and continued input")
        try nativeQuoteHistoryAcceptance()
        return ["AppKit standard responder history and menu validation", "AppKit pending command and composition history guards",
            "AppKit second responder shares Rust history", "AppKit queued split and continued input preserve disjoint remote text through responder history",
            "AppKit safe quote join preserves native suffix editing, history and reopen"]
    }

    private static func nativeQuoteHistoryAcceptance() throws {
        struct Step: Decodable {
            struct Suffix: Decodable { let text: String; let attributes: [String: JSONValue] }
            let action: String; let updateBase64: String?; let suffix: Suffix
        }
        enum JSONValue: Decodable {
            case string(String), other
            init(from decoder: Decoder) throws {
                let value = try decoder.singleValueContainer()
                self = (try? value.decode(String.self)).map(JSONValue.string) ?? .other
            }
        }
        struct QuoteCase: Decodable { let updateBase64: String; let stages: [Step] }
        struct Oracle: Decodable { let cases: [QuoteCase] }
        let process = Process(), output = Pipe()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        process.arguments = ["pnpm", "exec", "tsx", "--conditions=import", "scripts/apple-quote-history-oracle.ts"]
        process.standardOutput = output
        try process.run()
        let bytes = output.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        try require(process.terminationStatus == 0, "Production quote history oracle failed")
        let oracle = try JSONDecoder().decode(Oracle.self, from: bytes).cases[0]
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let core = LabCore(directory: directory.appendingPathComponent("apple-native-lab"))
        var opened: Result<LabState, Error>?
        core.open { opened = $0 }; try wait { opened != nil }; _ = try opened!.get()
        let view = NativeDocumentView(core: core)
        view.binding.load(); try wait { view.binding.state != nil && !view.binding.hasPendingWork }
        view.binding.store.applyRemote(oracle.updateBase64)
        try wait { !view.binding.hasPendingWork }
        func block(_ id: String, _ projection: NativeProjection) throws -> NativeBlock {
            guard let value = projection.blocks.first(where: { $0.id == id }) else {
                throw LabError.message("Native quote block \(id) is missing")
            }
            return value
        }
        func contents(_ block: NativeBlock, _ projection: NativeProjection) -> String {
            (projection.text as NSString).substring(with: block.range.nsRange)
        }
        let initial = try read(core).projection
        let left = try block("b", initial), right = try block("c", initial)
        try require(NSMaxRange(left.range.nsRange) + 1 == right.range.location, "Synthetic quote boundary is not adjacent")
        let range = NSRange(location: NSMaxRange(left.range.nsRange), length: 1)
        view.textView.setSelectedRange(range)
        view.textView.insertText("", replacementRange: range)
        let optimistic = view.binding.store.projection!
        try require(try block("b", optimistic).container == block("d", optimistic).container,
            "Optimistic quote join separated the surviving suffix from its parent")
        try wait { !view.binding.hasPendingWork }
        var joined = true
        for step in oracle.stages {
            switch step.action {
            case "apply":
                guard let update = step.updateBase64 else { throw LabError.message("Quote oracle omitted remote bytes") }
                view.binding.store.applyRemote(update)
            case "undo": view.undoProse(); joined = false
            case "redo": view.redoProse(); joined = true
            case "joined": break
            default: throw LabError.message("Unknown quote history oracle action")
            }
            try wait { !view.binding.hasPendingWork }
            let projection = try read(core).projection
            let b = try block("b", projection), d = try block("d", projection)
            try require(contents(b, projection) == (joined ? "潮汐夜航" : "潮汐"), "Native quote history changed the wrong paragraph")
            try require(contents(d, projection) == step.suffix.text, "Native quote history lost remote suffix text")
            for key in ["futureSuffix", "lateSuffix"] {
                if case .string(let value) = step.suffix.attributes[key] {
                    let json = String(data: try JSONEncoder().encode(value), encoding: .utf8)!
                    try require(d.structuralAttributes[key] == json, "Native quote history lost remote suffix metadata")
                }
            }
            try require(view.textView.string == projection.text, "Native quote view did not follow core history")
            if joined { try require(b.container == d.container, "Native joined quote did not retain the suffix parent") }
            else { try require(try block("c", projection).container == d.container, "Undo changed the original suffix parent") }
        }
        let remoteComplete = try read(core).projection
        let suffix = try block("d", remoteComplete)
        let end = NSRange(location: NSMaxRange(suffix.range.nsRange), length: 0)
        view.textView.setSelectedRange(end)
        view.textView.insertText("续", replacementRange: end)
        try wait { !view.binding.hasPendingWork }
        let continued = try read(core).projection
        try require(try contents(block("d", continued), continued) == contents(suffix, remoteComplete) + "续",
            "Native typing into the retained quote suffix targeted a different paragraph")
        view.undoProse(); try wait { !view.binding.hasPendingWork }
        let beforeReopen = try read(core).projection
        try require(beforeReopen.text == remoteComplete.text, "Native suffix undo removed earlier remote work")
        var reopened: Result<LabState, Error>?
        core.reopen { reopened = $0 }; try wait { reopened != nil }; _ = try reopened!.get()
        view.binding.load(); try wait { !view.binding.hasPendingWork }
        let afterReopen = try read(core).projection
        try require(afterReopen.text == beforeReopen.text && view.textView.string == beforeReopen.text,
            "Native quote join and remote suffix edits did not survive reopen")
        try require(try block("b", afterReopen).container == block("d", afterReopen).container,
            "Reopen changed the joined suffix parent")
    }
}
