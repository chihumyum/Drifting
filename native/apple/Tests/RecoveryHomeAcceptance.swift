import AppKit
import CryptoKit

/// 恢复 (the database recovery window) and 项目主页 through the real AppKit
/// controllers, the tab host, the Rust workspace and SQLite, wired as
/// AppDelegate wires them. A failed upgrade is provoked with the debug
/// bridge's fault seam on a synthetic lab directory; panels, alerts and
/// pasteboards are answered here without windows on screen. Every title,
/// body and file is synthetic.
extension BindingAcceptance {
    static let databaseFault = "DRIFTING_TEST_DATABASE_FAULT_STAGE"

    static func recoveryHomeAcceptance() throws -> [String] {
        // The fault seam never outlives this suite, whatever fails.
        unsetenv(databaseFault)
        defer { unsetenv(databaseFault) }
        let saved = (DocumentStore.entityLinkDelay, MacChapterWorkspace.backlinkDelay, WordCountModel.refreshDelay, ProjectHomeModel.stampDelay)
        defer { (DocumentStore.entityLinkDelay, MacChapterWorkspace.backlinkDelay, WordCountModel.refreshDelay, ProjectHomeModel.stampDelay) = saved }
        DocumentStore.entityLinkDelay = 0.05
        MacChapterWorkspace.backlinkDelay = 0.05
        WordCountModel.refreshDelay = 0.05
        ProjectHomeModel.stampDelay = 0.05
        try recoveryWindow()
        try projectHome()
        try projectHomeRecents()
        return [
            "AppKit 恢复 shows instead of the workspace when an upgrade stops: the previous database is untouched, nothing opens and later reads refuse without opening, and the window states in Chinese what happened, the versions and the verified safety copy's size, time and SHA-256 prefix",
            "AppKit 恢复 exports the safety copy through the save panel under its default name as a verified copy whose bytes equal it while the original stays, shows its folder in Finder, and copies diagnostics with the code, versions, app and macOS versions and architecture but no path, title or identity beyond the recovery session",
            "AppKit 恢复 重试 while the upgrade still fails updates the window from the new failure, 恢复安全副本… asks first (取消 writes nothing) and rebuilds the library from the copy made before the upgrade and opens it with the synthetic project and its chapter text, 重试 opens it once the fault is gone, and a failure without a safety copy turns off the buttons that need one",
            "AppKit 项目主页 opens as one tab per project from 视图 › 项目主页 and the project shelf, reused when open, shows the name, summary, 故事线, 章节, 设定, 总字数 and 最后编辑 as Rust reports them and chapter statuses with a progress bar, 编辑资料… opens 项目资料 whose saved summary it follows, and 继续写作 names the most recently edited chapter with its last paragraph and opens it",
            "AppKit 项目主页 reads 今日, 连续天数, 本周 and 本月 from a seeded 今日字数 ledger against the 写作计划 across a month boundary and follows today's words, lists storyline tracks with their chapters in book order as status-coloured items that open the chapter, and categories with element counts that open the category page and follow a category trash",
            "AppKit 项目主页 最近 lists the last ten pages this device opened newest first without duplicates, opens them, leaves out a trashed page until it is restored and forgets a purged one, follows a chapter rename, a status change, word counts and a project rename, writes nothing to the journal, and shows the same counts and pages after a cold relaunch from settings.json",
        ]
    }

    // MARK: 恢复

    private static func sha256(_ url: URL) throws -> String {
        SHA256.hash(data: try Data(contentsOf: url)).map { String(format: "%02x", $0) }.joined()
    }

    /// The database and its write-ahead log, as bytes.
    private static func databaseDigest(_ lab: URL) throws -> [String] {
        try ["apple-native-workspace.db", "apple-native-workspace.db-wal"].map { lab.appendingPathComponent($0) }
            .filter { FileManager.default.fileExists(atPath: $0.path) }.map(sha256)
    }

    /// Makes the next open take the upgrade path: the last-version marker goes.
    private static func removeVersionMarker(_ lab: URL) throws {
        let marker = lab.appendingPathComponent("safety-backups/apple-native-workspace.db.last-version")
        try require(FileManager.default.fileExists(atPath: marker.path), "The workspace wrote no version marker")
        try FileManager.default.removeItem(at: marker)
    }

    /// The recovery window's panels, answered here.
    private final class RecoveryAnswers {
        var alerts: [NSAlert] = []
        var answer = NSApplication.ModalResponse.alertFirstButtonReturn
        var names: [String] = []
        var destination: URL?
        var revealed: [URL] = []
        var quits = 0
        let pasteboard = NSPasteboard(name: NSPasteboard.Name("drifting-acceptance-\(UUID().uuidString)"))

        func configure(_ controller: MacDatabaseRecoveryWindowController) {
            controller.pasteboard = pasteboard
            controller.presentAlert = { [unowned self] alert, done in self.alerts.append(alert); done(self.answer) }
            controller.chooseSaveURL = { [unowned self] name, done in self.names.append(name); done(self.destination) }
            controller.reveal = { [unowned self] in self.revealed.append($0) }
            controller.quit = { [unowned self] in self.quits += 1 }
        }
    }

    private static func recoveryWindow() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let lab = root.appendingPathComponent("apple-native-lab")
        defer { try? FileManager.default.removeItem(at: root) }
        let answers = RecoveryAnswers()
        defer { answers.pasteboard.releaseGlobally() }

