import AppKit

/// 文件 › 导出为 Markdown 文件夹… (and per project on the 项目书架): asks for a
/// destination folder, reads the project's relational Markdown from Rust
/// and writes it into a new `<项目名>-<yyyy-MM-dd>` folder there, then
/// reports the count and offers 在访达中显示. Reading writes nothing.
final class MacMarkdownFolderExport {
    private let workspace: LabWorkspaceCore
    /// Chooses the destination folder; nil uses an open panel. Acceptance answers here.
    var chooseFolder: ((NSWindow?, @escaping (URL?) -> Void) -> Void)?
    /// Shows the result; nil presents it on the window. Acceptance answers here.
    var presentAlert: ((NSAlert, @escaping (NSApplication.ModalResponse) -> Void) -> Void)?
    /// Shows the new folder in the Finder; nil asks NSWorkspace.
    var reveal: ((URL) -> Void)?
    var onStatus: ((String) -> Void)?
    /// The day in the folder name.
    var now: () -> Date = Date.init
    private(set) var isExporting = false
    private(set) var lastAlert: NSAlert?

    init(workspace: LabWorkspaceCore) { self.workspace = workspace }

    func begin(project: WorkspaceProject, window: NSWindow?, completion: ((Result<URL, Error>) -> Void)? = nil) {
        guard !isExporting else { completion?(.failure(LabError.message("正在导出，请稍候。"))); return }
        let finish: (URL?) -> Void = { [weak self] folder in
            guard let self else { return }
            guard let folder else { completion?(.failure(LabError.message("已取消导出。"))); return }
            self.export(project: project, into: folder, window: window, completion: completion)
        }
        if let chooseFolder { chooseFolder(window, finish); return }
        let panel = NSOpenPanel()
        panel.title = "导出为 Markdown 文件夹"
        panel.message = "选择一个位置。会在其中新建“\(MarkdownFolderWriter.folderName(projectName: project.name, date: now()))”文件夹，每个章节、漂流、设定、分类、故事线、批注和素材各写成一个 Markdown 文件。"
        panel.prompt = "导出到这里"
        panel.canChooseFiles = false
        panel.canChooseDirectories = true
        panel.canCreateDirectories = true
        panel.allowsMultipleSelection = false
        if let window { panel.beginSheetModal(for: window) { finish($0 == .OK ? panel.url : nil) } }
        else { finish(panel.runModal() == .OK ? panel.url : nil) }
    }

    private func export(project: WorkspaceProject, into parent: URL, window: NSWindow?,
                        completion: ((Result<URL, Error>) -> Void)?) {
        isExporting = true
        onStatus?("正在导出“\(project.name)”为 Markdown 文件夹…")
        workspace.exportArchive(projectID: project.id) { [weak self] result in
            guard let self else { return }
            self.isExporting = false
            let written = result.flatMap { archive in
                Result<(URL, WorkspaceMarkdownArchive), Error> {
                    (try MarkdownFolderWriter.write(archive, into: parent, date: self.now()), archive)
                }
            }
            switch written {
            case .success(let (folder, archive)):
                let message = "已导出 \(archive.files.count) 个 Markdown 文件到“\(folder.lastPathComponent)”。"
                self.onStatus?(message)
                self.report(folder: folder, archive: archive, window: window)
                completion?(.success(folder))
            case .failure(let error):
                self.onStatus?(error.localizedDescription)
                completion?(.failure(error))
            }
        }
    }

    // MARK: 导出全部项目

    /// One project's result in 导出全部项目: its folder and file count, or why it failed.
    struct ProjectExport: Equatable {
        let project: WorkspaceProject
        let folder: URL?
        let files: Int
        let failure: String?
    }

    /// 文件 › 导出全部项目为 Markdown 文件夹…: asks for a location, creates a new
    /// `全部项目-<yyyy-MM-dd>` folder there (`-2`, `-3` … when it exists) and
    /// writes each project's archive into its own folder inside it, as
    /// 导出为 Markdown 文件夹 does (same path checks and naming). A project
    /// that fails is reported and the others still export. Reading writes
    /// nothing. `completion` gets the outer folder and each project's result.
    func beginAll(projects: [WorkspaceProject], window: NSWindow?,
                  completion: ((Result<(URL, [ProjectExport]), Error>) -> Void)? = nil) {
        guard !isExporting else { completion?(.failure(LabError.message("正在导出，请稍候。"))); return }
        guard !projects.isEmpty else { completion?(.failure(LabError.message("还没有项目可以导出。"))); return }
        let finish: (URL?) -> Void = { [weak self] parent in
            guard let self else { return }
            guard let parent else { completion?(.failure(LabError.message("已取消导出。"))); return }
            let folder: URL
            do { folder = try MarkdownFolderWriter.newFolder(Self.allFolderName(date: self.now()), in: parent) } catch {
                self.onStatus?(error.localizedDescription); completion?(.failure(error)); return
            }
            self.isExporting = true
            self.onStatus?("正在导出全部 \(projects.count) 个项目为 Markdown 文件夹…")
            self.exportEach(projects[...], into: folder, done: []) { [weak self] results in
                guard let self else { return }
                self.isExporting = false
                self.reportAll(folder: folder, results: results, window: window)
                completion?(.success((folder, results)))
            }
        }
        if let chooseFolder { chooseFolder(window, finish); return }
        let panel = NSOpenPanel()
        panel.title = "导出全部项目为 Markdown 文件夹"
        panel.message = "选择一个位置。会在其中新建“\(Self.allFolderName(date: now()))”文件夹，每个项目各写成其中的一个文件夹。"
        panel.prompt = "导出到这里"
        panel.canChooseFiles = false
        panel.canChooseDirectories = true
        panel.canCreateDirectories = true
        panel.allowsMultipleSelection = false
        if let window { panel.beginSheetModal(for: window) { finish($0 == .OK ? panel.url : nil) } }
        else { finish(panel.runModal() == .OK ? panel.url : nil) }
    }

