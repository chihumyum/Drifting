import Foundation

/// One ordered key/value row of an element's facts or a category template.
/// Text is exactly what the author typed; Rust decides which rows are blank.
struct WorkspaceFact: Codable, Equatable {
    var key: String
    var value: String

    var payload: [String: Any] { ["key": key, "value": value] }
}

/// An element category as the shared Rust workspace store returns it.
struct WorkspaceElementCategory: Decodable, Equatable {
    let id: String
    let projectId: String
    let name: String
    let color: String
    /// Cloned into elements created in this category later; never applied
    /// to existing elements.
    let templateFacts: [WorkspaceFact]
    let documentId: String
    let createdAt: String
    let updatedAt: String

    /// `#RRGGBB` components in 0...1, or nil for a value this view cannot draw.
    var rgb: (red: Double, green: Double, blue: Double)? { Self.rgb(hex: color) }

    static func rgb(hex color: String) -> (red: Double, green: Double, blue: Double)? {
        let hex = color.hasPrefix("#") ? String(color.dropFirst()) : color
        guard hex.count == 6, let value = UInt32(hex, radix: 16) else { return nil }
        return (Double((value >> 16) & 0xFF) / 255, Double((value >> 8) & 0xFF) / 255, Double(value & 0xFF) / 255)
    }
}

/// A live or trashed element. Its prose body is the `element:<id>` document.
struct WorkspaceElement: Decodable, Equatable {
    let id: String
    let projectId: String
    let categoryId: String?
    let name: String
    let summary: String
    let aliases: [String]
    let groupName: String?
    /// Ordered facts; rows with a blank key and value are never stored.
    let facts: [WorkspaceFact]
    let documentId: String
    let createdAt: String
    let updatedAt: String
}

struct WorkspaceElementLibrary: Decodable, Equatable {
    var categories: [WorkspaceElementCategory]
    var elements: [WorkspaceElement]
    var trashedElements: [WorkspaceElement]
    /// Trashing a category detaches its elements; restoring does not re-attach.
    var trashedCategories: [WorkspaceElementCategory]

    static let empty = WorkspaceElementLibrary(categories: [], elements: [], trashedElements: [], trashedCategories: [])
}

/// Every library command returns its own result and the complete library
/// after it, so no list is patched locally.
struct WorkspaceElementReply<Value: Decodable>: Decodable {
    let result: Value?
    let library: WorkspaceElementLibrary
}

/// Chapters whose prose links one element, in book order. `first` is in that
/// chapter's projection UTF-16 coordinates when it was read.
struct WorkspaceElementBacklinks: Decodable, Equatable {
    struct Chapter: Decodable, Equatable {
        let chapterId: String
        let chapterTitle: String
        /// Linked runs, and the distinct blocks that hold them.
        let spans: Int
        let blocks: Int
        let first: NativeRange
    }
    /// A chapter whose prose could not be read, e.g. with unresolved sync
    /// dependencies. It is listed so a missing count is not mistaken for none.
    struct Unavailable: Decodable, Equatable {
        let chapterId: String
        let chapterTitle: String
    }
    let elementId: String
    let chapters: [Chapter]
    let unavailable: [Unavailable]
}

extension EntityLinkDirectory {
    /// Live and trashed elements, chapters and drifts of one project. An
    /// element's colour is its live category's; a detached element keeps the
    /// default. Chapter and drift links keep the default colour.
    init(library: WorkspaceElementLibrary, chapters: [WorkspaceChapter], trashedChapters: [WorkspaceChapter],
         drifts: WorkspaceDriftLibrary = .empty) {
        let categories = Dictionary(library.categories.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        func target(_ element: WorkspaceElement, trashed: Bool) -> EntityLinkTarget {
            let category = element.categoryId.flatMap { categories[$0] }
            return EntityLinkTarget(kind: .element, id: element.id, name: element.name, trashed: trashed,
                colorHex: category?.color, category: category?.name, aliases: element.aliases, summary: element.summary)
        }
        self.init(targets: library.trashedElements.map { target($0, trashed: true) }
            + library.elements.map { target($0, trashed: false) }
            + trashedChapters.map { EntityLinkTarget(kind: .chapter, id: $0.id, name: $0.title, trashed: true) }
            + chapters.map { EntityLinkTarget(kind: .chapter, id: $0.id, name: $0.title) }
            + drifts.trashedDrifts.map { EntityLinkTarget(kind: .drift, id: $0.id, name: $0.title, trashed: true) }
            + drifts.drifts.map { EntityLinkTarget(kind: .drift, id: $0.id, name: $0.title, summary: $0.summary) })
    }

    /// What linking reads from the library: live names and aliases.
    static func linkNames(_ library: WorkspaceElementLibrary) -> [[String]] {
        library.elements.sorted { $0.id < $1.id }.map { [$0.id, $0.name] + $0.aliases }
    }
}

/// Present fields are written; an explicit nil inside `groupName` or
/// `categoryID` clears it. Absent fields stay unchanged.
struct WorkspaceElementChanges {
    var name: String?
    var summary: String?
    var groupName: String??
    var categoryID: String??
    var aliases: [String]?

