import Foundation
import ImageIO
import UniformTypeIdentifiers

/// An image or PDF copied into the workspace's app-owned asset store.
struct WorkspaceAsset: Decodable, Equatable {
    let id: String
    /// `image` or `pdf`.
    let kind: String
    let mime: String
    let `extension`: String
    let sizeBytes: UInt64
    let width: UInt64?
    let height: UInt64?
}

/// One 素材: an imported image or PDF, a link or a text note, in the
/// library's authored order.
struct WorkspaceMaterialItem: Decodable, Equatable {
    let id: String
    let title: String
    /// `image`, `pdf`, `url` or `text`.
    let kind: String
    let asset: WorkspaceAsset?
    let externalUrl: String?
    /// A text note's body as plain text, one line per paragraph.
    let text: String
    /// The author's notes on any item, as plain text.
    let notes: String
    let orderKey: Int64
    let createdAt: String
    let updatedAt: String
    /// Read-only absolute path of the stored bytes of an image or PDF. Hosts
    /// read it; only Rust writes or removes it. Absent on command results.
    let assetPath: String?

    var hasFile: Bool { kind == "image" || kind == "pdf" }
    var fileURL: URL? { assetPath.map { URL(fileURLWithPath: $0) } }
    var link: URL? { externalUrl.flatMap(URL.init(string:)) }
}

/// An element's portrait: an image asset bound to the element.
struct WorkspaceElementPortrait: Decodable, Equatable {
    let elementId: String
    let asset: WorkspaceAsset
    /// Absent on a `setPortrait` result; present in the library.
    let assetPath: String?
}

struct WorkspaceMaterialLibrary: Decodable, Equatable {
    var items: [WorkspaceMaterialItem]
    /// Portraits of live and trashed elements.
    var portraits: [WorkspaceElementPortrait]

    static let empty = WorkspaceMaterialLibrary(items: [], portraits: [])

    func item(id: String) -> WorkspaceMaterialItem? { items.first { $0.id == id } }
    func portrait(elementID: String) -> WorkspaceElementPortrait? { portraits.first { $0.elementId == elementID } }
}

/// Every library command returns its own result (nil for a read or a
/// deletion) and the complete library after it, so no list is patched locally.
struct WorkspaceMaterialReply<Value: Decodable>: Decodable {
    let result: Value?
    let library: WorkspaceMaterialLibrary
}

/// Present fields are written with one `field.set` each; Rust skips a field
/// equal to the stored value. Only text notes have a body.
struct WorkspaceMaterialChanges: Equatable {
    var title: String?
    var notes: String?
    var body: String?

    var isEmpty: Bool { title == nil && notes == nil && body == nil }
    var fields: [String: Any] {
        var fields: [String: Any] = [:]
        if let title { fields["title"] = title }
        if let notes { fields["notes"] = notes }
        if let body { fields["body"] = body }
        return fields
    }
}

/// A local image or PDF the author chose, described for Rust. The host reads
/// the type and image size; Rust copies the bytes under its size cap.
struct MaterialSourceFile: Equatable {
    let url: URL
    let mime: String
    let fileExtension: String
    let width: Int?
    let height: Int?
    let sizeBytes: UInt64

    static let maximumBytes: UInt64 = 200 * 1024 * 1024

    var isImage: Bool { width != nil }
    var payload: [String: Any] {
        var payload: [String: Any] = ["path": url.path, "mime": mime, "extension": fileExtension]
        if let width, let height { payload["width"] = width; payload["height"] = height }
        return payload
    }

    /// Rust names stored bytes by the MIME type (`source.<ext>`), not by the
    /// extension it was given, so the host passes the same extension.
    static func storedExtension(mime: String) -> String {
        switch mime {
        case "application/pdf": return "pdf"
        case "image/jpeg": return "jpg"
        case "image/svg+xml": return "svg"
        default:
            guard mime.hasPrefix("image/") else { return "bin" }
            let suffix = String(mime.dropFirst("image/".count))
            return !suffix.isEmpty && suffix.unicodeScalars.allSatisfy({ $0.isASCII && CharacterSet.alphanumerics.contains($0) })
                ? suffix : "bin"
        }
    }

