import Foundation
import CoreGraphics

/// Geometry of the 设定总览 canvas in world points, before pan and zoom. The
/// renderer's metrics: one element card per 96 × 56 cell, chapter pills of
/// 110 on a 120 slot, a 16-point group header and a 12-point gap between
/// neighbouring category boxes.
enum ElementOverviewMetrics {
    static let cellWidth: CGFloat = 96
    static let cellHeight: CGFloat = 56
    static let pillWidth: CGFloat = 110
    static let slot: CGFloat = 120
    static let groupHeader: CGFloat = 16
    static let paddingTop: CGFloat = 8
    static let paddingBottom: CGFloat = 4
    static let gapX: CGFloat = cellWidth / 8
    static let zoomRange: ClosedRange<CGFloat> = 0.4...2.0
    /// Half of the renderer's quarter-cell band padding, above and below the lanes.
    static let bandPadding: CGFloat = cellHeight * 0.25 / 2
    /// The act strip above the lanes, when the book has acts.
    static let actStrip: CGFloat = 22
    /// Lane names sit in a gutter at the band's leading edge.
    static let laneGutter: CGFloat = 104
    static let bandTrailing: CGFloat = 12
    static let driftCard = CGSize(width: 150, height: 50)
    static let driftGap: CGFloat = 12
    static let driftsPerRow = 8
    /// Breathing room around everything when fitting the view.
    static let margin: CGFloat = 3

    /// The column pitch of cards inside a box `widthCells` wide: the box's
    /// visible width shared by its columns.
    static func columnStep(widthCells: Int) -> CGFloat {
        (CGFloat(widthCells) * cellWidth - gapX) / CGFloat(max(1, widthCells))
    }
}

/// A grid cell; `y` is negative above the chapter band.
struct ElementOverviewCell: Hashable {
    var x: Int
    var y: Int
}

/// The renderer's double-sided skyline packer (`solveSuperElementLayout`):
/// category boxes above (negative rows) and below the band, which occupies
/// rows `0..<bandCells`. Pinned boxes are placed as stored (a box crossing the
/// band snaps to the nearer side) and become obstacles; automatic boxes are
/// packed largest first around them, each on the side that keeps it lowest
/// while balancing the area above and below the band.
enum ElementOverviewSolver {
    enum Side: String, Equatable { case top, bottom }

    struct Input: Equatable {
        let id: String
        let widthCells: Int
        let heightCells: Int
        let pinned: ElementOverviewCell?
    }

    struct Placement: Equatable {
        let id: String
        let cell: ElementOverviewCell
        let side: Side
        let pinned: Bool
    }

    struct Result: Equatable {
        /// In input order.
        let placements: [Placement]
        let minX: Int, maxX: Int, minY: Int, maxY: Int

        func placement(id: String) -> Placement? { placements.first { $0.id == id } }
    }

    /// Sparse skyline: how many cells are taken at each column on one side.
    private struct Skyline {
        var heights: [Int: Int] = [:]
        func peak(_ x: Int, _ width: Int) -> Int {
            var peak = 0
            for dx in 0..<width { peak = max(peak, heights[x + dx] ?? 0) }
            return peak
        }
        mutating func occupy(_ x: Int, _ width: Int, _ height: Int) {
            for dx in 0..<width where height > heights[x + dx] ?? 0 { heights[x + dx] = height }
        }
    }

    /// The lowest slot for a box `width` wide, nearest the anchor on ties;
    /// the search is centred so the box's middle lands near the anchor.
    private static func bestSlot(_ skyline: Skyline, width: Int, anchorX: Int, searchExtent: Int) -> (x: Int, lift: Int) {
        let centre = anchorX - width / 2
        var best = (x: centre, lift: Int.max, distance: Int.max)
        for x in (centre - searchExtent)...(centre + searchExtent) {
            let lift = skyline.peak(x, width), distance = abs(x - centre)
            if lift < best.lift || (lift == best.lift && distance < best.distance) { best = (x, lift, distance) }
        }
        return (best.x, best.lift)
    }

    /// A pinned row that would cross the band snaps to the nearer side:
    /// just above it (bottom row at -1) or just below it.
    static func clamp(row: Int, heightCells: Int, bandCells: Int) -> (row: Int, side: Side) {
        if row + heightCells > 0 && row < bandCells {
            return Double(row) < Double(bandCells) / 2 ? (-heightCells, .top) : (bandCells, .bottom)
        }
        return (row, row < 0 ? .top : .bottom)
    }