        // A workspace with a synthetic project and chapter text, closed as quitting does.
        let first = LabWorkspaceCore(directory: lab)
        let listed: [WorkspaceProject] = try elementResult { first.projects(completion: $0) }
        try require(listed.isEmpty, "The recovery fixture was not isolated")
        let project: WorkspaceProject = try elementResult { first.createProject(name: "恢复合成项目", completion: $0) }
        let chapter: WorkspaceChapter = try elementResult { first.createChapter(projectID: project.id, title: "雾中灯塔", completion: $0) }
        let prose = "灯塔在雾里亮了一夜。"
        do {
            let (window, host) = elementHost(first)
            defer { window.close() }
            let view: NativeDocumentView = try elementResult { host.open(project: project, chapter: chapter, completion: $0) }
            try elementSettled(host, view)
            view.textView.setSelectedRange(NSRange(location: 0, length: 0))
            view.textView.insertText(prose, replacementRange: NSRange(location: 0, length: 0))
            try elementSettled(host, view)
            let closed: Bool = try elementResult { host.close(completion: $0) }
            try require(closed, "The first workspace did not close")
        }

        // The next launch takes the upgrade path and stops inside the shadow migration.
        try removeVersionMarker(lab)
        let before = try databaseDigest(lab)
        setenv(databaseFault, "migration", 1)
        let relaunched = LabWorkspaceCore(directory: lab)
        let coordinator = DatabaseRecoveryCoordinator(workspace: relaunched)
        var recovering = 0
        var recovered: [WorkspaceProject]?
        coordinator.onRecovering = { recovering += 1 }
        coordinator.onRecovered = { recovered = $0 }
        coordinator.configure = { answers.configure($0) }
        var launch: Result<[WorkspaceProject], Error>?
        coordinator.open { launch = $0 }
        try wait { launch != nil }
        guard case .failure(let failure)? = launch, DatabaseRecoveryCoordinator.isOpenFailure(failure),
              let controller = coordinator.controller else {
            throw LabError.message("The failed upgrade did not show 恢复: \(String(describing: launch))")
        }
        defer { controller.onOpened = nil; controller.window?.close() }
        try require((failure as? LabError)?.diagnosticDescription.hasPrefix("database-recovery:") == true, "The open did not stop for recovery")
        try wait { controller.status != nil && !controller.busy }
        guard let status = controller.status, let backup = status.safetyBackup, let session = status.recoverySessionId else {
            throw LabError.message("恢复 has no safety copy")
        }
        try require(recovering == 1 && recovered == nil && controller.window?.isVisible == true, "恢复 did not show instead of the workspace")
        try require(controller.headline.stringValue == "升级本地资料库时停止，之前的资料库保持原样。"
            && status.code == "migration-statement-failed" && controller.codeValue.stringValue == status.code
            && controller.versionValue.stringValue == "\(status.sourceVersion ?? "未知") → \(status.targetVersion)"
            && controller.backupValue.stringValue.contains(DatabaseRecoveryText.size(backup.sizeBytes))
            && controller.backupValue.stringValue.contains(DatabaseRecoveryText.time(backup.createdAtMs))
            && controller.backupValue.stringValue.hasSuffix("SHA-256 \(backup.sha256.prefix(12))") && backup.sizeBytes > 0
            && controller.detail.stringValue.contains("安全副本"),
            "恢复 shows \(controller.headline.stringValue) / \(controller.codeValue.stringValue) / \(controller.versionValue.stringValue) / \(controller.backupValue.stringValue)")
        try require([controller.retryButton, controller.restoreButton, controller.exportButton, controller.revealButton,
                     controller.copyButton, controller.quitButton].allSatisfy(\.isEnabled), "A 恢复 button is off with a safety copy")
        // Nothing opened: reads refuse with the failure instead of opening again.
        let refusal = try elementRefused({ (done: @escaping (Result<[WorkspaceProject], Error>) -> Void) in relaunched.projects(completion: done) },
                                         "A read opened the workspace while 恢复 showed")
        try require(refusal == "升级本地资料库时停止，之前的资料库保持原样。", "The refusal reads \(refusal)")
        _ = try elementRefused({ (done: @escaping (Result<AgentJSON, Error>) -> Void) in relaunched.diagnostics(completion: done) },
                               "The diagnostic summary read a workspace while 恢复 showed")
        try require(try databaseDigest(lab) == before, "The failed upgrade changed the previous database")

        // 导出安全副本…: a verified copy under the default name; the original stays.
        let exports = root.appendingPathComponent("导出", isDirectory: true)
        try FileManager.default.createDirectory(at: exports, withIntermediateDirectories: true)
        let name = "Drifting-database-safety-\(backup.backupId.prefix(16)).sqlite"
        answers.destination = exports.appendingPathComponent(name)
        let exported: URL = try elementResult { controller.export(completion: $0) }
        let original: URL = try elementResult { relaunched.recoveryBackupFile(sessionID: session, backupID: backup.backupId, completion: $0) }
        try require(answers.names == [name] && exported == answers.destination
            && (try Data(contentsOf: exported)) == (try Data(contentsOf: original)) && (try sha256(exported)) == backup.sha256
            && FileManager.default.fileExists(atPath: original.path)
            && controller.notice.stringValue == "安全副本已导出为“\(name)”。",
            "The export differs: \(answers.names) \(controller.notice.stringValue)")
        // Exporting over it again replaces it with the same bytes.
        let again: URL = try elementResult { controller.export(completion: $0) }
        try require(again == exported && (try sha256(again)) == backup.sha256
            && (try FileManager.default.contentsOfDirectory(atPath: exports.path)) == [name], "A second export left something else behind")

        // 在访达中显示: the folder holding the copy.
        let folder: URL = try elementResult { controller.revealBackupFolder(completion: $0) }
        try require(answers.revealed == [folder]
            && folder.standardizedFileURL.path == original.deletingLastPathComponent().standardizedFileURL.path,
            "在访达中显示 revealed \(answers.revealed)")

