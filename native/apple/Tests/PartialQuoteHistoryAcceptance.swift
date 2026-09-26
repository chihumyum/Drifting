import AppKit

extension BindingAcceptance {
    static func partialQuoteHistoryAcceptance() throws -> [String] {
        enum MetadataValue: Decodable {
            case string(String), other
            init(from decoder: Decoder) throws {
                let value = try decoder.singleValueContainer()
                self = (try? value.decode(String.self)).map(MetadataValue.string) ?? .other
            }
        }
        struct Step: Decodable {
            struct Suffix: Decodable { let text: String; let attributes: [String: MetadataValue] }
            let action: String
            let updateBase64: String?
            let suffix: Suffix
        }
        struct QuoteCase: Decodable {
            let name: String
            let updateBase64: String
            let range: NativeRange
            let text: String
            let stages: [Step]
        }
        struct Oracle: Decodable { let cases: [QuoteCase] }
        let process = Process(), output = Pipe()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        process.arguments = ["pnpm", "exec", "tsx", "--conditions=import", "scripts/apple-quote-history-oracle.ts"]
        process.standardOutput = output
        try process.run()
        let bytes = output.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        try require(process.terminationStatus == 0, "Partial quote production oracle failed")
        guard let oracle = try JSONDecoder().decode(Oracle.self, from: bytes).cases.first(where: {
            $0.name == "delete across adjacent quotes preserving right suffix identity"
        }) else { throw LabError.message("Production partial quote deletion case is missing") }
        try require(oracle.range.nsRange == NSRange(location: 1, length: 3) && oracle.text.isEmpty,
                    "Partial quote oracle changed its accepted operation")

        let parent = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: parent) }
        let directory = parent.appendingPathComponent("apple-native-lab")
        let core = LabCore(directory: directory)
        func result<T>(_ run: (@escaping (Result<T, Error>) -> Void) -> Void) throws -> T {
            var value: Result<T, Error>?
            run { value = $0 }; try wait { value != nil }; return try value!.get()
        }
        let _: LabState = try result { core.open(completion: $0) }
        let first = NativeDocumentView(core: core), second = NativeDocumentView(core: core)
        defer { _ = first.binding.detach(); _ = second.binding.detach() }
        func settle(_ stage: String) throws {
            try wait { !first.binding.hasPendingWork || first.binding.hasFailedDraft || second.binding.hasFailedDraft }
            try require(!first.binding.hasPendingWork && !first.binding.hasUnsubmittedDraft && !second.binding.hasUnsubmittedDraft,
                        "Partial quote \(stage) retained a draft or pending work")
        }
        first.binding.load(); second.binding.load(); try settle("load")
        first.binding.store.applyRemote(oracle.updateBase64); try settle("fixture import")
        func block(_ id: String, _ projection: NativeProjection) throws -> NativeBlock {
            guard let value = projection.blocks.first(where: { $0.id == id }) else {
                throw LabError.message("Partial quote block \(id) is missing")
            }
            return value
        }
        func contents(_ block: NativeBlock, _ projection: NativeProjection) -> String {
            (projection.text as NSString).substring(with: block.range.nsRange)
        }

        // Synthetic fixture preparation only: load real persisted comment rows
        // on reopen so every subsequent edit uses the normal Rust anchor/CAS path.
        // No production comment-creation API or delegate callback is simulated.
        let comments: [(id: String, block: String, from: Int, to: Int, quote: String, original: String)] = [
            ("partial-prefix", "b", 0, 1, "潮", "潮汐"),
            ("partial-tail", "c", 1, 2, "航", "夜航"),
            ("partial-suffix", "d", 0, 2, "终章", "终章"),
        ]
        func literal(_ value: String) -> String { "'" + value.replacingOccurrences(of: "'", with: "''") + "'" }
        func json(_ value: Any) throws -> String {
            String(data: try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]), encoding: .utf8)!
        }
        func sql(_ statement: String) throws -> Data {
            let process = Process(), output = Pipe()
            process.executableURL = URL(fileURLWithPath: "/usr/bin/sqlite3")
            process.arguments = ["-bail", directory.appendingPathComponent("native-lab.db").path, statement]
            process.standardOutput = output
            try process.run()
            let data = output.fileHandleForReading.readDataToEndOfFile()
            process.waitUntilExit()
            try require(process.terminationStatus == 0, "Synthetic partial quote comment SQL failed")
            return data
        }
        var statements = ["BEGIN IMMEDIATE;"]
        for comment in comments {
            let anchor = try json(["selectedText": comment.quote, "future": ["keep": comment.id],
                "blockSnapshots": [["blockId": comment.block, "blockText": comment.original]],
                "textAnchor": ["startBlockId": comment.block, "startOffset": comment.from,
                    "endBlockId": comment.block, "endOffset": comment.to, "text": comment.quote]] as [String: Any])
            statements.append("INSERT INTO comment (id, project_id, target_kind, target_id, target_block_id, target_block_ids_json, anchor_json, body_json, created_at, updated_at) SELECT \(literal(comment.id)), project_id, target_kind, target_id, \(literal(comment.block)), \(literal(try json([comment.block]))), \(literal(anchor)), body_json, created_at, updated_at FROM comment WHERE id = 'fixture-comment';")
        }
        statements.append("COMMIT;")
        _ = try sql(statements.joined(separator: "\n"))
        let _: LabState = try result { core.reopen(completion: $0) }
        first.binding.load(); try settle("comment fixture reopen")

        let initial = try read(core).projection
        let b = try block("b", initial), c = try block("c", initial), d = try block("d", initial)
        try require(contents(b, initial) == "潮汐" && contents(c, initial) == "夜航" && contents(d, initial) == "终章",
                    "Partial quote fixture text changed")
        try require(NSMaxRange(b.range.nsRange) + 1 == c.range.location && NSMaxRange(c.range.nsRange) + 1 == d.range.location,
                    "Partial quote fixture blocks are not adjacent")
        let before = initial.text as NSString
        let prefix = before.substring(to: b.range.location), after = before.substring(from: NSMaxRange(d.range.nsRange))
        let range = NSRange(location: b.range.location + oracle.range.location, length: oracle.range.length)
        second.textView.setSelectedRange(NSRange(location: c.range.location + 1, length: 1))
        try wait { second.binding.selectionIsAnchored }

        func exact(joined: Bool, continued: Bool, suffix: Step.Suffix, caret: Int? = nil, stage: String) throws {
            let saved = try read(core), projection = saved.projection
            let body = joined ? (continued ? "潮续航" : "潮航") : "潮汐\n夜航"
            let expected = prefix + body + "\n" + suffix.text + after
            try require(saved.saved && saved.saveError == nil && Array(projection.text.utf16) == Array(expected.utf16),
                        "Partial quote \(stage) changed stored text or failed to save")
            for view in [first, second] {
                try require(Array(view.textView.string.utf16) == Array(expected.utf16)
                    && view.textView.textStorage?.length == expected.utf16.count && !view.binding.hasUnsubmittedDraft,
                            "Partial quote \(stage) did not converge in both native views")
            }
            let currentB = try block("b", projection), currentD = try block("d", projection)
            let tailAt: Int
            if joined {
                try require(!projection.blocks.contains { $0.id == "c" } && currentB.container == currentD.container,
                            "Partial quote \(stage) lost the right suffix container")
                tailAt = currentB.range.location + (continued ? 2 : 1)
            } else {
                let currentC = try block("c", projection)
                try require(currentC.container == currentD.container && currentB.container != currentC.container,
                            "Partial quote undo did not restore separate parents")
                tailAt = currentC.range.location + 1
            }
            try require(second.textView.selectedRange() == NSRange(location: tailAt, length: 1),
                        "Partial quote \(stage) lost the passive selection on the original 航")
            if let caret {
                try require(first.textView.selectedRange() == NSRange(location: caret, length: 0),
                            "Partial quote \(stage) moved the active caret")
            }
            let suffixQuote = (suffix.text as NSString).range(of: "终章")
            try require(suffixQuote.location != NSNotFound, "Remote suffix removed the synthetic quote")
            for (id, at, length) in [("partial-prefix", currentB.range.location, 1), ("partial-tail", tailAt, 1),
                                     ("partial-suffix", currentD.range.location + suffixQuote.location, 2)] {
                guard let comment = projection.comments.first(where: { $0.id == id }),
                      let original = comments.first(where: { $0.id == id }) else {
                    throw LabError.message("Partial quote \(stage) lost comment \(id)")
                }
                try require(Array(comment.quote.utf16) == Array(original.quote.utf16) && comment.ranges.count == 1
                    && comment.ranges[0].nsRange == NSRange(location: at, length: length),
                            "Partial quote \(stage) changed comment \(id) or its range")
            }
            for key in ["futureSuffix", "lateSuffix"] {
                if case .string(let value) = suffix.attributes[key] {
                    let encoded = String(data: try JSONEncoder().encode(value), encoding: .utf8)!
                    try require(currentD.structuralAttributes[key] == encoded, "Partial quote \(stage) lost remote suffix metadata")
                }
            }
        }

        guard let initialSuffix = oracle.stages.first?.suffix else { throw LabError.message("Missing quote history stages") }
        try exact(joined: false, continued: false, suffix: initialSuffix, stage: "initial")
        first.textView.setSelectedRange(range)
        first.textView.insertText("", replacementRange: range)
        let optimistic = first.binding.store.projection!
        try require(try block("b", optimistic).container == block("d", optimistic).container,
                    "Optimistic partial quote deletion separated the right suffix")
        // Keep both edits against the actual visible branch, before any queued
        // Rust reply. The second view must receive the same optimistic branch.
        first.textView.insertText("续", replacementRange: NSRange(location: range.location, length: 0))
        try require(first.binding.canEdit && Array(first.textView.string.utf16)
            == Array((prefix + "潮续航\n终章" + after).utf16), "Pending partial quote deletion blocked continued typing")
        try settle("delete and continued input")
        try exact(joined: true, continued: true, suffix: initialSuffix, caret: range.location + 1, stage: "continued input")
        first.undoProse(); try settle("typing undo")
        try exact(joined: true, continued: false, suffix: initialSuffix, stage: "typing undo")

        var joined = true
        for step in oracle.stages {
            switch step.action {
            case "joined": break
            case "apply":
                guard let update = step.updateBase64 else { throw LabError.message("Missing partial quote remote bytes") }
                first.binding.store.applyRemote(update)
            case "undo": first.undoProse(); joined = false
            case "redo": first.redoProse(); joined = true
            default: throw LabError.message("Unknown partial quote history action")
            }
            try settle(step.action)
            try exact(joined: joined, continued: false, suffix: step.suffix, stage: step.action)
        }
        guard let finalSuffix = oracle.stages.last?.suffix else { throw LabError.message("Missing final suffix") }
        try require(try read(core).projection.canRedo, "Partial quote history discarded the continued-input redo")
        first.redoProse(); try settle("continued input redo")
        try exact(joined: true, continued: true, suffix: finalSuffix, stage: "continued input redo")
        let _: LabState = try result { core.reopen(completion: $0) }
        first.binding.load(); try settle("SQLite reopen")
        try wait { second.binding.selectionIsAnchored }
        try exact(joined: true, continued: true, suffix: finalSuffix, stage: "SQLite reopen")

        let rows = try sql("SELECT json_group_array(json_object('id', id, 'anchor', json(anchor_json))) FROM comment WHERE id IN (\(comments.map { literal($0.id) }.joined(separator: ",")));")
        guard let persisted = try JSONSerialization.jsonObject(with: rows) as? [[String: Any]] else {
            throw LabError.message("Partial quote comment records did not decode")
        }
        try require(persisted.count == comments.count, "Partial quote lost persisted comment rows")
        for original in comments {
            guard let row = persisted.first(where: { $0["id"] as? String == original.id }),
                  let anchor = row["anchor"] as? [String: Any],
                  let future = anchor["future"] as? [String: Any],
                  let snapshots = anchor["blockSnapshots"] as? [[String: Any]] else {
                throw LabError.message("Partial quote rewrote original comment metadata")
            }
            try require(anchor["selectedText"] as? String == original.quote && future["keep"] as? String == original.id
                && snapshots.first?["blockId"] as? String == original.block
                && snapshots.first?["blockText"] as? String == original.original,
                        "Partial quote changed original quote/snapshot/future fields")
        }
        return ["AppKit partial quote deletion preserves queued typing, two-view selections, comments, suffix history and reopen"]
    }
}
