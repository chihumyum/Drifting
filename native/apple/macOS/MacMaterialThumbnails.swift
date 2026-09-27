import AppKit
import ImageIO
import PDFKit
import UniformTypeIdentifiers

/// Downsampled previews of stored images and PDF first pages. Files are read
/// off the main thread; results are cached by path and size. Stored bytes
/// are immutable (a replaced portrait is a new asset), so paths never go stale.
final class MaterialThumbnails {
    static let shared = MaterialThumbnails()
    private let cache = NSCache<NSString, NSImage>()
    private let queue: OperationQueue = {
        let queue = OperationQueue()
        queue.name = "cc.drifting.native-lab.thumbnails"
        queue.maxConcurrentOperationCount = 2
        queue.qualityOfService = .userInitiated
        return queue
    }()
    /// Callers waiting for the same key; main thread only.
    private var waiting: [String: [(NSImage?) -> Void]] = [:]

    private static func key(_ path: String, _ pixels: Int) -> String { "\(pixels)@\(path)" }

    func cached(path: String, side: CGFloat) -> NSImage? {
        cache.object(forKey: Self.key(path, Self.pixels(side)) as NSString)
    }

    /// Completion runs on the main thread with nil when the file cannot be read.
    func load(path: String, kind: String, side: CGFloat, completion: @escaping (NSImage?) -> Void) {
        precondition(Thread.isMainThread)
        let pixels = Self.pixels(side), key = Self.key(path, pixels)
        if let image = cache.object(forKey: key as NSString) { completion(image); return }
        if waiting[key] != nil { waiting[key]?.append(completion); return }
        waiting[key] = [completion]
        queue.addOperation { [weak self] in
            let image = Self.render(path: path, kind: kind, pixels: pixels)
            DispatchQueue.main.async {
                guard let self else { return }
                if let image { self.cache.setObject(image, forKey: key as NSString) }
                for done in self.waiting.removeValue(forKey: key) ?? [] { done(image) }
            }
        }
    }

    private static func pixels(_ side: CGFloat) -> Int { Int((side * 2).rounded(.up)) }

    /// ImageIO decodes only a thumbnail of the requested size; PDFKit draws
    /// the first page. Runs on the thumbnail queue.
    static func render(path: String, kind: String, pixels: Int) -> NSImage? {
        let url = URL(fileURLWithPath: path)
        if kind == "pdf" {
            // The page draws only while its document is alive.
            guard let document = PDFDocument(url: url), let page = document.page(at: 0) else { return nil }
            let bounds = page.bounds(for: .cropBox)
            guard bounds.width > 0, bounds.height > 0 else { return nil }
            let scale = CGFloat(pixels) / max(bounds.width, bounds.height)
            return withExtendedLifetime(document) {
                page.thumbnail(of: NSSize(width: bounds.width * scale, height: bounds.height * scale), for: .cropBox)
            }
        }
        guard let source = CGImageSourceCreateWithURL(url as CFURL, [kCGImageSourceShouldCache: false] as CFDictionary) else { return nil }
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceShouldCacheImmediately: true,
            kCGImageSourceThumbnailMaxPixelSize: pixels,
        ]
        guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else { return nil }
        return NSImage(cgImage: image, size: NSSize(width: image.width, height: image.height))
    }

    /// File URLs on a pasteboard, e.g. a drop from Finder.
    static func fileURLs(on pasteboard: NSPasteboard) -> [URL] {
        (pasteboard.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL]) ?? []
    }

    static func conforms(_ url: URL, to types: [UTType]) -> Bool {
        guard let type = (try? url.resourceValues(forKeys: [.contentTypeKey]))?.contentType
                ?? UTType(filenameExtension: url.pathExtension) else { return false }
        return types.contains { type.conforms(to: $0) }
    }
}