    /// Reads the file's type from its content (ImageIO) or extension (UTType)
    /// and an image's displayed pixel size. Refusals are Chinese.
    static func inspect(_ url: URL, imagesOnly: Bool = false) throws -> MaterialSourceFile {
        let name = url.lastPathComponent
        let values = try? url.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey, .contentTypeKey])
        guard values?.isRegularFile == true else {
            throw LabError.message("“\(name)”不是可以导入的文件。")
        }
        let size = UInt64(values?.fileSize ?? 0)
        guard size <= maximumBytes else {
            throw LabError.message("“\(name)”超过 200 MiB 素材上限，无法复制到本地素材库。")
        }
        let declared = values?.contentType ?? UTType(filenameExtension: url.pathExtension)
        if !imagesOnly, declared?.conforms(to: .pdf) == true {
            return MaterialSourceFile(url: url, mime: "application/pdf", fileExtension: "pdf", width: nil, height: nil, sizeBytes: size)
        }
        guard declared?.conforms(to: .image) == true else {
            throw LabError.message(imagesOnly ? "“\(name)”不是图片，肖像只能使用图片。" : "“\(name)”不是图片或 PDF，素材库只能导入图片或 PDF。")
        }
        guard let source = CGImageSourceCreateWithURL(url as CFURL, nil), CGImageSourceGetCount(source) > 0,
              let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let pixelWidth = (properties[kCGImagePropertyPixelWidth] as? NSNumber)?.intValue,
              let pixelHeight = (properties[kCGImagePropertyPixelHeight] as? NSNumber)?.intValue,
              pixelWidth > 0, pixelHeight > 0 else {
            throw LabError.message("无法读取“\(name)”的图片尺寸，这种图片格式暂不支持。")
        }
        // EXIF orientations 5–8 display the image rotated by a quarter turn.
        let orientation = (properties[kCGImagePropertyOrientation] as? NSNumber)?.intValue ?? 1
        let (width, height) = orientation >= 5 ? (pixelHeight, pixelWidth) : (pixelWidth, pixelHeight)
        // The content decides the type; a misnamed file keeps its real MIME.
        let sniffed = (CGImageSourceGetType(source) as String?).flatMap { UTType($0) }
        guard let mime = sniffed?.preferredMIMEType ?? declared?.preferredMIMEType, mime.hasPrefix("image/") else {
            throw LabError.message("无法识别“\(name)”的图片类型。")
        }
        return MaterialSourceFile(url: url, mime: mime, fileExtension: storedExtension(mime: mime),
                                  width: width, height: height, sizeBytes: size)
    }
}

/// Presentation state of one project's 素材库. Rust owns the list, its order
/// and the stored bytes; this model sequences commands and keeps the status.
final class MaterialLibraryModel {
    let projectID: String
    private let workspace: LabWorkspaceCore
    private(set) var library = WorkspaceMaterialLibrary.empty
    private(set) var loaded = false
    private(set) var busy = false
    private(set) var status = "正在读取素材库…"
    /// The 素材库 panel's view; other views (the 备忘与素材 board) observe.
    var onChange: (() -> Void)?
    private var observers: [(owner: () -> AnyObject?, block: () -> Void)] = []
    /// Every successful command's complete library, e.g. for portraits.
    var onLibrary: ((WorkspaceMaterialLibrary) -> Void)?

    init(workspace: LabWorkspaceCore, projectID: String) {
        self.workspace = workspace
        self.projectID = projectID
    }

    var items: [WorkspaceMaterialItem] { library.items }

    /// Calls `block` after every change while `owner` lives, beside `onChange`.
    func observe(_ owner: AnyObject, _ block: @escaping () -> Void) {
        observers.append(({ [weak owner] in owner }, block))
    }

    private func changed() {
        onChange?()
        observers.removeAll { $0.owner() == nil }
        for observer in observers { observer.block() }
    }

