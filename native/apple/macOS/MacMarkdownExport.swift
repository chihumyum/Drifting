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