/// A rounded preview well on a soft wash: an image once loaded, otherwise a
/// symbol or initial. No edge accents.
final class MaterialPreviewWell: NSView {
    let imageView = NSImageView()
    private let placeholder = NSTextField(labelWithString: "")
    /// The path whose thumbnail is shown, once it has loaded.
    private(set) var loadedPath: String?
    private var requestedPath: String?
    var isHighlighted = false { didSet { needsDisplay = true } }

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        imageView.imageScaling = .scaleProportionallyUpOrDown
        imageView.translatesAutoresizingMaskIntoConstraints = false
        imageView.wantsLayer = true
        imageView.layer?.cornerRadius = 6
        imageView.layer?.masksToBounds = true
        placeholder.alignment = .center
        placeholder.textColor = .secondaryLabelColor
        placeholder.font = .systemFont(ofSize: 22, weight: .medium)
        placeholder.translatesAutoresizingMaskIntoConstraints = false
        addSubview(imageView); addSubview(placeholder)
        NSLayoutConstraint.activate([
            imageView.leadingAnchor.constraint(equalTo: leadingAnchor), imageView.trailingAnchor.constraint(equalTo: trailingAnchor),
            imageView.topAnchor.constraint(equalTo: topAnchor), imageView.bottomAnchor.constraint(equalTo: bottomAnchor),
            placeholder.centerXAnchor.constraint(equalTo: centerXAnchor), placeholder.centerYAnchor.constraint(equalTo: centerYAnchor),
            placeholder.leadingAnchor.constraint(greaterThanOrEqualTo: leadingAnchor, constant: 2),
        ])
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override var wantsUpdateLayer: Bool { true }
    override func viewDidChangeEffectiveAppearance() { super.viewDidChangeEffectiveAppearance(); needsDisplay = true }
    override func updateLayer() {
        layer?.cornerRadius = 6
        layer?.backgroundColor = (isHighlighted ? NSColor.controlAccentColor.withAlphaComponent(0.18)
            : NSColor.secondaryLabelColor.withAlphaComponent(0.08)).cgColor
    }

    /// A symbol or a short text in place of a file preview.
    func showPlaceholder(symbol: String? = nil, text: String? = nil, pointSize: CGFloat = 22) {
        requestedPath = nil; loadedPath = nil
        imageView.image = nil
        placeholder.isHidden = false
        placeholder.font = .systemFont(ofSize: pointSize, weight: .medium)
        if let symbol, let image = NSImage(systemSymbolName: symbol, accessibilityDescription: nil) {
            placeholder.stringValue = ""
            imageView.image = image.withSymbolConfiguration(.init(pointSize: pointSize, weight: .regular))
            imageView.imageScaling = .scaleNone
            imageView.contentTintColor = .secondaryLabelColor
        } else {
            placeholder.stringValue = text ?? ""
        }
    }

    /// Loads the stored file's thumbnail; the placeholder stays until then.
    func showFile(path: String, kind: String, side: CGFloat, placeholderSymbol: String) {
        guard loadedPath != path else { return }
        if let cached = MaterialThumbnails.shared.cached(path: path, side: side) { show(cached, path: path); return }
        showPlaceholder(symbol: placeholderSymbol)
        requestedPath = path
        MaterialThumbnails.shared.load(path: path, kind: kind, side: side) { [weak self] image in
            guard let self, self.requestedPath == path, let image else { return }
            self.show(image, path: path)
        }
    }

    private func show(_ image: NSImage, path: String) {
        requestedPath = path; loadedPath = path
        placeholder.isHidden = true
        imageView.contentTintColor = nil
        imageView.imageScaling = .scaleProportionallyUpOrDown
        imageView.image = image
    }
}

/// The element page's 肖像: the image or a placeholder, 设置肖像… (an image
/// picker) and 移除肖像. An image file dropped on it replaces the portrait.
final class ElementPortraitView: NSView {
    static let side: CGFloat = 76
    let well = MaterialPreviewWell()
    let setButton = NSButton(title: "设置肖像…", target: nil, action: nil)
    let removeButton = NSButton(title: "移除肖像", target: nil, action: nil)
    /// The stored portrait's path, or nil for the placeholder.
    private(set) var shownPath: String?
    private var name = ""
    /// Called with the chosen or dropped image, or nil to remove.
    var onChange: ((URL?) -> Void)?
    /// Chooses an image; nil uses an open panel on the window. Acceptance
    /// answers here without a panel.
    var chooseFile: ((@escaping (URL?) -> Void) -> Void)?
    var isBusy = false { didSet { updateButtons() } }
    var hasImage: Bool { shownPath != nil && well.loadedPath == shownPath }

