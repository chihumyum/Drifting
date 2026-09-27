import Foundation

/// Entity kinds a relation endpoint may name, in the renderer's canonical
/// order. The native client addresses chapters and drifts (`node`), elements,
/// categories and storylines; the other kinds belong to renderer features and
/// stay as stored.
enum RelationKind {
    static let all = ["node", "element", "patch", "category", "storyline", "comment", "library_item"]
    static let structural = ["node", "element", "patch", "category", "storyline"]
    static let native = ["node", "element", "category", "storyline"]
    /// Kinds that 关联 through the built-in Generic association.
    static let associationSources = ["comment", "library_item"]

    /// How a type's allowed kinds read in the type editor.
    static func label(_ kind: String) -> String {
        switch kind {
        case "node": return "章节或漂流"
        case "element": return "设定"
        case "patch": return "设定补丁"
        case "category": return "分类"
        case "storyline": return "故事线"
        case "comment": return "批注"
        case "library_item": return "素材"
        default: return kind
        }
    }

    /// `values` in canonical order without duplicates.
    static func ordered(_ values: [String], in canonical: [String] = all) -> [String] {
        canonical.filter { values.contains($0) }
    }
}

/// One end of a relation: `node:<id>`, `element:<id>` and so on.
struct RelationEndpoint: Hashable {
    let kind: String
    let id: String
    var key: String { "\(kind):\(id)" }
}

/// A relation type as Rust stores it. Author types carry no system key; the
/// built-in “Generic association” is locked and links TODOs and library items
/// only, so native pickers never offer it.
struct WorkspaceRelationType: Decodable, Equatable {
    let id: String
    let projectId: String
    let name: String
    let normalizedName: String
    let description: String
    /// `directed` or `symmetric`.
    let orientation: String
    let systemKey: String?
    let locked: Bool
    let sourceRole: String
    let targetRole: String
    let sourceKinds: [String]
    let targetKinds: [String]
    let createdAt: String
    let updatedAt: String

    var isSymmetric: Bool { orientation == "symmetric" }
    var isAuthored: Bool { !locked && systemKey == nil }
    private var isGenericAssociation: Bool { systemKey == "generic-association" }
    /// The renderer's zh-CN presentation of the built-in type; author types verbatim.
    var displayName: String { isGenericAssociation ? "关联" : name }
    var displaySourceRole: String { isGenericAssociation ? "关联项" : sourceRole }
    var displayTargetRole: String { isGenericAssociation ? "对象" : targetRole }
    var displayDescription: String { isGenericAssociation ? "TODO 与素材的一键对象关联。" : description }
    /// “师父 → 徒弟”, or “对称 · 盟友”.
    var summary: String { isSymmetric ? "对称 · \(displaySourceRole)" : "\(displaySourceRole) → \(displayTargetRole)" }

    func allows(from: String, to: String) -> Bool { sourceKinds.contains(from) && targetKinds.contains(to) }

    /// Whether these ends fit the type, with the refusal Rust would give
    /// (`validateRelationAgainstType`). Pickers use it to offer only fitting
    /// types; Rust checks again on every write.
    func check(from: RelationEndpoint, to: RelationEndpoint) -> RelationCheck {
        if allows(from: from.kind, to: to.kind) { return .valid }
        let swap = RelationKind.structural.contains(from.kind) && allows(from: to.kind, to: from.kind)
        let expected = "\(sourceRole.isEmpty ? "源端" : sourceRole) → \(targetRole.isEmpty ? "目标端" : targetRole)"
        return .refused(swap ? "关系类型「\(name)」要求 \(expected)；当前两端方向相反，请交换两端后重试。"
                             : "关系类型「\(name)」要求 \(expected)，当前实体类型不符合其端点约束。", suggestsSwap: swap)
    }

    /// Fits the two ends in one direction or the other.
    func fits(_ first: RelationEndpoint, _ second: RelationEndpoint) -> Bool {
        allows(from: first.kind, to: second.kind) || allows(from: second.kind, to: first.kind)
    }
}

enum RelationCheck: Equatable {
    case valid
    case refused(String, suggestsSwap: Bool)

