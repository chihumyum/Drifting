import Foundation

/// `workspaceTransfer {"action":"exportArchive"}`: one project's relational
/// Markdown, a file per chapter, drift, element, category, storyline, note
/// and material plus `index.md` and `README.md`, for the host to write.
struct WorkspaceMarkdownArchive: Decodable, Equatable {
    struct File: Decodable, Equatable {
        /// Relative, `/`-separated, e.g. `book/chapters/001-雨夜-<id>.md`.
        let path: String
        let text: String
    }
    let projectName: String
    /// Entity pages; `files` also holds the index and the README.
    let documentCount: Int
    let files: [File]
}

/// 导出为 Markdown 文件夹: creates `<项目名>-<yyyy-MM-dd>` inside the chosen
/// folder (a numeric suffix instead of overwriting anything) and writes every
/// file as UTF-8, creating subfolders. Every path is checked before the
/// first byte is written: a path that could leave the folder refuses it all.
enum MarkdownFolderWriter {
    /// The folder name for a project on a day, safe for the file system.
    static func folderName(projectName: String, date: Date) -> String {
        let formatter = DateFormatter()
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyy-MM-dd"
        var name = projectName.trimmingCharacters(in: .whitespacesAndNewlines)
            .replacingOccurrences(of: "/", with: "／").replacingOccurrences(of: ":", with: "：")
            .components(separatedBy: .controlCharacters).joined()
        while name.hasPrefix(".") { name.removeFirst() }
        if name.isEmpty { name = "未命名项目" }
        return "\(String(name.prefix(80)))-\(formatter.string(from: date))"
    }

    /// The path's components when it stays inside the export folder.
    static func components(of path: String) throws -> [String] {
        let parts = path.split(separator: "/", omittingEmptySubsequences: false).map(String.init)
        let refused = path.isEmpty || path.hasPrefix("/") || path.hasPrefix("~") || path.contains("\\") || path.contains("\u{0}")
            || parts.contains { $0.isEmpty || $0 == "." || $0 == ".." }
        guard !refused else { throw LabError.message("导出内容包含无效的文件路径“\(path)”，已停止导出，没有写入任何文件。") }
        return parts
    }

    /// Writes the archive into a new folder inside `parent` and returns it.
    static func write(_ archive: WorkspaceMarkdownArchive, into parent: URL, date: Date = Date(),
                      fileManager: FileManager = .default) throws -> URL {
        let checked = try archive.files.map { (try components(of: $0.path), $0.text) }
        guard Set(checked.map { $0.0.joined(separator: "/").lowercased() }).count == checked.count else {
            throw LabError.message("导出内容包含重复的文件路径，已停止导出，没有写入任何文件。")
        }
        let base = folderName(projectName: archive.projectName, date: date)
        var folder = parent.appendingPathComponent(base, isDirectory: true)
        var suffix = 1
        while true {
            do {
                // Never an existing folder: creation fails instead of merging.
                try fileManager.createDirectory(at: folder, withIntermediateDirectories: false)
                break
            } catch let error as CocoaError where error.code == .fileWriteFileExists {
                suffix += 1
                guard suffix < 1000 else { throw LabError.message("目标位置已有太多同名文件夹，请换一个位置再试。") }
                folder = parent.appendingPathComponent("\(base)-\(suffix)", isDirectory: true)
            } catch {
                throw LabError.message("无法在所选位置创建文件夹，请换一个位置再试。")
            }
        }
        let root = folder.standardizedFileURL.path
        for (parts, text) in checked {
            let url = parts.reduce(folder) { $0.appendingPathComponent($1) }
            guard url.standardizedFileURL.path.hasPrefix(root + "/") else {
                throw LabError.message("导出内容包含无效的文件路径，已停止导出。")
            }
            do {
                try fileManager.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
                try Data(text.utf8).write(to: url, options: .withoutOverwriting)
            } catch {
                throw LabError.message("无法写入“\(parts.joined(separator: "/"))”，导出未完成。已写入的文件保留在“\(folder.lastPathComponent)”中。")
            }
        }
        return folder
    }
}
