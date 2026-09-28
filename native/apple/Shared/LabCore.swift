import Foundation
import DriftingCoreFFI

struct LabState: Decodable {
    let handle: UInt64
    let projectId: String
    let name: String
}

private struct CoreReply<Payload: Decodable>: Decodable {
    let abiVersion: Int
    let ok: Bool
    let value: Payload?
    let error: String?
}

enum LabError: LocalizedError {
    case message(String)
    case pendingRemoteUpdate(reason: String)
    case historyUnavailable(reason: String)
    case formattingUnavailable(reason: String)
    case commentUnavailable(reason: String)
    case elementUnavailable(reason: String)
    case storylineUnavailable(reason: String)
    case driftUnavailable(reason: String)
    case metadataUnavailable(reason: String)
    case relationUnavailable(reason: String)
    case libraryUnavailable(reason: String)
    case transferUnavailable(reason: String)
    case timelineUnavailable(reason: String)
    case versionHistoryUnavailable(reason: String)
    case reviewUnavailable(reason: String)
    case actUnavailable(reason: String)
    case projectUnavailable(reason: String)
    case patchUnavailable(reason: String)
    case trashUnavailable(reason: String)
    case plotGridUnavailable(reason: String)

    /// Keep the core's exact reason available to diagnostics without exposing
    /// CRDT identities in the shared macOS/iOS error presentation.
    var diagnosticDescription: String {
        switch self {
        case .message(let text), .pendingRemoteUpdate(let text), .historyUnavailable(let text), .formattingUnavailable(let text),
             .commentUnavailable(let text), .elementUnavailable(let text), .storylineUnavailable(let text),
             .driftUnavailable(let text), .metadataUnavailable(let text), .relationUnavailable(let text),
             .libraryUnavailable(let text), .transferUnavailable(let text), .timelineUnavailable(let text),
             .versionHistoryUnavailable(let text), .reviewUnavailable(let text), .actUnavailable(let text),
             .projectUnavailable(let text), .patchUnavailable(let text), .trashUnavailable(let text),
             .plotGridUnavailable(let text): return text
        }
    }
    var errorDescription: String? {
        switch self {
        case .message(let text): return text
        case .pendingRemoteUpdate:
            return "有已保存但尚未应用的远端更新。原始数据已保留，当前暂不打开文档。"
        case .historyUnavailable:
            return "远端修改影响了这次操作，暂时无法撤销或重做。当前文字已保留，可以继续编辑。"
        case .formattingUnavailable:
            return "当前选区暂时无法应用这种格式。正文和选区已保留，可以继续编辑。"
        case .commentUnavailable(let reason): return LabError.commentMessage(reason)
        case .elementUnavailable(let reason): return LabError.elementMessage(reason)
        case .storylineUnavailable(let reason): return LabError.storylineMessage(reason)
        case .driftUnavailable(let reason): return LabError.driftMessage(reason)
        case .metadataUnavailable(let reason): return LabError.metadataMessage(reason)
        case .relationUnavailable(let reason): return LabError.relationMessage(reason)
        case .libraryUnavailable(let reason): return LabError.libraryMessage(reason)
        case .transferUnavailable(let reason): return LabError.transferMessage(reason)
        case .timelineUnavailable(let reason): return LabError.timelineMessage(reason)
        case .versionHistoryUnavailable(let reason): return LabError.versionHistoryMessage(reason)
        case .reviewUnavailable(let reason): return LabError.reviewMessage(reason)
        case .actUnavailable(let reason): return LabError.actMessage(reason)
        case .projectUnavailable(let reason): return LabError.projectMessage(reason)
        case .patchUnavailable(let reason): return LabError.patchMessage(reason)
        case .trashUnavailable(let reason): return LabError.trashMessage(reason)
        case .plotGridUnavailable(let reason): return LabError.plotGridMessage(reason)
        }
    }

    /// 情节规划格 refusals roll the whole batch back. Rust's own reasons are
    /// Chinese (这一行不存在, 单元格和标题最多 10000 字, 格子宽度须在…); the
    /// rest are restated.
    private static func plotGridMessage(_ reason: String) -> String {
        let known: [(String, String)] = [
            ("章节或灵感不存在或已在回收站", "这一章或这条漂流已不可用（可能已移到回收站），情节规划格未能保存。"),
            ("Invalid plot grid identity", "情节规划格的行列标识无效，未能保存。"),
            ("Plot grid identity already exists", "这一行或这一列已经存在，请稍后重试。"),
            ("Project does not", "这个项目已不可用，请重新选择项目。"),
            ("Project and active generation identity do not match", "这个项目已不可用，请重新选择项目。"),
        ]
        if let known = known.first(where: { reason.contains($0.0) }) { return known.1 }
        if reason.unicodeScalars.contains(where: { (0x4E00...0x9FFF).contains($0.value) }) { return reason }
        return "情节规划格未能保存。已有内容未改变，可以稍后重试。"
    }

    /// “名称”已被设定“名称”使用: an element name or alias conflict, from
    /// `Name "x" is already used by element "y"`.
    static func elementNameConflict(_ reason: String) -> String? {
        guard reason.contains("is already used by element") else { return nil }
        let parts = reason.components(separatedBy: "\"")
        return parts.count >= 5 ? "“\(parts[1])”已被设定“\(parts[3])”使用，请换一个名称或别名。"
            : "名称或别名已被其他设定使用，请换一个。"
    }

    /// 彻底删除 refusals leave every row, body and journal entry in place.
    /// Rust's own messages are Chinese (只有回收站里的内容才能彻底删除,
    /// 请先关闭这一页…); diagnostics are restated.
    private static func trashMessage(_ reason: String) -> String {
        let known: [(String, String)] = [
            ("cannot be purged from the trash", "只有章节、漂流、设定、分类和故事线可以彻底删除。"),
            ("Project does not", "这个项目已不可用，请刷新项目列表。"),
            ("Project and active generation identity do not match", "这个项目已不可用，请刷新项目列表。"),
            ("Unknown or closed workspace", "工作区已关闭，请重新打开后再试。"),
        ]
        if let message = known.first(where: { reason.contains($0.0) })?.1 { return message }
        if reason.unicodeScalars.contains(where: { (0x4E00...0x9FFF).contains($0.value) }) { return reason }
        return "回收站的操作未能完成。回收站里的内容未改变，可以稍后重试。"
    }

    /// Patch refusals happen before any row or journal change. Rust's own
    /// messages are Chinese (补丁的标题和内容不能都为空, 这个补丁不存在…);
    /// diagnostics are restated.
    private static func patchMessage(_ reason: String) -> String {
        let known: [(String, String)] = [
            ("Invalid patch or element identity", "这个设定已不可用，请刷新设定库。"),
            ("has no lifecycle", "这个补丁的数据已变化，请刷新补丁列表。"),
            ("Invalid incarnation", "这个补丁的数据已变化，请刷新补丁列表。"),
            ("is not live", "这个补丁已被删除，请刷新补丁列表。"),
            ("Project does not", "这个项目已不可用，请重新选择项目。"),
            ("Project and active generation identity do not match", "这个项目已不可用，请重新选择项目。"),
        ]
        if let message = known.first(where: { reason.contains($0.0) })?.1 { return message }
        if reason.unicodeScalars.contains(where: { (0x4E00...0x9FFF).contains($0.value) }) { return reason }
        return "补丁的修改未能保存。已有内容未改变，可以稍后重试。"
    }

    /// Note and TODO refusals happen before any row, relation or anchor
    /// change. Rust's own messages are Chinese (内容不能为空, 浮动的只能是待办,
    /// 浮动的待办不能转为批注, 这条批注或待办不存在); diagnostics are restated.
    private static func reviewMessage(_ reason: String) -> String {
        let known: [(String, String)] = [
            ("Invalid comment priority", "优先级只能是低、中或高。"),
            ("Invalid comment kind", "只能写批注或待办。"),
            ("targetKind and targetId go together", "批注的位置不完整，请重新选择。"),
            ("are not supported natively", "原生版本暂不支持在这种页面上写批注或待办。"),
            ("不存在或已在回收站", "所在的页面已不可用（可能已移到回收站），请刷新后重试。"),
            ("converted suggestion", "已转化的建议不能解决或重新打开。"),
            ("Comment is not live", "这条批注或待办已被删除，请刷新审阅列表。"),
            ("Invalid comment incarnation", "这条批注或待办的数据已变化，请刷新审阅列表。"),
            ("Project does not", "这个项目已不可用，请重新选择项目。"),
            ("Project and active generation identity do not match", "这个项目已不可用，请重新选择项目。"),
        ]
        if let message = known.first(where: { reason.contains($0.0) })?.1 { return message }
        if reason.unicodeScalars.contains(where: { (0x4E00...0x9FFF).contains($0.value) }) { return reason }
        return "审阅操作未能完成。已有内容未改变，可以稍后重试。"
    }

    /// Act refusals (create, rename, move, colour, remove) happen before any
    /// row or journal change. Rust's own messages are Chinese (幕的起点不能越过
    /// 相邻的幕); diagnostics are restated.
    private static func actMessage(_ reason: String) -> String {
        let known: [(String, String)] = [
            ("Invalid act identity or colour", "幕颜色须为有效的颜色值。"),
            ("Invalid act identity or boundary", "这个位置无法保存，请重新拖动。"),
            ("Act boundary must be finite", "这个位置无法保存，请重新选择章节。"),
            ("Invalid act identity or empty name", "幕名称不能为空。"),
            ("already exists before this chapter", "这一章前已经有一幕的分界。"),
            ("Chapter is not available", "这一章已不可用，请刷新后重试。"),
            ("Act is not", "这一幕已不可用，请刷新整书大纲。"),
            ("Project does not", "这个项目已不可用，请重新选择项目。"),
            ("Project and active generation identity do not match", "这个项目已不可用，请重新选择项目。"),
        ]
        if let message = known.first(where: { reason.contains($0.0) })?.1 { return message }
        if reason.unicodeScalars.contains(where: { (0x4E00...0x9FFF).contains($0.value) }) { return reason }
        return "幕的修改未能保存。已有内容未改变，可以稍后重试。"
    }

    /// Project deletion refusals leave every row, body and file in place.
    /// Rust's own messages are Chinese (请先关闭这个项目里打开的章节和页面…).
    private static func projectMessage(_ reason: String) -> String {
        let known: [(String, String)] = [
            ("Project does not", "这个项目已不可用，请刷新项目列表。"),
            ("Project and active generation identity do not match", "这个项目已不可用，请刷新项目列表。"),
            ("Unknown or closed workspace", "工作区已关闭，请重新打开后再删除项目。"),
        ]
        if let message = known.first(where: { reason.contains($0.0) })?.1 { return message }
        if reason.unicodeScalars.contains(where: { (0x4E00...0x9FFF).contains($0.value) }) { return reason }
        return "项目未能删除。已有内容未改变，可以稍后重试。"
    }

    /// Story graph refusals happen before any row or journal change. Rust's
    /// own messages are Chinese; diagnostics are restated.
    private static func timelineMessage(_ reason: String) -> String {
        let known: [(String, String)] = [
            ("must be finite", "这个位置无法保存，请重新拖动。"),
            ("Project does not", "这个项目已不可用，请重新选择项目。"),
            ("Project and active generation identity do not match", "这个项目已不可用，请重新选择项目。"),
            ("Invalid node incarnation", "章节数据已变化，请刷新故事图谱。"),
            ("Invalid marker incarnation", "时间标记数据已变化，请刷新故事图谱。"),
            ("Storyline is not available", "这条故事线已不可用（可能已移到回收站），章节的轨道和位置都未改变。请刷新故事图谱。"),
            ("Chapter is not available", "这一章已不可用，请刷新故事图谱。"),
            ("Destination chapter", "目标位置旁的章节已不可用（可能已移到回收站），章节的轨道和成书顺序都未改变。请刷新故事图谱。"),
            ("Moving chapter is not available", "这一章已不可用，请刷新故事图谱。"),
        ]
        if let message = known.first(where: { reason.contains($0.0) })?.1 { return message }
        // Rust's own messages, e.g. 时间标记需要名称，或绑定一条漂流.
        if reason.unicodeScalars.contains(where: { (0x4E00...0x9FFF).contains($0.value) }) { return reason }
        return "故事图谱的修改未能保存。已有内容未改变，可以稍后重试。"
    }

    /// Version history refusals leave the body and its history unchanged,
    /// except a restore that applied but could not save, which says so.
    private static func versionHistoryMessage(_ reason: String) -> String {
        // Rust's own messages, e.g. 这个历史版本不属于当前文档, come first: a
        // restore that applied but failed to save names its save error.
        if reason.unicodeScalars.contains(where: { (0x4E00...0x9FFF).contains($0.value) }) { return reason }
        let known: [(String, String)] = [
            ("do not support", "这种页面没有历史版本。"),
            ("No version history for", "这种页面没有历史版本。"),
            ("active sync generation", "这个项目已不可用，请重新选择项目。"),
            ("Project does not", "这个项目已不可用，请重新选择项目。"),
            ("Project and active generation identity do not match", "这个项目已不可用，请重新选择项目。"),
            ("incarnation", "这一页已不可用（可能已移到回收站），请刷新后重试。"),
            ("scope", "这一页已不可用（可能已移到回收站），请刷新后重试。"),
        ]
        return known.first { reason.contains($0.0) }?.1 ?? "历史版本操作未能完成。正文未改变，可以稍后重试。"
    }

    /// Materials library and portrait refusals leave rows and stored bytes
    /// unchanged. Rust's asset store and library answer in Chinese (文件超过
    /// 200 MB 的上限, 找不到要导入的文件, 只能导入文件，不能导入文件夹,
    /// 素材已存在，不能覆盖, 链接必须以 http:// 或 https:// 开头), which pass
    /// through; its few remaining English diagnostics are restated, and
    /// anything else unexpected gets a generic sentence.
    private static func libraryMessage(_ reason: String) -> String {
        if reason.unicodeScalars.contains(where: { (0x4E00...0x9FFF).contains($0.value) }) { return reason }
        let known: [(String, String)] = [
            ("symlink", "素材库目录中有符号链接，已拒绝写入。"),
            ("Invalid asset extension", "这种文件类型暂不支持。"),
            ("Project does not", "这个项目已不可用，请重新选择项目。"),
            ("Project and active generation identity do not match", "这个项目已不可用，请重新选择项目。"),
        ]
        return known.first { reason.contains($0.0) }?.1 ?? "素材操作未能完成。已有内容未改变，可以稍后重试。"
    }

    /// Import refusals happen before the entity is created, except a failed
    /// body save, which is reported as such.
    private static func transferMessage(_ reason: String) -> String {
        let known: [(String, String)] = [
            ("导入的正文尚未保存", "页面已创建，但导入的正文尚未保存。请打开这一页检查后重试。"),
            ("Category is not available", "这个分类已不可用，请刷新设定库后重新选择。"),
            ("Imported bodies must start empty", "导入目标的正文不是空的，已停止导入。"),
            ("Project does not", "这个项目已不可用，请重新选择项目。"),
            ("Project and active generation identity do not match", "这个项目已不可用，请重新选择项目。"),
        ]
        if let message = known.first(where: { reason.contains($0.0) })?.1 { return message }
        if reason.unicodeScalars.contains(where: { (0x4E00...0x9FFF).contains($0.value) }) { return reason }
        return "导入或导出未能完成。已有内容未改变，可以稍后重试。"
    }