    func showStatus(_ message: String) { status = message; changed() }

    func load() {
        guard !busy else { return }
        busy = true; changed()
        workspace.materialLibrary(projectID: projectID) { [weak self] result in
            guard let self else { return }
            self.busy = false
            switch result {
            case .success(let library): self.apply(library, message: nil); self.onLibrary?(library)
            case .failure(let error): self.showStatus(error.localizedDescription)
            }
        }
    }

    /// Adopt a library returned by a command that ran elsewhere, e.g. a
    /// portrait change on an element page.
    func apply(_ library: WorkspaceMaterialLibrary, message: String?) {
        self.library = library; loaded = true
        status = message ?? (library.items.isEmpty
            ? "还没有素材。可以导入图片或 PDF、添加链接或新建笔记，也可以把文件拖到这里。"
            : "\(library.items.count) 个素材 · 双击预览，右键查看更多操作。")
        changed()
    }

    /// Imports files one at a time in the given order. A file that cannot be
    /// read or is refused is named in the status; the others still import.
    func importFiles(_ urls: [URL], completion: (([WorkspaceMaterialItem]) -> Void)? = nil) {
        guard !busy else { showStatus("正在保存素材库，请稍后重试。"); completion?([]); return }
        guard !urls.isEmpty else { completion?([]); return }
        busy = true
        status = urls.count == 1 ? "正在导入“\(urls[0].lastPathComponent)”…" : "正在导入 \(urls.count) 个文件…"
        changed()
        var imported: [WorkspaceMaterialItem] = []
        var refusals: [String] = []
        var remaining = urls[...]
        func next() {
            guard let url = remaining.popFirst() else {
                busy = false
                var parts: [String] = []
                if !imported.isEmpty { parts.append(imported.count == 1 ? "已导入“\(imported[0].title)”。" : "已导入 \(imported.count) 个素材。") }
                parts += refusals
                showStatus(parts.joined(separator: "\n"))
                completion?(imported)
                return
            }
            let file: MaterialSourceFile
            do { file = try MaterialSourceFile.inspect(url) } catch {
                refusals.append(error.localizedDescription); next(); return
            }
            let title = url.deletingPathExtension().lastPathComponent
            workspace.importMaterial(projectID: projectID, title: title, file: file) { [weak self] result in
                guard let self else { return }
                switch result {
                case .success(let reply):
                    self.library = reply.library; self.loaded = true
                    if let item = reply.result { imported.append(item) }
                    self.changed()
                    self.onLibrary?(reply.library)
                case .failure(let error):
                    refusals.append("“\(url.lastPathComponent)”：\(error.localizedDescription)")
                }
                next()
            }
        }
        next()
    }

    /// An address without a scheme is taken as https; Rust accepts http and
    /// https only. An empty title becomes the host name.
    func createLink(title: String, url: String, completion: ((Result<WorkspaceMaterialItem, Error>) -> Void)? = nil) {
        var address = url.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !address.isEmpty else {
            showStatus("请输入链接地址。"); completion?(.failure(LabError.message("请输入链接地址。"))); return
        }
        if !address.contains(":"), address.contains(".") { address = "https://" + address }
        var name = title.trimmingCharacters(in: .whitespacesAndNewlines)
        if name.isEmpty { name = URLComponents(string: address)?.host ?? address }
        mutate(message: "链接已添加。", completion: completion) {
            workspace.createMaterialLink(projectID: projectID, title: name, url: address, completion: $0)
        }
    }

