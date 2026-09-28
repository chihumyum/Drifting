import Foundation

/// A chapter's or drift's 情节规划格 as Rust stores it: author-named rows
/// and columns in order, the uniform cell size and the non-empty cells. It
/// is beside the prose and never derived from it.
struct WorkspacePlotGrid: Decodable, Equatable {
    struct Axis: Decodable, Equatable {
        let id: String
        var label: String
    }
    struct Cell: Decodable, Equatable {
        let rowId: String
        let columnId: String
        var value: String
    }

    var nodeId: String
    var cellWidth: Double
    var cellHeight: Double
    var rows: [Axis]
    var columns: [Axis]
    /// Non-empty cells only.
    var cells: [Cell]

    /// Rust's limits: cell width and height, and text per cell or header.
    static let widths: ClosedRange<Double> = 120...440
    static let heights: ClosedRange<Double> = 56...380
    static let defaultWidth: Double = 184
    static let defaultHeight: Double = 96
    static let maxText = 10_000

    /// A new node's grid before anything is written: three blank rows and
    /// three blank columns at the default size, as the renderer starts one.
    static func template(nodeID: String) -> WorkspacePlotGrid {
        WorkspacePlotGrid(nodeId: nodeID, cellWidth: defaultWidth, cellHeight: defaultHeight,
                          rows: (0..<3).map { _ in Axis(id: newID(.row), label: "") },
                          columns: (0..<3).map { _ in Axis(id: newID(.column), label: "") }, cells: [])
    }

    /// An identity the host supplies for `addRow`/`addColumn`, so later
    /// operations of the same batch can name it.
    static func newID(_ axis: PlotGridAxis) -> String {
        "plot-\(axis == .row ? "row" : "column")-\(UUID().uuidString.lowercased())"
    }

    func axes(_ axis: PlotGridAxis) -> [Axis] { axis == .row ? rows : columns }
    func index(_ axis: PlotGridAxis, of id: String) -> Int? { axes(axis).firstIndex { $0.id == id } }
    func label(_ axis: PlotGridAxis, _ id: String) -> String? { axes(axis).first { $0.id == id }?.label }

    func value(row: String, column: String) -> String {
        cells.first { $0.rowId == row && $0.columnId == column }?.value ?? ""
    }

    /// How many cells of a row or column hold text.
    func filledCells(_ axis: PlotGridAxis, _ id: String) -> Int {
        cells.filter { (axis == .row ? $0.rowId : $0.columnId) == id && !$0.value.isEmpty }.count
    }

    /// The grid after one operation, as Rust applies it; an operation Rust
    /// would refuse leaves the grid unchanged here and is refused there.
    func applying(_ op: PlotGridOp) -> WorkspacePlotGrid {
        var next = self
        switch op {
        case .setSize(let width, let height):
            next.cellWidth = width; next.cellHeight = height
        case .addAxis(let axis, let id, let label, let after):
            var list = axes(axis)
            guard !list.contains(where: { $0.id == id }) else { return self }
            let at: Int
            if let after { guard let found = list.firstIndex(where: { $0.id == after }) else { return self }; at = found + 1 } else { at = 0 }
            list.insert(Axis(id: id, label: label), at: at)
            next.set(axis, list)
        case .setLabel(let axis, let id, let label):
            var list = axes(axis)
            guard let at = list.firstIndex(where: { $0.id == id }) else { return self }
            list[at].label = label
            next.set(axis, list)
        case .moveAxis(let axis, let id, let after):
            var list = axes(axis)
            guard after != id, let from = list.firstIndex(where: { $0.id == id }) else { return self }
            let moving = list.remove(at: from)
            let at: Int
            if let after { guard let found = list.firstIndex(where: { $0.id == after }) else { return self }; at = found + 1 } else { at = 0 }
            list.insert(moving, at: at)
            next.set(axis, list)
        case .removeAxis(let axis, let id):
            guard index(axis, of: id) != nil else { return self }
            next.set(axis, axes(axis).filter { $0.id != id })
            next.cells.removeAll { (axis == .row ? $0.rowId : $0.columnId) == id }
        case .setCell(let row, let column, let value):
            guard index(.row, of: row) != nil, index(.column, of: column) != nil else { return self }
            next.cells.removeAll { $0.rowId == row && $0.columnId == column }
            if !value.isEmpty { next.cells.append(Cell(rowId: row, columnId: column, value: value)) }
            next.cells.sort { ($0.rowId, $0.columnId) < ($1.rowId, $1.columnId) }
        }
        return next
    }

