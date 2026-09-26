import AppKit

extension BindingAcceptance {
    static func relocationAcceptance() throws -> [String] {
        struct QuoteCase: Decodable { let name: String; let updateBase64: String; let range: NativeRange }
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
            try require(task.terminationStatus == 0, "Relocation fixture process failed")
            return bytes
        }
        let fixtures = try JSONDecoder().decode(Oracle.self, from: process([
            "pnpm", "exec", "tsx", "--conditions=import", "scripts/apple-quote-history-oracle.ts",
        ])).cases
        func result<T>(_ run: (@escaping (Result<T, Error>) -> Void) -> Void) throws -> T {
            var value: Result<T, Error>?
            run { value = $0 }; try wait { value != nil }; return try value!.get()
        }
        enum PacketMode { case plain, mixed, interleaved }
        var cases: [String] = []
        for (fixture, mode) in fixtures.flatMap({ fixture in
            [PacketMode.plain, .mixed, .interleaved].map { (fixture, $0) }
        }) {
            let mixed = mode != .plain, interleaved = mode == .interleaved
            let latePrefix = interleaved ? "保🙂续🚀" : "保🙂"
            let partial = fixture.range.length == 3
            let parent = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
            defer { try? FileManager.default.removeItem(at: parent) }
            let directory = parent.appendingPathComponent("apple-native-lab")
            let core = LabCore(directory: directory)
            let _: LabState = try result { core.open(completion: $0) }
            let first = NativeDocumentView(core: core), second = NativeDocumentView(core: core)
            defer { _ = first.binding.detach(); _ = second.binding.detach() }
            func settle(_ stage: String) throws {
                try wait { !first.binding.hasPendingWork || first.binding.hasRemoteBlock || first.binding.hasFailedDraft }
                let saved = try read(core)
                try require(!first.binding.hasPendingWork && saved.saved && saved.remoteBlock == nil && saved.saveError == nil,
                            "Relocation \(stage) did not save and settle: \(saved.saveError ?? "none"), remote: \(saved.remoteBlock?.reason ?? "none")")
            }
            first.binding.load(); second.binding.load(); try settle("load")
            first.binding.store.applyRemote(fixture.updateBase64); try settle("fixture")
            let initial = try read(core).projection
            guard let b = initial.blocks.first(where: { $0.id == "b" }),
                  let d = initial.blocks.first(where: { $0.id == "d" }) else {
                throw LabError.message("Relocation fixture paragraphs are missing")
            }
            let original = initial.text as NSString
            let prefix = original.substring(to: b.range.location), suffix = original.substring(from: NSMaxRange(d.range.nsRange))
            let checkpoint: NativeCheckpoint = try result { core.exportDocument(completion: $0) }
            let peer = #"""
            const Y = require('yjs'), fs = require('node:fs');
            const doc = new Y.Doc();
            const input = JSON.parse(fs.readFileSync(0, 'utf8'));
            Y.applyUpdate(doc, Buffer.from(input.update, 'base64'));
            function find(root, id = 'b') {
              for (const value of root.toArray()) {
                if (!(value instanceof Y.XmlElement)) continue;
                if (value.getAttribute('id') === id) return value;
                const nested = find(value, id); if (nested) return nested;
              }
            }
            const before = Y.encodeStateVector(doc);
            doc.transact(() => {
              find(doc.getXmlFragment('default')).get(0).insert(0, '保🙂');
              if (input.mixed) find(doc.getXmlFragment('default'), 'd').get(0).insert(1, '合');
              if (input.interleaved) find(doc.getXmlFragment('default')).get(0).insert(3, '续🚀');
            });
            process.stdout.write(Buffer.from(Y.encodeStateAsUpdate(doc, before)).toString('base64'));
            doc.destroy();
            """#
            let late = String(data: try process(["node", "-e", peer], input: JSONSerialization.data(withJSONObject: ["update": checkpoint.update, "mixed": mixed, "interleaved": interleaved])), encoding: .utf8)!
            let range = NSRange(location: b.range.location + fixture.range.location, length: fixture.range.length)
            first.textView.setSelectedRange(range); first.textView.insertText("", replacementRange: range)
            try settle("join")
            var selectedLateText = false
            if mixed {
                let joinedD = try read(core).projection.blocks.first { $0.id == "d" }!
                second.textView.setSelectedRange(NSRange(location: joinedD.range.location + 1, length: 1))
                try wait { second.binding.selectionIsAnchored }; selectedLateText = true
            }
            func verifyMixedSuffix(_ saved: NativeCheckpoint) throws {
                let script = #"""
                const Y = require('yjs'), fs = require('node:fs'), assert = require('node:assert/strict');
                const input = JSON.parse(fs.readFileSync(0, 'utf8')), doc = new Y.Doc();
                const decode = value => Buffer.from(value, 'base64');
                function find(root, id = 'd') { for (const node of root.toArray()) {
                  if (!(node instanceof Y.XmlElement)) continue;
                  if (node.getAttribute('id') === id) return node;
                  const nested = find(node, id); if (nested) return nested;
                } }
                Y.applyUpdate(doc, decode(input.original)); Y.applyUpdate(doc, decode(input.late));
                const source = find(doc.getXmlFragment('default'), 'b').get(0);
                assert.equal(source.toString(), input.prefix + '潮汐');
                const prefixUnits = Array.from({length: input.prefix.length}, (_, offset) => ({
                  id: Y.createRelativePositionFromTypeIndex(source, offset).item,
                  unit: input.prefix.charAt(offset),
                }));
                assert(prefixUnits.every(value => value.id));
                const prefixClient = prefixUnits[0].id.client;
                const block = find(doc.getXmlFragment('default')), text = block.get(0);
                const blockID = block._item.id, textID = text._item.id;
                const safeCharacter = Y.createRelativePositionFromTypeIndex(text, 1);
                Y.applyUpdate(doc, decode(input.saved));
                const after = find(doc.getXmlFragment('default'));
                assert.deepEqual(after._item.id, blockID); assert.deepEqual(after.get(0)._item.id, textID);
                assert.equal(after.get(0).toString(), '终合章');
                const position = Y.createAbsolutePositionFromRelativePosition(safeCharacter, doc);
                assert(position && position.type === after.get(0) && position.index === 1);
                const evidence = [...doc.getMap('drifting.native.relocation-alias.v1').entries()]
                  .filter(([key]) => key.startsWith('source/')).map(([, value]) => JSON.parse(value));
                // Entries may retain a coalesced string or overlapping scalar spans.
                // Verify each original UTF-16 clock, rather than metadata chunk size.
                const sourceUnits = new Map();
                for (const value of evidence) {
                  for (let offset = 0; offset < value.text.length; offset++) {
                    const key = `${value.id.client}:${value.id.clock + offset}`;
                    const unit = value.text.charAt(offset);
                    if (sourceUnits.has(key)) assert.equal(sourceUnits.get(key), unit);
                    sourceUnits.set(key, unit);
                  }
                  if (value.id.client === prefixClient) {
                    assert.equal(value.source_text.client, source._item.id.client);
                    assert.equal(value.source_text.clock, source._item.id.clock);
                  }
                }
                for (const {id, unit} of prefixUnits) {
                  assert.equal(sourceUnits.get(`${id.client}:${id.clock}`), unit);
                }
                assert(!sourceUnits.has(`${safeCharacter.item.client}:${safeCharacter.item.clock}`));
                assert(!evidence.some(value => value.text.includes('合')));
                doc.destroy();
                """#
                _ = try process(["node", "-e", script], input: JSONSerialization.data(withJSONObject: [
                    "original": checkpoint.update, "late": late, "saved": saved.update, "prefix": latePrefix,
                ]))
            }
            func exact(_ joined: Bool, _ stage: String) throws {
                if selectedLateText { try wait { second.binding.selectionIsAnchored } }
                let saved = try read(core), projection = saved.projection
                let body = latePrefix + (joined ? (partial ? "潮航" : "潮汐夜航") : "潮汐\n夜航")
                let expected = prefix + body + (mixed ? "\n终合章" : "\n终章") + suffix
                try require(saved.saved && Array(projection.text.utf16) == Array(expected.utf16),
                            "Relocation \(stage) changed or duplicated source text")
                for view in [first, second] {
                    try require(Array(view.textView.string.utf16) == Array(expected.utf16),
                                "Relocation \(stage) did not converge in both views")
                }
                try require(projection.blocks.filter { $0.id == "b" }.count == 1
                    && projection.blocks.contains(where: { $0.id == "c" }) != joined,
                            "Relocation \(stage) duplicated a paragraph or lost history structure")
                if selectedLateText {
                    let currentD = projection.blocks.first { $0.id == "d" }!
                    let expectedSelection = mixed ? NSRange(location: currentD.range.location + 2, length: 1)
                        : NSRange(location: b.range.location, length: 3)
                    try require(second.textView.selectedRange() == expectedSelection
                        && projection.selections.first { $0.viewId == second.binding.viewID }?.range?.nsRange == expectedSelection,
                                "Relocation \(stage) lost the original suffix or late-text selection")
                }
                for comment in initial.comments {
                    guard let current = projection.comments.first(where: { $0.id == comment.id }) else {
                        throw LabError.message("Relocation \(stage) dropped an existing comment")
                    }
                    try require(current.quote == comment.quote && current.status == comment.status,
                                "Relocation \(stage) changed an unrelated comment")
                }
                if mixed { try verifyMixedSuffix(try result { core.exportDocument(completion: $0) }) }
            }
            first.binding.store.applyRemote(late); try settle("late prefix")
            try exact(true, "late prefix")
            if !mixed {
                second.textView.setSelectedRange(NSRange(location: b.range.location, length: 3))
                try wait { second.binding.selectionIsAnchored }; selectedLateText = true
            }
            first.binding.store.applyRemote(late); try settle("duplicate")
            try exact(true, "duplicate")
            for cycle in 0..<2 {
                first.undoProse(); try settle("undo \(cycle)"); try exact(false, "undo \(cycle)")
                first.redoProse(); try settle("redo \(cycle)"); try exact(true, "redo \(cycle)")
            }
            if partial && !mixed {
                let basis: NativeCheckpoint = try result { core.exportDocument(completion: $0) }
                let formatter = peer.replacingOccurrences(of: ".insert(0, '保🙂');", with: ".format(0, 1, {bold: true});")
                let formatted = String(data: try process(["node", "-e", formatter], input: JSONSerialization.data(withJSONObject: ["update": basis.update])), encoding: .utf8)!
                first.binding.store.applyRemote(formatted); try settle("owned render formatting")
                let beforeRefusal = try read(core)
                let beforeBytes: NativeCheckpoint = try result { core.exportDocument(completion: $0) }
                let previousStatus = first.binding.onStatus
                var historyStatus = ""
                first.binding.onStatus = { historyStatus = $0; previousStatus?($0) }
                first.undoProse(); try settle("history refusal")
                let afterRefusal = try read(core)
                let afterBytes: NativeCheckpoint = try result { core.exportDocument(completion: $0) }
                try require(afterBytes.update == beforeBytes.update
                    && afterRefusal.projection.revision == beforeRefusal.projection.revision,
                            "Refused history changed prose or revision")
                try require(first.binding.canEdit && second.binding.canEdit && historyStatus.contains("可以继续编辑")
                    && !historyStatus.contains("RETENTION_REQUIRED"),
                            "Refused history trapped the shared owner or exposed internal identifiers")
                let currentD = try read(core).projection.blocks.first { $0.id == "d" }!
                first.textView.insertText("续", replacementRange: NSRange(location: NSMaxRange(currentD.range.nsRange), length: 0))
                try settle("input after refused history")
                first.undoProse(); try settle("new input undo after refusal")
                try exact(true, "continued editing after history refusal")
                cases.append("AppKit refused relocation history preserves remote formatting and keeps both views editable")
            }
            let _: LabState = try result { core.reopen(completion: $0) }
            first.binding.load(); try settle("reopen"); try exact(true, "reopen")
            first.binding.store.applyRemote(late); try settle("reopened duplicate"); try exact(true, "reopened duplicate")
            let exported: NativeCheckpoint = try result { core.exportDocument(completion: $0) }
            let verify = #"""
            const Y = require('yjs'), fs = require('node:fs'), assert = require('node:assert/strict');
            const input = JSON.parse(fs.readFileSync(0, 'utf8')), doc = new Y.Doc();
            Y.applyUpdate(doc, Buffer.from(input.update, 'base64'));
            const blocks = [];
            function walk(root) { for (const node of root.toArray()) {
              if (!(node instanceof Y.XmlElement)) continue;
              if (node.getAttribute('id') === 'b') blocks.push(node);
              walk(node);
            } }
            walk(doc.getXmlFragment('default'));
            assert.equal(blocks.length, 1); assert.equal(blocks[0].get(0).toDelta().map(part => part.insert).join(''), input.expected);
            doc.destroy();
            """#
            _ = try process(["node", "-e", verify], input: JSONSerialization.data(withJSONObject: [
                "update": exported.update, "expected": latePrefix + (partial ? "潮航" : "潮汐夜航"),
            ]))
            if interleaved {
                cases.append(partial
                    ? "AppKit interleaved Unicode prefix and safe suffix clocks after partial quote deletion preserve two views selections item identity history and reopen"
                    : "AppKit interleaved Unicode prefix and safe suffix clocks after quote join preserve two views selections item identity history and reopen")
            } else if mixed {
                cases.append(partial
                    ? "AppKit mixed late prefix and safe suffix after partial quote deletion preserve two views selections item identity history and reopen"
                    : "AppKit mixed late prefix and safe suffix after quote join preserve two views selections item identity history and reopen")
            } else {
                cases.append(partial
                    ? "AppKit late original prefix after partial quote deletion converges across two views history duplicate delivery and reopen"
                    : "AppKit late original prefix after quote join converges across two views history duplicate delivery and reopen")
            }
        }
        return cases
    }
}
