import AppKit

extension BindingAcceptance {
    static func remoteRecoveryAcceptance() throws -> [String] {
        struct Peer: Decodable { let blocked: String; let dependency: String; let full: String }
        func process(_ arguments: [String], input: Data? = nil) throws -> Data {
            let task = Process(), output = Pipe(), source = Pipe()
            task.executableURL = URL(fileURLWithPath: "/usr/bin/env")
            task.arguments = arguments; task.standardOutput = output
            if input != nil { task.standardInput = source }
            try task.run()
            if let input { source.fileHandleForWriting.write(input); try source.fileHandleForWriting.close() }
            let bytes = output.fileHandleForReading.readDataToEndOfFile()
            task.waitUntilExit(); try require(task.terminationStatus == 0, "Recovery fixture process failed")
            return bytes
        }
        func result<T>(_ operation: (@escaping (Result<T, Error>) -> Void) -> Void) throws -> T {
            var value: Result<T, Error>?
            operation { value = $0 }; try wait { value != nil }; return try value!.get()
        }
        func status(_ view: NSView) -> String? {
            if let label = view as? NSTextField, label.accessibilityIdentifier() == "document-status" { return label.stringValue }
            return view.subviews.lazy.compactMap { status($0) }.first
        }
        let seed = "ARD9pAIABwEHZGVmYXVsdAMKYmxvY2txdW90ZQcA/aQCAAMJcGFyYWdyYXBoBwD9pAIBBgQA/aQCAgbmva7msZAoAP2kAgECaWQBdwFiKAD9pAIAAmlkAXcEbGVmdIf9pAIAAwpibG9ja3F1b3RlBwD9pAIHAwlwYXJhZ3JhcGgHAP2kAggGBAD9pAIJBuWknOiIqigA/aQCCAJpZAF3AWOH/aQCCAMJcGFyYWdyYXBoBwD9pAINBgQA/aQCDgbnu4jnq6AoAP2kAg0CaWQBdwFkKAD9pAIHAmlkAXcFcmlnaHQA"
        var cases: [String] = []
        for marked in [false, true] {
            let parent = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
            defer { try? FileManager.default.removeItem(at: parent) }
            let directory = parent.appendingPathComponent("apple-native-lab")
            let core = LabCore(directory: directory)
            let _: LabState = try result { core.open(completion: $0) }
            let first = NativeDocumentView(core: core), second = NativeDocumentView(core: core)
            defer { _ = first.binding.detach(); _ = second.binding.detach() }
            first.binding.load(); second.binding.load(); try wait { !first.binding.hasPendingWork }
            first.binding.store.applyRemote(seed); try wait { !first.binding.hasPendingWork }
            let initial = try read(core).projection
            let b = initial.blocks.first { $0.id == "b" }!, d = initial.blocks.first { $0.id == "d" }!
            let original = initial.text as NSString
            let prefix = original.substring(to: b.range.location), suffix = original.substring(from: NSMaxRange(d.range.nsRange))
            let checkpoint: NativeCheckpoint = try result { core.exportDocument(completion: $0) }
            let fixture = #"""
            const Y = require('yjs'), fs = require('node:fs');
            const doc = new Y.Doc(); doc.clientID = 37931;
            Y.applyUpdate(doc, Buffer.from(JSON.parse(fs.readFileSync(0, 'utf8')).update, 'base64'));
            function find(root, id) { for (const node of root.toArray()) {
              if (!(node instanceof Y.XmlElement)) continue;
              if (node.getAttribute('id') === id) return node.get(0);
              const nested = find(node, id); if (nested) return nested;
            } }
            const events = []; doc.on('update', update => events.push(Buffer.from(update).toString('base64')));
            find(doc.getXmlFragment('default'), 'd').insert(0, '远🙂');
            find(doc.getXmlFragment('default'), 'b').insert(0, '保');
            process.stdout.write(JSON.stringify({dependency: events[0], blocked: events[1], full: Buffer.from(Y.encodeStateAsUpdate(doc)).toString('base64')}));
            doc.destroy();
            """#
            let peer = try JSONDecoder().decode(Peer.self, from: process(["node", "-e", fixture], input: JSONSerialization.data(withJSONObject: ["update": checkpoint.update])))
            let deletion = NSRange(location: b.range.location + 1, length: 3)
            first.textView.setSelectedRange(deletion); first.textView.insertText("", replacementRange: deletion)
            try wait { !first.binding.hasPendingWork }
            let joined = try read(core)
            func sql(_ query: String) throws -> String {
                String(data: try process(["sqlite3", "-bail", directory.appendingPathComponent("native-lab.db").path, query]), encoding: .utf8)!.trimmingCharacters(in: .whitespacesAndNewlines)
            }
            let baselineJournal = try sql("SELECT count(*) FROM sync_change_set;")
            let baselineSnapshot = try sql("SELECT hex(state_blob) FROM yjs_snapshots ORDER BY document_id;")
            let at = b.range.location + 1
            first.textView.setSelectedRange(NSRange(location: at, length: 0))
            if marked {
                first.textView.setMarkedText("中文", selectedRange: NSRange(location: 2, length: 0), replacementRange: NSRange(location: at, length: 0))
                try wait { !first.binding.store.hasPendingCommits }
                first.binding.store.applyRemote(peer.blocked)
            } else {
                first.binding.store.applyRemote(peer.blocked)
                first.textView.insertText("续", replacementRange: NSRange(location: at, length: 0))
                first.textView.insertText("后", replacementRange: NSRange(location: at + 1, length: 0))
            }
            let visible = first.textView.string, passive = second.textView.string
            let selection = first.textView.selectedRange(), markedRange = first.textView.markedRange()
            let inputKey = first.binding.inputKey, compositionParent = first.binding.compositionParent
            try wait { first.binding.hasRemoteBlock }
            let blockedID = first.binding.state!.remoteBlock!.updateId
            let raw = Data(base64Encoded: peer.blocked)!
            let expectedRow = "\(blockedID):" + raw.map { String(format: "%02X", $0) }.joined()
            func retained(_ stage: String) throws {
                let saved = try read(core)
                try require(saved.remoteBlock?.updateId == blockedID && !saved.saved && saved.saveError == nil,
                            "Recovery \(stage) dropped the blocked status")
                try require(NativeText.identical(saved.projection.text, joined.projection.text), "Recovery \(stage) submitted queued input while blocked")
                try require(NativeText.identical(first.textView.string, visible) && NativeText.identical(second.textView.string, passive)
                    && first.textView.selectedRange() == selection && first.binding.inputKey == inputKey,
                            "Recovery \(stage) replaced retained input")
                try require(try sql("SELECT id || ':' || hex(update_blob) FROM yjs_updates ORDER BY id;") == expectedRow,
                            "Recovery \(stage) changed raw row or receipt")
                try require(try sql("SELECT count(*) FROM sync_change_set;") == baselineJournal
                    && sql("SELECT hex(state_blob) FROM yjs_snapshots ORDER BY document_id;") == baselineSnapshot,
                            "Recovery \(stage) authored input or changed snapshot before closure")
                if marked { try require(first.textView.hasMarkedText() && first.textView.markedRange() == markedRange
                    && first.binding.compositionParent == compositionParent, "Recovery \(stage) cancelled the IME branch") }
            }
            try retained("first refusal")
            first.binding.store.applyRemote(peer.blocked)
            _ = try read(core) // Serial ABI barrier; duplicate must actually pass the blocked queue.
            try retained("duplicate while blocked")
            first.binding.store.applyRemote(peer.dependency)
            first.binding.store.applyRemote(peer.full)
            try wait { !first.binding.store.hasPendingCommits }
            let remoteText = prefix + "保潮航\n远🙂终章" + suffix
            if marked {
                let saved = try read(core)
                try require(saved.saved && saved.remoteBlock == nil && NativeText.identical(saved.projection.text, remoteText),
                            "Dependency did not recover the shared owner")
                try require(NativeText.identical(second.textView.string, remoteText) && NativeText.identical(first.textView.string, visible)
                    && first.textView.hasMarkedText() && first.textView.markedRange() == markedRange
                    && first.textView.selectedRange() == selection && first.binding.inputKey == inputKey
                    && first.binding.compositionParent == compositionParent && first.binding.hasUnsubmittedDraft,
                            "Recovery replayed or replaced marked text before a native commit")
                try require(first.binding.canEdit && second.binding.canEdit, "Recovered owner did not reopen editing")
                try require(status(first)?.contains("已恢复应用") == true && status(first)?.contains("尚未应用") == false
                    && status(first)?.contains("尚未提交") == true, "Recovered marked view still displays the old remote block")
                try require(try sql("SELECT count(*) FROM sync_change_set;") == String(Int(baselineJournal)! + 1),
                            "Recovery authored marked input before a native commit")
                first.textView.insertText("中文", replacementRange: NSRange(location: NSNotFound, length: 0))
                try wait { !first.binding.hasPendingWork }
            }
            let local = marked ? "中文" : "续后"
            let expected = prefix + "保潮\(local)航\n远🙂终章" + suffix
            func converged(_ value: String, _ stage: String) throws {
                let saved = try read(core)
                try require(saved.saved && saved.remoteBlock == nil && saved.saveError == nil && !first.binding.hasPendingWork,
                            "Recovery \(stage) did not settle")
                try require(NativeText.identical(saved.projection.text, value) && NativeText.identical(first.textView.string, value)
                    && NativeText.identical(second.textView.string, value), "Recovery \(stage) lost or duplicated exact input")
                for comment in initial.comments {
                    try require(saved.projection.comments.contains { $0.id == comment.id && $0.quote == comment.quote && $0.status == comment.status },
                                "Recovery \(stage) changed an unrelated comment")
                }
                try require(try sql("SELECT count(*) FROM yjs_document_revision_provenance WHERE source_kind='system';") == "1",
                            "Recovery \(stage) duplicated the System repair")
            }
            try converged(expected, "continued queue")
            try require(try sql("SELECT count(*) FROM sync_change_set;") == String(Int(baselineJournal)! + (marked ? 2 : 3)),
                        "Recovery duplicated or omitted an authored local event")
            first.undoProse(); try wait { !first.binding.hasPendingWork }
            try converged(marked ? remoteText : prefix + "保潮续航\n远🙂终章" + suffix, "first local undo")
            if !marked {
                first.undoProse(); try wait { !first.binding.hasPendingWork }; try converged(remoteText, "second local undo")
                first.redoProse(); try wait { !first.binding.hasPendingWork }
            }
            first.redoProse(); try wait { !first.binding.hasPendingWork }; try converged(expected, "local redo")
            first.binding.store.applyRemote(peer.full); try wait { !first.binding.hasPendingWork }; try converged(expected, "full duplicate")
            let _: LabState = try result { core.reopen(completion: $0) }
            first.binding.load(); try wait { !first.binding.hasPendingWork }; try converged(expected, "SQLite reopen")
            cases.append(marked
                ? "AppKit durable dependency recovery preserves marked branch until native commit and keeps remote text through history and reopen"
                : "AppKit durable dependency recovery bypasses held local jobs then drains exact queued input through history and reopen")
        }
        return cases
    }
}