    /// Relation refusals happen before any row or journal change. Rust gives
    /// the renderer's Chinese messages; those naming stored identities or
    /// written for diagnostics are restated.
    private static func relationMessage(_ reason: String) -> String {
        if let range = reason.range(of: "不符合新约束：") {
            return "已有关系不符合新的端点约束：" + reason[range.upperBound...]
        }
        let known: [(String, String)] = [
            ("需要先交换两端", "已有关系需要先交换两端，才能把这个类型改为对称关系。"),
            ("不存在或已在回收站", "关系一端已不可用（可能已移到回收站），请刷新后重试。"),
            ("not supported natively", "原生版本暂不支持这种关系端点。"),
            ("is not a structural kind", "关系的目标端必须是章节、漂流、设定、分类或故事线。"),
            ("has no lifecycle", "关系数据不完整，暂时无法修改。"),
            ("is not live", "关系数据已变化，请刷新后重试。"),
        ]
        if let message = known.first(where: { reason.contains($0.0) })?.1 { return message }
        // The renderer's own messages, e.g. 关系类型「师徒」已存在.
        if reason.unicodeScalars.contains(where: { (0x4E00...0x9FFF).contains($0.value) }) { return reason }
        return "关系操作未能完成。已有内容未改变，可以稍后重试。"
    }

    /// Summary, status and project detail refusals happen before any row or
    /// journal change.
    private static func metadataMessage(_ reason: String) -> String {
        let known: [(String, String)] = [
            ("A chapter cannot have status", "章节只能设为草稿、已完成或已弃用。"),
            ("A drift cannot have status", "漂流只能设为漂浮中或休眠。"),
            ("Chapter or drift is not", "这一章或这条漂流已不可用，请刷新列表。"),
            ("Project does not", "这个项目已不可用，请重新选择项目。"),
            ("Project and active generation identity do not match", "这个项目已不可用，请重新选择项目。"),
            ("Facts have rows without order registers", "字段数据不完整，暂时无法保存。已输入的内容仍保留。"),
        ]
        return known.first { reason.contains($0.0) }?.1 ?? "资料未能保存。已有内容未改变，可以稍后重试。"
    }

    /// Drift and drift group refusals happen before any row, binding or
    /// journal change.
    private static func driftMessage(_ reason: String) -> String {
        // 转为设定 is refused before writing when the drift's title is an
        // element's name or alias; a conversion that stopped part way says
        // what was done in Rust's own words.
        if let conflict = elementNameConflict(reason) {
            return conflict.replacingOccurrences(of: "请换一个名称或别名。", with: "请先给漂流或那个设定改名，再转为设定。")
        }
        if reason.contains("已创建") { return reason }
        let known: [(String, String)] = [
            ("灵感不存在或已在回收站", "这条漂流已不可用，请刷新漂流列表。"),
            ("Storyline is not available", "这条故事线已不可用，请刷新故事线列表后再转为章节。"),
            ("Category is not available", "这个分类已不可用，请刷新设定库后再转为设定。"),
            ("分类不存在或已在回收站", "这个分类已不可用，请刷新设定库后再转为设定。"),
            ("Unsaved or unapplied prose remains", "漂流正文尚未保存，请先重试保存。"),
            ("native draft is active", "请先完成漂流正文中的输入。"),
            ("nest at most one level", "分组最多嵌套一层：子分组中不能再建分组。"),
            ("Drift group is not available", "这个分组已不可用，请刷新漂流列表。"),
            ("Drift group name is empty", "分组名称不能为空。"),
            ("already bound to another act", "这条漂流已是另一幕的笔记，请先在那一幕解除。"),
            ("Act is not live", "这一幕已不可用，请刷新整书大纲。"),
            ("live document owner", "请先关闭这条漂流的页面，再恢复。"),
            ("Drift lifecycle must be", "漂流状态已变化，请刷新漂流列表。"),
            ("Drift is not open", "这条漂流的页面已关闭，请重新打开。"),
            ("Drift is not available", "这条漂流已不可用，请刷新漂流列表。"),
            ("Drift is not live", "这条漂流已不可用，请刷新漂流列表。"),
            ("complete prose state", "漂流正文还有未完成的同步依赖，暂时无法恢复。"),
            ("unresolved prose dependencies", "漂流正文还有未完成的同步依赖，暂时无法恢复。"),
            ("scope changed", "漂流已变化，请重新打开页面。"),
        ]
        return known.first { reason.contains($0.0) }?.1 ?? "漂流操作未能完成。已有内容未改变，可以稍后重试。"
    }

    /// Storyline refusals happen before any row, membership or journal change.
    private static func storylineMessage(_ reason: String) -> String {
        let known: [(String, String)] = [
            ("Storyline is not available", "这条故事线已不可用，请刷新故事线列表。"),
            ("Chapter is not available", "这一章已不可用，请刷新章节列表。"),
            ("primary storyline must be one of", "主线必须是已勾选的故事线之一。"),
            ("Invalid storyline colour", "颜色须为有效的颜色值。"),
            ("live document owner", "请先关闭这条故事线的页面，再恢复。"),
            ("Storyline lifecycle must be", "故事线状态已变化，请刷新故事线列表。"),
            ("Unknown storyline position", "故事线顺序已变化，请刷新后重试。"),
            ("Storyline is not open", "这条故事线页面已关闭，请重新打开。"),
            ("Facts have rows without order registers", "字段数据不完整，暂时无法保存。已输入的内容仍保留。"),
            ("unresolved prose dependencies", "故事线正文还有未完成的同步依赖，暂时无法恢复。"),
            ("more than one primary storyline", "章节的主线数据不一致，暂时无法保存。"),
            ("scope changed", "故事线已变化，请重新打开页面。"),
        ]
        return known.first { reason.contains($0.0) }?.1 ?? "故事线操作未能完成。已有内容未改变，可以稍后重试。"
    }

    /// Element library refusals happen before any row or journal change.
    /// Name conflicts name both sides; other known reasons get guidance.
    private static func elementMessage(_ reason: String) -> String {
        if let conflict = elementNameConflict(reason) { return conflict }
        let known: [(String, String)] = [
            ("Category is not available", "这个分类已不可用，请刷新设定库。"),
            ("Element is not available", "这个设定已不可用，请刷新设定库。"),
            ("Category name is empty", "分类名称不能为空，颜色须为有效的颜色值。"),
            ("模版格式范围无效", "加粗或斜体的范围超出了所在段落的文字，模版未保存。请重新选择文字后再试。"),
            ("Invalid template", "模版的格式无效，暂时无法保存。已输入的内容仍保留。"),
            ("分类不存在或已在回收站", "这个分类已不可用（可能已移到回收站），请刷新设定库。"),
            ("Category is not open", "这个分类页面已关闭，请重新打开。"),
            ("Category still has a live document owner", "请先关闭这个分类的页面，再恢复。"),
            ("Category has unresolved prose dependencies", "分类正文还有未完成的同步依赖，暂时无法恢复。"),
            ("unresolved prose dependencies", "设定正文还有未完成的同步依赖，暂时无法恢复。"),
            ("Category lifecycle must be", "分类状态已变化，请刷新设定库。"),
            ("Facts have rows without order registers", "字段数据不完整，暂时无法保存。已输入的内容仍保留。"),
            ("live document owner", "请先关闭这个设定的页面，再恢复。"),
            ("Element is not open", "这个设定页面已关闭，请重新打开。"),
            ("Element lifecycle must be", "设定状态已变化，请刷新设定库。"),
            ("scope changed", "设定已变化，请重新打开页面。"),
        ]
        return known.first { reason.contains($0.0) }?.1 ?? "设定操作未能完成。已有内容未改变，可以稍后重试。"
    }

    /// Comment refusals happen before any row, anchor or prose changes. Known
    /// core reasons get specific guidance; the exact text stays diagnostic.
    private static func commentMessage(_ reason: String) -> String {
        let known: [(String, String)] = [
            ("Document changed", "正文已变化，请重新选择要批注的文字。"),
            ("active drafts", "请先完成输入，再添加批注。"),
            ("pending save", "正文尚未保存，请先重试保存。"),
            ("Select text", "请先选中要批注的文字。"),
            ("body is empty", "批注内容不能为空。"),
            ("editable text blocks", "所选内容包含暂不支持批注的段落，请缩小选区。"),
            ("No text block", "请先选中要批注的文字。"),
            ("converted suggestion", "已转化的建议不能解决或重新打开。"),
            ("not on this chapter", "这条批注已不在当前章节，请刷新批注列表。"),
            ("not live", "这条批注已被删除，请刷新批注列表。"),
            ("Chapter is not available", "这一章已不可用，请重新打开章节。"),
        ]
        return known.first { reason.contains($0.0) }?.1 ?? "批注操作未能完成。正文和已有批注均未改变，可以稍后重试。"
    }
}

/// Sole Swift owner of one Rust handle. UI clients use this serial queue;
/// no blocking SQLite work runs on the main thread.
struct NativeInputReply: Decodable { let input: NativeProjection; let state: LabDocumentState }
struct NativeCheckpoint: Decodable { let update: String; let stateVector: String }
struct DraftSelection { let viewID: String; let epoch: UInt64; let range: NSRange }
/// `linked` spans were added; the state is adopted like a format reply.
struct NativeEntityLinkReply: Decodable { let linked: Int; let state: LabDocumentState }

final class LabCore {
    private let queue: DispatchQueue
    private var handle: UInt64?
    private let directory: URL
    private weak var sharedDocument: DocumentStore?
    private var pendingDocument: DocumentStore?
    private let closesOwnHandle: Bool
    /// Workspace chapter and element bodies link entity names; the
    /// standalone lab document has no workspace names to link.
    let linksEntities: Bool
    private(set) var isSuspended = false
    private(set) var isClosed = false

    fileprivate var hasPendingDocumentWork: Bool {
        precondition(Thread.isMainThread)
        return sharedDocument?.hasPendingWork == true
    }

    fileprivate var hasQueuedDocumentInput: Bool {
        precondition(Thread.isMainThread)
        return sharedDocument?.hasQueuedInput == true
    }

    func retainPendingDocument(_ store: DocumentStore, needed: Bool) {
        pendingDocument = needed ? store : nil
    }

    /// All views of this handle share one main-thread queue and undo owner.
    /// Weak caching lets the last view release the store without a retain cycle.
    func documentStore() -> DocumentStore {
        precondition(Thread.isMainThread)
        if let sharedDocument { return sharedDocument }
        let store = DocumentStore(core: self)
        sharedDocument = store
        return store
    }

    init(directory: URL? = nil) {
        queue = DispatchQueue(label: "cc.drifting.native-lab.core")
        closesOwnHandle = true
        linksEntities = false
        self.directory = directory ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent(Bundle.main.bundleIdentifier ?? "cc.drifting.native-lab")
            .appendingPathComponent("apple-native-lab", isDirectory: true)
    }

    fileprivate init(handle: UInt64, directory: URL, queue: DispatchQueue) {
        self.queue = queue
        closesOwnHandle = false
        linksEntities = true
        self.handle = handle
        self.directory = directory
    }

    fileprivate func suspend(_ value: Bool) {
        precondition(Thread.isMainThread)
        isSuspended = value
        // A background link reply may have landed during the owner change.
        if value { sharedDocument?.activity() } else { sharedDocument?.resumed() }
    }

    fileprivate func receiveReconciledState(_ state: LabDocumentState) {
        precondition(Thread.isMainThread)
        guard !isClosed else { return }
        // A chapter without views needs no new store. Its next view will load
        // the already-reconciled owner; retained drafts keep their existing one.
        sharedDocument?.receiveReconciledState(state)
    }

    fileprivate func invalidate() {
        precondition(Thread.isMainThread)
        isClosed = true
        queue.async { self.handle = nil }
        sharedDocument?.activity()
    }

    fileprivate var documentViewCount: Int { sharedDocument?.viewCount ?? 0 }
    /// A tab, page or the 全书长卷 shows this owner.
    var hasDocumentViews: Bool { documentViewCount > 0 }

    fileprivate static func call<Payload: Decodable>(_ request: [String: Any]) throws -> Payload? {
        let data = try JSONSerialization.data(withJSONObject: request)
        guard let input = String(data: data, encoding: .utf8) else { throw LabError.message("无法编码请求") }
        let pointer = input.withCString { drifting_lab_call($0) }
        guard let pointer else { throw LabError.message("无法连接文档核心") }
        defer { drifting_lab_free(pointer) }
        let reply = try JSONDecoder().decode(CoreReply<Payload>.self, from: Data(String(cString: pointer).utf8))
        guard reply.abiVersion == 1 else { throw LabError.message("核心版本不匹配") }
        guard reply.ok else {
            let reason = reply.error ?? "核心操作失败"
            if ["documentUndo", "documentRedo"].contains(request["operation"] as? String ?? ""),
               reason.hasPrefix("NATIVE_HISTORY_UNAVAILABLE:") {
                throw LabError.historyUnavailable(reason: reason)
            }
            if request["operation"] as? String == "documentFormat",
               reason.hasPrefix("NATIVE_FORMATTING_UNAVAILABLE:") {
                throw LabError.formattingUnavailable(reason: reason)
            }
            if ["documentComments", "documentCreateComment", "documentUpdateCommentBody", "documentSetCommentResolved"]
                .contains(request["operation"] as? String ?? "") {
                throw LabError.commentUnavailable(reason: reason)
            }
            if ["open", "workspaceOpenChapter", "workspaceReopenChapter", "workspaceElements", "workspaceStorylines", "workspaceDrifts"]
                .contains(request["operation"] as? String ?? ""),
               reason.contains("REMOTE_TEXT_RETENTION_REQUIRED:") {
                throw LabError.pendingRemoteUpdate(reason: reason)
            }
            if request["operation"] as? String == "workspaceElements" {
                throw LabError.elementUnavailable(reason: reason)
            }
            if request["operation"] as? String == "workspaceStorylines" {
                throw LabError.storylineUnavailable(reason: reason)
            }
            if request["operation"] as? String == "workspaceDrifts" {
                throw LabError.driftUnavailable(reason: reason)
            }
            if request["operation"] as? String == "workspaceMetadata" {
                throw LabError.metadataUnavailable(reason: reason)
            }
            if request["operation"] as? String == "workspaceRelations" {
                throw LabError.relationUnavailable(reason: reason)
            }
            if request["operation"] as? String == "workspaceLibrary" {
                throw LabError.libraryUnavailable(reason: reason)
            }
            if request["operation"] as? String == "workspaceTransfer" {
                throw LabError.transferUnavailable(reason: reason)
            }
            if request["operation"] as? String == "workspaceTimeline" {
                throw LabError.timelineUnavailable(reason: reason)
            }
            if request["operation"] as? String == "workspaceComments" {
                throw LabError.reviewUnavailable(reason: reason)
            }
            if ["workspaceCreateAct", "workspaceRenameAct", "workspaceMoveAct", "workspaceSetActColor", "workspaceRemoveAct"]
                .contains(request["operation"] as? String ?? "") {
                throw LabError.actUnavailable(reason: reason)
            }
            if request["operation"] as? String == "workspacePatches" {
                throw LabError.patchUnavailable(reason: reason)
            }
            if request["operation"] as? String == "workspaceDeleteProject" {
                throw LabError.projectUnavailable(reason: reason)
            }
            if ["workspacePurgeTrashed", "workspaceEmptyTrash", "workspaceTrash"].contains(request["operation"] as? String ?? "") {
                throw LabError.trashUnavailable(reason: reason)
            }
            if request["operation"] as? String == "workspaceHistory" {
                throw LabError.versionHistoryUnavailable(reason: reason)
            }
            if request["operation"] as? String == "workspacePlotGrid" {
                throw LabError.plotGridUnavailable(reason: reason)
            }
            throw LabError.message(reason)
        }
        return reply.value
    }

