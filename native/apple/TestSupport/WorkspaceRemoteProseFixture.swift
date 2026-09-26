import Foundation
import SQLite3
#if canImport(DriftingNativeIOS)
@testable import DriftingNativeIOS
#endif

struct RemoteProseTestPacket {
    let original: RemoteProseOriginal
    let envelope: Data
}

/// Synthetic test discovery only. This is neither a provider transport nor a
/// sync frontier: the receiving core still verifies every original and row.
enum WorkspaceRemoteProseFixture {
    enum SQLValue: Equatable {
        case null
        case integer(Int64)
        case real(Double)
        case text(String)
        case blob(Data)
    }

    static func databaseURL(in directory: URL) -> URL {
        directory.appendingPathComponent("apple-native-workspace.db")
    }

    private static func sqliteError(_ database: OpaquePointer?, _ context: String) -> Error {
        let detail = database.map { String(cString: sqlite3_errmsg($0)) } ?? "SQLite did not open"
        return LabError.message("\(context): \(detail)")
    }

    private static func withDatabase<T>(in directory: URL, writable: Bool = false,
                                        _ body: (OpaquePointer) throws -> T) throws -> T {
        var database: OpaquePointer?
        let flags = (writable ? SQLITE_OPEN_READWRITE : SQLITE_OPEN_READONLY) | SQLITE_OPEN_FULLMUTEX
        let code = sqlite3_open_v2(databaseURL(in: directory).path, &database, flags, nil)
        guard code == SQLITE_OK, let database else {
            let error = sqliteError(database, "Synthetic workspace open failed")
            if let database { sqlite3_close(database) }
            throw error
        }
        defer { sqlite3_close(database) }
        sqlite3_busy_timeout(database, 5_000)
        return try body(database)
    }