    var message: String? { if case .refused(let message, _) = self { return message }; return nil }
    var isValid: Bool { self == .valid }
}

/// A curated relation. Symmetric relations are stored with the bytewise
/// smaller `kind:id` first, so either end may be `from`.
struct WorkspaceRelation: Decodable, Equatable {
    let id: String
    let projectId: String
    let fromKind: String
    let fromId: String
    let toKind: String
    let toId: String
    let relationTypeId: String
    let createdAt: String
    let updatedAt: String

    var from: RelationEndpoint { RelationEndpoint(kind: fromKind, id: fromId) }
    var to: RelationEndpoint { RelationEndpoint(kind: toKind, id: toId) }
}

/// A type as the author enters it. Rust trims, orders kinds and gives a
/// symmetric type one shared role; the editor sends exactly what was typed.
struct RelationTypeDefinition: Equatable {
    var name: String
    var description: String
    var orientation: String
    var sourceRole: String
    var targetRole: String
    var sourceKinds: [String]
    var targetKinds: [String]

    init(name: String, description: String = "", orientation: String, sourceRole: String, targetRole: String,
         sourceKinds: [String], targetKinds: [String]) {
        self.name = name; self.description = description; self.orientation = orientation
        self.sourceRole = sourceRole; self.targetRole = targetRole
        self.sourceKinds = sourceKinds; self.targetKinds = targetKinds
    }

    init(type: WorkspaceRelationType) {
        self.init(name: type.name, description: type.description, orientation: type.orientation, sourceRole: type.sourceRole,
                  targetRole: type.targetRole, sourceKinds: type.sourceKinds, targetKinds: type.targetKinds)
    }

    var payload: [String: Any] {
        ["name": name, "description": description, "orientation": orientation, "sourceRole": sourceRole,
         "targetRole": targetRole, "sourceKinds": sourceKinds, "targetKinds": targetKinds]
    }

    /// Whether a type created from this definition would accept these ends,
    /// so inline creation never adds a type the picker would then hide
    /// (`validateRelationTypeDefinitionAgainstRelation`). Name and role rules
    /// stay with Rust.
    func check(from: RelationEndpoint, to: RelationEndpoint) -> RelationCheck {
        let trim = { (text: String) in text.trimmingCharacters(in: .whitespacesAndNewlines) }
        let symmetric = orientation == "symmetric"
        let shared = [trim(sourceRole), trim(targetRole)].first { !$0.isEmpty } ?? "端点"
        let sources = RelationKind.ordered(sourceKinds)
        let draft = WorkspaceRelationType(id: "draft-relation-type", projectId: "", name: trim(name), normalizedName: "",
            description: "", orientation: orientation, systemKey: nil, locked: false,
            sourceRole: symmetric ? shared : trim(sourceRole), targetRole: symmetric ? shared : trim(targetRole),
            sourceKinds: sources, targetKinds: RelationKind.ordered(symmetric ? sources : targetKinds, in: RelationKind.structural),
            createdAt: "", updatedAt: "")
        return draft.check(from: from, to: to)
    }
}

/// Every type and relation of one project. Every relation command returns
/// its own result and the complete library after it.
struct WorkspaceRelationLibrary: Decodable, Equatable {
    var types: [WorkspaceRelationType]
    var relations: [WorkspaceRelation]

    static let empty = WorkspaceRelationLibrary(types: [], relations: [])

    func type(id: String) -> WorkspaceRelationType? { types.first { $0.id == id } }
    func relation(id: String) -> WorkspaceRelation? { relations.first { $0.id == id } }
    /// Types the author can use natively, by name (Rust's order).
    var authoredTypes: [WorkspaceRelationType] { types.filter(\.isAuthored) }
    func usage(typeID: String) -> Int { relations.filter { $0.relationTypeId == typeID }.count }