    func open(completion: @escaping (Result<LabState, Error>) -> Void) {
        perform(completion) {
            let state: LabState? = try LabCore.call(self.handle.map { ["operation": "read", "handle": $0] }
                ?? ["operation": "open", "directory": self.directory.path])
            guard let state else { throw LabError.message("项目没有返回") }
            self.handle = state.handle
            return state
        }
    }

    func rename(_ name: String, completion: @escaping (Result<LabState, Error>) -> Void) {
        perform(completion) {
            guard let handle = self.handle else { throw LabError.message("请先打开项目") }
            guard let state: LabState = try LabCore.call(["operation": "rename", "handle": handle, "name": name]) else {
                throw LabError.message("保存结果缺失")
            }
            return state
        }
    }

    func reopen(completion: @escaping (Result<LabState, Error>) -> Void) {
        precondition(Thread.isMainThread)
        guard sharedDocument?.hasPendingWork != true else {
            completion(.failure(LabError.message("仍有未完成的输入或待恢复草稿，请先保存或处理草稿"))); return
        }
        perform(completion) {
            if let handle = self.handle { let _: LabState? = try LabCore.call(["operation": "close", "handle": handle]); self.handle = nil }
            guard let state: LabState = try LabCore.call(["operation": "open", "directory": self.directory.path]) else {
                throw LabError.message("项目没有返回")
            }
            self.handle = state.handle
            return state
        }
    }

    func document(_ operation: String = "documentRead", edit: [String: Any]? = nil,
                  completion: @escaping (Result<LabDocumentState, Error>) -> Void) {
        documentRequest(operation, fields: edit.map { ["edit": $0] } ?? [:], completion: completion)
    }

    private func documentRequest(_ operation: String, fields: [String: Any],
                                 completion: @escaping (Result<LabDocumentState, Error>) -> Void) {
        perform(completion) {
            guard let handle = self.handle else { throw LabError.message("请先打开项目") }
            var request = fields; request["operation"] = operation; request["handle"] = handle
            guard let state: LabDocumentState = try LabCore.call(request) else { throw LabError.message("正文没有返回") }
            return state
        }
    }

    /// Direct comments on this workspace chapter, in the renderer's order.
    func comments(completion: @escaping (Result<[WorkspaceComment], Error>) -> Void) {
        documentValue("documentComments", fields: [:]) { (result: Result<WorkspaceCommentList, Error>) in
            completion(result.map(\.comments))
        }
    }

    /// Callers route this through DocumentStore so queued input, marked text
    /// and the projection revision are checked before the core is asked.
    /// With `suggestion` (`{metadata, priority?}`) the row is a Copilot
    /// suggestion: author and source `copilot`, the metadata kept verbatim.
    func createComment(revision: UInt64, range: NSRange, body: String, suggestion: [String: Any]? = nil,
                       completion: @escaping (Result<WorkspaceCommentCreation, Error>) -> Void) {
        var fields: [String: Any] = ["revision": revision, "range": ["location": range.location, "length": range.length], "body": body]
        if let suggestion { fields["suggestion"] = suggestion }
        documentValue("documentCreateComment", fields: fields, completion: completion)
    }

    func updateCommentBody(id: String, body: String, completion: @escaping (Result<WorkspaceComment, Error>) -> Void) {
        documentValue("documentUpdateCommentBody", fields: ["commentId": id, "body": body]) { (result: Result<WorkspaceCommentReply, Error>) in
            completion(result.map(\.comment))
        }
    }

    func setCommentResolved(id: String, resolved: Bool, completion: @escaping (Result<WorkspaceComment, Error>) -> Void) {
        documentValue("documentSetCommentResolved", fields: ["commentId": id, "resolved": resolved]) { (result: Result<WorkspaceCommentReply, Error>) in
            completion(result.map(\.comment))
        }
    }

    /// Links every unlinked element name, alias and chapter title in this
    /// workspace body. Never an undo step; with pending input, a failed save or
    /// a remote block Rust links nothing and the caller retries later.
    func linkEntities(completion: @escaping (Result<NativeEntityLinkReply, Error>) -> Void) {
        perform(completion) {
            guard let handle = self.handle else { throw LabError.message("请先打开项目") }
            guard let value: NativeEntityLinkReply = try LabCore.call(["operation": "documentLinkEntities", "handle": handle]) else {
                throw LabError.message("链接结果没有返回")
            }
            return value
        }
    }

    private func documentValue<Payload: Decodable>(_ operation: String, fields: [String: Any],
                                                   completion: @escaping (Result<Payload, Error>) -> Void) {
        perform(completion) {
            guard let handle = self.handle else { throw LabError.message("请先打开项目") }
            var request = fields; request["operation"] = operation; request["handle"] = handle
            guard let value: Payload = try LabCore.call(request) else { throw LabError.message("批注结果没有返回") }
            return value
        }
    }

    func exportDocument(completion: @escaping (Result<NativeCheckpoint, Error>) -> Void) {
        perform(completion) {
            guard let handle = self.handle else { throw LabError.message("请先打开项目") }
            guard let value: NativeCheckpoint = try LabCore.call(["operation": "documentExport", "handle": handle]) else {
                throw LabError.message("文档状态没有返回")
            }
            return value
        }
    }

    /// Fixture transport only; production reducer/acknowledgement is a P4 gate.
    /// Native views must route this through the shared input queue before use;
    /// direct calls currently belong to transport acceptance only.
    func applyRemote(_ update: String, encoding: UInt8 = 1,
                     completion: @escaping (Result<LabDocumentState, Error>) -> Void) {
        documentRequest("documentApplyRemote", fields: ["update": update, "encoding": encoding], completion: completion)
    }

    func beginDraft(key: String, revision: UInt64, range: NSRange,
                    completion: @escaping (Result<Bool, Error>) -> Void) {
        perform(completion) {
            guard let handle = self.handle else { throw LabError.message("请先打开项目") }
            let _: LabState? = try LabCore.call(["operation": "documentBeginDraft", "handle": handle,
                "start": ["key": key, "revision": revision, "range": ["location": range.location, "length": range.length]]])
            return true
        }
    }

    func commitDraft(key: String, text: String, selection: DraftSelection? = nil,
                     completion: @escaping (Result<LabDocumentState, Error>) -> Void) {
        var commit: [String: Any] = ["key": key, "text": text]
        if let selection {
            commit["selection"] = ["viewId": selection.viewID, "epoch": selection.epoch,
                "range": ["location": selection.range.location, "length": selection.range.length]]
        }
        documentRequest("documentCommitDraft", fields: ["commit": commit], completion: completion)
    }

    func cancelDraft(key: String, completion: @escaping (Result<Bool, Error>) -> Void) {
        perform(completion) {
            guard let handle = self.handle else { throw LabError.message("请先打开项目") }
            let _: LabState? = try LabCore.call(["operation": "documentCancelDraft", "handle": handle, "key": key])
            return true
        }
    }

    func inputFork(key: String, source: String? = nil, completion: @escaping (Result<NativeInputReply, Error>) -> Void) {
        inputRequest("documentInputFork", fields: ["key": key, "source": source.map { $0 as Any } ?? NSNull()], completion: completion)
    }

    func inputReplace(key: String, sequence: UInt64, change: NativeTextChange, selection: DraftSelection?,
                      completion: @escaping (Result<NativeInputReply, Error>) -> Void) {
        var edit: [String: Any] = ["key": key, "sequence": sequence,
            "range": ["location": change.range.location, "length": change.range.length], "text": change.text]
        if let selection { edit["selection"] = ["viewId": selection.viewID, "epoch": selection.epoch,
            "range": ["location": selection.range.location, "length": selection.range.length]] }
        inputRequest("documentInputReplace", fields: ["edit": edit], completion: completion)
    }

    private func inputRequest(_ operation: String, fields: [String: Any],
                              completion: @escaping (Result<NativeInputReply, Error>) -> Void) {
        perform(completion) {
            guard let handle = self.handle else { throw LabError.message("请先打开项目") }
            var request = fields; request["operation"] = operation; request["handle"] = handle
            guard let value: NativeInputReply = try LabCore.call(request) else { throw LabError.message("输入状态没有返回") }
            return value
        }
    }

    func inputDrop(key: String) {
        perform({ (_: Result<Bool, Error>) in }) {
            guard let handle = self.handle else { return true }
            let _: LabState? = try LabCore.call(["operation": "documentInputDrop", "handle": handle, "key": key])
            return true
        }
    }

    func selection(viewID: String, epoch: UInt64, revision: UInt64, range: NSRange,
                   completion: @escaping (Result<NativeSelectionCapture, Error>) -> Void) {
        perform(completion) {
            guard let handle = self.handle else { throw LabError.message("请先打开项目") }
            guard let value: NativeSelectionCapture = try LabCore.call(["operation": "documentSelect", "handle": handle,
                "selection": ["viewId": viewID, "epoch": epoch, "revision": revision,
                    "range": ["location": range.location, "length": range.length]]]) else {
                throw LabError.message("选区没有返回")
            }
            return value
        }
    }

    func dropSelection(viewID: String) {
        perform({ (_: Result<Bool, Error>) in }) {
            guard let handle = self.handle else { return true }
            let _: LabState? = try LabCore.call(["operation": "documentDropSelection", "handle": handle, "viewId": viewID])
            return true
        }
    }

    private func perform<Payload>(_ completion: @escaping (Result<Payload, Error>) -> Void, _ operation: @escaping () throws -> Payload) {
        queue.async {
            let result = Result { try operation() }
            DispatchQueue.main.async { completion(result) }
        }
    }

    deinit {
        // Enqueued operations retain self, so deinit only runs after they finish.
        if closesOwnHandle, let handle {
            queue.async { let _: LabState? = try? LabCore.call(["operation": "close", "handle": handle]) }
        }
    }
}

struct WorkspaceProject: Decodable, Equatable {
    let id: String
    let name: String
}

struct WorkspaceChapter: Decodable {
    let id: String
    let title: String
    /// `draft`, `finished` or `discarded` in chapter lists; nil for a chapter
    /// named elsewhere, e.g. by a search hit or an outline row.
    var writingStatus: String? = nil
    /// The chapter's coordinate on the book axis in chapter lists (acts
    /// start at such coordinates); nil for a chapter named elsewhere.
    var bookOrder: Double? = nil
    /// When the row last changed; for a trashed chapter, when it was
    /// trashed (trash stamps it with `deleted_at`). Nil when named elsewhere.
    var updatedAt: String? = nil
}
struct WorkspaceAct: Decodable {
    let id: String
    let projectId: String
    let name: String
    let color: String?
    let startOrder: Double?
    let driftNodeId: String?
    let createdAt: String
    let updatedAt: String
}

struct ChapterScope: Hashable {
    let projectID: String
    let chapterID: String
}

struct ElementScope: Hashable {
    let projectID: String
    let elementID: String
}

struct StorylineScope: Hashable {
    let projectID: String
    let storylineID: String
}

struct DriftScope: Hashable {
    let projectID: String
    let driftID: String
}

struct CategoryScope: Hashable {
    let projectID: String
    let categoryID: String
}

/// One Rust prose owner in the workspace: a chapter body, or an element,
/// storyline, drift or category page body. Rust keys them separately; Swift
/// keeps one wrapper per live handle.
enum DocumentScope: Hashable {
    case chapter(ChapterScope)
    case element(ElementScope)
    case storyline(StorylineScope)
    case drift(DriftScope)
    case category(CategoryScope)

    var projectID: String {
        switch self {
        case .chapter(let scope): return scope.projectID
        case .element(let scope): return scope.projectID
        case .storyline(let scope): return scope.projectID
        case .drift(let scope): return scope.projectID
        case .category(let scope): return scope.projectID
        }
    }

    /// How refusals name the document to the author.
    var kindName: String {
        switch self {
        case .chapter: return "章节"
        case .element: return "设定"
        case .storyline: return "故事线"
        case .drift: return "漂流"
        case .category: return "分类"
        }
    }
}
struct WorkspaceOutlineEntry: Decodable, Equatable {
    let kind: String
    let id: String
    let title: String
    let actId: String?
    /// An act's stored colour (`#rrggbb`); nil for chapters and for acts
    /// that follow the default hue cycle.
    let color: String?
    /// An act's boundary on the book axis: it starts at the first chapter
    /// whose book order is at least this. Nil for chapters and for an act
    /// anchored at the head of the book.
    var startOrder: Double? = nil
}

private struct WorkspaceState: Decodable {
    let handle: UInt64
    let projects: [WorkspaceProject]
}

struct WorkspaceDocumentReply: Decodable {
    let handle: UInt64
    let projectId: String
    let chapterId: String
    let document: LabDocumentState
}

struct RemoteChangeOriginal: Codable {
    let projectId: String
    let projectSyncId: String
    let syncGenerationId: String
    let changeSetId: String
    let originalEnvelopeSha256: String
}

private protocol WorkspaceRemoteDeliveryReply: Decodable {
    var documents: [WorkspaceDocumentReply] { get }
}

struct WorkspaceRemoteProseReply: WorkspaceRemoteDeliveryReply {
    let changeSetId: String
    let alreadyApplied: Bool
    let affectedDocuments: [String]
    let documents: [WorkspaceDocumentReply]
}

struct WorkspaceRemoteChangesReply: WorkspaceRemoteDeliveryReply {
    let changeSetId: String
    let alreadyApplied: Bool
    let affectedDocuments: [String]
    let documents: [WorkspaceDocumentReply]
    let projectId: String
    let projects: [WorkspaceProject]
    let chapters: [WorkspaceChapter]
}

/// `workspaceAgent readProse`: `live` when read from an open owner.
struct WorkspaceAgentProse: Decodable {
    let text: String
    let live: Bool
}