    var fields: [String: Any] {
        var fields: [String: Any] = [:]
        if let name { fields["name"] = name }
        if let summary { fields["summary"] = summary }
        if let groupName { fields["groupName"] = groupName.map { $0 as Any } ?? NSNull() }
        if let categoryID { fields["categoryId"] = categoryID.map { $0 as Any } ?? NSNull() }
        if let aliases { fields["aliases"] = aliases }
        return fields
    }
}

enum ElementText {
    /// Aliases are typed as one line separated by ASCII or full-width commas.
    static func aliases(from text: String) -> [String] {
        text.components(separatedBy: CharacterSet(charactersIn: ",，"))
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
    }
    static func display(aliases: [String]) -> String { aliases.joined(separator: "，") }
    static func trimmed(_ text: String) -> String { text.trimmingCharacters(in: .whitespacesAndNewlines) }
    /// The rows Rust would store: a row whose key and value are both blank is
    /// dropped, and nothing is trimmed. Used only to skip unchanged commits.
    static func stored(facts: [WorkspaceFact]) -> [WorkspaceFact] {
        facts.filter { !trimmed($0.key).isEmpty || !trimmed($0.value).isEmpty }
    }
}

/// Presentation state of one project's 设定库. Rust owns every list and
/// order-independent identity; this model only groups rows for display.
final class ElementLibraryModel {
    enum Row: Equatable {
        case category(WorkspaceElementCategory, count: Int)
        case uncategorized(count: Int)
        case group(name: String, section: String)
        case element(WorkspaceElement, grouped: Bool)
        case empty(section: String)
        case trashHeader(count: Int)
        /// “已删除分类” or “已删除设定” inside the trash.
        case trashPart(title: String, identifier: String)
        case trashedCategory(WorkspaceElementCategory)
        case trashed(WorkspaceElement)

        var element: WorkspaceElement? {
            switch self {
            case .element(let element, _), .trashed(let element): return element
            default: return nil
            }
        }
        var identifier: String {
            switch self {
            case .category(let category, _): return "element-category-\(category.id)"
            case .uncategorized: return "element-category-uncategorized"
            case .group(let name, let section): return "element-group-\(section)-\(name)"
            case .element(let element, _): return "element-row-\(element.id)"
            case .empty(let section): return "element-empty-\(section)"
            case .trashHeader: return "element-trash"
            case .trashPart(_, let identifier): return identifier
            case .trashedCategory(let category): return "trashed-element-category-\(category.id)"
            case .trashed(let element): return "trashed-element-\(element.id)"
            }
        }
    }

    let projectID: String
    private let workspace: LabWorkspaceCore
    private(set) var library = WorkspaceElementLibrary.empty
    private(set) var loaded = false
    private(set) var busy = false
    private(set) var status = "正在读取设定库…"
    var onChange: (() -> Void)?
    /// Every successful command's complete library, for open element pages.
    var onLibrary: ((WorkspaceElementLibrary) -> Void)?

    init(workspace: LabWorkspaceCore, projectID: String) {
        self.workspace = workspace
        self.projectID = projectID
    }

    var rows: [Row] {
        var rows: [Row] = []
        let order: (WorkspaceElement, WorkspaceElement) -> Bool = {
            $0.name.localizedStandardCompare($1.name) == .orderedAscending
        }
        func section(_ members: [WorkspaceElement], id: String) {
            guard !members.isEmpty else { rows.append(.empty(section: id)); return }
            rows += members.filter { $0.groupName == nil }.sorted(by: order).map { .element($0, grouped: false) }
            let groups = Set(members.compactMap(\.groupName)).sorted { $0.localizedStandardCompare($1) == .orderedAscending }
            for group in groups {
                rows.append(.group(name: group, section: id))
                rows += members.filter { $0.groupName == group }.sorted(by: order).map { .element($0, grouped: true) }
            }
        }
        let live = Set(library.categories.map(\.id))
        for category in library.categories {
            let members = library.elements.filter { $0.categoryId == category.id }
            rows.append(.category(category, count: members.count))
            section(members, id: category.id)
        }
        let orphans = library.elements.filter { $0.categoryId.map { !live.contains($0) } ?? true }
        if !orphans.isEmpty {
            rows.append(.uncategorized(count: orphans.count))
            section(orphans, id: "uncategorized")
        }
        let trashed = library.trashedCategories.count + library.trashedElements.count
        if trashed > 0 {
            rows.append(.trashHeader(count: trashed))
            if !library.trashedCategories.isEmpty {
                rows.append(.trashPart(title: "已删除分类", identifier: "element-trash-categories"))
                rows += library.trashedCategories.map { .trashedCategory($0) }
                if !library.trashedElements.isEmpty {
                    rows.append(.trashPart(title: "已删除设定", identifier: "element-trash-elements"))
                }
            }
            rows += library.trashedElements.map { .trashed($0) }
        }
        return rows
    }