    static func solve(_ inputs: [Input], bandCells: Int, anchorX: Int = 0, searchExtent: Int = 96,
                      balance: Double = 1) -> Result {
        var top = Skyline(), bottom = Skyline()
        var topArea = 0, bottomArea = 0
        var placed: [String: Placement] = [:]
        for input in inputs {
            guard let pin = input.pinned else { continue }
            let (row, side) = clamp(row: pin.y, heightCells: input.heightCells, bandCells: bandCells)
            placed[input.id] = Placement(id: input.id, cell: ElementOverviewCell(x: pin.x, y: row), side: side, pinned: true)
            let area = input.widthCells * input.heightCells
            // A pinned box claims its columns from the band out to its far
            // edge; a gap it leaves is the author's choice.
            if side == .top {
                top.occupy(pin.x, input.widthCells, abs(row)); topArea += area
            } else {
                bottom.occupy(pin.x, input.widthCells, row + input.heightCells - bandCells); bottomArea += area
            }
        }
        // First-fit decreasing, ties by identity so the layout is stable.
        let automatic = inputs.filter { $0.pinned == nil }.sorted { left, right in
            let (a, b) = (left.widthCells * left.heightCells, right.widthCells * right.heightCells)
            return a != b ? a > b : left.id < right.id
        }
        for input in automatic {
            let (w, h) = (input.widthCells, input.heightCells)
            let area = w * h
            let above = bestSlot(top, width: w, anchorX: anchorX, searchExtent: searchExtent)
            let below = bestSlot(bottom, width: w, anchorX: anchorX, searchExtent: searchExtent)
            let topScore = Double(above.lift + h) + balance * Double(max(0, topArea + area - bottomArea)).squareRoot()
            let bottomScore = Double(below.lift + h) + balance * Double(max(0, bottomArea + area - topArea)).squareRoot()
            if topScore < bottomScore || (topScore == bottomScore && topArea <= bottomArea) {
                placed[input.id] = Placement(id: input.id, cell: ElementOverviewCell(x: above.x, y: -(above.lift + h)), side: .top, pinned: false)
                top.occupy(above.x, w, above.lift + h); topArea += area
            } else {
                placed[input.id] = Placement(id: input.id, cell: ElementOverviewCell(x: below.x, y: bandCells + below.lift),
                                             side: .bottom, pinned: false)
                bottom.occupy(below.x, w, below.lift + h); bottomArea += area
            }
        }
        let placements = inputs.compactMap { placed[$0.id] }
        var minX = Int.max, maxX = Int.min, minY = 0, maxY = bandCells
        for (placement, input) in zip(placements, inputs.filter { placed[$0.id] != nil }) {
            minX = min(minX, placement.cell.x); maxX = max(maxX, placement.cell.x + input.widthCells)
            minY = min(minY, placement.cell.y); maxY = max(maxY, placement.cell.y + input.heightCells)
        }
        if placements.isEmpty { minX = 0; maxX = 0 }
        return Result(placements: placements, minX: minX, maxX: maxX, minY: minY, maxY: maxY)
    }
}

/// One category's box (`buildSuperElementCategoryModel`): elements grouped by
/// group name (named groups sorted, the ungrouped last), a width of √n cells
/// clamped to 1…6 (at least 2 with several groups), a header strip per named
/// group when there are several groups, and a height rounded up to whole
/// cells. An empty category is a 2 × 1 placeholder. Elements without a live
/// category share the 未分类 box, which cannot be pinned.
struct ElementOverviewBox: Equatable {
    static let uncategorized = "__uncategorized__"

    struct Group: Equatable {
        let name: String?
        let elements: [WorkspaceElement]
        let cardRowsTop: CGFloat
        let cardRows: Int
        /// Nil when the group has no header strip.
        let headerTop: CGFloat?
    }

    let key: String
    /// Nil for 未分类.
    let category: WorkspaceElementCategory?
    let groups: [Group]
    let widthCells: Int
    let heightCells: Int
    let contentHeight: CGFloat
    let count: Int

    var name: String { category?.name ?? "未分类" }