        // 拷贝诊断信息: code, versions and host facts, nothing that names the book or the device's paths.
        controller.copyDiagnostics()
        guard let text = answers.pasteboard.string(forType: .string),
              let object = try JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any],
              let host = object["host"] as? [String: Any] else { throw LabError.message("拷贝诊断信息 copied no JSON") }
        let version = ProcessInfo.processInfo.operatingSystemVersion
        try require(object["kind"] as? String == "drifting-database-recovery" && object["code"] as? String == status.code
            && object["targetVersion"] as? String == status.targetVersion && object["recoverySessionId"] as? String == session
            && object["safetyBackupAvailable"] as? Bool == true
            && host["macOS"] as? String == "\(version.majorVersion).\(version.minorVersion).\(version.patchVersion)"
            && ["arm64", "x86_64"].contains(host["architecture"] as? String ?? "") && host["appVersion"] != nil,
            "The diagnostics lack facts: \(text)")
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        for secret in [root.path, lab.path, home, NSUserName(), "恢复合成项目", "雾中灯塔", "灯塔在雾里", project.id, chapter.id,
                       backup.backupId, backup.sha256, original.lastPathComponent] {
            try require(!text.contains(secret), "The diagnostics name \(secret)")
        }

        // 重试 while the upgrade still fails: the window follows the new failure.
        let reads = controller.statusReads
        controller.retry()
        try wait { controller.statusReads > reads && !controller.busy }
        try require(recovered == nil && coordinator.isRecovering && controller.status?.safetyBackup != nil
            && controller.notice.stringValue == "重试没有成功，资料库保持原样。"
            && controller.headline.stringValue == "升级本地资料库时停止，之前的资料库保持原样。",
            "A failing 重试 reads \(controller.notice.stringValue)")
        try require(try databaseDigest(lab) == before, "A failing 重试 changed the previous database")

        // 恢复安全副本…: 取消 writes nothing; 恢复 rebuilds from the copy and opens.
        unsetenv(databaseFault)
        answers.answer = .alertSecondButtonReturn
        controller.restore()
        try require(answers.alerts.count == 1 && answers.alerts[0].messageText == "用安全副本恢复资料库？"
            && answers.alerts[0].informativeText.contains("升级前") && answers.alerts[0].informativeText.contains("重建本地资料库")
            && answers.alerts[0].buttons.map(\.title) == ["恢复", "取消"] && !controller.busy && recovered == nil,
            "The restore confirmation differs")
        try require(try databaseDigest(lab) == before, "取消 changed the database")
        answers.answer = .alertFirstButtonReturn
        controller.restore()
        try wait { recovered != nil }
        try require(recovered?.map(\.name) == ["恢复合成项目"] && !coordinator.isRecovering && controller.window?.isVisible != true
            && answers.quits == 0 && recovering == 1, "The restore did not open the workspace: \(recovered ?? [])")
        do {
            let (window, host) = elementHost(relaunched)
            defer { window.close() }
            let view: NativeDocumentView = try elementResult { host.open(project: project, chapter: chapter, completion: $0) }
            try elementSettled(host, view)
            try require(view.textView.string.contains(prose), "The restored chapter reads \(view.textView.string)")
            let closed: Bool = try elementResult { host.close(completion: $0) }
            try require(closed, "The restored workspace did not close")
        }

        // 重试 once the fault is gone opens the workspace.
        try removeVersionMarker(lab)
        setenv(databaseFault, "migration", 1)
        let third = LabWorkspaceCore(directory: lab)
        let retrying = DatabaseRecoveryCoordinator(workspace: third)
        var reopened: [WorkspaceProject]?
        retrying.onRecovered = { reopened = $0 }
        retrying.configure = { answers.configure($0) }
        var second: Result<[WorkspaceProject], Error>?
        retrying.open { second = $0 }
        try wait { second != nil && retrying.controller?.status != nil && retrying.controller?.busy == false }
        guard let retryController = retrying.controller else { throw LabError.message("The second failure showed no 恢复") }
        defer { retryController.onOpened = nil; retryController.window?.close() }
        // A safety copy moved away no longer verifies: it is not offered, and the code is the open's own.
        guard let secondSession = retryController.status?.recoverySessionId,
              let secondBackup = retryController.status?.safetyBackup else { throw LabError.message("The second failure has no safety copy") }
        let copy: URL = try elementResult { third.recoveryBackupFile(sessionID: secondSession, backupID: secondBackup.backupId, completion: $0) }
        let aside = root.appendingPathComponent("moved-safety-copy.sqlite")
        try FileManager.default.moveItem(at: copy, to: aside)
        let unverifiedReads = retryController.statusReads
        retryController.retry()
        try wait { retryController.statusReads > unverifiedReads && !retryController.busy }
        try require(retryController.status?.code == "safety-backup-invalid" && retryController.status?.safetyBackup == nil
            && retryController.codeValue.stringValue == "safety-backup-invalid"
            && retryController.backupValue.stringValue == "没有可用的安全副本"
            && retryController.detail.stringValue.contains("无法校验")
            && !retryController.restoreButton.isEnabled && !retryController.exportButton.isEnabled
            && retryController.retryButton.isEnabled && retryController.revealButton.isEnabled && reopened == nil,
            "A moved safety copy reads \(retryController.codeValue.stringValue) / \(retryController.backupValue.stringValue) / \(retryController.detail.stringValue)")
        try FileManager.default.moveItem(at: aside, to: copy)
        unsetenv(databaseFault)
        retryController.retry()
        try wait { reopened != nil }
        try require(reopened?.map(\.name) == ["恢复合成项目"] && !retrying.isRecovering, "重试 did not open the workspace")
        let opened: [WorkspaceProject] = try elementResult { third.projects(completion: $0) }
        try require(opened.map(\.id) == [project.id], "The reopened workspace lists \(opened)")
        let closed: Bool = try elementResult { third.close(completion: $0) }
        try require(closed, "The reopened workspace did not close")

        // Any other failure has no recovery session or safety copy: those buttons are off.
        let plain = MacDatabaseRecoveryWindowController(workspace: LabWorkspaceCore(directory: lab))
        answers.configure(plain)
        defer { plain.window?.close() }
        var shown = false
        plain.show(LabError.workspaceUnavailable(reason: "failed to open database: synthetic")) { shown = true }
        try wait { shown }
        try require(plain.status?.code == "database-open-failed" && plain.headline.stringValue == "无法打开本地资料库。"
            && plain.backupValue.stringValue == "没有可用的安全副本" && plain.retryButton.isEnabled && plain.copyButton.isEnabled
            && plain.quitButton.isEnabled && !plain.restoreButton.isEnabled && !plain.exportButton.isEnabled && !plain.revealButton.isEnabled,
            "A plain failure shows \(plain.headline.stringValue) with restore \(plain.restoreButton.isEnabled)")
        plain.quitApp()
        try require(answers.quits == 1, "退出 did not quit")
    }

    // MARK: 项目主页

    /// 视图 › 项目主页's target, as AppDelegate's action opens the page.
    private final class HomeMenuProbe: NSObject {
        let open: () -> Void
        init(_ open: @escaping () -> Void) { self.open = open }
        @objc func fire(_ sender: Any?) { open() }
    }

    private final class HomeHarness {
        let root: URL
        let directory: URL
        let journal: JournalProbe
        let workspace: LabWorkspaceCore
        let settings: LabSettingsStore
        let project: WorkspaceProject
        let chapters: [WorkspaceChapter]
        let window: NSWindow
        let host: MacChapterWorkspace
        /// The tab host's last refusal, as the status line would show it.
        var lastError: String?

        init(name: String, chapterTitles: [String]) throws {
            root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
            directory = root.appendingPathComponent("apple-native-lab")
            journal = JournalProbe(directory: directory)
            workspace = LabWorkspaceCore(directory: directory)
            settings = LabSettingsStore(directory: root)
            let workspace = self.workspace
            let listed: [WorkspaceProject] = try BindingAcceptance.elementResult { workspace.projects(completion: $0) }
            try BindingAcceptance.require(listed.isEmpty, "The home fixture was not isolated")
            let created: WorkspaceProject = try BindingAcceptance.elementResult { workspace.createProject(name: name, completion: $0) }
            project = created
            chapters = try chapterTitles.map { title in
                try BindingAcceptance.elementResult { workspace.createChapter(projectID: created.id, title: title, completion: $0) }
            }
            (window, host) = BindingAcceptance.elementHost(workspace)
            // As AppDelegate wires the tab host.
            host.homeSettings = settings
            host.plotPlannerSettings = settings
            host.chaptersChanged(projectID: created.id)
            host.onError = { [weak self] in self?.lastError = $0.localizedDescription }
        }

        func cleanup() {
            window.close()
            try? FileManager.default.removeItem(at: root)
        }

        func open(_ chapter: WorkspaceChapter) throws -> NativeDocumentView {
            let view: NativeDocumentView = try BindingAcceptance.elementResult { host.open(project: project, chapter: chapter, completion: $0) }
            try settled(view)
            return view
        }

        func settled(_ views: NativeDocumentView...) throws {
            try BindingAcceptance.wait {
                !self.host.isBusy && views.allSatisfy {
                    $0.binding.state != nil && !$0.binding.hasPendingWork && !$0.binding.store.hasScheduledLinks && !$0.binding.store.isLinking
                }
            }
        }

        func type(_ view: NativeDocumentView, _ text: String) throws {
            let end = (view.textView.string as NSString).length
            view.textView.setSelectedRange(NSRange(location: end, length: 0))
            view.textView.insertText(text, replacementRange: NSRange(location: end, length: 0))
            try settled(view)
        }

        /// Saves stamp milliseconds; apart so the last edit is exact.
        func pause() { RunLoop.current.run(until: Date().addingTimeInterval(0.02)) }

        /// Opens (or shows again) the project's page and waits for its reads.
        @discardableResult
        func home(_ project: WorkspaceProject? = nil) throws -> MacProjectHomeView {
            try BindingAcceptance.wait { !self.host.isBusy && self.host.canNavigate }
            guard let page = host.openHome(project: project ?? self.project) else {
                throw LabError.message("项目主页 did not open: \(lastError ?? "no reason")")
            }
            try settledHome(page)
            return page
        }

        func settledHome(_ page: MacProjectHomeView) throws {
            try BindingAcceptance.wait {
                page.model.loaded && !page.model.loading && self.host.wordCountLibrary(projectID: page.model.projectID)?.ready == true
                    && (page.model.continueChapter == nil || page.model.continueExcerpt != nil)
            }
        }

        func counts() throws -> WordCountLibrary {
            let counts: WorkspaceWordCounts = try BindingAcceptance.elementResult { workspace.wordCounts(projectID: project.id, completion: $0) }
            return WordCountLibrary(counts.counts)
        }
    }

    private static func projectHome() throws {
        let harness = try HomeHarness(name: "主页合成项目", chapterTitles: ["雨夜", "钟楼", "码头"])
        defer { harness.cleanup() }
        let workspace = harness.workspace, host = harness.host, project = harness.project, journal = harness.journal
        let (rain, bell, dock) = (harness.chapters[0], harness.chapters[1], harness.chapters[2])

        // Storylines, memberships, categories, elements and a drift, as the panels write them.
        let main: WorkspaceStorylineReply<WorkspaceStoryline> = try elementResult { workspace.createStoryline(projectID: project.id, name: "主线", completion: $0) }
        let side: WorkspaceStorylineReply<WorkspaceStoryline> = try elementResult { workspace.createStoryline(projectID: project.id, name: "支线", completion: $0) }
        guard let mainLine = main.result, let sideLine = side.result else { throw LabError.message("No storyline was created") }
        var storylines = side.library
        for (chapter, lines, primary) in [(rain, [mainLine.id], mainLine.id), (bell, [mainLine.id, sideLine.id], mainLine.id),
                                          (dock, [sideLine.id], sideLine.id)] {
            let reply: WorkspaceStorylineReply<WorkspaceChapterStorylines> = try elementResult {
                workspace.setChapterStorylines(projectID: project.id, chapterID: chapter.id, storylineIDs: lines, primary: primary, completion: $0)
            }
            storylines = reply.library
        }
        host.applyStorylineLibrary(projectID: project.id, library: storylines)
        let people: WorkspaceElementReply<WorkspaceElementCategory> = try elementResult {
            workspace.createElementCategory(projectID: project.id, name: "人物", completion: $0)
        }
        let places: WorkspaceElementReply<WorkspaceElementCategory> = try elementResult {
            workspace.createElementCategory(projectID: project.id, name: "地点", completion: $0)
        }
        guard let peopleID = people.result?.id, let placesID = places.result?.id else { throw LabError.message("No category was created") }
        var library = places.library
        for (name, category) in [("林雾", peopleID), ("老周", peopleID), ("北塔", placesID)] {
            let reply: WorkspaceElementReply<WorkspaceElement> = try elementResult {
                workspace.createElement(projectID: project.id, categoryID: category, name: name, completion: $0)
            }
            library = reply.library
        }
        host.applyElementLibrary(projectID: project.id, library: library)
        let drift: WorkspaceDriftReply<WorkspaceDrift> = try elementResult { workspace.createDrift(projectID: project.id, title: "灯塔传说", groupID: nil, completion: $0) }
        host.applyDriftLibrary(projectID: project.id, library: drift.library)
        let _: WorkspaceProjectDetails = try elementResult {
            workspace.updateProject(projectID: project.id, changes: WorkspaceProjectChanges(summary: "港口小城的长篇"), completion: $0)
        }
        for (chapter, status) in [(rain, WritingStatus.finished), (dock, .discarded)] {
            let _: WorkspaceNodeMetadata = try elementResult { host.setNodeStatus(projectID: project.id, nodeID: chapter.id, status: status.rawValue, completion: $0) }
        }
        // 雨夜 first, then 钟楼 with two paragraphs: 钟楼 is edited last.
        let rainView = try harness.open(rain)
        try harness.type(rainView, "雨夜里钟声响起。")
        harness.pause()
        let bellView = try harness.open(bell)
        try harness.type(bellView, "钟楼的第一段。")
        try harness.type(bellView, "\n")
        try harness.type(bellView, "钟楼最后一段写到这里。")
        try wait {
            host.wordCounts(projectID: project.id).isIdle && host.wordCountLibrary(projectID: project.id)?.ready == true
                && (host.wordCountLibrary(projectID: project.id)?.count(nodeID: bell.id) ?? 0) > 0
        }
        let bellWords = host.wordCountLibrary(projectID: project.id)?.count(nodeID: bell.id) ?? 0

        // 视图 › 项目主页, wired as AppDelegate wires its action.
        let probe = HomeMenuProbe { host.openHome(project: project) }
        let menu = MacMainMenu.build([.projectHome: MacMainMenu.Action(#selector(HomeMenuProbe.fire(_:)), probe)])
        guard let item = MacMainMenu.item(.projectHome, in: menu), let action = item.action else { throw LabError.message("视图 has no 项目主页") }
        try require(item.title == "项目主页" && MacMainMenu.submenu("视图", in: menu)?.items.first === item && MacMainMenu.path(.projectHome) == "视图 › 项目主页",
                    "项目主页 is not first in 视图")
        var mark = try journal.mark()
        try require(NSApp.sendAction(action, to: item.target, from: item), "项目主页 did not act")
        guard let page = host.homePage(projectID: project.id) else { throw LabError.message("The menu opened no 项目主页") }
        try harness.settledHome(page)
        try require(host.activeHome == project && host.activeView == nil && page.window === harness.window
            && host.homeProjects(pane: 0) == [project] && host.activeProject == project, "项目主页 is not the shown tab")

        // Counts as Rust reports them.
        let rustStorylines: WorkspaceStorylineLibrary = try elementResult { workspace.storylineLibrary(projectID: project.id, completion: $0) }
        let rustElements: WorkspaceElementLibrary = try elementResult { workspace.elementLibrary(projectID: project.id, completion: $0) }
        let rustChapters: [WorkspaceChapter] = try elementResult { workspace.chapters(projectID: project.id, completion: $0) }
        let total = try harness.counts().chapterTotal
        func value(_ key: String) -> String { page.countValues[key]?.stringValue ?? "" }
        try require(page.nameLabel.stringValue == "主页合成项目" && page.summaryLabel.stringValue == "港口小城的长篇"
            && value("storylines") == "\(rustStorylines.storylines.count)" && rustStorylines.storylines.count == 2
            && value("chapters") == "\(rustChapters.count)" && rustChapters.count == 3
            && value("elements") == "\(rustElements.elements.count)" && rustElements.elements.count == 3
            && value("words") == WordCountText.full(total) && total > 0 && value("edited") == "刚刚",
            "项目主页 counts differ: \(page.countValues.mapValues(\.stringValue))")
        try require(page.statusLabel.stringValue == "草稿 1 · 已完成 1 · 已弃用 1" && abs(page.progress.doubleValue - 1.0 / 3) < 0.0001
            && !page.progress.isIndeterminate && page.progressLabel.stringValue == "已完成 1 / 3 章 · 33%",
            "Chapter statuses read \(page.statusLabel.stringValue) \(page.progress.doubleValue)")
        // 继续写作: the chapter edited last, with its last paragraph.
        try require(page.continueButton.title == "钟楼" && page.continueExcerpt.stringValue == "钟楼最后一段写到这里。"
            && page.continueMeta.stringValue == "最后编辑 刚刚 · \(WordCountText.full(bellWords))",
            "继续写作 reads \(page.continueButton.title) / \(page.continueExcerpt.stringValue) / \(page.continueMeta.stringValue)")
        try journal.expect([], since: mark, "Opening and reading 项目主页")

        // One page per project: the menu and the shelf show the same tab again.
        _ = try harness.open(rain)
        try require(host.activeHome == nil && host.activeChapter?.id == rain.id, "A chapter tab did not replace the page")
        try require(NSApp.sendAction(action, to: item.target, from: item), "项目主页 did not act again")
        try harness.settledHome(page)
        try require(host.homePage(projectID: project.id) === page && host.homeProjects(pane: 0) == [project] && host.activeHome == project,
                    "项目主页 was not reused")
        let shelfModel = ProjectShelfModel(workspace: workspace)
        let shelf = MacProjectShelfWindowController(model: shelfModel)
        defer { shelf.window?.close() }
        shelf.onOpenHome = { host.openHome(project: $0) }
        var loaded = false
        shelfModel.load { loaded = true }
        try wait { loaded }
        _ = try harness.open(rain)
        try require(shelf.select(projectID: project.id) && shelf.homeButton.isEnabled, "The shelf does not offer 项目主页")
        shelf.openHomeSelected()
        try harness.settledHome(page)
        try require(host.activeHome == project && host.homePage(projectID: project.id) === page && host.homeProjects(pane: 0).count == 1,
                    "The shelf did not show the same 项目主页")
        // Another project's page is its own tab.
        let other: WorkspaceProject = try elementResult { workspace.createProject(name: "另一部", completion: $0) }
        let otherPage = try harness.home(other)
        try require(otherPage !== page && host.homeProjects(pane: 0).map(\.id) == [project.id, other.id]
            && otherPage.countValues["chapters"]?.stringValue == "0" && otherPage.continueButton.isHidden, "Another project's page differs")
        host.closeHome(projectID: other.id, pane: 0)
        try require(host.homeProjects(pane: 0) == [project] && host.homePage(projectID: other.id) == nil, "Closing a 项目主页 kept it")

        // 继续写作 opens the chapter edited last.
        try harness.home()
        page.continueButton.performClick(nil)
        try wait { host.activeChapter?.id == bell.id && !host.isBusy }
        try require(host.activeHome == nil && host.homePage(projectID: project.id) === page, "继续写作 opened \(host.activeChapter?.title ?? "nothing")")

        // 编辑资料… opens 项目资料; the saved summary reaches the page.
        try harness.home()
        var editing: WorkspaceProject?
        var sheet: ProjectProfileSheet?
        host.onEditProjectProfile = { edited in
            editing = edited
            let profile = ProjectProfileSheet(model: ProjectProfileModel(workspace: workspace, projectID: edited.id), projectName: edited.name,
                                              plans: harness.settings)
            profile.onFinish = { host.projectDetailsChanged(projectID: edited.id) }
            sheet = profile
            profile.begin(in: harness.window)
        }
        page.editProfileButton.performClick(nil)
        try require(editing == project, "编辑资料… did not ask for 项目资料")
        try wait { sheet?.stored != nil }
        sheet?.summaryView.string = "港口小城的长篇，第二稿"
        mark = try journal.mark()
        sheet?.done()
        try wait { page.summaryLabel.stringValue == "港口小城的长篇，第二稿" }
        let written = try journal.originals(since: mark)
        try require(written.count == 1 && written[0].allSatisfy { $0.hasSuffix(" project") }, "Saving the summary wrote \(written)")

        // 今日 / 连续天数 / 本周 / 本月 from a seeded ledger against the plan.
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "Asia/Shanghai")!
        harness.settings.calendar = calendar
        func day(_ month: Int, _ day: Int) -> Date { calendar.date(from: DateComponents(year: 2026, month: month, day: day, hour: 12))! }
        for (date, words) in [(day(8, 31), 200), (day(9, 1), 100), (day(9, 25), 50), (day(9, 26), -20), (day(9, 27), 300),
                              (day(9, 28), 400), (day(9, 29), 500)] {
            harness.settings.now = { date }
            harness.settings.recordWords(words, projectID: project.id)
        }
        harness.settings.now = { day(9, 30) }
        harness.settings.setWritingPlan(WritingPlan(projectWordTarget: 50_000, dailyWordGoal: 100), projectID: project.id)
        func rhythm(_ key: String) -> String { page.rhythmValues[key]?.stringValue ?? "" }
        try require(rhythm("today") == "0 / 100 字 · 0%" && rhythm("streak") == "3 天" && rhythm("week") == "900 / 700 字"
            && rhythm("month") == "1,330 / 3,000 字 · 写作 5 天" && harness.settings.dailyWords(projectID: project.id).count == 7,
            "The seeded rhythm reads \(page.rhythmValues.mapValues(\.stringValue))")
        harness.settings.recordWords(120, projectID: project.id)
        try require(rhythm("today") == "120 / 100 字 · 100%" && rhythm("streak") == "4 天" && rhythm("week") == "1,020 / 700 字"
            && rhythm("month") == "1,450 / 3,000 字 · 写作 6 天", "Today's words did not reach the page: \(page.rhythmValues.mapValues(\.stringValue))")
        // Across the month boundary, two days on: no streak, a new month.
        harness.settings.now = { day(10, 2) }
        harness.settings.checkDay()
        try require(rhythm("today") == "0 / 100 字 · 0%" && rhythm("streak") == "0 天" && rhythm("week") == "1,020 / 700 字"
            && rhythm("month") == "0 / 3,100 字 · 写作 0 天", "October reads \(page.rhythmValues.mapValues(\.stringValue))")
        // A 40-day run outlives the 31 kept days: the dropped days carry its length.
        for offset in 0..<40 {
            let date = calendar.date(byAdding: .day, value: offset, to: day(10, 3))!
            harness.settings.now = { date }
            harness.settings.recordWords(10, projectID: project.id)
        }
        try require(rhythm("streak") == "40 天" && harness.settings.dailyWords(projectID: project.id).count == 31
            && harness.settings.dailyStreak(projectID: project.id) == DailyStreakCarry(through: "2026-10-11", days: 9),
            "A 40-day run reads \(rhythm("streak")) with \(String(describing: harness.settings.dailyStreak(projectID: project.id)))")
        // The next morning it still counts until the day ends unwritten; a gap then ends it.
        let after = calendar.date(byAdding: .day, value: 40, to: day(10, 3))!
        harness.settings.now = { after }
        harness.settings.checkDay()
        try require(rhythm("streak") == "40 天", "Before writing the next day the streak reads \(rhythm("streak"))")
        let later = calendar.date(byAdding: .day, value: 2, to: after)!
        harness.settings.now = { later }
        harness.settings.checkDay()
        harness.settings.recordWords(10, projectID: project.id)
        try require(rhythm("streak") == "1 天", "After a gap the streak reads \(rhythm("streak"))")
        harness.settings.now = Date.init

        // Storyline tracks: chapters in book order as status-coloured items that open the chapter.
        try require(page.trackChips.map(\.storyline.name) == ["主线", "支线"]
            && page.trackChips[0].chips.map(\.chapter.id) == [rain.id, bell.id] && page.trackChips[1].chips.map(\.chapter.id) == [bell.id, dock.id]
            && page.trackChips[0].chips.map(\.color) == [NSColor.systemGreen, .systemBlue]
            && page.trackChips[1].chips.map(\.color) == [NSColor.systemBlue, .systemGray]
            && page.trackChips[1].chips[1].toolTip == "§3 码头 · 已弃用", "Tracks read \(page.trackChips.map { ($0.storyline.name, $0.chips.map(\.chapter.title)) })")
        try require(page.trackChips[1].chips[1].accessibilityPerformPress(), "A track item did not press")
        try wait { host.activeChapter?.id == dock.id && !host.isBusy }
        // Categories with element counts that open the category page.
        try harness.home()
        try require(page.categoryButtons.map(\.title) == ["人物 · 2", "地点 · 1"] && page.uncategorizedLabel.superview == nil,
                    "Categories read \(page.categoryButtons.map(\.title))")
        page.categoryButtons[1].performClick(nil)
        try wait { host.activeCategory?.id == placesID && !host.isBusy }
        try harness.home()
        // A category trash moves its element to 未分类; the page follows.
        let _: WorkspaceElementReply<WorkspaceElementCategory> = try elementResult { host.trashCategory(projectID: project.id, categoryID: placesID, completion: $0) }
        try wait { page.categoryButtons.map(\.title) == ["人物 · 2"] }
        try require(page.uncategorizedLabel.stringValue == "未分类 · 1" && page.uncategorizedLabel.superview != nil
            && page.countValues["elements"]?.stringValue == "3", "The category trash reads \(page.categoryButtons.map(\.title)) \(page.uncategorizedLabel.stringValue)")
        let closed: Bool = try elementResult { host.close(completion: $0) }
        try require(closed && host.homeProjects(pane: 0).isEmpty, "Closing the workspace kept 项目主页")
    }

    private static func projectHomeRecents() throws {
        let titles = ["第一章", "第二章", "第三章", "第四章", "第五章", "第六章"]
        let harness = try HomeHarness(name: "最近合成项目", chapterTitles: titles)
        defer { harness.cleanup() }
        let workspace = harness.workspace, host = harness.host, project = harness.project, journal = harness.journal, settings = harness.settings
        let chapters = harness.chapters
        let category: WorkspaceElementReply<WorkspaceElementCategory> = try elementResult {
            workspace.createElementCategory(projectID: project.id, name: "人物", completion: $0)
        }
        guard let categoryValue = category.result else { throw LabError.message("No category was created") }
        var elements: [WorkspaceElement] = []
        var library = category.library
        for name in ["林雾", "老周", "阿青"] {
            let reply: WorkspaceElementReply<WorkspaceElement> = try elementResult {
                workspace.createElement(projectID: project.id, categoryID: categoryValue.id, name: name, completion: $0)
            }
            elements.append(reply.result!); library = reply.library
        }
        host.applyElementLibrary(projectID: project.id, library: library)
        let storyline: WorkspaceStorylineReply<WorkspaceStoryline> = try elementResult { workspace.createStoryline(projectID: project.id, name: "主线", completion: $0) }
        host.applyStorylineLibrary(projectID: project.id, library: storyline.library)
        let drift: WorkspaceDriftReply<WorkspaceDrift> = try elementResult { workspace.createDrift(projectID: project.id, title: "灯塔传说", groupID: nil, completion: $0) }
        host.applyDriftLibrary(projectID: project.id, library: drift.library)
        guard let storylineValue = storyline.result, let driftValue = drift.result else { throw LabError.message("No storyline or drift was created") }

        // Twelve pages opened in order: the six chapters, three elements, the category, the storyline and the drift.
        func opened(_ run: (@escaping (Result<NativeDocumentView, Error>) -> Void) -> Void) throws {
            let view: NativeDocumentView = try elementResult(run)
            try harness.settled(view)
        }
        for chapter in chapters { try opened { host.open(project: project, chapter: chapter, completion: $0) } }
        for element in elements { try opened { host.open(project: project, element: element, completion: $0) } }
        try opened { host.open(project: project, category: categoryValue, completion: $0) }
        try opened { host.open(project: project, storyline: storylineValue, completion: $0) }
        try opened { host.open(project: project, drift: driftValue, completion: $0) }
        var mark = try journal.mark()
        let page = try harness.home()
        func labels() -> [String] { page.recentButtons.map(\.title) }
        let newest = ["漂流 · 灯塔传说", "故事线 · 主线", "分类 · 人物", "设定 · 阿青", "设定 · 老周", "设定 · 林雾",
                      "章节 · 第六章", "章节 · 第五章", "章节 · 第四章", "章节 · 第三章"]
        try require(labels() == newest && settings.recentPages(projectID: project.id).count == 10, "最近 reads \(labels())")
        // Reopening one moves it first, once.
        try opened { host.open(project: project, chapter: chapters[3], completion: $0) }
        try harness.home()
        try require(labels() == ["章节 · 第四章"] + newest.filter { $0 != "章节 · 第四章" } && labels().count == 10,
                    "A reopened page did not move first: \(labels())")
        // A row opens its page.
        let row = try require(index: labels().firstIndex(of: "设定 · 老周"), "老周 is not listed")
        page.recentButtons[row].performClick(nil)
        try wait { host.activeElement?.id == elements[1].id && !host.isBusy }
        try harness.home()
        try require(labels().first == "设定 · 老周", "Opening from 最近 did not move it first: \(labels())")
        try journal.expect([], since: mark, "Showing 项目主页 and opening pages from 最近")

        // A trashed page is left out until it is restored; a purged one is forgotten.
        let _: WorkspaceElementReply<WorkspaceElement> = try elementResult { host.trashElement(projectID: project.id, elementID: elements[2].id, completion: $0) }
        try harness.home()
        try require(!labels().contains("设定 · 阿青") && labels().count == 9
            && settings.recentPages(projectID: project.id).contains(RecentPage(kind: .element, id: elements[2].id)),
            "The trashed element is still listed: \(labels())")
        let listing: WorkspaceTrashListing = try elementResult { workspace.trash(projectID: project.id, completion: $0) }
        guard let trashed = listing.trashed.first(where: { $0.id == elements[2].id })?.item else { throw LabError.message("阿青 is not in the trash") }
        let _: Void = try elementResult { host.restore(trashed, projectID: project.id, completion: $0) }
        try wait { labels().contains("设定 · 阿青") }
        let _: WorkspaceElementReply<WorkspaceElement> = try elementResult { host.trashElement(projectID: project.id, elementID: elements[2].id, completion: $0) }
        let _: WorkspaceTrashPurgeReply = try elementResult { host.purge(trashed, projectID: project.id, completion: $0) }
        try wait { !labels().contains("设定 · 阿青") }
        try require(!settings.recentPages(projectID: project.id).contains { $0.id == elements[2].id } && labels().count == 9,
                    "The purged element was kept")

        // Following: a chapter rename, a status change, word counts and a project rename.
        let renamed: WorkspaceChapter = try elementResult { workspace.renameChapter(projectID: project.id, chapterID: chapters[3].id, title: "第四章 雾港", completion: $0) }
        host.rename(chapter: renamed, projectID: project.id)
        try wait { labels().contains("章节 · 第四章 雾港") }
        let _: WorkspaceNodeMetadata = try elementResult { host.setNodeStatus(projectID: project.id, nodeID: chapters[0].id, status: WritingStatus.finished.rawValue, completion: $0) }
        try wait { page.statusLabel.stringValue == "草稿 5 · 已完成 1 · 已弃用 0" }
        try require(page.progressLabel.stringValue == "已完成 1 / 6 章 · 17%", "The status change reads \(page.progressLabel.stringValue)")
        let wordsBefore = page.countValues["words"]?.stringValue
        let view = try harness.open(chapters[4])
        try harness.type(view, "第五章写下的新句子。")
        try wait {
            host.wordCounts(projectID: project.id).isIdle && (host.wordCountLibrary(projectID: project.id)?.count(nodeID: chapters[4].id) ?? 0) > 0
        }
        try harness.home()
        try require(page.countValues["words"]?.stringValue == WordCountText.full(try harness.counts().chapterTotal)
            && page.countValues["words"]?.stringValue != wordsBefore && page.continueButton.title == "第五章"
            && page.continueExcerpt.stringValue == "第五章写下的新句子。", "Word counts did not reach the page: \(page.countValues["words"]?.stringValue ?? "")")
        let project2: WorkspaceProject = try elementResult { workspace.renameProject(projectID: project.id, name: "最近合成项目·改", completion: $0) }
        host.rename(project: project2)
        try require(page.nameLabel.stringValue == "最近合成项目·改" && host.homeProjects(pane: 0).first?.name == "最近合成项目·改",
                    "The project rename did not reach the page")
        mark = try journal.mark()
        try harness.home()
        try journal.expect([], since: mark, "Reading 项目主页 again")
        let expected = (labels(), page.countValues.filter { $0.key != "edited" }.mapValues(\.stringValue), page.statusLabel.stringValue,
                        page.continueButton.title)
        let file = try String(contentsOf: settings.fileURL, encoding: .utf8)
        try require(file.contains("\"recentPages\"") && file.contains(chapters[3].id), "settings.json lacks 最近")

        // Cold relaunch: a new workspace, settings store and tab host.
        let closed: Bool = try elementResult { host.close(completion: $0) }
        try require(closed, "The workspace did not close")
        let cold = LabWorkspaceCore(directory: harness.directory)
        let coldSettings = LabSettingsStore(directory: harness.root)
        let (coldWindow, coldHost) = elementHost(cold)
        defer { coldWindow.close() }
        coldHost.homeSettings = coldSettings
        let _: [WorkspaceProject] = try elementResult { cold.projects(completion: $0) }
        guard let coldPage = coldHost.openHome(project: project2) else { throw LabError.message("项目主页 did not open after the relaunch") }
        try wait {
            coldPage.model.loaded && !coldPage.model.loading && coldHost.wordCountLibrary(projectID: project.id)?.ready == true
                && coldPage.model.continueExcerpt != nil
        }
        let relaunched = (coldPage.recentButtons.map(\.title), coldPage.countValues.filter { $0.key != "edited" }.mapValues(\.stringValue),
                          coldPage.statusLabel.stringValue, coldPage.continueButton.title)
        try require(relaunched.0 == expected.0 && relaunched.1 == expected.1 && relaunched.2 == expected.2 && relaunched.3 == expected.3,
                    "After a cold relaunch 项目主页 reads \(relaunched) instead of \(expected)")
        let coldClosed: Bool = try elementResult { coldHost.close(completion: $0) }
        try require(coldClosed, "The relaunched workspace did not close")
    }

    private static func require<T>(index: T?, _ message: String) throws -> T {
        guard let index else { throw LabError.message(message) }
        return index
    }
}