    /// The endpoint's relations on either side, newest first. A self-relation
    /// is listed once, as outgoing. 关联 from notes, TODOs and library items
    /// are shown with those instead (审阅 and the 备忘与素材 board).
    func entries(for endpoint: RelationEndpoint, names: RelationNameDirectory) -> [RelationEntry] {
        relations.reversed().compactMap { relation in
            let outgoing = relation.from == endpoint
            guard outgoing || relation.to == endpoint else { return nil }
            let other = outgoing ? relation.to : relation.from
            guard !RelationKind.associationSources.contains(other.kind) else { return nil }
            let type = type(id: relation.relationTypeId)
            let canSwap = type.map { !$0.isSymmetric && RelationKind.structural.contains(relation.from.kind)
                && $0.check(from: relation.to, to: relation.from).isValid } ?? false
            return RelationEntry(relation: relation, type: type, direction: outgoing ? .outgoing : .incoming,
                                 other: other, otherName: names.name(of: other), canSwap: canSwap)
        }
    }

    /// The other ends of every relation of the endpoint.
    func related(to endpoint: RelationEndpoint) -> Set<RelationEndpoint> {
        Set(relations.compactMap { relation in
            relation.from == endpoint ? relation.to : relation.to == endpoint ? relation.from : nil
        })
    }

    /// Author types that connect the two ends in either direction.
    func types(between first: RelationEndpoint, and second: RelationEndpoint) -> [WorkspaceRelationType] {
        authoredTypes.filter { $0.fits(first, second) }
    }

    /// Author types a relation can change to, and whether its ends must swap
    /// for each (`relationTypeNeedsSwap`). Its current type is included.
    func retypeOptions(for relation: WorkspaceRelation) -> [(type: WorkspaceRelationType, swap: Bool)] {
        types.filter { $0.isAuthored || $0.id == relation.relationTypeId }.compactMap { type in
            if type.check(from: relation.from, to: relation.to).isValid { return (type, false) }
            guard RelationKind.structural.contains(relation.from.kind),
                  type.check(from: relation.to, to: relation.from).isValid else { return nil }
            return (type, true)
        }
    }
}

struct WorkspaceRelationReply<Value: Decodable>: Decodable {
    let result: Value?
    let library: WorkspaceRelationLibrary
}

/// How a relation's other end reads: its name, the kind label shown beside
/// it and whether the native client can open it.
struct RelationEndpointName: Equatable {
    let name: String
    let kindLabel: String
    let available: Bool
}

/// One relation seen from one of its ends.
struct RelationEntry: Equatable {
    enum Direction: Equatable { case outgoing, incoming }
    let relation: WorkspaceRelation
    /// Nil when the type is missing from the library.
    let type: WorkspaceRelationType?
    let direction: Direction
    let other: RelationEndpoint
    let otherName: RelationEndpointName
    /// A directed relation whose ends also fit the type the other way round.
    let canSwap: Bool

    var typeName: String { type?.displayName ?? "缺失的关系类型" }
    var isSymmetric: Bool { type?.isSymmetric == true }
    /// This end's role, e.g. 师父 on the mentor's page and 徒弟 on the apprentice's.
    var ownRole: String {
        guard let type else { return "" }
        return direction == .outgoing ? type.displaySourceRole : type.displayTargetRole
    }
    var otherRole: String {
        guard let type else { return "" }
        return direction == .outgoing ? type.displayTargetRole : type.displaySourceRole
    }
    /// → when this end is the source, ← when it is the target, ↔ for symmetric types.
    var arrow: String { isSymmetric ? "↔" : direction == .outgoing ? "→" : "←" }
    /// “类型 · 角色” before the arrow and the other end's name after it.
    var lead: String { ownRole.isEmpty ? typeName : "\(typeName) · \(ownRole)" }
    /// “师徒 · 师父 → 阿岚”.
    var text: String { "\(lead) \(arrow) \(otherName.name)" }
}

/// Names of the project's live chapters, drifts, elements, categories and
/// storylines, read from their libraries. Relation rows and the add sheet
/// resolve ends against it, so they follow renames and trash.
struct RelationNameDirectory {
    enum Group: String, CaseIterable {
        case chapter = "章节", drift = "漂流", element = "设定", category = "分类", storyline = "故事线"
        var kind: String {
            switch self {
            case .chapter, .drift: return "node"
            case .element: return "element"
            case .category: return "category"
            case .storyline: return "storyline"
            }
        }
    }
    struct Candidate: Equatable {
        let endpoint: RelationEndpoint
        let name: String
        let group: Group
    }