    init(key: String, category: WorkspaceElementCategory?, elements: [WorkspaceElement]) {
        typealias M = ElementOverviewMetrics
        self.key = key
        self.category = category
        count = elements.count
        var buckets: [String?: [WorkspaceElement]] = [:]
        var order: [String?] = []
        for element in elements {
            let name = element.groupName?.trimmingCharacters(in: .whitespacesAndNewlines)
            let key = name?.isEmpty == false ? name : nil
            if buckets[key] == nil { order.append(key) }
            buckets[key, default: []].append(element)
        }
        let named = order.compactMap { $0 }.sorted { $0.localizedStandardCompare($1) == .orderedAscending }
        let ordered: [(String?, [WorkspaceElement])] = named.map { ($0, buckets[$0] ?? []) }
            + (buckets[nil].map { [(nil, $0)] } ?? [])
        guard !elements.isEmpty else {
            groups = []; widthCells = 2; heightCells = 1; contentHeight = M.cellHeight
            return
        }
        let width = max(ordered.count > 1 ? 2 : 1, min(6, Int(Double(elements.count).squareRoot().rounded(.up))))
        let headers = ordered.count > 1
        var cursor = M.paddingTop
        var groups: [Group] = []
        for (index, (name, members)) in ordered.enumerated() {
            var headerTop: CGFloat?
            if headers, name != nil {
                headerTop = cursor
                cursor += M.groupHeader
            } else if headers, index > 0 {
                cursor += 6
            }
            let rows = max(1, (members.count + width - 1) / width)
            groups.append(Group(name: name, elements: members, cardRowsTop: cursor, cardRows: rows, headerTop: headerTop))
            cursor += CGFloat(rows) * M.cellHeight
        }
        self.groups = groups
        widthCells = width
        contentHeight = cursor + M.paddingBottom
        heightCells = max(1, Int((contentHeight / M.cellHeight).rounded(.up)))
    }
}

/// A category's stored placement on the overview grid.
struct WorkspaceCategoryLayout: Decodable, Equatable {
    let categoryId: String
    /// `auto` or `pinned`.
    let layoutMode: String
    let gridX: Int?
    let gridY: Int?

    var cell: ElementOverviewCell? {
        guard layoutMode == "pinned", let gridX, let gridY else { return nil }
        return ElementOverviewCell(x: gridX, y: gridY)
    }
}

/// Everything the 设定总览 draws, in world points: category boxes with their
/// element cards, the chapter band (act strip, storyline lanes and chapter
/// pills in book order), unbound drift cards when shown, and relation edges
/// with at least one element end. Pure; built from Rust's replies.
struct ElementOverviewScene {
    typealias M = ElementOverviewMetrics

    struct Input {
        var library = WorkspaceElementLibrary.empty
        var layouts: [String: WorkspaceCategoryLayout] = [:]
        var book = BookLayout.empty
        var storylines = WorkspaceStorylineLibrary.empty
        var nodes: [String: WorkspaceNodeMetadata] = [:]
        var relations = WorkspaceRelationLibrary.empty
        /// Drifts shown in the 漂流 row; empty while it is hidden.
        var drifts: [WorkspaceDrift] = []
    }

    enum Kind: Equatable { case element, chapter, drift }

    struct Card: Equatable {
        let kind: Kind
        let id: String
        /// World frame; element cards also have a frame inside their box.
        let frame: CGRect
        let title: String
        let detail: String
        /// The box's, lane's or nothing's colour.
        let colorHex: String?
        let dimmed: Bool
        /// The box an element card sits in.
        let boxKey: String?
        var endpoint: RelationEndpoint { RelationEndpoint(kind: kind == .element ? "element" : "node", id: id) }
        var key: String { endpoint.key }
    }

    struct Box: Equatable {
        let model: ElementOverviewBox
        let placement: ElementOverviewSolver.Placement
        /// The visible box: its cells less half the gap on either side.
        let frame: CGRect
        var key: String { model.key }
        var pinned: Bool { placement.pinned }
        /// Where the legend straddles the top border.
        var legendFrame: CGRect {
            CGRect(x: frame.minX + 6, y: frame.minY - 10, width: min(frame.width - 12, 220), height: 20)
        }
        /// Group headers in world points.
        var headers: [(title: String, frame: CGRect)] {
            model.groups.compactMap { group in
                guard let top = group.headerTop, let name = group.name else { return nil }
                return (name, CGRect(x: frame.minX + 6, y: frame.minY + top, width: frame.width - 12, height: M.groupHeader))
            }
        }
    }