/// `workspaceAgent readProjection`: a body's text, blocks and marks for
/// printing, read from its open owner (`live`, with text not saved yet) or
/// from stored prose. Display hints only; the marks stay in Yrs.
struct WorkspaceBodyProjection: Decodable {
    struct Marks: Decodable {
        /// Mark names without y-prosemirror's overlap suffix.
        let names: Set<String>
        /// A `link` mark's address.
        let href: String?
        private struct Keys: CodingKey {
            let stringValue: String
            var intValue: Int? { nil }
            init?(stringValue: String) { self.stringValue = stringValue }
            init?(intValue: Int) { return nil }
        }
        private struct Link: Decodable { let href: String? }
        init(from decoder: Decoder) throws {
            let values = try decoder.container(keyedBy: Keys.self)
            var names = Set<String>(), href: String?
            for key in values.allKeys {
                let name = key.stringValue.replacingOccurrences(of: "--[a-zA-Z0-9+/=]{8}$", with: "", options: .regularExpression)
                names.insert(name)
                if name == "link", href == nil { href = (try? values.decode(Link.self, forKey: key))?.href }
            }
            self.names = names
            self.href = href
        }
    }
    struct Run: Decodable {
        let range: NativeRange
        let attributes: Marks
    }
    struct Block: Decodable {
        let kind: String
        /// Nesting inside quotes and lists (a list item adds two levels).
        let depth: Int
        /// The parent element: blocks of one quote or list item share it.
        let container: String
        let range: NativeRange
        let runs: [Run]
        /// A heading's level.
        let level: Int?
        /// Enclosing `blockquote` / `bulletList` / `orderedList` / `listItem`
        /// tags, outermost first.
        let containers: [String]
        /// The number of the nearest enclosing ordered-list item.
        let listNumber: Int?
        private enum CodingKeys: String, CodingKey { case kind, depth, container, range, runs, attributes, containers, listNumber }
        private struct Attributes: Decodable {
            let level: Double?
            private enum CodingKeys: String, CodingKey { case level }
            init(from decoder: Decoder) throws {
                level = try? decoder.container(keyedBy: CodingKeys.self).decode(Double.self, forKey: .level)
            }
        }
        init(kind: String, depth: Int = 0, container: String = "", range: NativeRange, runs: [Run] = [], level: Int? = nil,
             containers: [String] = [], listNumber: Int? = nil) {
            self.kind = kind; self.depth = depth; self.container = container; self.range = range; self.runs = runs; self.level = level
            self.containers = containers; self.listNumber = listNumber
        }
        init(from decoder: Decoder) throws {
            let values = try decoder.container(keyedBy: CodingKeys.self)
            kind = try values.decode(String.self, forKey: .kind)
            depth = (try? values.decode(Int.self, forKey: .depth)) ?? 0
            container = (try? values.decode(String.self, forKey: .container)) ?? ""
            range = try values.decode(NativeRange.self, forKey: .range)
            runs = (try? values.decode([Run].self, forKey: .runs)) ?? []
            level = (try? values.decode(Attributes.self, forKey: .attributes))?.level.map { Int($0) }
            containers = (try? values.decode([String].self, forKey: .containers)) ?? []
            listNumber = try? values.decode(Int.self, forKey: .listNumber)
        }
    }
    struct Projection: Decodable {
        let text: String
        let blocks: [Block]
    }
    let projection: Projection
    let live: Bool
}

/// `workspaceAgent applyChanges`: `handle` is the open owner that adopted the
/// revision, or nil when a temporary owner applied, saved and closed.
struct WorkspaceAgentApplied: Decodable {
    let applied: Int
    let handle: UInt64?
    let document: LabDocumentState
}

/// `workspaceDeleteProject`: what was removed and the projects that remain.
struct WorkspaceProjectDeletion: Decodable, Equatable {
    let projectId: String
    let assetIds: [String]
    let documentIds: [String]
}
struct WorkspaceProjectDeletionReply: Decodable {
    let deleted: WorkspaceProjectDeletion
    let projects: [WorkspaceProject]
}

struct WorkspaceChapterTrashReply: Decodable {
    let projectId: String
    let chapterId: String
    let chapters: [WorkspaceChapter]
    let trashedChapters: [WorkspaceChapter]
}

/// Registry of Swift wrappers for Rust's chapter and element owners. Cache
/// changes belong to the main thread; the workspace queue owns only FFI
/// requests and its handle.
final class LabWorkspaceCore {
    private let queue = DispatchQueue(label: "cc.drifting.native-lab.workspace")
    private let directory: URL
    private var handle: UInt64?
    private struct Owner { let handle: UInt64; let core: LabCore }
    private struct OwnerReply: Decodable { let handle: UInt64 }
    private var owners: [DocumentScope: Owner] = [:]
    private var remoteDeliveryInFlight = 0
    private(set) var isChangingOwners = false
    var hasPendingDocuments: Bool { owners.values.contains { $0.core.hasPendingDocumentWork } }
    /// Input a view accepted that Rust has not applied yet (queued, sending
    /// or composing). A failed save is not queued: its text is in the owner.
    var hasQueuedInput: Bool { owners.values.contains { $0.core.hasQueuedDocumentInput } }
    /// Open Rust owners with a Swift wrapper, e.g. to keep the 全书长卷 bounded.
    var openDocumentCount: Int { owners.count }
    func hasOpenDocument(_ scope: DocumentScope) -> Bool { owners[scope] != nil }
    /// A remote original was accepted for this project. Open owners were
    /// saved again; bodies without an owner changed only in durable prose.
    var onRemoteOriginal: ((String) -> Void)?

    init(directory: URL? = nil) {
        self.directory = directory ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent(Bundle.main.bundleIdentifier ?? "cc.drifting.native-lab")
            .appendingPathComponent("apple-native-lab", isDirectory: true)
    }

    func projects(completion: @escaping (Result<[WorkspaceProject], Error>) -> Void) {
        perform(completion) {
            if self.handle != nil { return try self.request("workspaceProjects") }
            guard let state: WorkspaceState = try LabCore.call([
                "operation": "workspaceOpen", "directory": self.directory.path,
            ]) else { throw LabError.message("工作区没有返回") }
            self.handle = state.handle
            return state.projects
        }
    }

    func createProject(name: String, completion: @escaping (Result<WorkspaceProject, Error>) -> Void) {
        perform(completion) { try self.request("workspaceCreateProject", fields: ["name": name]) }
    }

    func renameProject(projectID: String, name: String,
                       completion: @escaping (Result<WorkspaceProject, Error>) -> Void) {
        updateMetadata("workspaceRenameProject", fields: ["projectId": projectID, "name": name], completion: completion)
    }

    /// Deletes the project, its rows, prose, history and asset bytes. Rust
    /// refuses while any body of the project is open; callers close its tabs
    /// and panels first. The reply lists the remaining projects.
    func deleteProject(projectID: String, completion: @escaping (Result<WorkspaceProjectDeletionReply, Error>) -> Void) {
        precondition(Thread.isMainThread)
        guard !isChangingOwners else {
            completion(.failure(LabError.message("请先完成输入，并等待正文保存后再删除项目。"))); return
        }
        perform(completion) { try self.request("workspaceDeleteProject", fields: ["projectId": projectID]) }
    }

    func chapters(projectID: String, completion: @escaping (Result<[WorkspaceChapter], Error>) -> Void) {
        perform(completion) { try self.request("workspaceChapters", fields: ["projectId": projectID]) }
    }

    func trashedChapters(projectID: String, completion: @escaping (Result<[WorkspaceChapter], Error>) -> Void) {
        perform(completion) { try self.request("workspaceTrashedChapters", fields: ["projectId": projectID]) }
    }

    func trashChapter(projectID: String, chapterID: String,
                      completion: @escaping (Result<WorkspaceChapterTrashReply, Error>) -> Void) {
        notAuthored(projectID) {
            changeLifecycle(.chapter(ChapterScope(projectID: projectID, chapterID: chapterID)), closesOwner: true, completion: completion) {
                try self.request("workspaceTrashChapter", fields: ["projectId": projectID, "chapterId": chapterID])
            }
        }
    }

    func restoreChapter(projectID: String, chapterID: String,
                        completion: @escaping (Result<WorkspaceChapterTrashReply, Error>) -> Void) {
        notAuthored(projectID) {
            changeLifecycle(.chapter(ChapterScope(projectID: projectID, chapterID: chapterID)), closesOwner: false, completion: completion) {
                try self.request("workspaceRestoreChapter", fields: ["projectId": projectID, "chapterId": chapterID])
            }
        }
    }

    // MARK: 回收站

    /// 彻底删除: a trashed chapter, drift, element, category or storyline and
    /// what only it owns (comments on it, its facts, an element's patches,
    /// its body and version history) in one original. Rust refuses live
    /// content and an open page. The reply lists what remains in the trash.
    func purgeTrashed(projectID: String, kind: String, id: String,
                      completion: @escaping (Result<WorkspaceTrashPurgeReply, Error>) -> Void) {
        precondition(Thread.isMainThread)
        guard !isChangingOwners else {
            completion(.failure(LabError.message("请先完成输入，并等待正文保存后再彻底删除。"))); return
        }
        perform(completion) {
            try self.request("workspacePurgeTrashed", fields: ["projectId": projectID, "kind": kind, "id": id])
        }
    }

    /// The project's trash: every trashed chapter, drift, element, category
    /// and storyline with its title, newest first by the time it was trashed.
    func trash(projectID: String, completion: @escaping (Result<WorkspaceTrashListing, Error>) -> Void) {
        perform(completion) { try self.request("workspaceTrash", fields: ["projectId": projectID]) }
    }

    /// 清空回收站: everything in the project's trash in one original. Rust
    /// purges only while the trash holds exactly `confirmed`, the entries the
    /// author was shown; otherwise it refuses and writes nothing.
    func emptyTrash(projectID: String, confirmed: [WorkspaceTrashItem],
                    completion: @escaping (Result<WorkspaceTrashPurgeReply, Error>) -> Void) {
        precondition(Thread.isMainThread)
        guard !isChangingOwners else {
            completion(.failure(LabError.message("请先完成输入，并等待正文保存后再清空回收站。"))); return
        }
        let keys = confirmed.map(\.confirmedKey)
        perform(completion) { try self.request("workspaceEmptyTrash", fields: ["projectId": projectID, "confirmed": keys]) }
    }

    // MARK: Diagnostics

    /// The sanitized workspace summary: counts, sizes, integrity, journal and
    /// open-body state. Rust never includes names, identities, prose or paths.
    func diagnostics(completion: @escaping (Result<AgentJSON, Error>) -> Void) {
        perform(completion) { try self.request("workspaceDiagnostics") }
    }

    /// 导出为 Markdown 文件夹: one Markdown file per chapter, drift, element,
    /// category, storyline, note and material, for the host to write. Open
    /// bodies are read live, so queued input is refused first.
    func exportArchive(projectID: String, completion: @escaping (Result<WorkspaceMarkdownArchive, Error>) -> Void) {
        precondition(Thread.isMainThread)
        guard !isChangingOwners, !hasPendingDocuments else {
            completion(.failure(LabError.message("请先完成输入，并等待正文保存后再导出。"))); return
        }
        perform(completion) {
            try self.request("workspaceTransfer", fields: ["projectId": projectID, "command": ["action": "exportArchive"]])
        }
    }

    private func changeLifecycle<Payload>(_ scope: DocumentScope, closesOwner: Bool,
                                          completion: @escaping (Result<Payload, Error>) -> Void,
                                          _ operation: @escaping () throws -> Payload) {
        precondition(Thread.isMainThread)
        guard beginOwnerChange() else {
            completion(.failure(LabError.message("请先完成输入，并保存或处理所有待恢复草稿"))); return
        }
        perform({ (result: Result<Payload, Error>) in
            // Rust saves the live owner before changing its lifecycle. A failed
            // transaction keeps every wrapper and view; a restored document is
            // left closed until its new incarnation is opened normally.
            if closesOwner, case .success = result {
                self.owners.removeValue(forKey: scope)?.core.invalidate()
            }
            self.endOwnerChange()
            completion(result)
        }, operation)
    }

    // MARK: Elements library

    /// Live categories, live elements and the element trash of one project.
    func elementLibrary(projectID: String, completion: @escaping (Result<WorkspaceElementLibrary, Error>) -> Void) {
        perform(completion) {
            let reply: WorkspaceElementReply<WorkspaceElement> = try self.elementRequest(projectID, ["action": "library"])
            return reply.library
        }
    }

    /// An empty name becomes the renderer's default; Rust picks the colour.
    func createElementCategory(projectID: String, name: String,
                               completion: @escaping (Result<WorkspaceElementReply<WorkspaceElementCategory>, Error>) -> Void) {
        perform(completion) { try self.elementRequest(projectID, ["action": "createCategory", "name": name]) }
    }

    func updateElementCategory(projectID: String, categoryID: String, name: String? = nil, color: String? = nil,
                               completion: @escaping (Result<WorkspaceElementReply<WorkspaceElementCategory>, Error>) -> Void) {
        var command: [String: Any] = ["action": "updateCategory", "categoryId": categoryID]
        if let name { command["name"] = name }
        if let color { command["color"] = color }
        perform(completion) { try self.elementRequest(projectID, command) }
    }

    /// Without a name Rust chooses the next free default name. Summary,
    /// aliases and facts are written in the same original; without facts
    /// the category's template facts are cloned.
    func createElement(projectID: String, categoryID: String, name: String? = nil, groupName: String? = nil,
                       summary: String? = nil, aliases: [String]? = nil, facts: [WorkspaceFact]? = nil,
                       completion: @escaping (Result<WorkspaceElementReply<WorkspaceElement>, Error>) -> Void) {
        var command: [String: Any] = ["action": "createElement", "categoryId": categoryID]
        if let name { command["name"] = name }
        if let groupName { command["groupName"] = groupName }
        if let summary { command["summary"] = summary }
        if let aliases { command["aliases"] = aliases }
        if let facts { command["facts"] = facts.map(\.payload) }
        perform(completion) { try self.elementRequest(projectID, command) }
    }

    /// Page fields change metadata only; the element's body owner, its
    /// queued input and history are untouched, so no owner guard applies.
    func updateElement(projectID: String, elementID: String, changes: WorkspaceElementChanges,
                       completion: @escaping (Result<WorkspaceElementReply<WorkspaceElement>, Error>) -> Void) {
        var command = changes.fields
        command["action"] = "updateElement"; command["elementId"] = elementID
        perform(completion) { try self.elementRequest(projectID, command) }
    }

    /// Replaces the element's ordered facts. Metadata only, like header fields.
    func setElementFacts(projectID: String, elementID: String, facts: [WorkspaceFact],
                         completion: @escaping (Result<WorkspaceElementReply<WorkspaceElement>, Error>) -> Void) {
        perform(completion) {
            try self.elementRequest(projectID, ["action": "setElementFacts", "elementId": elementID, "facts": facts.map(\.payload)])
        }
    }

    /// The facts later elements of this category clone at creation.
    func setCategoryTemplateFacts(projectID: String, categoryID: String, facts: [WorkspaceFact],
                                  completion: @escaping (Result<WorkspaceElementReply<WorkspaceElementCategory>, Error>) -> Void) {
        perform(completion) {
            try self.elementRequest(projectID, ["action": "setCategoryTemplateFacts", "categoryId": categoryID, "facts": facts.map(\.payload)])
        }
    }

    /// Detaches every element of the category and removes the category's
    /// relations; no element owner changes, so open element pages stay open.
    /// Rust saves an open category body before the trash commits, then
    /// retires it.
    func trashElementCategory(projectID: String, categoryID: String,
                              completion: @escaping (Result<WorkspaceElementReply<WorkspaceElementCategory>, Error>) -> Void) {
        changeLifecycle(.category(CategoryScope(projectID: projectID, categoryID: categoryID)), closesOwner: true, completion: completion) {
            try self.elementRequest(projectID, ["action": "trashCategory", "categoryId": categoryID])
        }
    }

