import AppKit

/// 今日字数: the net change in canonical chapter word counts that this
/// device's own saves made today, per project, kept in `settings.json`.
///
/// Rust stores a chapter's count with every body save, and every read of the
/// counts runs on the serial workspace queue in the order of those saves. The
/// ledger compares each read with the previous one: a chapter's change counts
/// (a new chapter from zero, e.g. an import), a chapter that left the list
/// does not. `LabWorkspaceCore` brackets each change this device did not
/// write (a received original, a version restore, chapter trash and restore,
/// a reconcile) with a read before and an unauthored read after it, so its
/// effect is re-based without being counted. The first read of a project in
/// a session is the baseline. Drift bodies never count.
final class DailyWordLedger {
    let store: LabSettingsStore
    /// Per project, each live chapter's count at the last read.
    private var baselines: [String: [String: Int]] = [:]
    /// Reads observed, for acceptance.
    private(set) var observed = 0

    init(store: LabSettingsStore) { self.store = store }

    /// Observes every word-count read of the workspace from now on.
    func attach(to workspace: LabWorkspaceCore) {
        workspace.onWordCountRead = { [weak self] projectID, counts, authored in
            self?.observe(projectID: projectID, counts: counts, authored: authored)
        }
    }

    func observe(projectID: String, counts: WorkspaceWordCounts, authored: Bool) {
        precondition(Thread.isMainThread)
        observed += 1
        let current = Dictionary(counts.counts.filter { $0.kind == "chapter" }.map { ($0.nodeId, $0.wordCount ?? 0) },
                                 uniquingKeysWith: { first, _ in first })
        let previous = baselines[projectID]
        baselines[projectID] = current
        guard authored, let previous else { return }
        let delta = current.reduce(0) { $0 + $1.value - (previous[$1.key] ?? 0) }
        store.recordWords(delta, projectID: projectID)
    }

    /// A deleted project: its baseline goes; the store forgets its days.
    func forget(projectID: String) { baselines.removeValue(forKey: projectID) }
}

/// “今日 523 / 1,500 字 · 34%” against the 写作计划's 每日目标.
enum DailyWordText {
    /// The value after “今日”: “523 / 1,500 字 · 34%”, or “523 字 · 未设每日目标”.
    static func value(today: Int, goal: Int) -> String {
        guard goal > 0 else { return "\(WordCountText.full(today)) · 未设每日目标" }
        return "\(WordCountText.grouped(today)) / \(WordCountText.full(goal)) · \(Int(((fraction(today: today, goal: goal) ?? 0) * 100).rounded(.down)))%"
    }

    static func line(today: Int, goal: Int) -> String { "今日 \(value(today: today, goal: goal))" }

    /// The track's fill, 0...1; nil without a daily goal.
    static func fraction(today: Int, goal: Int) -> Double? {
        guard goal > 0 else { return nil }
        return min(1, max(0, Double(today) / Double(goal)))
    }
}