    struct Lane: Equatable {
        /// Nil for 未归属 (本书 while there are no storylines).
        let storylineID: String?
        let name: String
        let colorHex: String?
        let frame: CGRect
        let count: Int
    }

    struct ActSpan: Equatable {
        let id: String
        let title: String
        let colorHex: String
        let frame: CGRect
        let count: Int
    }

    /// A dashed connector between two pills of one storyline that is not the
    /// primary of both (`SuperElementChapterBand` transits).
    struct Transit: Equatable {
        let colorHex: String?
        let from: CGPoint
        let to: CGPoint
    }

    struct Edge: Equatable {
        let relation: WorkspaceRelation
        let type: WorkspaceRelationType?
        let from: CGPoint
        let control1: CGPoint
        let control2: CGPoint
        let to: CGPoint
        let directed: Bool
        let colorHex: String
        let fromName: String
        let toName: String
        var id: String { relation.id }

        func point(at t: CGFloat) -> CGPoint {
            let u = 1 - t
            let a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t
            return CGPoint(x: a * from.x + b * control1.x + c * control2.x + d * to.x,
                           y: a * from.y + b * control1.y + c * control2.y + d * to.y)
        }

        var midpoint: CGPoint { point(at: 0.5) }

        /// The distance from a point to the curve, sampled as 24 segments.
        func distance(to point: CGPoint) -> CGFloat {
            var best = CGFloat.greatestFiniteMagnitude
            var previous = from
            for step in 1...24 {
                let next = self.point(at: CGFloat(step) / 24)
                best = min(best, Self.segmentDistance(point, previous, next))
                previous = next
            }
            return best
        }

