import AppKit

extension BindingAcceptance {
    static func remoteBlockAcceptance() throws -> [String] {
        struct QuoteCase: Decodable { let name: String; let updateBase64: String }
        struct Oracle: Decodable { let cases: [QuoteCase] }
        func process(_ arguments: [String], input: Data? = nil) throws -> Data {
            let task = Process(), output = Pipe(), source = Pipe()
            task.executableURL = URL(fileURLWithPath: "/usr/bin/env")
            task.arguments = arguments; task.standardOutput = output
            if input != nil { task.standardInput = source }
            try task.run()
            if let input { source.fileHandleForWriting.write(input); try source.fileHandleForWriting.close() }
            let bytes = output.fileHandleForReading.readDataToEndOfFile()
            task.waitUntilExit()
            try require(task.terminationStatus == 0, "Remote block fixture process failed")
            return bytes
        }
        let oracle = try JSONDecoder().decode(Oracle.self, from: process([
            "pnpm", "exec", "tsx", "--conditions=import", "scripts/apple-quote-history-oracle.ts",
        ]))
        guard let fixture = oracle.cases.first(where: {
            $0.name == "delete across adjacent quotes preserving right suffix identity"
        }) else { throw LabError.message("Remote block quote fixture is missing") }
        func result<T>(_ run: (@escaping (Result<T, Error>) -> Void) -> Void) throws -> T {
            var value: Result<T, Error>?
            run { value = $0 }; try wait { value != nil }; return try value!.get()
        }
        func status(_ view: NSView) -> String? {
            if let label = view as? NSTextField, label.accessibilityIdentifier() == "document-status" {
                return label.stringValue
            }
            return view.subviews.lazy.compactMap { status($0) }.first
        }
        func retryTitle(_ view: NSView) -> String? {
            if let button = view as? NSButton, button.title == "重试应用" { return button.title }
            return view.subviews.lazy.compactMap { retryTitle($0) }.first
        }
        var cases: [String] = []
        for marked in [false, true] {
            let scenario = marked ? "marked" : "queued"
            let parent = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
            defer { try? FileManager.default.removeItem(at: parent) }
            let directory = parent.appendingPathComponent("apple-native-lab")
            let core = LabCore(directory: directory)
            let _: LabState = try result { core.open(completion: $0) }
            let first = NativeDocumentView(core: core), second = NativeDocumentView(core: core)
            defer { _ = first.binding.detach(); _ = second.binding.detach() }
            first.binding.load(); second.binding.load()
            try wait { first.binding.state != nil && !first.binding.hasPendingWork }
            first.binding.store.applyRemote(fixture.updateBase64)
            try wait { !first.binding.hasPendingWork }
            let before = try read(core).projection
            guard let b = before.blocks.first(where: { $0.id == "b" }) else {
                throw LabError.message("Original b is missing")
            }
            let checkpoint: NativeCheckpoint = try result { core.exportDocument(completion: $0) }
            // This peer edits the actual original XmlText before the local
            // structural deletion. The delta keeps its CRDT parent identity.
            let peer = #"""
            const Y = require('yjs');
            const fs = require('node:fs');
            const document = new Y.Doc();
            Y.applyUpdate(document, Buffer.from(JSON.parse(fs.readFileSync(0, 'utf8')).update, 'base64'));
            function find(root) {
              for (const value of root.toArray()) {
                if (!(value instanceof Y.XmlElement)) continue;
                if (value.getAttribute('id') === 'b') return value;
                const nested = find(value); if (nested) return nested;
              }
            }
            const block = find(document.getXmlFragment('default'));
            if (!block || !(block.get(0) instanceof Y.XmlText)) throw new Error('Missing original b text');
            const vector = Y.encodeStateVector(document);
            // Newly formatted legacy insertion is outside the plain-prefix
            // alias contract and must remain durably blocked.
            block.get(0).insert(0, '保', {bold: true});
            process.stdout.write(Buffer.from(Y.encodeStateAsUpdate(document, vector)).toString('base64'));
            document.destroy();
            """#
            let lateBytes = try process(["node", "-e", peer], input: JSONSerialization.data(withJSONObject: ["update": checkpoint.update]))
            guard let late = String(data: lateBytes, encoding: .utf8), let raw = Data(base64Encoded: late) else {
                throw LabError.message("Late original-b update did not decode")
            }
            let deletion = NSRange(location: b.range.location + 1, length: 3)
            first.textView.setSelectedRange(deletion)
            first.textView.insertText("", replacementRange: deletion)
            try wait { !first.binding.hasPendingWork }
            let joined = try read(core)
            guard let joinedB = joined.projection.blocks.first(where: { $0.id == "b" }) else {
                throw LabError.message("Joined b is missing")
            }
            try require((joined.projection.text as NSString).substring(with: joinedB.range.nsRange) == "潮航",
                        "Remote block fixture did not execute the real partial quote deletion")
            func sql(_ query: String, at database: URL? = nil) throws -> String {
                let bytes = try process(["sqlite3", "-bail", (database ?? directory.appendingPathComponent("native-lab.db")).path, query])
                return String(data: bytes, encoding: .utf8)!.trimmingCharacters(in: .whitespacesAndNewlines)
            }
            let snapshot = try sql("SELECT hex(state_blob) FROM yjs_snapshots ORDER BY document_id;")
            let authored = try sql("SELECT count(*) FROM sync_change_set;")
            let at = joinedB.range.location + 1
            first.textView.setSelectedRange(NSRange(location: at, length: 0))
            if marked {
                first.textView.setMarkedText("中文", selectedRange: NSRange(location: 2, length: 0),
                                            replacementRange: NSRange(location: at, length: 0))
                try wait { !first.binding.store.hasPendingCommits }
                first.binding.store.applyRemote(late)
            } else {
                // No run-loop yield: queued input stays on the visible branch
                // while the earlier remote delivery waits for its ABI response.
                first.binding.store.applyRemote(late)
                first.textView.insertText("续", replacementRange: NSRange(location: at, length: 0))
                first.textView.insertText("后", replacementRange: NSRange(location: at + 1, length: 0))
            }
            let visible = first.textView.string, passive = second.textView.string
            let selection = first.textView.selectedRange(), markedRange = first.textView.markedRange()
            try wait { first.binding.hasRemoteBlock }
            guard let blocked = first.binding.state?.remoteBlock else { throw LabError.message("Remote block is absent") }
            try require(blocked.updateId > 0 && !blocked.reason.isEmpty, "Remote block lacks row identity or reason")
            let expectedRow = "\(blocked.updateId):" + raw.map { String(format: "%02X", $0) }.joined()
            func preserved(_ stage: String) throws {
                let current = try read(core)
                try require(!current.saved && current.saveError == nil && current.remoteBlock?.updateId == blocked.updateId
                    && current.remoteBlock?.reason == blocked.reason,
                            "\(scenario) \(stage): receive was reported as applied/saved or changed its block")
                try require(Array(current.projection.text.utf16) == Array(joined.projection.text.utf16)
                    && current.projection.revision == joined.projection.revision,
                            "\(scenario) \(stage): blocked update or queued input mutated live prose")
                try require(Array(first.textView.string.utf16) == Array(visible.utf16)
                    && Array(second.textView.string.utf16) == Array(passive.utf16)
                    && first.textView.selectedRange() == selection,
                            "\(scenario) \(stage): a native draft or selection was replaced")
                try require(first.binding.hasPendingWork && second.binding.hasPendingWork
                    && !first.binding.canEdit && !second.binding.canEdit,
                            "\(scenario) \(stage): pending input escaped the remote block")
                let message = status(first)
                try require(message == status(second) && message?.contains("涉及已合并的段落") == true
                    && message?.contains("远端更新已保存，但尚未应用") == true
                    && message?.contains("REMOTE_TEXT_RETENTION_REQUIRED") == false,
                            "\(scenario) \(stage): views disagree or hide the block from a draft")
                try require(retryTitle(first) != nil && retryTitle(second) != nil,
                            "\(scenario) \(stage): retry still claims a local save")
                if marked {
                    try require(first.textView.hasMarkedText() && first.textView.markedRange() == markedRange
                        && first.binding.hasUnsubmittedDraft,
                                "\(stage): remote block cancelled native marked text")
                }
                try require(try sql("SELECT id || ':' || hex(update_blob) FROM yjs_updates ORDER BY id;") == expectedRow,
                            "\(scenario) \(stage): blocked bytes were lost, changed, duplicated or pruned")
                try require(try sql("SELECT hex(state_blob) FROM yjs_snapshots ORDER BY document_id;") == snapshot
                    && sql("SELECT count(*) FROM sync_change_set;") == authored,
                            "\(scenario) \(stage): blocked replay checkpointed or authored queued input")
            }
            try preserved("received")
            first.binding.retrySave()
            // This read is a serial ABI barrier after documentSave. Both main
            // callbacks finish before the preservation checks execute.
            _ = try read(core)
            try preserved("retry")
            first.undoProse(); second.redoProse()
            first.binding.discardDraft(); first.binding.load(); second.binding.load()
            try preserved("history, discard and refresh guards")
            var reopened: Result<LabState, Error>?
            core.reopen { reopened = $0 }; try wait { reopened != nil }
            if case .success = reopened! { throw LabError.message("Blocked reopen discarded queued or marked input") }
            try preserved("reopen refused")
            // SQLite's backup API captures WAL and database state consistently.
            // A distinct synthetic directory respects the single-owner guard
            // and exercises cold replay without closing retained local drafts.
            // Process-crash reopening is recorded by the durability suite.
            let coldDirectory = parent.appendingPathComponent("recovered/apple-native-lab")
            try FileManager.default.createDirectory(at: coldDirectory, withIntermediateDirectories: true)
            let coldDatabase = coldDirectory.appendingPathComponent("native-lab.db")
            _ = try sql(".backup '\(coldDatabase.path.replacingOccurrences(of: "'", with: "''"))'")
            let cold = LabCore(directory: coldDirectory)
            var coldOpen: Result<LabState, Error>?
            cold.open { coldOpen = $0 }; try wait { coldOpen != nil }
            guard case .failure(let error) = coldOpen!, let detail = error as? LabError else {
                throw LabError.message("Cold open discarded the persisted remote block")
            }
            let originalReason = "Stored prose update \(blocked.updateId) is unapplied; original bytes retained: \(blocked.reason)"
            try require(detail.diagnosticDescription == originalReason,
                        "Cold open discarded the original core diagnostic")
            try require(detail.localizedDescription == "有已保存但尚未应用的远端更新。原始数据已保留，当前暂不打开文档。",
                        "Cold open exposed internal identifiers or omitted retained-data guidance")
            try require(try sql("SELECT id || ':' || hex(update_blob) FROM yjs_updates ORDER BY id;", at: coldDatabase) == expectedRow
                && sql("SELECT hex(state_blob) FROM yjs_snapshots ORDER BY document_id;", at: coldDatabase) == snapshot,
                        "Cold replay changed the backup's retained update or checkpoint")
            try preserved("cold open refused with retained-data guidance")
            let newcomer = NativeDocumentView(core: core)
            newcomer.binding.load()
            try require(status(newcomer) == status(first), "New view hid the retained remote block")
            try require(Array(newcomer.textView.string.utf16) == Array(passive.utf16), "New view lost the retained shared input")
            _ = newcomer.binding.detach()
            cases.append(marked
                ? "AppKit stored but unapplied remote update preserves marked input and shared recovery status"
                : "AppKit stored but unapplied remote update preserves queued input and blocks history, retry compaction and reopen")
        }
        return cases
    }
}