    func showStatus(_ message: String) { status = message; onChange?() }

    func load() {
        guard !busy else { return }
        busy = true; onChange?()
        workspace.elementLibrary(projectID: projectID) { [weak self] result in
            guard let self else { return }
            self.busy = false
            switch result {
            case .success(let library): self.apply(library, message: nil); self.onLibrary?(library)
            case .failure(let error): self.showStatus(error.localizedDescription)
            }
        }
    }

    /// Adopt a library returned by a command that ran elsewhere, such as a
    /// page edit or a trash that also closed tabs.
    func apply(_ library: WorkspaceElementLibrary, message: String?) {
        self.library = library; loaded = true
        status = message ?? (library.categories.isEmpty
            ? "还没有分类。先新建一个分类，例如“人物”或“地点”。"
            : "点击设定打开页面；右键分类或设定查看更多操作。")
        onChange?()
    }

    func createCategory(name: String, completion: ((Result<WorkspaceElementCategory, Error>) -> Void)? = nil) {
        mutate(message: "分类已创建。", completion: completion) {
            workspace.createElementCategory(projectID: projectID, name: name, completion: $0)
        }
    }

    func renameCategory(id: String, name: String, completion: ((Result<WorkspaceElementCategory, Error>) -> Void)? = nil) {
        mutate(message: "分类名称已保存。", completion: completion) {
            workspace.updateElementCategory(projectID: projectID, categoryID: id, name: name, completion: $0)
        }
    }

    func recolorCategory(id: String, color: String, completion: ((Result<WorkspaceElementCategory, Error>) -> Void)? = nil) {
        mutate(message: "分类颜色已保存。", completion: completion) {
            workspace.updateElementCategory(projectID: projectID, categoryID: id, color: color, completion: $0)
        }
    }

    func createElement(categoryID: String, completion: ((Result<WorkspaceElement, Error>) -> Void)? = nil) {
        mutate(message: "设定已创建，可以在页面中填写名称和正文。", completion: completion) {
            workspace.createElement(projectID: projectID, categoryID: categoryID, completion: $0)
        }
    }

    /// Only elements created later clone the template.
    func setTemplateFacts(categoryID: String, facts: [WorkspaceFact],
                          completion: ((Result<WorkspaceElementCategory, Error>) -> Void)? = nil) {
        mutate(message: "模板字段已保存，之后新建的设定会带上这些字段。", completion: completion) {
            workspace.setCategoryTemplateFacts(projectID: projectID, categoryID: categoryID, facts: facts, completion: $0)
        }
    }

    /// Its elements stay live and open; they move to 未分类.
    func trashCategory(id: String, completion: ((Result<WorkspaceElementCategory, Error>) -> Void)? = nil) {
        let name = library.categories.first { $0.id == id }?.name ?? "分类"
        mutate(message: "“\(name)”已移到回收站，其中的设定已移到“未分类”。", completion: completion) {
            workspace.trashElementCategory(projectID: projectID, categoryID: id, completion: $0)
        }
    }

    /// Restoring does not move detached elements back.
    func restoreCategory(id: String, completion: ((Result<WorkspaceElementCategory, Error>) -> Void)? = nil) {
        mutate(message: "分类已恢复。原来的设定仍在“未分类”中，可以在设定页面重新选择分类。", completion: completion) {
            workspace.restoreElementCategory(projectID: projectID, categoryID: id, completion: $0)
        }
    }

    func restore(elementID: String, completion: ((Result<WorkspaceElement, Error>) -> Void)? = nil) {
        mutate(message: "设定已恢复，点击即可打开。", completion: completion) {
            workspace.restoreElement(projectID: projectID, elementID: elementID, completion: $0)
        }
    }

    private func mutate<Value: Decodable>(message: String, completion: ((Result<Value, Error>) -> Void)?,
                               operation: (@escaping (Result<WorkspaceElementReply<Value>, Error>) -> Void) -> Void) {
        guard !busy else {
            completion?(.failure(LabError.message("正在保存设定库，请稍后重试"))); return
        }
        busy = true; onChange?()
        operation { [weak self] result in
            guard let self else { return }
            self.busy = false
            switch result {
            case .success(let reply):
                self.apply(reply.library, message: message)
                self.onLibrary?(reply.library)
                if let value = reply.result { completion?(.success(value)) }
                else { completion?(.failure(LabError.message("设定库结果缺失"))) }
            case .failure(let error):
                self.showStatus(error.localizedDescription)
                completion?(.failure(error))
            }
        }
    }
}