    /// An empty title becomes the body's first line.
    func createText(title: String, body: String, completion: ((Result<WorkspaceMaterialItem, Error>) -> Void)? = nil) {
        var name = title.trimmingCharacters(in: .whitespacesAndNewlines)
        if name.isEmpty {
            let first = body.split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) }.first { !$0.isEmpty }
            name = first.map { String($0.prefix(30)) } ?? "未命名笔记"
        }
        mutate(message: "笔记已保存。", completion: completion) {
            workspace.createMaterialText(projectID: projectID, title: name, body: body, completion: $0)
        }
    }

    /// Unchanged fields are not sent; nothing changed writes nothing.
    func update(itemID: String, changes: WorkspaceMaterialChanges, message: String = "素材已保存。",
                completion: ((Result<WorkspaceMaterialItem, Error>) -> Void)? = nil) {
        guard let item = library.item(id: itemID) else {
            showStatus("这个素材已不可用，请刷新素材库。"); completion?(.failure(LabError.message("这个素材已不可用。"))); return
        }
        var sent = changes
        if let title = sent.title {
            let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty else {
                let refusal = "标题不能为空。"
                showStatus(refusal); completion?(.failure(LabError.message(refusal))); return
            }
            sent.title = trimmed == item.title ? nil : trimmed
        }
        if sent.notes == item.notes { sent.notes = nil }
        if sent.body == item.text { sent.body = nil }
        guard !sent.isEmpty else { completion?(.success(item)); return }
        mutate(message: message, completion: completion) {
            workspace.updateMaterial(projectID: projectID, itemID: itemID, changes: sent, completion: $0)
        }
    }

    /// Places the item before another one, or last with nil. A place it
    /// already has writes nothing; Rust renumbers the order by rank.
    func move(itemID: String, before: String?, completion: ((Result<Void, Error>) -> Void)? = nil) {
        guard let item = library.item(id: itemID) else {
            showStatus("这个素材已不可用，请刷新素材库。"); completion?(.failure(LabError.message("这个素材已不可用。"))); return
        }
        guard !busy else { completion?(.failure(LabError.message("正在保存素材库，请稍后重试。"))); return }
        var order = library.items.map(\.id).filter { $0 != itemID }
        order.insert(itemID, at: before.flatMap { order.firstIndex(of: $0) } ?? order.count)
        guard order != library.items.map(\.id) else { completion?(.success(())); return }
        busy = true; changed()
        workspace.moveMaterial(projectID: projectID, itemID: itemID, beforeItemID: before) { [weak self] result in
            guard let self else { return }
            self.busy = false
            switch result {
            case .success(let reply):
                self.apply(reply.library, message: "“\(item.title)”已移动。")
                self.onLibrary?(reply.library)
                completion?(.success(()))
            case .failure(let error):
                self.showStatus(error.localizedDescription)
                completion?(.failure(error))
            }
        }
    }

    /// Removes the item and, after the commit, its stored bytes.
    func delete(itemID: String, completion: ((Result<Void, Error>) -> Void)? = nil) {
        let title = library.item(id: itemID)?.title ?? "素材"
        guard !busy else { completion?(.failure(LabError.message("正在保存素材库，请稍后重试。"))); return }
        busy = true; changed()
        workspace.deleteMaterial(projectID: projectID, itemID: itemID) { [weak self] result in
            guard let self else { return }
            self.busy = false
            switch result {
            case .success(let reply):
                self.apply(reply.library, message: "“\(title)”已删除。")
                self.onLibrary?(reply.library)
                completion?(.success(()))
            case .failure(let error):
                self.showStatus(error.localizedDescription)
                completion?(.failure(error))
            }
        }
    }

    private func mutate(message: String, completion: ((Result<WorkspaceMaterialItem, Error>) -> Void)?,
                        operation: (@escaping (Result<WorkspaceMaterialReply<WorkspaceMaterialItem>, Error>) -> Void) -> Void) {
        guard !busy else {
            completion?(.failure(LabError.message("正在保存素材库，请稍后重试。"))); return
        }
        busy = true; changed()
        operation { [weak self] result in
            guard let self else { return }
            self.busy = false
            switch result {
            case .success(let reply):
                self.apply(reply.library, message: message)
                self.onLibrary?(reply.library)
                if let value = reply.result { completion?(.success(value)) }
                else { completion?(.failure(LabError.message("素材库结果缺失"))) }
            case .failure(let error):
                self.showStatus(error.localizedDescription)
                completion?(.failure(error))
            }
        }
    }
}