    /// Live entities in picker order: chapters in book order, drifts, elements
    /// by name, categories and storylines in their library order.
    private(set) var candidates: [Candidate] = []
    private var byKey: [String: Candidate] = [:]
    let storylinesKnown: Bool
    let loaded: Bool

    static let empty = RelationNameDirectory(elements: nil, chapters: nil, drifts: nil, storylines: nil)

    init(elements: WorkspaceElementLibrary?, chapters: [WorkspaceChapter]?, drifts: WorkspaceDriftLibrary?,
         storylines: WorkspaceStorylineLibrary?) {
        storylinesKnown = storylines != nil
        loaded = elements != nil && chapters != nil && drifts != nil
        func add(_ kind: String, _ id: String, _ name: String, _ group: Group) {
            let candidate = Candidate(endpoint: RelationEndpoint(kind: kind, id: id), name: name, group: group)
            candidates.append(candidate)
            byKey[candidate.endpoint.key] = candidate
        }
        for chapter in chapters ?? [] { add("node", chapter.id, chapter.title.isEmpty ? "无标题章节" : chapter.title, .chapter) }
        for drift in drifts?.drifts ?? [] { add("node", drift.id, drift.title.isEmpty ? "无标题漂流" : drift.title, .drift) }
        let sorted = (elements?.elements ?? []).sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
        for element in sorted { add("element", element.id, element.name.isEmpty ? "未命名设定" : element.name, .element) }
        for category in elements?.categories ?? [] { add("category", category.id, category.name, .category) }
        for storyline in storylines?.storylines ?? [] {
            add("storyline", storyline.id, storyline.name.isEmpty ? "未命名故事线" : storyline.name, .storyline)
        }
    }

    func candidate(_ endpoint: RelationEndpoint) -> Candidate? { byKey[endpoint.key] }

    func name(of endpoint: RelationEndpoint) -> RelationEndpointName {
        if let candidate = byKey[endpoint.key] {
            return RelationEndpointName(name: candidate.name, kindLabel: candidate.group.rawValue, available: true)
        }
        switch endpoint.kind {
        case "node": return RelationEndpointName(name: loaded ? "已不可用的章节或漂流" : "正在读取…", kindLabel: "章节", available: false)
        case "element": return RelationEndpointName(name: loaded ? "已不可用的设定" : "正在读取…", kindLabel: "设定", available: false)
        case "category": return RelationEndpointName(name: loaded ? "已不可用的分类" : "正在读取…", kindLabel: "分类", available: false)
        case "storyline":
            return RelationEndpointName(name: storylinesKnown ? "已不可用的故事线" : "正在读取…", kindLabel: "故事线", available: false)
        default:
            return RelationEndpointName(name: "原生版本暂不支持显示", kindLabel: RelationKind.label(endpoint.kind), available: false)
        }
    }
}

/// One project's relation types and relations. Rust owns every row and
/// check; each reply replaces the library, which reaches every open relation
/// section through `onLibrary` and the type manager through `onChange`.
final class RelationLibraryModel {
    let projectID: String
    private let workspace: LabWorkspaceCore
    private(set) var library = WorkspaceRelationLibrary.empty
    private(set) var loaded = false
    /// Why the last read failed, until a later read or write succeeds.
    private(set) var loadError: String?
    private var reading = false
    private var rereadRequested = false
    /// Commands sent and not yet answered, reads included.
    private(set) var pending = 0
    var busy: Bool { pending > 0 }
    var onLibrary: ((WorkspaceRelationLibrary) -> Void)?
    /// A read failed; the last library stays.
    var onReadFailure: ((String) -> Void)?
    var onChange: (() -> Void)?
    private var observers: [(owner: () -> AnyObject?, block: (WorkspaceRelationLibrary) -> Void)] = []

    init(workspace: LabWorkspaceCore, projectID: String) {
        self.workspace = workspace
        self.projectID = projectID
    }

    /// Calls `block` with every adopted library while `owner` lives, e.g.
    /// the 设定总览 beside the page sections.
    func observe(_ owner: AnyObject, _ block: @escaping (WorkspaceRelationLibrary) -> Void) {
        observers.append(({ [weak owner] in owner }, block))
    }