    private mutating func set(_ axis: PlotGridAxis, _ list: [Axis]) {
        if axis == .row { rows = list } else { columns = list }
    }

    /// The operations that write this grid from nothing: its size when it is
    /// not Rust's default, every row and column in order and every cell.
    var creationOps: [PlotGridOp] {
        var ops: [PlotGridOp] = []
        if cellWidth != Self.defaultWidth || cellHeight != Self.defaultHeight { ops.append(.setSize(width: cellWidth, height: cellHeight)) }
        for axis in [PlotGridAxis.row, .column] {
            var previous: String?
            for item in axes(axis) {
                ops.append(.addAxis(axis, id: item.id, label: item.label, after: previous))
                previous = item.id
            }
        }
        ops += cells.map { .setCell(row: $0.rowId, column: $0.columnId, value: $0.value) }
        return ops
    }
}

struct WorkspacePlotGridReply: Decodable {
    /// Nil before the node's first edit.
    let grid: WorkspacePlotGrid?
    /// Identities Rust generated for additions sent without one.
    let created: [String]
}

enum PlotGridAxis: Equatable {
    case row, column
    var name: String { self == .row ? "行" : "列" }
}

/// One named change of `workspacePlotGrid`. A batch of them is one original.
enum PlotGridOp: Equatable {
    case setSize(width: Double, height: Double)
    /// Placed right after `after`, or first with nil.
    case addAxis(PlotGridAxis, id: String, label: String, after: String?)
    case setLabel(PlotGridAxis, id: String, label: String)
    /// Placed right after `after`, or first with nil.
    case moveAxis(PlotGridAxis, id: String, after: String?)
    /// Removes the row or column and its cells.
    case removeAxis(PlotGridAxis, id: String)
    /// An empty value clears the cell.
    case setCell(row: String, column: String, value: String)

    var payload: [String: Any] {
        func key(_ axis: PlotGridAxis) -> String { axis == .row ? "rowId" : "columnId" }
        func name(_ axis: PlotGridAxis) -> String { axis == .row ? "Row" : "Column" }
        switch self {
        case .setSize(let width, let height): return ["op": "setSize", "width": width, "height": height]
        case .addAxis(let axis, let id, let label, let after):
            var payload: [String: Any] = ["op": "add\(name(axis))", "id": id, "label": label]
            if let after { payload["after"] = after }
            return payload
        case .setLabel(let axis, let id, let label): return ["op": "set\(name(axis))Label", key(axis): id, "label": label]
        case .moveAxis(let axis, let id, let after):
            var payload: [String: Any] = ["op": "move\(name(axis))", key(axis): id]
            if let after { payload["after"] = after }
            return payload
        case .removeAxis(let axis, let id): return ["op": "remove\(name(axis))", key(axis): id]
        case .setCell(let row, let column, let value): return ["op": "setCell", "rowId": row, "columnId": column, "value": value]
        }
    }
}