    private static func statement(_ database: OpaquePointer, sql: String,
                                  parameters: [SQLValue]) throws -> OpaquePointer {
        var prepared: OpaquePointer?
        guard sqlite3_prepare_v2(database, sql, -1, &prepared, nil) == SQLITE_OK, let prepared else {
            throw sqliteError(database, "Synthetic SQL preparation failed")
        }
        do {
            guard sqlite3_bind_parameter_count(prepared) == Int32(parameters.count) else {
                throw LabError.message("Synthetic SQL parameter count mismatch")
            }
            let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)
            for (offset, value) in parameters.enumerated() {
                let index = Int32(offset + 1)
                let code: Int32
                switch value {
                case .null: code = sqlite3_bind_null(prepared, index)
                case .integer(let value): code = sqlite3_bind_int64(prepared, index, value)
                case .real(let value): code = sqlite3_bind_double(prepared, index, value)
                case .text(let value): code = value.withCString { sqlite3_bind_text(prepared, index, $0, -1, transient) }
                case .blob(let value):
                    if value.isEmpty { code = sqlite3_bind_zeroblob(prepared, index, 0) }
                    else {
                        code = value.withUnsafeBytes { sqlite3_bind_blob(prepared, index, $0.baseAddress, Int32(value.count), transient) }
                    }
                }
                guard code == SQLITE_OK else { throw sqliteError(database, "Synthetic SQL binding failed") }
            }
            return prepared
        } catch {
            sqlite3_finalize(prepared)
            throw error
        }
    }

    static func query(in directory: URL, sql: String,
                      parameters: [SQLValue] = []) throws -> [[String: SQLValue]] {
        try withDatabase(in: directory) { database in
            let prepared = try statement(database, sql: sql, parameters: parameters)
            defer { sqlite3_finalize(prepared) }
            var rows: [[String: SQLValue]] = []
            while true {
                let code = sqlite3_step(prepared)
                if code == SQLITE_DONE { return rows }
                guard code == SQLITE_ROW else { throw sqliteError(database, "Synthetic SQL query failed") }
                var row: [String: SQLValue] = [:]
                for column in 0..<sqlite3_column_count(prepared) {
                    let key = String(cString: sqlite3_column_name(prepared, column))
                    switch sqlite3_column_type(prepared, column) {
                    case SQLITE_NULL: row[key] = .null
                    case SQLITE_INTEGER: row[key] = .integer(sqlite3_column_int64(prepared, column))
                    case SQLITE_FLOAT: row[key] = .real(sqlite3_column_double(prepared, column))
                    case SQLITE_TEXT:
                        let length = Int(sqlite3_column_bytes(prepared, column))
                        guard let pointer = sqlite3_column_text(prepared, column) else {
                            throw LabError.message("Synthetic SQL text was unavailable")
                        }
                        row[key] = .text(String(decoding: UnsafeBufferPointer(start: pointer, count: length), as: UTF8.self))
                    case SQLITE_BLOB:
                        let length = Int(sqlite3_column_bytes(prepared, column))
                        if length == 0 { row[key] = .blob(Data()) }
                        else if let pointer = sqlite3_column_blob(prepared, column) {
                            row[key] = .blob(Data(bytes: pointer, count: length))
                        } else { throw LabError.message("Synthetic SQL blob was unavailable") }
                    default: throw LabError.message("Synthetic SQL storage type was unsupported")
                    }
                }
                rows.append(row)
            }
        }
    }

    /// One prepared SQL statement, including a complete CREATE TRIGGER body.
    static func execute(in directory: URL, sql: String, parameters: [SQLValue] = []) throws {
        try withDatabase(in: directory, writable: true) { database in
            let prepared = try statement(database, sql: sql, parameters: parameters)
            defer { sqlite3_finalize(prepared) }
            guard sqlite3_step(prepared) == SQLITE_DONE else {
                throw sqliteError(database, "Synthetic SQL execution failed")
            }
        }
    }

    /// Call only after the baseline workspace's asynchronous close completes.
    /// SQLite backup avoids copying an uncheckpointed main file or sharing a WAL.
    static func copyClosedBaseline(from source: URL, to destinations: [URL]) throws {
        try withDatabase(in: source) { sourceDatabase in
            for destination in destinations {
                try FileManager.default.createDirectory(at: destination, withIntermediateDirectories: true)
                let target = databaseURL(in: destination)
                guard !FileManager.default.fileExists(atPath: target.path) else {
                    throw LabError.message("Synthetic replica destination already exists")
                }
                var destinationDatabase: OpaquePointer?
                let code = sqlite3_open_v2(target.path, &destinationDatabase,
                    SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX, nil)
                guard code == SQLITE_OK, let destinationDatabase else {
                    let error = sqliteError(destinationDatabase, "Synthetic replica open failed")
                    if let destinationDatabase { sqlite3_close(destinationDatabase) }
                    throw error
                }
                defer { sqlite3_close(destinationDatabase) }
                guard let backup = sqlite3_backup_init(destinationDatabase, "main", sourceDatabase, "main") else {
                    throw sqliteError(destinationDatabase, "Synthetic replica backup could not start")
                }
                let copied = sqlite3_backup_step(backup, -1)
                let finished = sqlite3_backup_finish(backup)
                guard copied == SQLITE_DONE && finished == SQLITE_OK else {
                    throw sqliteError(destinationDatabase, "Synthetic replica backup failed")
                }
            }
        }
    }

    static func localPackets(in directory: URL, documentID: String,
                             excluding: Set<String> = []) throws -> [RemoteProseTestPacket] {
        let rows = try query(in: directory, sql: """
            SELECT c.project_id, c.project_sync_id, c.sync_generation_id,
                   c.change_set_id, c.payload_sha256, c.encoded_bytes
            FROM sync_change_set AS c
            WHERE c.origin = 'local' AND c.apply_state = 'applied'
              AND EXISTS (SELECT 1 FROM sync_apply_receipt AS r WHERE r.change_set_id = c.change_set_id)
              AND EXISTS (SELECT 1 FROM sync_mutation AS m
                          WHERE m.change_set_id = c.change_set_id AND m.target_id = ? AND m.action = 'yjs.update')
              AND NOT EXISTS (SELECT 1 FROM sync_mutation AS m
                              WHERE m.change_set_id = c.change_set_id AND m.action <> 'yjs.update')
            ORDER BY c.rowid
            """, parameters: [.text(documentID)])
        return try rows.compactMap { row in
            guard case .text(let projectID) = row["project_id"],
                  case .text(let projectSyncID) = row["project_sync_id"],
                  case .text(let generationID) = row["sync_generation_id"],
                  case .text(let changeSetID) = row["change_set_id"],
                  case .text(let envelopeHash) = row["payload_sha256"],
                  case .blob(let envelope) = row["encoded_bytes"], !envelope.isEmpty else {
                throw LabError.message("Synthetic original discovery found malformed journal storage")
            }
            guard !excluding.contains(changeSetID) else { return nil }
            return RemoteProseTestPacket(original: RemoteProseOriginal(
                projectId: projectID, projectSyncId: projectSyncID, syncGenerationId: generationID,
                changeSetId: changeSetID, originalEnvelopeSha256: envelopeHash), envelope: envelope)
        }
    }

    static func durableCounts(in directory: URL, documentID: String) throws -> [String: Int64] {
        let rows = try query(in: directory, sql: """
            SELECT
              (SELECT COUNT(*) FROM sync_change_set) AS sync_change_set,
              (SELECT COUNT(*) FROM sync_mutation) AS sync_mutation,
              (SELECT COUNT(*) FROM sync_apply_receipt) AS sync_apply_receipt,
              (SELECT COUNT(*) FROM sync_yjs_materialization_receipt) AS sync_yjs_materialization_receipt,
              (SELECT COUNT(*) FROM yjs_updates WHERE document_id = ?1) AS yjs_updates,
              (SELECT COUNT(*) FROM yjs_snapshots WHERE document_id = ?1) AS yjs_snapshots,
              (SELECT COUNT(*) FROM yjs_document_revision_provenance WHERE document_id = ?1) AS yjs_document_revision_provenance,
              COALESCE((SELECT revision FROM yjs_document_revision WHERE document_id = ?1), 0) AS revision
            """, parameters: [.text(documentID)])
        guard let row = rows.first else { throw LabError.message("Synthetic durable counts did not return") }
        return try row.mapValues { value in
            guard case .integer(let count) = value else { throw LabError.message("Synthetic durable count was not an integer") }
            return count
        }
    }
}