    /// Restore requires the category page to be closed; elements stay detached.
    func restoreElementCategory(projectID: String, categoryID: String,
                                completion: @escaping (Result<WorkspaceElementReply<WorkspaceElementCategory>, Error>) -> Void) {
        changeLifecycle(.category(CategoryScope(projectID: projectID, categoryID: categoryID)), closesOwner: false, completion: completion) {
            try self.elementRequest(projectID, ["action": "restoreCategory", "categoryId": categoryID])
        }
    }

    func openCategory(projectID: String, categoryID: String, completion: @escaping (Result<LabCore, Error>) -> Void) {
        openDocument(.category(CategoryScope(projectID: projectID, categoryID: categoryID)), reopen: false, completion: completion)
    }

    func closeCategory(projectID: String, categoryID: String, completion: @escaping (Result<Bool, Error>) -> Void) {
        closeDocument(.category(CategoryScope(projectID: projectID, categoryID: categoryID)), completion: completion)
    }

    /// The body new elements of the category start from, as editable
    /// blocks; empty when unset. A read only.
    func elementTemplate(projectID: String, categoryID: String,
                         completion: @escaping (Result<[BookImportBlock], Error>) -> Void) {
        perform(completion) {
            let reply: WorkspaceElementReply<[BookImportBlock]> = try self.elementRequest(projectID,
                ["action": "elementTemplate", "categoryId": categoryID])
            return reply.result ?? []
        }
    }

    /// Replaces the category's element template; an empty list clears it and
    /// an unchanged template writes nothing. Metadata only: no owner changes.
    func setElementTemplate(projectID: String, categoryID: String, blocks: [BookImportBlock],
                            completion: @escaping (Result<WorkspaceElementReply<WorkspaceElementCategory>, Error>) -> Void) {
        perform(completion) {
            try self.elementRequest(projectID, ["action": "setElementTemplate", "categoryId": categoryID,
                                                "blocks": blocks.map(\.payload)])
        }
    }

    /// Rust saves an open body before the trash commits, then retires it.
    /// The element's relations are removed with it and do not come back on restore.
    func trashElement(projectID: String, elementID: String,
                      completion: @escaping (Result<WorkspaceElementReply<WorkspaceElement>, Error>) -> Void) {
        changeLifecycle(.element(ElementScope(projectID: projectID, elementID: elementID)), closesOwner: true, completion: completion) {
            try self.elementRequest(projectID, ["action": "trashElement", "elementId": elementID])
        }
    }

    /// Restore requires the element to be closed; its page opens normally later.
    func restoreElement(projectID: String, elementID: String,
                        completion: @escaping (Result<WorkspaceElementReply<WorkspaceElement>, Error>) -> Void) {
        changeLifecycle(.element(ElementScope(projectID: projectID, elementID: elementID)), closesOwner: false, completion: completion) {
            try self.elementRequest(projectID, ["action": "restoreElement", "elementId": elementID])
        }
    }

    func openElement(projectID: String, elementID: String, completion: @escaping (Result<LabCore, Error>) -> Void) {
        openDocument(.element(ElementScope(projectID: projectID, elementID: elementID)), reopen: false, completion: completion)
    }

    func reopenElement(projectID: String, elementID: String, completion: @escaping (Result<LabCore, Error>) -> Void) {
        reopenDocument(.element(ElementScope(projectID: projectID, elementID: elementID)), completion: completion)
    }

    func closeElement(projectID: String, elementID: String, completion: @escaping (Result<Bool, Error>) -> Void) {
        closeDocument(.element(ElementScope(projectID: projectID, elementID: elementID)), completion: completion)
    }

    /// Every live category's placement on the 设定总览 grid (`auto`, or
    /// `pinned` at a cell) with the library. A read only.
    func categoryLayouts(projectID: String,
                         completion: @escaping (Result<WorkspaceElementReply<[WorkspaceCategoryLayout]>, Error>) -> Void) {
        perform(completion) { try self.elementRequest(projectID, ["action": "categoryLayouts"]) }
    }

    /// Pins a category to a grid cell, or returns it to the solver with nil.
    /// Metadata only; an unchanged placement writes nothing.
    func setCategoryLayout(projectID: String, categoryID: String, cell: ElementOverviewCell?,
                           completion: @escaping (Result<WorkspaceElementReply<WorkspaceCategoryLayout>, Error>) -> Void) {
        var command: [String: Any] = ["action": "setCategoryLayout", "categoryId": categoryID]
        if let cell { command["gridX"] = cell.x; command["gridY"] = cell.y }
        perform(completion) { try self.elementRequest(projectID, command) }
    }

    /// Chapters whose prose links the element, read from live owners or cold
    /// durable state. A read only: no owner, history or journal changes.
    func elementBacklinks(projectID: String, elementID: String,
                          completion: @escaping (Result<WorkspaceElementBacklinks, Error>) -> Void) {
        perform(completion) { try self.elementRequest(projectID, ["action": "backlinks", "elementId": elementID]) }
    }

    private func elementRequest<Payload: Decodable>(_ projectID: String, _ command: [String: Any]) throws -> Payload {
        try request("workspaceElements", fields: ["projectId": projectID, "command": command])
    }

    // MARK: Storylines

    /// Live and trashed storylines and every live chapter's memberships.
    func storylineLibrary(projectID: String, completion: @escaping (Result<WorkspaceStorylineLibrary, Error>) -> Void) {
        perform(completion) {
            let reply: WorkspaceStorylineReply<WorkspaceStoryline> = try self.storylineRequest(projectID, ["action": "library"])
            return reply.library
        }
    }

    /// An empty name becomes “New Storyline”; Rust picks the colour. The
    /// first live storyline becomes every live chapter's primary.
    func createStoryline(projectID: String, name: String,
                         completion: @escaping (Result<WorkspaceStorylineReply<WorkspaceStoryline>, Error>) -> Void) {
        perform(completion) { try self.storylineRequest(projectID, ["action": "createStoryline", "name": name]) }
    }

    /// Metadata only: an open body owner, its input and history are untouched.
    func updateStoryline(projectID: String, storylineID: String, changes: WorkspaceStorylineChanges,
                         completion: @escaping (Result<WorkspaceStorylineReply<WorkspaceStoryline>, Error>) -> Void) {
        var command = changes.fields
        command["action"] = "updateStoryline"; command["storylineId"] = storylineID
        perform(completion) { try self.storylineRequest(projectID, command) }
    }

    /// Places the storyline before another one, or last with nil.
    func moveStoryline(projectID: String, storylineID: String, beforeStorylineID: String?,
                       completion: @escaping (Result<WorkspaceStorylineReply<[WorkspaceStoryline]>, Error>) -> Void) {
        perform(completion) {
            try self.storylineRequest(projectID, ["action": "moveStoryline", "storylineId": storylineID,
                "beforeStorylineId": beforeStorylineID.map { $0 as Any } ?? NSNull()])
        }
    }

    func setStorylineFacts(projectID: String, storylineID: String, facts: [WorkspaceFact],
                           completion: @escaping (Result<WorkspaceStorylineReply<WorkspaceStoryline>, Error>) -> Void) {
        perform(completion) {
            try self.storylineRequest(projectID, ["action": "setStorylineFacts", "storylineId": storylineID, "facts": facts.map(\.payload)])
        }
    }

    /// Replaces the chapter's storylines. Without a primary Rust chooses the
    /// lowest-ordered one; an empty list leaves the chapter 未归属.
    func setChapterStorylines(projectID: String, chapterID: String, storylineIDs: [String], primary: String?,
                              completion: @escaping (Result<WorkspaceStorylineReply<WorkspaceChapterStorylines>, Error>) -> Void) {
        var command: [String: Any] = ["action": "setChapterStorylines", "chapterId": chapterID, "storylineIds": storylineIDs]
        // Always explicit: an absent primary would keep the chapter's current one.
        command["primary"] = primary ?? NSNull()
        perform(completion) { try self.storylineRequest(projectID, command) }
    }

    /// Rust saves an open body before the trash commits, then retires it.
    /// Chapters whose primary it was lose all their storylines, and its
    /// relations are removed.
    func trashStoryline(projectID: String, storylineID: String,
                        completion: @escaping (Result<WorkspaceStorylineReply<WorkspaceStoryline>, Error>) -> Void) {
        changeLifecycle(.storyline(StorylineScope(projectID: projectID, storylineID: storylineID)), closesOwner: true, completion: completion) {
            try self.storylineRequest(projectID, ["action": "trashStoryline", "storylineId": storylineID])
        }
    }

    /// Restore requires the page to be closed; chapters are not linked again.
    func restoreStoryline(projectID: String, storylineID: String,
                          completion: @escaping (Result<WorkspaceStorylineReply<WorkspaceStoryline>, Error>) -> Void) {
        changeLifecycle(.storyline(StorylineScope(projectID: projectID, storylineID: storylineID)), closesOwner: false, completion: completion) {
            try self.storylineRequest(projectID, ["action": "restoreStoryline", "storylineId": storylineID])
        }
    }

    func openStoryline(projectID: String, storylineID: String, completion: @escaping (Result<LabCore, Error>) -> Void) {
        openDocument(.storyline(StorylineScope(projectID: projectID, storylineID: storylineID)), reopen: false, completion: completion)
    }

    func closeStoryline(projectID: String, storylineID: String, completion: @escaping (Result<Bool, Error>) -> Void) {
        closeDocument(.storyline(StorylineScope(projectID: projectID, storylineID: storylineID)), completion: completion)
    }

    private func storylineRequest<Payload: Decodable>(_ projectID: String, _ command: [String: Any]) throws -> Payload {
        try request("workspaceStorylines", fields: ["projectId": projectID, "command": command])
    }

    // MARK: Drifts

    /// Live and trashed drifts and every drift group of one project.
    func driftLibrary(projectID: String, completion: @escaping (Result<WorkspaceDriftLibrary, Error>) -> Void) {
        perform(completion) {
            let reply: WorkspaceDriftReply<WorkspaceDrift> = try self.driftRequest(projectID, ["action": "library"])
            return reply.library
        }
    }

    /// Without a title Rust chooses the next free “New Drift” name.
    func createDrift(projectID: String, title: String?, groupID: String?,
                     completion: @escaping (Result<WorkspaceDriftReply<WorkspaceDrift>, Error>) -> Void) {
        var command: [String: Any] = ["action": "createDrift"]
        if let title { command["title"] = title }
        if let groupID { command["groupId"] = groupID }
        perform(completion) { try self.driftRequest(projectID, command) }
    }

    /// Title and group are metadata: an open body owner, its input and
    /// history are untouched.
    func updateDrift(projectID: String, driftID: String, changes: WorkspaceDriftChanges,
                     completion: @escaping (Result<WorkspaceDriftReply<WorkspaceDrift>, Error>) -> Void) {
        var command = changes.fields
        command["action"] = "updateDrift"; command["driftId"] = driftID
        perform(completion) { try self.driftRequest(projectID, command) }
    }

    /// Rust unbinds the drift's act, removes its relations and saves an open
    /// body before the trash commits, then retires it.
    func trashDrift(projectID: String, driftID: String,
                    completion: @escaping (Result<WorkspaceDriftReply<WorkspaceDrift>, Error>) -> Void) {
        changeLifecycle(.drift(DriftScope(projectID: projectID, driftID: driftID)), closesOwner: true, completion: completion) {
            try self.driftRequest(projectID, ["action": "trashDrift", "driftId": driftID])
        }
    }

    /// Restore requires the page to be closed; the act binding is not restored.
    func restoreDrift(projectID: String, driftID: String,
                      completion: @escaping (Result<WorkspaceDriftReply<WorkspaceDrift>, Error>) -> Void) {
        changeLifecycle(.drift(DriftScope(projectID: projectID, driftID: driftID)), closesOwner: false, completion: completion) {
            try self.driftRequest(projectID, ["action": "restoreDrift", "driftId": driftID])
        }
    }

    /// An empty name becomes “新分组”. Groups nest one level only.
    func createDriftGroup(projectID: String, name: String, parentGroupID: String?,
                          completion: @escaping (Result<WorkspaceDriftReply<WorkspaceDriftGroup>, Error>) -> Void) {
        var command: [String: Any] = ["action": "createGroup", "name": name]
        if let parentGroupID { command["parentGroupId"] = parentGroupID }
        perform(completion) { try self.driftRequest(projectID, command) }
    }

    func renameDriftGroup(projectID: String, groupID: String, name: String,
                          completion: @escaping (Result<WorkspaceDriftReply<WorkspaceDriftGroup>, Error>) -> Void) {
        perform(completion) { try self.driftRequest(projectID, ["action": "renameGroup", "groupId": groupID, "name": name]) }
    }

    /// Its subgroups and drifts move to its parent; the reply has no result.
    func deleteDriftGroup(projectID: String, groupID: String,
                          completion: @escaping (Result<WorkspaceDriftReply<WorkspaceDriftGroup>, Error>) -> Void) {
        perform(completion) { try self.driftRequest(projectID, ["action": "deleteGroup", "groupId": groupID]) }
    }

    /// Binds a drift as the act's notes, or unbinds the act with nil.
    func bindActDrift(projectID: String, actID: String, driftID: String?,
                      completion: @escaping (Result<WorkspaceDriftReply<WorkspaceAct>, Error>) -> Void) {
        perform(completion) {
            try self.driftRequest(projectID, ["action": "bindAct", "actId": actID, "driftId": driftID.map { $0 as Any } ?? NSNull()])
        }
    }

    func openDrift(projectID: String, driftID: String, completion: @escaping (Result<LabCore, Error>) -> Void) {
        openDocument(.drift(DriftScope(projectID: projectID, driftID: driftID)), reopen: false, completion: completion)
    }

    func closeDrift(projectID: String, driftID: String, completion: @escaping (Result<Bool, Error>) -> Void) {
        closeDocument(.drift(DriftScope(projectID: projectID, driftID: driftID)), completion: completion)
    }

    private func driftRequest<Payload: Decodable>(_ projectID: String, _ command: [String: Any]) throws -> Payload {
        try request("workspaceDrifts", fields: ["projectId": projectID, "command": command])
    }

    /// 转为章节: the same node joins the end of the book as a 草稿, primary in
    /// `storylineID` when given, out of its group, with its markers and act
    /// released, in one original. Rust saves and releases an open body; the
    /// chapter opens its own owner. Like chapter trash, it is not the
    /// author's writing for 今日字数, so word-count reads bracket it.
    func convertDriftToChapter(projectID: String, driftID: String, storylineID: String?,
                               completion: @escaping (Result<WorkspaceDriftReply<WorkspaceChapter>, Error>) -> Void) {
        var command: [String: Any] = ["action": "convertToChapter", "driftId": driftID]
        if let storylineID { command["storylineId"] = storylineID }
        notAuthored(projectID) {
            changeLifecycle(.drift(DriftScope(projectID: projectID, driftID: driftID)), closesOwner: true, completion: completion) {
                try self.driftRequest(projectID, command)
            }
        }
    }