        private static func segmentDistance(_ p: CGPoint, _ a: CGPoint, _ b: CGPoint) -> CGFloat {
            let dx = b.x - a.x, dy = b.y - a.y
            let length = dx * dx + dy * dy
            let t = length > 0 ? max(0, min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / length)) : 0
            return hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy))
        }

        /// The arrowhead's two barbs at the end of a directed edge.
        var arrowBarbs: (CGPoint, CGPoint)? {
            guard directed else { return nil }
            let angle = atan2(to.y - control2.y, to.x - control2.x)
            let size: CGFloat = 7, spread: CGFloat = .pi / 7
            return (CGPoint(x: to.x - size * cos(angle - spread), y: to.y - size * sin(angle - spread)),
                    CGPoint(x: to.x - size * cos(angle + spread), y: to.y - size * sin(angle + spread)))
        }
    }

    let boxes: [Box]
    let cards: [Card]
    let lanes: [Lane]
    let acts: [ActSpan]
    let transits: [Transit]
    let edges: [Edge]
    /// The visible band.
    let bandFrame: CGRect
    /// Rows the band reserves on the grid, including the gap on both sides.
    let bandCells: Int
    /// The 漂流 row, when shown.
    let driftArea: CGRect?
    /// Everything, with a margin.
    let bounds: CGRect
    let solution: ElementOverviewSolver.Result
    /// Seconds the solver took for this scene.
    let solverSeconds: Double
    private let cardIndex: [String: Int]
    private let boxIndex: [String: Int]

    static let empty = ElementOverviewScene(input: Input())

    func card(_ endpoint: RelationEndpoint) -> Card? { cardIndex[endpoint.key].map { cards[$0] } }
    func box(_ key: String) -> Box? { boxIndex[key].map { boxes[$0] } }
    func edge(_ id: String) -> Edge? { edges.first { $0.id == id } }

    // MARK: Building

    init(input: Input) {
        let library = input.library
        // Boxes: live categories in library order, then 未分类 for elements
        // without a live category.
        let live = Set(library.categories.map(\.id))
        var members: [String: [WorkspaceElement]] = [:]
        var orphans: [WorkspaceElement] = []
        for element in library.elements {
            if let id = element.categoryId, live.contains(id) { members[id, default: []].append(element) }
            else { orphans.append(element) }
        }
        var models = library.categories.map { ElementOverviewBox(key: $0.id, category: $0, elements: members[$0.id] ?? []) }
        if !orphans.isEmpty { models.append(ElementOverviewBox(key: ElementOverviewBox.uncategorized, category: nil, elements: orphans)) }

        // Band geometry: the act strip, one lane per storyline in authored
        // order, then 未归属 (本书 without storylines) when a chapter has no
        // primary, centred on x = 0.
        let book = input.book
        let storylines = input.storylines
        var laneChapters: [String?: [String]] = [:]
        for chapter in book.chapters {
            laneChapters[storylines.primary(chapterID: chapter.id)?.id, default: []].append(chapter.id)
        }
        var laneSpecs: [(id: String?, name: String, color: String?)] = storylines.storylines.map { ($0.id, $0.name, $0.color) }
        if storylines.storylines.isEmpty || laneChapters[nil]?.isEmpty == false {
            laneSpecs.append((nil, storylines.storylines.isEmpty ? "本书" : "未归属", nil))
        }
        let hasActs = book.chapters.contains { $0.actID != nil }
        let strip = hasActs ? M.actStrip : 0
        let bandHeight = strip + CGFloat(laneSpecs.count) * M.cellHeight + 2 * M.bandPadding
        let bandCells = Int((bandHeight / M.cellHeight).rounded(.up)) + 1
        let slots = max(book.chapters.count, 4)
        let bandWidth = M.laneGutter + CGFloat(slots) * M.slot + M.bandTrailing
        let bandFrame = CGRect(x: -bandWidth / 2, y: (CGFloat(bandCells) * M.cellHeight - bandHeight) / 2,
                               width: bandWidth, height: bandHeight)
        self.bandFrame = bandFrame
        self.bandCells = bandCells

        // Solve.
        let started = Date()
        let solution = ElementOverviewSolver.solve(models.map { model in
            ElementOverviewSolver.Input(id: model.key, widthCells: model.widthCells, heightCells: model.heightCells,
                                        pinned: model.category == nil ? nil : input.layouts[model.key]?.cell)
        }, bandCells: bandCells)
        solverSeconds = Date().timeIntervalSince(started)
        self.solution = solution

        var cards: [Card] = []
        var boxes: [Box] = []
        for (model, placement) in zip(models, solution.placements) {
            let frame = CGRect(x: CGFloat(placement.cell.x) * M.cellWidth + M.gapX / 2, y: CGFloat(placement.cell.y) * M.cellHeight,
                               width: CGFloat(model.widthCells) * M.cellWidth - M.gapX, height: CGFloat(model.heightCells) * M.cellHeight)
            boxes.append(Box(model: model, placement: placement, frame: frame))
            let step = M.columnStep(widthCells: model.widthCells)
            for group in model.groups {
                for (index, element) in group.elements.enumerated() {
                    let column = index % model.widthCells, row = index / model.widthCells
                    let card = CGRect(x: frame.minX + CGFloat(column) * step + 3, y: frame.minY + group.cardRowsTop + CGFloat(row) * M.cellHeight + 3,
                                      width: step - 6, height: M.cellHeight - 6)
                    cards.append(Card(kind: .element, id: element.id, frame: card, title: element.name.isEmpty ? "未命名设定" : element.name,
                                      detail: element.summary, colorHex: model.category?.color, dimmed: false, boxKey: model.key))
                }
            }
        }

        // Lanes, acts, pills and transits.
        var lanes: [Lane] = []
        var laneIndex: [String?: Int] = [:]
        let lanesTop = bandFrame.minY + M.bandPadding + strip
        for (index, spec) in laneSpecs.enumerated() {
            laneIndex[spec.id] = index
            lanes.append(Lane(storylineID: spec.id, name: spec.name, colorHex: spec.color,
                              frame: CGRect(x: bandFrame.minX, y: lanesTop + CGFloat(index) * M.cellHeight, width: bandWidth, height: M.cellHeight),
                              count: laneChapters[spec.id]?.count ?? 0))
        }
        let slotLeft = bandFrame.minX + M.laneGutter
        func slotRect(_ index: Int) -> CGRect { CGRect(x: slotLeft + CGFloat(index) * M.slot, y: 0, width: M.slot, height: 0) }
        var pillCentre: [String: CGPoint] = [:]
        for (index, chapter) in book.chapters.enumerated() {
            let primary = storylines.primary(chapterID: chapter.id)
            let lane = laneIndex[primary?.id] ?? laneIndex[nil] ?? 0
            let x = slotRect(index).minX + (M.slot - M.pillWidth) / 2
            let frame = CGRect(x: x, y: lanesTop + CGFloat(lane) * M.cellHeight + 3, width: M.pillWidth, height: M.cellHeight - 6)
            let metadata = input.nodes[chapter.id]
            let status = metadata?.writingStatus ?? chapter.writingStatus
            cards.append(Card(kind: .chapter, id: chapter.id, frame: frame, title: chapter.title.isEmpty ? "未命名章节" : chapter.title,
                              detail: metadata?.summary ?? "", colorHex: primary?.color, dimmed: status == WritingStatus.discarded.rawValue,
                              boxKey: nil))
            pillCentre[chapter.id] = CGPoint(x: frame.midX, y: frame.midY)
        }
        var acts: [ActSpan] = []
        if hasActs {
            for act in book.acts where !act.chapterIDs.isEmpty {
                let indices = act.chapterIDs.compactMap { id in book.chapters.firstIndex { $0.id == id } }
                guard let first = indices.min(), let last = indices.max() else { continue }
                acts.append(ActSpan(id: act.id, title: act.title.isEmpty ? "未命名幕" : act.title, colorHex: act.hex,
                                    frame: CGRect(x: slotRect(first).minX + 2, y: bandFrame.minY + M.bandPadding,
                                                  width: CGFloat(last - first + 1) * M.slot - 4, height: M.actStrip - 4),
                                    count: act.chapterIDs.count))
            }
        }
        var transits: [Transit] = []
        for storyline in storylines.storylines {
            let lane = storylines.chapters(storylineID: storyline.id).map(\.chapterId).filter { pillCentre[$0] != nil }
            for (a, b) in zip(lane, lane.dropFirst()) {
                let primaries = (storylines.membership(chapterID: a)?.primary, storylines.membership(chapterID: b)?.primary)
                guard primaries.0 != storyline.id || primaries.1 != storyline.id, let from = pillCentre[a], let to = pillCentre[b] else { continue }
                transits.append(Transit(colorHex: storyline.color, from: from, to: to))
            }
        }

        // The 漂流 row, below everything else.
        var driftArea: CGRect?
        if !input.drifts.isEmpty {
            let columns = min(M.driftsPerRow, input.drifts.count)
            let rows = (input.drifts.count + M.driftsPerRow - 1) / M.driftsPerRow
            let width = CGFloat(columns) * (M.driftCard.width + M.driftGap) + M.driftGap
            let height = CGFloat(rows) * (M.driftCard.height + M.driftGap) + M.driftGap + 22
            let top = CGFloat(solution.maxY + 1) * M.cellHeight
            let area = CGRect(x: -width / 2, y: top, width: width, height: height)
            driftArea = area
            for (index, drift) in input.drifts.enumerated() {
                let column = index % M.driftsPerRow, row = index / M.driftsPerRow
                let frame = CGRect(x: area.minX + M.driftGap + CGFloat(column) * (M.driftCard.width + M.driftGap),
                                   y: area.minY + 22 + CGFloat(row) * (M.driftCard.height + M.driftGap),
                                   width: M.driftCard.width, height: M.driftCard.height)
                let metadata = input.nodes[drift.id]
                cards.append(Card(kind: .drift, id: drift.id, frame: frame, title: drift.title.isEmpty ? "未命名漂流" : drift.title,
                                  detail: metadata?.summary ?? drift.summary, colorHex: nil,
                                  dimmed: metadata?.writingStatus == WritingStatus.resting.rawValue, boxKey: nil))
            }
        }

        let cardIndex = Dictionary(cards.enumerated().map { ($1.key, $0) }, uniquingKeysWith: { first, _ in first })

        // Edges: every relation with an element end whose other end is shown.
        var edges: [Edge] = []
        for relation in input.relations.relations {
            guard relation.fromKind == "element" || relation.toKind == "element",
                  let from = cardIndex[relation.from.key].map({ cards[$0] }), let to = cardIndex[relation.to.key].map({ cards[$0] }) else { continue }
            let type = input.relations.type(id: relation.relationTypeId)
            let directed = type.map { !$0.isSymmetric } ?? false
            edges.append(Self.edge(relation, type: type, from: from, to: to, directed: directed))
        }

        var bounds = bandFrame
        for box in boxes { bounds = bounds.union(box.frame) }
        if let driftArea { bounds = bounds.union(driftArea) }
        bounds = bounds.insetBy(dx: -M.margin * M.cellWidth, dy: -M.margin * M.cellHeight)

        self.boxes = boxes
        self.cards = cards
        self.lanes = lanes
        self.acts = acts
        self.transits = transits
        self.edges = edges
        self.driftArea = driftArea
        self.bounds = bounds
        self.cardIndex = cardIndex
        boxIndex = Dictionary(boxes.enumerated().map { ($1.key, $0) }, uniquingKeysWith: { first, _ in first })
    }

    /// `relationEdgePath`: an S-curve between the card centres; a directed
    /// edge stops short of its target along the dominant axis so the arrow
    /// meets the card's side.
    private static func edge(_ relation: WorkspaceRelation, type: WorkspaceRelationType?, from: Card, to: Card, directed: Bool) -> Edge {
        let start = CGPoint(x: from.frame.midX, y: from.frame.midY)
        var end = CGPoint(x: to.frame.midX, y: to.frame.midY)
        let dx = end.x - start.x, dy = end.y - start.y
        let c1: CGPoint, c2: CGPoint
        if !directed {
            let midY = (start.y + end.y) / 2
            c1 = CGPoint(x: start.x, y: midY); c2 = CGPoint(x: end.x, y: midY)
        } else if abs(dx) >= abs(dy) {
            end.x -= (dx < 0 ? -1 : 1) * (to.frame.width / 2 + 6)
            let midX = (start.x + end.x) / 2
            c1 = CGPoint(x: midX, y: start.y); c2 = CGPoint(x: midX, y: end.y)
        } else {
            end.y -= (dy < 0 ? -1 : 1) * (to.frame.height / 2 + 6)
            let midY = (start.y + end.y) / 2
            c1 = CGPoint(x: start.x, y: midY); c2 = CGPoint(x: end.x, y: midY)
        }
        return Edge(relation: relation, type: type, from: start, control1: c1, control2: c2, to: end, directed: directed,
                    colorHex: RelationPalette.color(typeID: relation.relationTypeId), fromName: from.title, toName: to.title)
    }

    // MARK: Hit testing

    enum Hit: Equatable {
        case legend(String)
        case card(Kind, String)
        case edge(String)
        case box(String)
        case band
        case empty
    }

    /// What lies under a world point: a legend, then cards, then an edge
    /// within `tolerance`, then a box's empty area, then the band.
    func hit(_ point: CGPoint, tolerance: CGFloat) -> Hit {
        for box in boxes.reversed() where box.legendFrame.contains(point) { return .legend(box.key) }
        for card in cards.reversed() where card.frame.contains(point) { return .card(card.kind, card.id) }
        var nearest: (id: String, distance: CGFloat)?
        for edge in edges {
            let distance = edge.distance(to: point)
            if distance <= tolerance, distance < nearest?.distance ?? .greatestFiniteMagnitude { nearest = (edge.id, distance) }
        }
        if let nearest { return .edge(nearest.id) }
        for box in boxes.reversed() where box.frame.contains(point) { return .box(box.key) }
        if bandFrame.contains(point) { return .band }
        return .empty
    }

    // MARK: Dropping a box

    /// The cell a box whose visible frame now starts at `origin` lands on,
    /// with a band crossing snapped to the nearer side as the solver does.
    func dropCell(key: String, origin: CGPoint) -> ElementOverviewCell? {
        guard let box = box(key), box.model.category != nil else { return nil }
        let x = Int(((origin.x - M.gapX / 2) / M.cellWidth).rounded())
        let row = Int((origin.y / M.cellHeight).rounded())
        return ElementOverviewCell(x: x, y: ElementOverviewSolver.clamp(row: row, heightCells: box.model.heightCells, bandCells: bandCells).row)
    }
}

/// A relation type's colour, stable across views: the renderer's
/// `defaultRelationTypeColor` hash over its story hues and a neutral ink.
enum RelationPalette {
    static let colors = BookPalette.acts + ["#8A8A8A"]

    static func color(typeID: String) -> String {
        var hash: Int32 = 5381
        for unit in typeID.utf16 {
            let sum = Int64(hash &<< 5) + Int64(hash)
            hash = Int32(truncatingIfNeeded: sum) ^ Int32(unit)
        }
        return colors[Int(abs(Int64(hash)) % Int64(colors.count))]
    }
}