    /// Reads the library again, e.g. after a trash purged relations. A read
    /// requested during a read runs once more afterwards.
    func load() {
        guard !reading else { rereadRequested = true; return }
        reading = true; pending += 1
        workspace.relationLibrary(projectID: projectID) { [weak self] result in
            guard let self else { return }
            self.reading = false; self.pending -= 1
            switch result {
            case .success(let library): self.adopt(library)
            case .failure(let error):
                self.loadError = error.localizedDescription
                self.onReadFailure?(error.localizedDescription)
                self.onChange?()
            }
            if self.rereadRequested { self.rereadRequested = false; self.load() }
        }
    }

    func createType(_ definition: RelationTypeDefinition, completion: @escaping (Result<WorkspaceRelationType, Error>) -> Void) {
        send(completion) { self.workspace.createRelationType(projectID: self.projectID, definition: definition, completion: $0) }
    }

    func updateType(id: String, definition: RelationTypeDefinition, completion: @escaping (Result<WorkspaceRelationType, Error>) -> Void) {
        send(completion) {
            self.workspace.updateRelationType(projectID: self.projectID, relationTypeID: id, definition: definition, completion: $0)
        }
    }

    /// Rust refuses a built-in type and a type still used by relations.
    func deleteType(id: String, completion: @escaping (Result<Void, Error>) -> Void) {
        sendOptional({ (result: Result<WorkspaceRelationType?, Error>) in completion(result.map { _ in () }) }) {
            self.workspace.deleteRelationType(projectID: self.projectID, relationTypeID: id, completion: $0)
        }
    }

    /// An identical edge of the same type is returned without writing.
    func add(from: RelationEndpoint, to: RelationEndpoint, typeID: String,
             completion: @escaping (Result<WorkspaceRelation, Error>) -> Void) {
        send(completion) {
            self.workspace.addRelation(projectID: self.projectID, from: from, to: to, relationTypeID: typeID, completion: $0)
        }
    }

    func remove(relationID: String, completion: @escaping (Result<Void, Error>) -> Void) {
        sendOptional({ (result: Result<WorkspaceRelation?, Error>) in completion(result.map { _ in () }) }) {
            self.workspace.removeRelation(projectID: self.projectID, relationID: relationID, completion: $0)
        }
    }

    /// Changes the type and optionally swaps the ends; an unchanged relation writes nothing.
    func retype(relationID: String, typeID: String, swap: Bool, completion: @escaping (Result<WorkspaceRelation, Error>) -> Void) {
        send(completion) {
            self.workspace.retypeRelation(projectID: self.projectID, relationID: relationID, relationTypeID: typeID,
                                          swap: swap, completion: $0)
        }
    }

    private func adopt(_ library: WorkspaceRelationLibrary) {
        self.library = library; loaded = true; loadError = nil
        onLibrary?(library)
        observers.removeAll { $0.owner() == nil }
        for observer in observers { observer.block(library) }
        onChange?()
    }

    private func send<Value: Decodable>(_ completion: @escaping (Result<Value, Error>) -> Void,
                                        _ operation: (@escaping (Result<WorkspaceRelationReply<Value>, Error>) -> Void) -> Void) {
        sendOptional({ (result: Result<Value?, Error>) in
            completion(result.flatMap { $0.map { .success($0) } ?? .failure(LabError.message("关系结果缺失")) })
        }, operation)
    }

    /// Adopts the reply's library before reporting the result, so every
    /// section already shows the stored state when the caller continues.
    private func sendOptional<Value: Decodable>(_ completion: @escaping (Result<Value?, Error>) -> Void,
                                                _ operation: (@escaping (Result<WorkspaceRelationReply<Value>, Error>) -> Void) -> Void) {
        pending += 1; onChange?()
        operation { [weak self] result in
            guard let self else { return }
            self.pending -= 1
            switch result {
            case .success(let reply):
                self.adopt(reply.library)
                completion(.success(reply.result))
            case .failure(let error):
                self.onChange?()
                completion(.failure(error))
            }
        }
    }
}