    /// 转为设定: a new element in the category with the drift's title,
    /// summary and body, then the drift goes to the trash. A name conflict
    /// is refused before anything is written. The drift's open body is
    /// released on success, and when Rust reports that the element and its
    /// body were made but the trash failed; the library reply is the drifts'.
    func convertDriftToElement(projectID: String, driftID: String, categoryID: String,
                               completion: @escaping (Result<WorkspaceDriftReply<WorkspaceDriftElementConversion>, Error>) -> Void) {
        precondition(Thread.isMainThread)
        let scope = DocumentScope.drift(DriftScope(projectID: projectID, driftID: driftID))
        guard beginOwnerChange() else {
            completion(.failure(LabError.message("请先完成输入，并保存或处理所有待恢复草稿"))); return
        }
        perform({ (result: Result<WorkspaceDriftReply<WorkspaceDriftElementConversion>, Error>) in
            let released: Bool
            switch result {
            case .success: released = true
            case .failure(let error):
                released = ((error as? LabError)?.diagnosticDescription ?? "").contains("已创建并复制了正文")
            }
            if released { self.owners.removeValue(forKey: scope)?.core.invalidate() }
            self.endOwnerChange()
            completion(result)
        }) {
            try self.driftRequest(projectID, ["action": "convertToElement", "driftId": driftID, "categoryId": categoryID])
        }
    }

    // MARK: 情节规划格

    /// Without operations, reads the node's grid (nil before its first
    /// edit). With operations, applies them in order in one original and
    /// returns the grid; any refusal rolls the whole batch back. Chapters
    /// and drifts only; the body, its history and word counts are untouched.
    func plotGrid(projectID: String, nodeID: String, ops: [PlotGridOp],
                  completion: @escaping (Result<WorkspacePlotGridReply, Error>) -> Void) {
        var fields: [String: Any] = ["projectId": projectID, "nodeId": nodeID]
        if !ops.isEmpty { fields["ops"] = ops.map(\.payload) }
        perform(completion) { try self.request("workspacePlotGrid", fields: fields) }
    }

    // MARK: Relations

    /// Every relation type and relation of one project.
    func relationLibrary(projectID: String, completion: @escaping (Result<WorkspaceRelationLibrary, Error>) -> Void) {
        perform(completion) {
            let reply: WorkspaceRelationReply<WorkspaceRelationType> = try self.relationRequest(projectID, ["action": "library"])
            return reply.library
        }
    }

    /// Relation writes change no document: no owner guard applies.
    func createRelationType(projectID: String, definition: RelationTypeDefinition,
                            completion: @escaping (Result<WorkspaceRelationReply<WorkspaceRelationType>, Error>) -> Void) {
        perform(completion) { try self.relationRequest(projectID, ["action": "createType", "definition": definition.payload]) }
    }

    /// Refused for the built-in type and when a relation of the type would
    /// no longer fit; an unchanged definition writes nothing.
    func updateRelationType(projectID: String, relationTypeID: String, definition: RelationTypeDefinition,
                            completion: @escaping (Result<WorkspaceRelationReply<WorkspaceRelationType>, Error>) -> Void) {
        perform(completion) {
            try self.relationRequest(projectID, ["action": "updateType", "relationTypeId": relationTypeID, "definition": definition.payload])
        }
    }

    /// Refused for the built-in type and a type still in use; the reply has no result.
    func deleteRelationType(projectID: String, relationTypeID: String,
                            completion: @escaping (Result<WorkspaceRelationReply<WorkspaceRelationType>, Error>) -> Void) {
        perform(completion) { try self.relationRequest(projectID, ["action": "deleteType", "relationTypeId": relationTypeID]) }
    }

    /// Rust validates the ends against the type and stores symmetric ends in
    /// canonical order; an identical edge is returned without writing.
    func addRelation(projectID: String, from: RelationEndpoint, to: RelationEndpoint, relationTypeID: String,
                     completion: @escaping (Result<WorkspaceRelationReply<WorkspaceRelation>, Error>) -> Void) {
        perform(completion) {
            try self.relationRequest(projectID, ["action": "addRelation", "fromKind": from.kind, "fromId": from.id,
                "toKind": to.kind, "toId": to.id, "relationTypeId": relationTypeID])
        }
    }

    /// An unknown relation is a no-op; the reply has no result.
    func removeRelation(projectID: String, relationID: String,
                        completion: @escaping (Result<WorkspaceRelationReply<WorkspaceRelation>, Error>) -> Void) {
        perform(completion) { try self.relationRequest(projectID, ["action": "removeRelation", "relationId": relationID]) }
    }

    func retypeRelation(projectID: String, relationID: String, relationTypeID: String, swap: Bool,
                        completion: @escaping (Result<WorkspaceRelationReply<WorkspaceRelation>, Error>) -> Void) {
        perform(completion) {
            try self.relationRequest(projectID, ["action": "retypeRelation", "relationId": relationID,
                "relationTypeId": relationTypeID, "swap": swap])
        }
    }

    private func relationRequest<Payload: Decodable>(_ projectID: String, _ command: [String: Any]) throws -> Payload {
        try request("workspaceRelations", fields: ["projectId": projectID, "command": command])
    }

    // MARK: Materials library

    /// Library items and element portraits of one project. A read only.
    func materialLibrary(projectID: String, completion: @escaping (Result<WorkspaceMaterialLibrary, Error>) -> Void) {
        perform(completion) {
            let reply: WorkspaceMaterialReply<WorkspaceMaterialItem> = try self.libraryRequest(projectID, ["action": "library"])
            return reply.library
        }
    }

    /// Rust copies the file into the asset store under its 200 MB cap, then
    /// commits the asset and item rows; the source is never modified.
    func importMaterial(projectID: String, title: String, file: MaterialSourceFile,
                        completion: @escaping (Result<WorkspaceMaterialReply<WorkspaceMaterialItem>, Error>) -> Void) {
        perform(completion) {
            try self.libraryRequest(projectID, ["action": "importFile", "title": title, "file": file.payload])
        }
    }

    /// Rust accepts http and https only.
    func createMaterialLink(projectID: String, title: String, url: String,
                            completion: @escaping (Result<WorkspaceMaterialReply<WorkspaceMaterialItem>, Error>) -> Void) {
        perform(completion) { try self.libraryRequest(projectID, ["action": "createLink", "title": title, "url": url]) }
    }

    func createMaterialText(projectID: String, title: String, body: String,
                            completion: @escaping (Result<WorkspaceMaterialReply<WorkspaceMaterialItem>, Error>) -> Void) {
        perform(completion) { try self.libraryRequest(projectID, ["action": "createText", "title": title, "body": body]) }
    }

    /// One `field.set` per changed field in one original; unchanged fields
    /// write nothing.
    func updateMaterial(projectID: String, itemID: String, changes: WorkspaceMaterialChanges,
                        completion: @escaping (Result<WorkspaceMaterialReply<WorkspaceMaterialItem>, Error>) -> Void) {
        var command = changes.fields
        command["action"] = "updateItem"; command["itemId"] = itemID
        perform(completion) { try self.libraryRequest(projectID, command) }
    }

    /// Rows first, then the stored bytes; the reply has no result.
    func deleteMaterial(projectID: String, itemID: String,
                        completion: @escaping (Result<WorkspaceMaterialReply<WorkspaceMaterialItem>, Error>) -> Void) {
        perform(completion) { try self.libraryRequest(projectID, ["action": "deleteItem", "itemId": itemID]) }
    }

    /// Imports an image as the element's portrait, or clears it with nil;
    /// the previous portrait's row and bytes are released. Metadata only:
    /// the element's body owner is untouched.
    func setElementPortrait(projectID: String, elementID: String, file: MaterialSourceFile?,
                            completion: @escaping (Result<WorkspaceMaterialReply<WorkspaceElementPortrait>, Error>) -> Void) {
        var command: [String: Any] = ["action": "setPortrait", "elementId": elementID]
        if let file { command["file"] = file.payload }
        perform(completion) { try self.libraryRequest(projectID, command) }
    }

    /// Moves an item before another one, or last with nil; an unchanged
    /// order writes nothing. The reply's library lists the new order.
    func moveMaterial(projectID: String, itemID: String, beforeItemID: String?,
                      completion: @escaping (Result<WorkspaceMaterialReply<WorkspaceMaterialItem>, Error>) -> Void) {
        var command: [String: Any] = ["action": "moveItem", "itemId": itemID]
        if let beforeItemID { command["before"] = beforeItemID }
        perform(completion) { try self.libraryRequest(projectID, command) }
    }

    private func libraryRequest<Payload: Decodable>(_ projectID: String, _ command: [String: Any]) throws -> Payload {
        try request("workspaceLibrary", fields: ["projectId": projectID, "command": command])
    }

    // MARK: Import and export

    /// Creates the chapter, drift or element and fills its empty body with
    /// one paragraph per block through a temporary owner, saved as the
    /// author's input. No open owner changes.
    func importBlocks(projectID: String, title: String, target: BookImportTarget, blocks: [BookImportBlock],
                      completion: @escaping (Result<WorkspaceImportedEntity, Error>) -> Void) {
        let command: [String: Any] = ["action": "importBlocks", "target": target.payload(title: title),
                                      "blocks": blocks.map(\.payload)]
        perform(completion) { try self.request("workspaceTransfer", fields: ["projectId": projectID, "command": command]) }
    }

    /// The whole book, reading open chapters from their live owners. Queued
    /// input would be missing, so it is refused until every body is saved.
    func exportBook(projectID: String, format: BookExportFormat, completion: @escaping (Result<String, Error>) -> Void) {
        precondition(Thread.isMainThread)
        guard !isChangingOwners, !hasPendingDocuments else {
            completion(.failure(LabError.message("请先完成输入，并等待正文保存后再导出。"))); return
        }
        struct Exported: Decodable { let text: String }
        perform({ (result: Result<Exported, Error>) in completion(result.map(\.text)) }) {
            try self.request("workspaceTransfer", fields: ["projectId": projectID,
                "command": ["action": "exportBook", "format": format.rawValue]])
        }
    }

    // MARK: Metadata

    /// The project's summary, facts and storyline template.
    func projectDetails(projectID: String, completion: @escaping (Result<WorkspaceProjectDetails, Error>) -> Void) {
        perform(completion) { try self.metadataRequest(projectID, ["action": "project"]) }
    }

    /// One original with the present fields; an unchanged field writes nothing.
    func updateProject(projectID: String, changes: WorkspaceProjectChanges,
                       completion: @escaping (Result<WorkspaceProjectDetails, Error>) -> Void) {
        var command = changes.fields
        command["action"] = "updateProject"
        perform(completion) { try self.metadataRequest(projectID, command) }
    }

    /// A live chapter's or drift's summary and writing status.
    func nodeMetadata(projectID: String, nodeID: String, completion: @escaping (Result<WorkspaceNodeMetadata, Error>) -> Void) {
        perform(completion) { try self.metadataRequest(projectID, ["action": "node", "nodeId": nodeID]) }
    }

    /// Every live chapter's and drift's title, summary and status in one read.
    func nodesMetadata(projectID: String, completion: @escaping (Result<[WorkspaceNodeMetadata], Error>) -> Void) {
        perform(completion) { try self.metadataRequest(projectID, ["action": "nodes"]) }
    }

    /// Metadata only: the node's body owner, its input and history are untouched.
    func setNodeSummary(projectID: String, nodeID: String, summary: String,
                        completion: @escaping (Result<WorkspaceNodeMetadata, Error>) -> Void) {
        perform(completion) {
            try self.metadataRequest(projectID, ["action": "setNodeSummary", "nodeId": nodeID, "summary": summary])
        }
    }

    /// Chapters take draft/finished/discarded and drifts drifting/resting;
    /// Rust refuses any other status before writing.
    func setNodeStatus(projectID: String, nodeID: String, status: String,
                       completion: @escaping (Result<WorkspaceNodeMetadata, Error>) -> Void) {
        perform(completion) {
            try self.metadataRequest(projectID, ["action": "setNodeStatus", "nodeId": nodeID, "status": status])
        }
    }

    private func metadataRequest<Payload: Decodable>(_ projectID: String, _ command: [String: Any]) throws -> Payload {
        let reply: WorkspaceMetadataReply<Payload> = try request("workspaceMetadata", fields: ["projectId": projectID, "command": command])
        return reply.result
    }

    // MARK: Word counts

    /// Every live chapter's and drift's canonical word count. A read only.
    /// Each body save already stored its own count in Rust.
    func wordCounts(projectID: String, completion: @escaping (Result<WorkspaceWordCounts, Error>) -> Void) {
        readWordCounts(projectID, "counts", authored: true, completion: completion)
    }

    /// Projects every live chapter and drift body with durable prose, then
    /// reads the counts. Derived rows only: no original, no `updated_at`.
    /// A reconcile only corrects projections no save wrote, so for 今日字数
    /// it is never the author's: it is bracketed like a receipt.
    func reconcileWordCounts(projectID: String, completion: @escaping (Result<WorkspaceWordCounts, Error>) -> Void) {
        if onWordCountRead != nil { readWordCounts(projectID, "counts", authored: true) }
        readWordCounts(projectID, "reconcile", authored: false, completion: completion)
    }

    /// Every word-count read of a project, reported in the order Rust ran it
    /// on the workspace queue (the order of every body save). `authored` is
    /// false for the read that closes a change this device did not write: a
    /// received original, a version restore, chapter trash and restore, or a
    /// reconcile. Set by the Mac's 今日字数 ledger; nil sends no extra reads.
    var onWordCountRead: ((_ projectID: String, _ counts: WorkspaceWordCounts, _ authored: Bool) -> Void)?

    private func readWordCounts(_ projectID: String, _ action: String, authored: Bool,
                                completion: ((Result<WorkspaceWordCounts, Error>) -> Void)? = nil) {
        perform({ (result: Result<WorkspaceWordCounts, Error>) in
            if case .success(let counts) = result { self.onWordCountRead?(projectID, counts, authored) }
            completion?(result)
        }) { try self.metricsRequest(projectID, action) }
    }

    /// Brackets a change this device did not write with word-count reads,
    /// enqueued directly before and after it on the serial workspace queue:
    /// what changed before it is the author's, what it changed is not. A
    /// receipt may change bodies without an owner, so its closing read reconciles.
    private func notAuthored(_ projectID: String, reconcile: Bool = false, _ enqueue: () -> Void) {
        precondition(Thread.isMainThread)
        guard onWordCountRead != nil else { enqueue(); return }
        readWordCounts(projectID, "counts", authored: true)
        enqueue()
        readWordCounts(projectID, reconcile ? "reconcile" : "counts", authored: false)
    }

    private func metricsRequest(_ projectID: String, _ action: String) throws -> WorkspaceWordCounts {
        try request("workspaceMetrics", fields: ["projectId": projectID, "command": ["action": action]])
    }

    func outline(projectID: String, completion: @escaping (Result<[WorkspaceOutlineEntry], Error>) -> Void) {
        perform(completion) { try self.request("workspaceOutline", fields: ["projectId": projectID]) }
    }

    func createAct(projectID: String, chapterID: String,
                   completion: @escaping (Result<WorkspaceAct, Error>) -> Void) {
        updateMetadata("workspaceCreateAct", fields: ["projectId": projectID, "chapterId": chapterID], completion: completion)
    }

    func renameAct(projectID: String, actID: String, name: String,
                   completion: @escaping (Result<WorkspaceAct, Error>) -> Void) {
        updateMetadata("workspaceRenameAct", fields: ["projectId": projectID, "actId": actID, "name": name], completion: completion)
    }