    override init(frame: NSRect) {
        super.init(frame: frame)
        setAccessibilityIdentifier("element-portrait")
        well.setAccessibilityIdentifier("element-portrait-image")
        well.setAccessibilityLabel("肖像")
        for (button, id, action) in [(setButton, "set-element-portrait", #selector(choose)),
                                     (removeButton, "remove-element-portrait", #selector(remove))] {
            button.target = self; button.action = action
            button.isBordered = false
            button.controlSize = .small
            button.font = .systemFont(ofSize: 11)
            button.contentTintColor = .secondaryLabelColor
            button.setAccessibilityIdentifier(id)
        }
        let stack = NSStackView(views: [well, setButton, removeButton])
        stack.orientation = .vertical; stack.alignment = .centerX; stack.spacing = 2
        stack.setCustomSpacing(6, after: well)
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: leadingAnchor), stack.trailingAnchor.constraint(equalTo: trailingAnchor),
            stack.topAnchor.constraint(equalTo: topAnchor), stack.bottomAnchor.constraint(lessThanOrEqualTo: bottomAnchor),
            well.widthAnchor.constraint(equalToConstant: Self.side), well.heightAnchor.constraint(equalToConstant: Self.side),
            widthAnchor.constraint(equalToConstant: Self.side + 12),
        ])
        setContentHuggingPriority(.required, for: .horizontal)
        let menu = NSMenu()
        menu.addItem(withTitle: "设置肖像…", action: #selector(choose), keyEquivalent: "").target = self
        menu.addItem(withTitle: "移除肖像", action: #selector(remove), keyEquivalent: "").target = self
        well.menu = menu
        registerForDraggedTypes([.fileURL])
        show(path: nil, name: "")
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    /// Shows the stored portrait, or the element's initial on the wash.
    func show(path: String?, name: String) {
        self.name = name
        shownPath = path
        if let path {
            well.showFile(path: path, kind: "image", side: Self.side, placeholderSymbol: "person.crop.square")
        } else if let initial = name.first {
            well.showPlaceholder(text: String(initial), pointSize: 28)
        } else {
            well.showPlaceholder(symbol: "person.crop.square", pointSize: 28)
        }
        well.setAccessibilityValue(path == nil ? "未设置肖像" : "已设置肖像")
        updateButtons()
    }

    private func updateButtons() {
        setButton.title = shownPath == nil ? "设置肖像…" : "更换肖像…"
        setButton.isEnabled = !isBusy
        removeButton.isHidden = shownPath == nil
        removeButton.isEnabled = !isBusy
    }

    @objc func choose() {
        guard !isBusy else { return }
        let finish: (URL?) -> Void = { [weak self] url in if let url { self?.onChange?(url) } }
        if let chooseFile { chooseFile(finish); return }
        let panel = NSOpenPanel()
        panel.allowedContentTypes = [.image]
        panel.allowsMultipleSelection = false
        panel.canChooseDirectories = false
        panel.message = "选择一张图片作为“\(name)”的肖像"
        panel.prompt = "设为肖像"
        if let window { panel.beginSheetModal(for: window) { if $0 == .OK { finish(panel.url) } } }
        else if panel.runModal() == .OK { finish(panel.url) }
    }

    @objc func remove() {
        guard !isBusy, shownPath != nil else { return }
        onChange?(nil)
    }

    /// A drop's first file becomes the portrait; Rust and the host refuse
    /// anything that is not an image.
    @discardableResult
    func acceptDrop(from pasteboard: NSPasteboard) -> Bool {
        guard !isBusy, let url = MaterialThumbnails.fileURLs(on: pasteboard).first else { return false }
        onChange?(url)
        return true
    }

    override func draggingEntered(_ sender: NSDraggingInfo) -> NSDragOperation {
        guard !isBusy, let url = MaterialThumbnails.fileURLs(on: sender.draggingPasteboard).first,
              MaterialThumbnails.conforms(url, to: [.image]) else { return [] }
        well.isHighlighted = true
        return .copy
    }
    override func draggingExited(_ sender: NSDraggingInfo?) { well.isHighlighted = false }
    override func draggingEnded(_ sender: NSDraggingInfo) { well.isHighlighted = false }
    override func performDragOperation(_ sender: NSDraggingInfo) -> Bool {
        well.isHighlighted = false
        return acceptDrop(from: sender.draggingPasteboard)
    }
}