    /// `全部项目-2026-09-29`.
    static func allFolderName(date: Date) -> String { MarkdownFolderWriter.folderName(projectName: "全部项目", date: date) }

    private func exportEach(_ remaining: ArraySlice<WorkspaceProject>, into folder: URL, done: [ProjectExport],
                            completion: @escaping ([ProjectExport]) -> Void) {
        guard let project = remaining.first else { completion(done); return }
        workspace.exportArchive(projectID: project.id) { [weak self] result in
            guard let self else { return }
            let written = result.flatMap { archive in
                Result<ProjectExport, Error> {
                    let path = try MarkdownFolderWriter.write(archive, into: folder, date: self.now())
                    return ProjectExport(project: project, folder: path, files: archive.files.count, failure: nil)
                }
            }
            let entry = (try? written.get()) ?? ProjectExport(project: project, folder: nil, files: 0,
                failure: written.failureMessage)
            self.exportEach(remaining.dropFirst(), into: folder, done: done + [entry], completion: completion)
        }
    }

    private func reportAll(folder: URL, results: [ProjectExport], window: NSWindow?) {
        let exported = results.filter { $0.failure == nil }
        let files = exported.reduce(0) { $0 + $1.files }
        let failed = results.filter { $0.failure != nil }
        let message = "已导出 \(exported.count) 个项目、共 \(files) 个 Markdown 文件到“\(folder.lastPathComponent)”。"
            + (failed.isEmpty ? "" : "\(failed.count) 个项目未能导出。")
        onStatus?(message)
        let alert = NSAlert()
        alert.messageText = failed.isEmpty ? "已导出 \(exported.count) 个项目" : "已导出 \(exported.count) 个项目，\(failed.count) 个未能导出"
        var lines = exported.map { "“\($0.project.name)”：\($0.files) 个文件，在“\($0.folder?.lastPathComponent ?? "")”" }
        lines += failed.map { "“\($0.project.name)”未能导出：\($0.failure ?? "")" }
        alert.informativeText = "共 \(files) 个 Markdown 文件，已写入“\(folder.lastPathComponent)”。\n" + lines.joined(separator: "\n")
        alert.addButton(withTitle: "在访达中显示").setAccessibilityIdentifier("markdown-export-reveal")
        alert.addButton(withTitle: "好")
        lastAlert = alert
        let done: (NSApplication.ModalResponse) -> Void = { [weak self] response in
            guard response == .alertFirstButtonReturn else { return }
            if let reveal = self?.reveal { reveal(folder) } else { NSWorkspace.shared.activateFileViewerSelecting([folder]) }
        }
        if let presentAlert { presentAlert(alert, done) }
        else if let window { alert.beginSheetModal(for: window, completionHandler: done) }
        else { done(alert.runModal()) }
    }

    private func report(folder: URL, archive: WorkspaceMarkdownArchive, window: NSWindow?) {
        let alert = NSAlert()
        alert.messageText = "已导出 \(archive.files.count) 个 Markdown 文件"
        alert.informativeText = "“\(archive.projectName)”的 \(archive.documentCount) 个条目，以及索引和说明，已写入“\(folder.lastPathComponent)”。条目之间用 [[路径|标题]] 互相链接；图片和 PDF 不包含在内。"
        alert.addButton(withTitle: "在访达中显示").setAccessibilityIdentifier("markdown-export-reveal")
        alert.addButton(withTitle: "好")
        lastAlert = alert
        let done: (NSApplication.ModalResponse) -> Void = { [weak self] response in
            guard response == .alertFirstButtonReturn else { return }
            if let reveal = self?.reveal { reveal(folder) } else { NSWorkspace.shared.activateFileViewerSelecting([folder]) }
        }
        if let presentAlert { presentAlert(alert, done) }
        else if let window { alert.beginSheetModal(for: window, completionHandler: done) }
        else { done(alert.runModal()) }
    }
}

private extension Result where Failure == Error {
    var failureMessage: String? {
        if case .failure(let error) = self { return error.localizedDescription }
        return nil
    }
}