    func removeAct(projectID: String, actID: String,
                   completion: @escaping (Result<WorkspaceAct, Error>) -> Void) {
        updateMetadata("workspaceRemoveAct", fields: ["projectId": projectID, "actId": actID], completion: completion)
    }

    /// Sets an act's colour (`#rrggbb`) or clears it with nil; an unchanged
    /// colour writes nothing. Metadata only: no owner, input or history changes.
    func setActColor(projectID: String, actID: String, color: String?,
                     completion: @escaping (Result<WorkspaceAct, Error>) -> Void) {
        perform(completion) {
            try self.request("workspaceSetActColor", fields: ["projectId": projectID, "actId": actID,
                                                              "color": color.map { $0 as Any } ?? NSNull()])
        }
    }

    /// Moves an act's boundary to a book-axis coordinate strictly between its
    /// neighbouring boundaries; Rust refuses one at or beyond a neighbour and
    /// writes nothing for an unchanged start. Metadata only.
    func moveAct(projectID: String, actID: String, startOrder: Double,
                 completion: @escaping (Result<WorkspaceAct, Error>) -> Void) {
        updateMetadata("workspaceMoveAct", fields: ["projectId": projectID, "actId": actID, "startOrder": startOrder],
                       completion: completion)
    }

    // MARK: Element patches

    /// An element's 设定补丁 in their authored order. A read only.
    func elementPatches(projectID: String, elementID: String, completion: @escaping (Result<[WorkspacePatch], Error>) -> Void) {
        perform(completion) {
            let reply: WorkspacePatchReply<WorkspacePatch> = try self.patchRequest(projectID, ["action": "patches", "elementId": elementID])
            return reply.patches
        }
    }

    /// Patches made from a chapter's or drift's text. A read only.
    func nodePatches(projectID: String, nodeID: String, completion: @escaping (Result<[WorkspacePatch], Error>) -> Void) {
        perform(completion) {
            let reply: WorkspacePatchReply<WorkspacePatch> = try self.patchRequest(projectID, ["action": "nodePatches", "nodeId": nodeID])
            return reply.patches
        }
    }

    /// A floating patch (no source), or one anchored to a chapter selection.
    /// Title and body cannot both be empty. The reply lists the element's
    /// patches with the new one last.
    func createPatch(projectID: String, elementID: String, title: String?, body: String, source: WorkspacePatchSource?,
                     completion: @escaping (Result<WorkspacePatchReply<WorkspacePatch>, Error>) -> Void) {
        var command: [String: Any] = ["action": "createPatch", "elementId": elementID, "body": body]
        if let title { command["title"] = title }
        if let source { command["source"] = source.payload }
        perform(completion) { try self.patchRequest(projectID, command) }
    }

    /// Present fields change (`title: .some(nil)` clears the title);
    /// unchanged values write nothing.
    func updatePatch(projectID: String, patchID: String, changes: WorkspacePatchChanges,
                     completion: @escaping (Result<WorkspacePatchReply<WorkspacePatch>, Error>) -> Void) {
        var command = changes.fields
        command["action"] = "updatePatch"; command["patchId"] = patchID
        perform(completion) { try self.patchRequest(projectID, command) }
    }

    /// Moves a patch before another of the same element, or last with nil.
    func movePatch(projectID: String, patchID: String, before: String?,
                   completion: @escaping (Result<WorkspacePatchReply<WorkspacePatch>, Error>) -> Void) {
        var command: [String: Any] = ["action": "movePatch", "patchId": patchID]
        if let before { command["before"] = before }
        perform(completion) { try self.patchRequest(projectID, command) }
    }

    /// The reply has no result; it lists the element's remaining patches.
    func deletePatch(projectID: String, patchID: String,
                     completion: @escaping (Result<WorkspacePatchReply<WorkspacePatch>, Error>) -> Void) {
        perform(completion) { try self.patchRequest(projectID, ["action": "deletePatch", "patchId": patchID]) }
    }

    private func patchRequest<Payload: Decodable>(_ projectID: String, _ command: [String: Any]) throws -> Payload {
        try request("workspacePatches", fields: ["projectId": projectID, "command": command])
    }

    // MARK: Notes and TODOs

    /// Every note and TODO of the project, oldest first. A read only.
    func projectComments(projectID: String, completion: @escaping (Result<[WorkspaceComment], Error>) -> Void) {
        perform(completion) {
            let reply: WorkspaceCommentsReply = try self.commentsRequest(projectID, ["action": "list"])
            return reply.comments
        }
    }

    /// A floating TODO (no target), or a note or TODO on a whole chapter,
    /// drift, element, category or storyline. Selection notes are created
    /// through the chapter's owner instead.
    /// `byAssistant` records the writing assistant as the author (写作助手).
    func createComment(projectID: String, kind: String, target: RelationEndpoint?, body: String, priority: String?,
                       byAssistant: Bool = false, completion: @escaping (Result<WorkspaceCommentsReply, Error>) -> Void) {
        var command: [String: Any] = ["action": "create", "kind": kind, "body": body]
        if let target { command["targetKind"] = target.kind; command["targetId"] = target.id }
        if let priority { command["priority"] = priority }
        if byAssistant { command["byAssistant"] = true }
        perform(completion) { try self.commentsRequest(projectID, command) }
    }

    /// Present fields change; `priority: .some(nil)` clears it. Unchanged
    /// values write nothing, and a floating TODO cannot become a note.
    func updateComment(projectID: String, commentID: String, changes: WorkspaceCommentChanges,
                       completion: @escaping (Result<WorkspaceCommentsReply, Error>) -> Void) {
        var command = changes.fields
        command["action"] = "update"; command["commentId"] = commentID
        perform(completion) { try self.commentsRequest(projectID, command) }
    }

    func setCommentResolved(projectID: String, commentID: String, resolved: Bool,
                            completion: @escaping (Result<WorkspaceCommentsReply, Error>) -> Void) {
        perform(completion) {
            try self.commentsRequest(projectID, ["action": "setResolved", "commentId": commentID, "resolved": resolved])
        }
    }

    /// Removes the comment and every relation touching it. An open chapter
    /// owner stops tracking its anchor; the caller refreshes the views.
    func deleteComment(projectID: String, commentID: String,
                       completion: @escaping (Result<WorkspaceCommentsReply, Error>) -> Void) {
        perform(completion) { try self.commentsRequest(projectID, ["action": "delete", "commentId": commentID]) }
    }

    private func commentsRequest(_ projectID: String, _ command: [String: Any]) throws -> WorkspaceCommentsReply {
        try request("workspaceComments", fields: ["projectId": projectID, "command": command])
    }

    /// Records the author's decision on an open Copilot suggestion (after an
    /// accepted proposal was applied, with what it created as `result`); the
    /// suggestion becomes `converted`. Other comments are refused.
    func resolveSuggestion(projectID: String, commentID: String, accepted: Bool, result: [String: Any]?,
                           completion: @escaping (Result<WorkspaceSuggestionReply, Error>) -> Void) {
        var command: [String: Any] = ["action": "resolveSuggestion", "commentId": commentID, "accepted": accepted]
        if let result { command["result"] = result }
        perform(completion) { try self.request("workspaceComments", fields: ["projectId": projectID, "command": command]) }
    }

    /// Every accept and reject decision on suggestions, oldest first. A read only.
    func suggestionActions(projectID: String, completion: @escaping (Result<[WorkspaceCommentAction], Error>) -> Void) {
        perform(completion) {
            let reply: WorkspaceSuggestionActionsReply = try self.request("workspaceComments",
                fields: ["projectId": projectID, "command": ["action": "suggestionActions"]])
            return reply.result
        }
    }

    func chapterOutline(projectID: String, chapterID: String,
                        completion: @escaping (Result<[NativeOutlineItem], Error>) -> Void) {
        perform(completion) {
            try self.request("workspaceChapterOutline", fields: ["projectId": projectID, "chapterId": chapterID])
        }
    }

    func search(projectID: String, query: String, completion: @escaping (Result<WorkspaceSearchResult, Error>) -> Void) {
        perform(completion) { try self.request("workspaceSearch", fields: ["projectId": projectID, "query": query]) }
    }

    func resolveSearchHit(_ hit: WorkspaceSearchHit, completion: @escaping (Result<WorkspaceSearchLocation, Error>) -> Void) {
        perform(completion) {
            let payload = try JSONSerialization.jsonObject(with: JSONEncoder().encode(hit))
            return try self.request("workspaceResolveSearchHit", fields: ["hit": payload])
        }
    }

    /// Summaries, drifts, elements (name, aliases, summary, facts, body),
    /// categories, storylines and materials. Bodies are read from their live
    /// owner (unsaved text included) or a cold reader. A read only.
    func searchEntities(projectID: String, query: String,
                        completion: @escaping (Result<WorkspaceEntitySearchResult, Error>) -> Void) {
        perform(completion) { try self.request("workspaceSearchEntities", fields: ["projectId": projectID, "query": query]) }
    }

    /// The current range of a body hit in its open owner. Rust refuses when
    /// the page is not open, the body's scope changed, input is pending or
    /// the matched text changed.
    func resolveEntityHit(projectID: String, hit: WorkspaceEntitySearchHit,
                          completion: @escaping (Result<WorkspaceSearchLocation, Error>) -> Void) {
        perform(completion) {
            let payload = try JSONSerialization.jsonObject(with: JSONEncoder().encode(hit))
            do {
                return try self.request("workspaceResolveEntityHit", fields: ["projectId": projectID, "hit": payload])
            } catch LabError.message(let reason) {
                // Rust's refusals are Chinese; anything else is not shown raw.
                guard reason.unicodeScalars.contains(where: { (0x4E00...0x9FFF).contains($0.value) }) else {
                    throw LabError.message("这条结果已无法定位，请重新搜索。")
                }
                throw LabError.message(reason)
            }
        }
    }

    /// Completion reports durable acceptance and dispatch to existing stores.
    /// Queued input and marked drafts can keep individual views on their old
    /// input basis until DocumentStore's normal refresh can safely adopt it.
    func receiveProse(original: RemoteChangeOriginal, envelope: Data,
                      completion: @escaping (Result<WorkspaceRemoteProseReply, Error>) -> Void) {
        receiveOriginal("workspaceReceiveProse", original: original, envelope: envelope, completion: completion)
    }

    /// The caller receives fresh project and chapter lists only after the
    /// complete original succeeds. Existing editor owners stay in place.
    func receiveChanges(original: RemoteChangeOriginal, envelope: Data,
                        completion: @escaping (Result<WorkspaceRemoteChangesReply, Error>) -> Void) {
        receiveOriginal("workspaceReceiveChanges", original: original, envelope: envelope, completion: completion)
    }

    private func receiveOriginal<Reply: WorkspaceRemoteDeliveryReply>(_ operation: String,
            original: RemoteChangeOriginal, envelope: Data,
            completion: @escaping (Result<Reply, Error>) -> Void) {
        precondition(Thread.isMainThread)
        guard !isChangingOwners else {
            completion(.failure(LabError.message("正在切换章节，请稍后重试接收更改"))); return
        }
        let fields: [String: Any]
        do {
            // Own immutable request values before entering the asynchronous
            // queue; callers may reuse the original Data after this returns.
            fields = ["original": try JSONSerialization.jsonObject(with: JSONEncoder().encode(original)),
                      "envelope": envelope.base64EncodedString()]
        } catch { completion(.failure(error)); return }
        remoteDeliveryInFlight += 1
        notAuthored(original.projectId, reconcile: true) {
            perform({ (result: Result<Reply, Error>) in
                if case .success(let reply) = result { self.routeReconciledDocuments(reply.documents) }
                self.remoteDeliveryInFlight -= 1
                if case .success = result { self.onRemoteOriginal?(original.projectId) }
                completion(result)
            }) {
                try self.request(operation, fields: fields)
            }
        }
    }

    func reconcileProse(projectID: String, completion: @escaping (Result<Bool, Error>) -> Void) {
        precondition(Thread.isMainThread)
        guard !isChangingOwners else {
            completion(.failure(LabError.message("正在切换章节，请稍后重试恢复正文"))); return
        }
        remoteDeliveryInFlight += 1
        notAuthored(projectID, reconcile: true) {
            perform({ (result: Result<[WorkspaceDocumentReply], Error>) in
                if case .success(let documents) = result { self.routeReconciledDocuments(documents) }
                self.remoteDeliveryInFlight -= 1
                completion(result.map { _ in true })
            }) {
                try self.request("workspaceReconcileProse", fields: ["projectId": projectID])
            }
        }
    }

    private func routeReconciledDocuments(_ documents: [WorkspaceDocumentReply]) {
        precondition(Thread.isMainThread)
        for document in documents {
            let scope = DocumentScope.chapter(ChapterScope(projectID: document.projectId, chapterID: document.chapterId))
            guard let owner = owners[scope], owner.handle == document.handle, !owner.core.isClosed else { continue }
            owner.core.receiveReconciledState(document.document)
        }
    }

    // MARK: Writing Agent

    /// The lab's own data directory (keyed by its bundle identifier): the
    /// workspace directory, `agent/` and 设置 (`settings.json`, `fonts/`).
    var dataDirectory: URL { directory.deletingLastPathComponent() }

    /// The native Agent's conversations live beside the lab workspace
    /// directory, in `agent/<projectId>/`.
    var agentDirectory: URL { dataDirectory.appendingPathComponent("agent", isDirectory: true) }

    /// A body's live text when its owner is open, otherwise its stored text.
    /// A read only: no owner, history or journal changes.
    func agentReadProse(projectID: String, kind: String, id: String,
                        completion: @escaping (Result<WorkspaceAgentProse, Error>) -> Void) {
        perform(completion) {
            try self.request("workspaceAgent", fields: ["projectId": projectID,
                "command": ["action": "readProse", "target": ["kind": kind, "id": id]]])
        }
    }

    /// A body's styled projection for printing and PDF export: live from its
    /// open owner, else stored. A read only: no owner opens, nothing is
    /// written. Queued input is not in it yet; callers wait for it first.
    func readProjection(projectID: String, kind: String, id: String,
                        completion: @escaping (Result<WorkspaceBodyProjection, Error>) -> Void) {
        perform(completion) {
            try self.request("workspaceAgent", fields: ["projectId": projectID,
                "command": ["action": "readProjection", "target": ["kind": kind, "id": id]]])
        }
    }