/// One node's 情节规划格, shared by every dock that shows the page. Each
/// gesture is one `workspacePlotGrid` call with the operations it needs;
/// operations that change nothing are dropped, and a gesture that changes
/// nothing writes nothing. Gestures run one at a time in order; docks show
/// the stored grid with the queued gestures applied. A refusal keeps its
/// Chinese reason in `message`, drops the gestures queued behind it and
/// reads the stored grid again. Before the first edit a blank 3×3 template
/// is shown; the first gesture writes it as it then looks.
final class PlotGridModel {
    let projectID: String
    let nodeID: String
    private let workspace: LabWorkspaceCore
    /// The last grid Rust returned; nil before the node's first edit.
    private(set) var stored: WorkspacePlotGrid?
    private(set) var loaded = false
    /// A refusal or failed read, in Chinese; nil after a command succeeds.
    private(set) var message: String?
    /// Every call sent, in order, for acceptance.
    private(set) var sentBatches: [[PlotGridOp]] = []
    /// The blank template, and what it looks like once a gesture wrote it.
    private let blank: WorkspacePlotGrid
    private var template: WorkspacePlotGrid
    private var queue: [[PlotGridOp]] = []
    private var sending: [PlotGridOp]?
    /// A queued or sent gesture writes the template.
    private var creating = false
    private var reading = false
    private var rereadAfter = false
    private var observers: [(owner: () -> AnyObject?, block: () -> Void)] = []

    init(workspace: LabWorkspaceCore, projectID: String, nodeID: String) {
        self.workspace = workspace
        self.projectID = projectID
        self.nodeID = nodeID
        blank = .template(nodeID: nodeID)
        template = blank
    }

    /// What the docks show: the stored grid (or the template) with every
    /// gesture not yet answered applied.
    var grid: WorkspacePlotGrid {
        ((sending.map { [$0] } ?? []) + queue).joined().reduce(stored ?? template) { $0.applying($1) }
    }
    var busy: Bool { sending != nil || !queue.isEmpty || reading }

    /// Calls `block` after every change while `owner` lives.
    func observe(_ owner: AnyObject, _ block: @escaping () -> Void) {
        observers.append(({ [weak owner] in owner }, block))
    }

    private func changed() {
        observers.removeAll { $0.owner() == nil }
        for observer in observers { observer.block() }
    }

    /// Reads the stored grid. Reads and writes share the workspace queue, so
    /// a read never overtakes a gesture sent before it.
    func load() {
        guard !reading else { rereadAfter = true; return }
        reading = true
        workspace.plotGrid(projectID: projectID, nodeID: nodeID, ops: []) { [weak self] result in
            guard let self else { return }
            self.reading = false
            switch result {
            case .success(let reply):
                self.stored = reply.grid
                self.loaded = true
            case .failure(let error):
                self.message = "情节规划格暂时无法读取：\(error.localizedDescription)"
            }
            self.changed()
            if self.rereadAfter { self.rereadAfter = false; self.load() }
        }
    }

    /// One gesture. Returns false when nothing changes (nothing is sent).
    @discardableResult
    func perform(_ ops: [PlotGridOp]) -> Bool {
        var base = grid, needed: [PlotGridOp] = []
        for op in ops {
            let next = base.applying(op)
            if next != base { needed.append(op); base = next }
        }
        guard !needed.isEmpty else { return false }
        var batch = needed
        if stored == nil, !creating {
            // The template becomes the stored grid as the gesture leaves it.
            batch = base.creationOps
            template = base
            creating = true
        }
        queue.append(batch)
        changed()
        sendNext()
        return true
    }

    private func sendNext() {
        guard sending == nil, !queue.isEmpty else { return }
        let batch = queue.removeFirst()
        sending = batch
        sentBatches.append(batch)
        workspace.plotGrid(projectID: projectID, nodeID: nodeID, ops: batch) { [weak self] result in
            guard let self else { return }
            self.sending = nil
            switch result {
            case .success(let reply):
                self.stored = reply.grid
                self.loaded = true
                self.message = nil
                self.changed()
                self.sendNext()
            case .failure(let error):
                // Rust rolled the whole batch back; later gestures were built on it.
                self.queue.removeAll()
                if self.stored == nil { self.creating = false; self.template = self.blank }
                self.message = error.localizedDescription
                self.changed()
                self.load()
            }
        }
    }
}