    /// Applies an accepted Agent revision through the body's document owner:
    /// Rust saves the author's pending edits as theirs, then commits each
    /// exact-text replacement as one Agent undo step. An open owner adopts
    /// the returned state as a receipt does; queued input is refused first.
    func agentApplyChanges(projectID: String, kind: String, id: String, changes: [[String: Any]], agent: [String: String],
                           completion: @escaping (Result<WorkspaceAgentApplied, Error>) -> Void) {
        precondition(Thread.isMainThread)
        guard !isChangingOwners else {
            completion(.failure(LabError.message("正在切换页面，请稍后再应用修改。"))); return
        }
        let scope: DocumentScope?
        switch kind {
        case "chapter": scope = .chapter(ChapterScope(projectID: projectID, chapterID: id))
        case "element": scope = .element(ElementScope(projectID: projectID, elementID: id))
        case "drift": scope = .drift(DriftScope(projectID: projectID, driftID: id))
        case "storyline": scope = .storyline(StorylineScope(projectID: projectID, storylineID: id))
        case "category": scope = .category(CategoryScope(projectID: projectID, categoryID: id))
        default: scope = nil
        }
        if let scope, owners[scope]?.core.hasPendingDocumentWork == true {
            completion(.failure(LabError.message("作者正在输入，请结束输入并等待正文保存后再应用修改。"))); return
        }
        perform({ (result: Result<WorkspaceAgentApplied, Error>) in
            if case .success(let reply) = result, let handle = reply.handle,
               let owner = self.owners.values.first(where: { $0.handle == handle }), !owner.core.isClosed {
                owner.core.receiveReconciledState(reply.document)
            }
            completion(result)
        }) {
            try self.request("workspaceAgent", fields: ["projectId": projectID, "command": [
                "action": "applyChanges", "target": ["kind": kind, "id": id], "changes": changes, "agent": agent]])
        }
    }

    // MARK: Story timeline

    /// Every live node's narrative order and graph position, and the
    /// markers in narrative order. A read only.
    func timeline(projectID: String, completion: @escaping (Result<WorkspaceTimeline, Error>) -> Void) {
        perform(completion) {
            let reply: WorkspaceTimelineReply<WorkspaceTimelineNode> = try self.timelineRequest(projectID, ["action": "timeline"])
            return reply.timeline
        }
    }

    /// A chapter's place in story time, or nil to take it off the narrative
    /// axis. Metadata only: no owner, input or history is touched.
    func setNarrativeOrder(projectID: String, chapterID: String, order: Double?,
                           completion: @escaping (Result<WorkspaceTimelineReply<WorkspaceTimelineNode>, Error>) -> Void) {
        perform(completion) {
            try self.timelineRequest(projectID, ["action": "setNarrativeOrder", "chapterId": chapterID,
                "order": order.map { $0 as Any } ?? NSNull()])
        }
    }

    /// One story graph drop: the narrative order (`.some(nil)` unplaces) and
    /// the lane (`.some(id)` makes that storyline primary, dropping the
    /// previous primary's link and keeping the others; `.some(nil)` removes
    /// every link) change together in one original, or not at all. Absent
    /// fields stay. Metadata only.
    /// `bookBefore`, when present, also moves the chapter in reading order
    /// (before that chapter, or last with nil) in the same original.
    func moveChapterOnTimeline(projectID: String, chapterID: String, order: Double??, lane: String??, bookBefore: String?? = nil,
                               completion: @escaping (Result<WorkspaceTimelineReply<WorkspaceTimelineNode>, Error>) -> Void) {
        var command: [String: Any] = ["action": "moveChapter", "chapterId": chapterID]
        if let order { command["order"] = order.map { $0 as Any } ?? NSNull() }
        if let lane { command["lane"] = lane.map { $0 as Any } ?? NSNull() }
        if let bookBefore { command["bookBefore"] = bookBefore.map { $0 as Any } ?? NSNull() }
        // A book move waits for input and owner changes, as chapter reordering does.
        if bookBefore != nil, isChangingOwners || hasPendingDocuments {
            completion(.failure(LabError.message("请先完成输入，并等待正文保存后再操作"))); return
        }
        perform(completion) { try self.timelineRequest(projectID, command) }
    }

    /// A drift card's place in the story graph's free area.
    func setNodePosition(projectID: String, nodeID: String, x: Double, y: Double,
                         completion: @escaping (Result<WorkspaceTimelineReply<WorkspaceTimelineNode>, Error>) -> Void) {
        perform(completion) {
            try self.timelineRequest(projectID, ["action": "setPosition", "nodeId": nodeID, "x": x, "y": y])
        }
    }

    /// A label-less marker must name a live drift, which captions it.
    func createTimelineMarker(projectID: String, narrativeOrder: Double, label: String, driftID: String?,
                              completion: @escaping (Result<WorkspaceTimelineReply<WorkspaceTimelineMarker>, Error>) -> Void) {
        var command: [String: Any] = ["action": "createMarker", "narrativeOrder": narrativeOrder, "label": label]
        if let driftID { command["driftId"] = driftID }
        perform(completion) { try self.timelineRequest(projectID, command) }
    }

    /// Present fields change; unchanged fields write nothing.
    func updateTimelineMarker(projectID: String, markerID: String, changes: TimelineMarkerChanges,
                              completion: @escaping (Result<WorkspaceTimelineReply<WorkspaceTimelineMarker>, Error>) -> Void) {
        var command = changes.fields
        command["action"] = "updateMarker"; command["markerId"] = markerID
        perform(completion) { try self.timelineRequest(projectID, command) }
    }

    /// The reply has no result.
    func deleteTimelineMarker(projectID: String, markerID: String,
                              completion: @escaping (Result<WorkspaceTimelineReply<WorkspaceTimelineMarker>, Error>) -> Void) {
        perform(completion) { try self.timelineRequest(projectID, ["action": "deleteMarker", "markerId": markerID]) }
    }

    private func timelineRequest<Payload: Decodable>(_ projectID: String, _ command: [String: Any]) throws -> Payload {
        try request("workspaceTimeline", fields: ["projectId": projectID, "command": command])
    }

    // MARK: Version history

    /// A body's versions, newest first. An open owner's pending input is
    /// saved (and captured when due) before the list is read.
    func versionHistory(projectID: String, target: VersionHistoryTarget,
                        completion: @escaping (Result<[WorkspaceHistoryEntry], Error>) -> Void) {
        perform(completion) {
            let reply: WorkspaceHistoryList = try self.request("workspaceHistory", fields: ["projectId": projectID,
                "command": ["action": "list", "target": target.payload]])
            return reply.entries
        }
    }

    /// Restores a version as one undoable edit through the body's owner,
    /// after Rust captured the current state. An open owner adopts the
    /// returned state as an Agent revision does; queued input is refused first.
    func restoreVersion(projectID: String, target: VersionHistoryTarget, snapshotID: String,
                        completion: @escaping (Result<WorkspaceHistoryRestored, Error>) -> Void) {
        precondition(Thread.isMainThread)
        guard !isChangingOwners else {
            completion(.failure(LabError.message("正在切换页面，请稍后再恢复历史版本。"))); return
        }
        if owners[target.scope]?.core.hasPendingDocumentWork == true {
            completion(.failure(LabError.message("正在输入或保存正文，请结束输入并等待保存后再恢复历史版本。"))); return
        }
        notAuthored(projectID) {
            perform({ (result: Result<WorkspaceHistoryRestored, Error>) in
                if case .success(let reply) = result, let handle = reply.handle,
                   let owner = self.owners.values.first(where: { $0.handle == handle }), !owner.core.isClosed {
                    owner.core.receiveReconciledState(reply.document)
                }
                completion(result)
            }) {
                try self.request("workspaceHistory", fields: ["projectId": projectID, "command": [
                    "action": "restore", "target": target.payload, "snapshotId": snapshotID]])
            }
        }
    }

    func createChapter(projectID: String, title: String,
                       completion: @escaping (Result<WorkspaceChapter, Error>) -> Void) {
        perform(completion) {
            try self.request("workspaceCreateChapter", fields: ["projectId": projectID, "title": title])
        }
    }

    func renameChapter(projectID: String, chapterID: String, title: String,
                       completion: @escaping (Result<WorkspaceChapter, Error>) -> Void) {
        updateMetadata("workspaceRenameChapter", fields: ["projectId": projectID, "chapterId": chapterID, "title": title], completion: completion)
    }

    func moveChapter(projectID: String, chapterID: String, beforeChapterID: String?,
                     completion: @escaping (Result<[WorkspaceChapter], Error>) -> Void) {
        updateMetadata("workspaceMoveChapter", fields: ["projectId": projectID, "chapterId": chapterID,
            "beforeChapterId": beforeChapterID.map { $0 as Any } ?? NSNull()], completion: completion)
    }

    private func updateMetadata<Payload: Decodable>(_ operation: String, fields: [String: Any],
                                                    completion: @escaping (Result<Payload, Error>) -> Void) {
        precondition(Thread.isMainThread)
        guard !isChangingOwners, !hasPendingDocuments else {
            completion(.failure(LabError.message("请先完成输入，并等待正文保存后再操作")))
            return
        }
        // Metadata changes deliberately retain the current document and store.
        perform(completion) { try self.request(operation, fields: fields) }
    }

    func openChapter(projectID: String, chapterID: String, completion: @escaping (Result<LabCore, Error>) -> Void) {
        openDocument(.chapter(ChapterScope(projectID: projectID, chapterID: chapterID)), reopen: false, completion: completion)
    }

    func reopenChapter(projectID: String, chapterID: String, completion: @escaping (Result<LabCore, Error>) -> Void) {
        reopenDocument(.chapter(ChapterScope(projectID: projectID, chapterID: chapterID)), completion: completion)
    }

    private func reopenDocument(_ scope: DocumentScope, completion: @escaping (Result<LabCore, Error>) -> Void) {
        guard (owners[scope]?.core.documentViewCount ?? 0) <= 1 else {
            completion(.failure(LabError.message("请先关闭这个\(scope.kindName)的另一处显示，再重新打开"))); return
        }
        openDocument(scope, reopen: true, completion: completion)
    }

    private func openDocument(_ scope: DocumentScope, reopen: Bool,
                              completion: @escaping (Result<LabCore, Error>) -> Void) {
        precondition(Thread.isMainThread)
        guard beginOwnerChange() else {
            completion(.failure(LabError.message("请先完成输入，并等待正文保存后再切换章节")))
            return
        }
        perform({ (result: Result<OwnerReply, Error>) in
            let result = result.map { reply -> LabCore in
                if let owner = self.owners[scope], owner.handle == reply.handle { return owner.core }
                // Only a successful explicit reopen invalidates this scope.
                self.owners[scope]?.core.invalidate()
                let core = LabCore(handle: reply.handle, directory: self.directory, queue: self.queue)
                self.owners[scope] = Owner(handle: reply.handle, core: core)
                return core
            }
            self.endOwnerChange()
            completion(result)
        }) {
            switch scope {
            case .chapter(let chapter):
                return try self.request(reopen ? "workspaceReopenChapter" : "workspaceOpenChapter",
                                        fields: ["projectId": chapter.projectID, "chapterId": chapter.chapterID])
            case .element(let element):
                return try self.elementRequest(element.projectID,
                    ["action": "openElement", "elementId": element.elementID, "reopen": reopen])
            case .storyline(let storyline):
                // The storyline command has no reopen flag; callers never
                // ask for one (see `MacChapterWorkspace.canReopenActive`).
                guard !reopen else { throw LabError.message("故事线页面暂不支持从磁盘重新打开") }
                return try self.storylineRequest(storyline.projectID,
                    ["action": "openStoryline", "storylineId": storyline.storylineID])
            case .drift(let drift):
                // The drift command has no reopen flag either.
                guard !reopen else { throw LabError.message("漂流页面暂不支持从磁盘重新打开") }
                return try self.driftRequest(drift.projectID, ["action": "openDrift", "driftId": drift.driftID])
            case .category(let category):
                // Nor does the category command.
                guard !reopen else { throw LabError.message("分类页面暂不支持从磁盘重新打开") }
                return try self.elementRequest(category.projectID, ["action": "openCategory", "categoryId": category.categoryID])
            }
        }
    }

    func closeChapter(projectID: String, chapterID: String, completion: @escaping (Result<Bool, Error>) -> Void) {
        closeDocument(.chapter(ChapterScope(projectID: projectID, chapterID: chapterID)), completion: completion)
    }

    private func closeDocument(_ scope: DocumentScope, completion: @escaping (Result<Bool, Error>) -> Void) {
        precondition(Thread.isMainThread)
        guard (owners[scope]?.core.documentViewCount ?? 0) <= 1, beginOwnerChange() else {
            completion(.failure(LabError.message("请先完成输入、处理草稿，并关闭这个\(scope.kindName)的另一处显示"))); return
        }
        perform({ (result: Result<Bool, Error>) in
            if case .success = result { self.owners.removeValue(forKey: scope)?.core.invalidate() }
            self.endOwnerChange()
            completion(result)
        }) {
            switch scope {
            case .chapter(let chapter):
                return try self.emptyRequest("workspaceCloseChapter",
                                             fields: ["projectId": chapter.projectID, "chapterId": chapter.chapterID])
            case .element(let element):
                return try self.emptyRequest("workspaceElements", fields: ["projectId": element.projectID,
                    "command": ["action": "closeElement", "elementId": element.elementID]])
            case .storyline(let storyline):
                return try self.emptyRequest("workspaceStorylines", fields: ["projectId": storyline.projectID,
                    "command": ["action": "closeStoryline", "storylineId": storyline.storylineID]])
            case .drift(let drift):
                return try self.emptyRequest("workspaceDrifts", fields: ["projectId": drift.projectID,
                    "command": ["action": "closeDrift", "driftId": drift.driftID]])
            case .category(let category):
                return try self.emptyRequest("workspaceElements", fields: ["projectId": category.projectID,
                    "command": ["action": "closeCategory", "categoryId": category.categoryID]])
            }
        }
    }

    func close(completion: @escaping (Result<Bool, Error>) -> Void) {
        precondition(Thread.isMainThread)
        guard beginOwnerChange() else {
            completion(.failure(LabError.message("仍有未完成输入或待恢复草稿，请先保存所有章节"))); return
        }
        perform({ (result: Result<Bool, Error>) in
            if case .success = result {
                self.owners.values.forEach { $0.core.invalidate() }
                self.owners.removeAll()
            }
            self.endOwnerChange()
            completion(result)
        }) {
            guard self.handle != nil else { return true }
            _ = try self.emptyRequest("workspaceClose")
            self.handle = nil
            return true
        }
    }

    private func beginOwnerChange() -> Bool {
        guard !isChangingOwners, remoteDeliveryInFlight == 0, !hasPendingDocuments else { return false }
        isChangingOwners = true
        owners.values.forEach { $0.core.suspend(true) }
        return true
    }
    private func endOwnerChange() {
        isChangingOwners = false
        owners.values.forEach { $0.core.suspend(false) }
    }
    private func emptyRequest(_ operation: String, fields: [String: Any] = [:]) throws -> Bool {
        guard let handle else { throw LabError.message("请先打开工作区") }
        var request = fields; request["operation"] = operation; request["handle"] = handle
        let _: LabState? = try LabCore.call(request)
        return true
    }

    private func request<Payload: Decodable>(_ operation: String, fields: [String: Any] = [:]) throws -> Payload {
        guard let handle else { throw LabError.message("请先打开工作区") }
        var request = fields
        request["operation"] = operation
        request["handle"] = handle
        guard let result: Payload = try LabCore.call(request) else { throw LabError.message("工作区结果缺失") }
        return result
    }

    private func perform<Payload>(_ completion: @escaping (Result<Payload, Error>) -> Void,
                                  _ operation: @escaping () throws -> Payload) {
        queue.async {
            let result = Result { try operation() }
            DispatchQueue.main.async { completion(result) }
        }
    }

    deinit {
        if let handle {
            queue.async { let _: LabState? = try? LabCore.call(["operation": "workspaceClose", "handle": handle]) }
        }
    }
}
