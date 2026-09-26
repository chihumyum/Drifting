import AppKit
import Carbon
import CryptoKit

/// Observer only: all keyboard input and input-source changes come from CUA.
/// This helper never synthesizes events or calls TextKit input methods.
@main
@MainActor
struct SystemIMEAcceptance {
    private static var pinyin = "com.apple.inputmethod.SCIM.ITABC"
    private static let nihao: [UInt16] = [45, 34, 4, 0, 31]
    private static var phaseFile = URL(fileURLWithPath: "/dev/null")
    private static var originalSource = ""
    private static var window: NSWindow!
    private static var view: NativeDocumentView!
    private static var observed: [(UInt16, NSEvent.ModifierFlags)] = []
    private static var keyboardObservations: [[String: Any]] = []
    private static var cases: [[String: Any]] = []
    private static var activePhase = "starting"
    private static var core: LabCore!
    private static let inputSourceMenuTarget = SystemIMEInputSourceMenuTarget()
    private static var inputSourceSelections: [[String: Any]] = []

    private static func sourceID() -> String {
        guard let source = TISCopyCurrentKeyboardInputSource()?.takeRetainedValue(),
              let value = TISGetInputSourceProperty(source, kTISPropertyInputSourceID) else { return "unavailable" }
        return Unmanaged<CFString>.fromOpaque(value).takeUnretainedValue() as String
    }
    private static func inputContextObservation() -> [String: Any] {
        let context = view?.textView.inputContext
        let current = NSTextInputContext.current
        var tis: [String: Any] = [:]
        if let source = TISCopyCurrentKeyboardInputSource()?.takeRetainedValue() {
            for (name, key) in [("modeID", kTISPropertyInputModeID), ("sourceType", kTISPropertyInputSourceType)] {
                if let key, let value = TISGetInputSourceProperty(source, key) {
                    tis[name] = Unmanaged<CFString>.fromOpaque(value).takeUnretainedValue() as String
                }
            }
            if let value = TISGetInputSourceProperty(source, kTISPropertyInputSourceIsASCIICapable) {
                tis["asciiCapable"] = CFBooleanGetValue(Unmanaged<CFBoolean>.fromOpaque(value).takeUnretainedValue())
            }
        }
        return ["viewContextPresent": context != nil, "currentContextIsViewContext": context != nil && current === context,
                "viewSelectedSource": context?.selectedKeyboardInputSource as Any? ?? NSNull(),
                "currentSelectedSource": current?.selectedKeyboardInputSource as Any? ?? NSNull(),
                "keyboardSourceIDs": context?.keyboardInputSources ?? [],
                "allowedSourceLocales": context?.allowedInputSourceLocales as Any? ?? NSNull(),
                "tis": tis, "modeBoundary": "TIS mode class and ASCII capability do not establish a provider's Chinese/English submode."]
    }
    private static func require(_ condition: @autoclosure () throws -> Bool, _ message: String) throws {
        if try condition() == false { throw LabError.message(message) }
    }
    private static func write(_ value: [String: Any], to file: URL) throws {
        try JSONSerialization.data(withJSONObject: value, options: [.prettyPrinted, .sortedKeys]).write(to: file, options: .atomic)
    }
    private static func focused() -> Bool {
        NSApp.isActive && window.isKeyWindow && window.isVisible && window.occlusionState.contains(.visible)
            && window.firstResponder === view.textView
    }
    private static func phase(_ name: String, _ action: String) throws {
        activePhase = name
        try write(["schemaVersion": 1, "status": "waiting", "phase": name, "action": action,
                   "inputSource": sourceID(), "targetInputSource": pinyin, "originalInputSource": originalSource,
                   "readyForInput": focused(), "marked": view.textView.hasMarkedText(),
                   "inputContext": inputContextObservation()], to: phaseFile)
    }
    private static func inputObservation() -> [String: Any] {
        let range = view?.textView.markedRange() ?? NSRange(location: NSNotFound, length: 0)
        return ["phase": activePhase, "keyDowns": observed.map { code, flags in
            ["keyCode": Int(code), "modifierFlags": flags.intersection(.deviceIndependentFlagsMask).rawValue,
             "command": flags.contains(.command), "shift": flags.contains(.shift),
             "control": flags.contains(.control), "option": flags.contains(.option)] as [String: Any]
        }, "marked": view?.textView.hasMarkedText() == true,
                "markedLocation": range.location == NSNotFound ? NSNull() : range.location as Any,
                "markedUtf16Length": range.length, "focused": view != nil && focused(), "inputSource": sourceID(),
                "inputContext": inputContextObservation()]
    }
    private static func wait(_ condition: () -> Bool, timeout: TimeInterval = 180) async throws {
        let until = ProcessInfo.processInfo.systemUptime + timeout
        while !condition() && ProcessInfo.processInfo.systemUptime < until {
            // Standard NSApplication.run owns event dispatch and input-context
            // activation. Yield the main actor instead of nesting an event pump.
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        try require(condition(), "Timed out during system IME phase: \(activePhase)")
    }
    private static func result<T>(_ operation: (@escaping (Result<T, Error>) -> Void) -> Void) async throws -> T {
        var value: Result<T, Error>?
        operation { value = $0 }; try await wait({ value != nil }, timeout: 20)
        return try value!.get()
    }
    private static func state() async throws -> LabDocumentState { try await result { core.document(completion: $0) } }
    private static func keys(_ name: String, action: String, codes: [UInt16], modifiers: NSEvent.ModifierFlags = []) async throws {
        observed = []
        try phase(name, action)
        try await wait { observed.count >= codes.count }
        keyboardObservations.append(inputObservation())
        try require(focused(), "IME input lost the target window or responder")
        try require(sourceID() == pinyin, "IME input source changed during a keyboard phase")
        let mask: NSEvent.ModifierFlags = [.command, .shift, .control, .option]
        try require(observed.count == codes.count && zip(observed, codes).allSatisfy {
            $0.0.0 == $0.1 && $0.0.1.intersection(mask) == modifiers
        }, "Unexpected keyboard input during system IME phase: \(name)")
        cases.append(["name": name, "observedKeyDownCount": observed.count, "source": "CUA through macOS input routing"])
    }
    private static func compose(_ name: String, expected: String) async throws {
        observed = []
        try phase("\(name)-position", "Use CUA Command+Up to place the caret at the start of the editor, without a selection.")
        try await wait { !observed.isEmpty }
        keyboardObservations.append(inputObservation())
        let mask: NSEvent.ModifierFlags = [.command, .shift, .control, .option]
        try require(observed.count == 1 && observed[0].0 == 126 && observed[0].1.intersection(mask) == [.command],
                    "Expected one Command+Up positioning key before system composition")
        try require(focused() && sourceID() == pinyin && view.textView.selectedRange() == NSRange(location: 0, length: 0),
                    "Command+Up did not place the focused system IME caret at the document start")
        try await keys(name, action: "Use CUA pressKey for n, i, h, a, o individually. Do not use typeText or paste.", codes: nihao)
        try await wait({ view.textView.hasMarkedText() }, timeout: 5)
        let marked = view.textView.markedRange()
        try require(marked.location != NSNotFound && marked.length > 0, "System pinyin did not expose a marked range")
        let stored = try await state()
        try require(stored.saved && stored.projection.text == expected, "Uncommitted system pinyin entered durable prose")
        cases.append(["name": "\(name)-marked-not-persisted", "markedUtf16Length": marked.length, "status": "passed"])
    }
    private static func commit(_ name: String, previous: String) async throws -> String {
        try await keys(name, action: "Use CUA pressKey Space to select the Chinese candidate.", codes: [49])
        try await wait { !view.textView.hasMarkedText() && !view.binding.hasPendingWork }
        let stored = try await state(), text = stored.projection.text
        try require(stored.saved && text.hasSuffix(previous) && text != previous, "System candidate commit did not persist once")
        let count = (text as NSString).length - (previous as NSString).length
        let inserted = (text as NSString).substring(to: count)
        try require(inserted.unicodeScalars.contains { (0x3400...0x9fff).contains($0.value) || (0x20000...0x3134f).contains($0.value) }
            && !inserted.unicodeScalars.contains { CharacterSet.latinLettersForIME.contains($0) },
            "Space did not commit a Chinese candidate")
        cases.append(["name": "\(name)-Chinese-persisted", "committedUtf16Length": count, "status": "passed"])
        return text
    }
    private static func history(_ prefix: String, before: String, after: String) async throws {
        try await keys("\(prefix)-undo", action: "Use CUA pressKey Command+Z once.", codes: [6], modifiers: [.command])
        try await wait { !view.binding.hasPendingWork }
        let undone = try await state()
        try require(undone.projection.text == before && !undone.projection.canUndo, "One system composition was not one local undo unit")
        try await keys("\(prefix)-redo", action: "Use CUA pressKey Command+Shift+Z once.", codes: [6], modifiers: [.command, .shift])
        try await wait { !view.binding.hasPendingWork }
        let redone = try await state()
        try require(redone.projection.text == after, "System composition redo did not restore the committed text")
        let _: LabState = try await result { core.reopen(completion: $0) }
        view.binding.load(); try await wait { !view.binding.hasPendingWork }
        let reopened = try await state()
        try require(reopened.projection.text == after && view.textView.string == after, "System composition did not survive SQLite reopen")
        cases.append(["name": "\(prefix)-single-undo-redo-and-reopen", "status": "passed"])
    }
    private static func installMenu() {
        let bar = NSMenu(), application = NSMenuItem(), edit = NSMenuItem()
        let sources = NSMenuItem(title: "Input Source", action: nil, keyEquivalent: "")
        bar.addItem(application); bar.addItem(edit); bar.addItem(sources)
        application.submenu = NSMenu(title: "Drifting System IME")
        application.submenu?.addItem(withTitle: "Quit", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        edit.submenu = NSMenu(title: "Edit")
        edit.submenu?.addItem(withTitle: "Undo", action: #selector(ProseTextView.undo(_:)), keyEquivalent: "z")
        let redo = NSMenuItem(title: "Redo", action: #selector(ProseTextView.redo(_:)), keyEquivalent: "z")
        redo.keyEquivalentModifierMask = [.command, .shift]; edit.submenu?.addItem(redo)
        let sourceMenu = NSMenu(title: "Input Source")
        sourceMenu.delegate = inputSourceMenuTarget
        sourceMenu.addItem(withTitle: "Waiting for editor", action: nil, keyEquivalent: "").isEnabled = false
        sources.submenu = sourceMenu
        NSApp.mainMenu = bar
    }
    fileprivate static func updateInputSourceMenu(_ menu: NSMenu) {
        menu.removeAllItems()
        guard let context = view?.textView.inputContext else { return }
        for id in context.keyboardInputSources ?? [] {
            let name = NSTextInputContext.localizedName(forInputSource: id) ?? id
            let item = NSMenuItem(title: "\(name) [\(id)]", action: #selector(SystemIMEInputSourceMenuTarget.select(_:)), keyEquivalent: "")
            item.representedObject = id; item.target = inputSourceMenuTarget
            item.state = context.selectedKeyboardInputSource == id ? .on : .off
            menu.addItem(item)
        }
    }
    fileprivate static func selectInputSourceFromMenu(_ item: NSMenuItem) {
        guard let id = item.representedObject as? String, let context = view?.textView.inputContext,
              context.keyboardInputSources?.contains(id) == true else { return }
        let before = context.selectedKeyboardInputSource
        // Only this explicit visible menu action changes the window's source.
        // Startup, phase polling and cleanup never select an input source.
        context.selectedKeyboardInputSource = id
        inputSourceSelections.append(["phase": activePhase, "requestedSource": id,
            "previousSource": before as Any? ?? NSNull(), "selectedSource": context.selectedKeyboardInputSource as Any? ?? NSNull(),
            "route": "visible Input Source menu action"])
    }
    static func main() {
        originalSource = sourceID()
        let app = NSApplication.shared
        app.setActivationPolicy(.regular)
        let delegate = SystemIMEAppDelegate()
        app.delegate = delegate
        withExtendedLifetime(delegate) { app.run() }
    }
    fileprivate static func observe() async {
        var report: [String: Any] = ["schemaVersion": 1, "kind": "apple-system-ime-observation", "status": "failed"]
        guard let configURL = Bundle.main.url(forResource: "ime-config", withExtension: "json"),
              let config = try? JSONSerialization.jsonObject(with: Data(contentsOf: configURL)) as? [String: String],
              let output = config["report"], let phasePath = config["phase"], let directory = config["directory"] else {
            fputs("Missing isolated system IME configuration\n", stderr); NSApp.terminate(nil); return
        }
        phaseFile = URL(fileURLWithPath: phasePath)
        pinyin = config["inputSource"] ?? pinyin
        installMenu()
        window = NSWindow(contentRect: NSRect(x: 160, y: 100, width: 960, height: 700),
                          styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
        window.title = "Drifting · System Pinyin Acceptance (synthetic)"; window.isReleasedWhenClosed = false
        let monitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { event in
            if event.window === window { observed.append((event.keyCode, event.modifierFlags)) }
            return event
        }
        defer { if let monitor { NSEvent.removeMonitor(monitor) }; window.close(); NSApp.terminate(nil) }
        do {
            try require(!FileManager.default.fileExists(atPath: directory), "System IME test requires a fresh synthetic directory")
            core = LabCore(directory: URL(fileURLWithPath: directory))
            let _: LabState = try await result { core.open(completion: $0) }
            view = NativeDocumentView(core: core)
            view.frame = window.contentView!.bounds; view.autoresizingMask = [.width, .height]
            window.contentView = view; view.binding.load()
            try await wait { view.binding.state != nil && !view.binding.hasPendingWork }
            window.makeKeyAndOrderFront(nil); window.makeFirstResponder(view.textView)
            try phase("select-pinyin", "Use CUA to focus this editor, then choose \(pinyin) from the app's Input Source menu.")
            try await wait { sourceID() == pinyin && focused() }
            let baseline = try await state().projection.text
            try require(baseline.hasPrefix("合成文档：灯塔"), "System IME fixture was not the synthetic document")
            try await compose("type-basic", expected: baseline)
            let committed = try await commit("commit-basic", previous: baseline)
            try await history("basic", before: baseline, after: committed)
            try await compose("type-cancel", expected: committed)
            try await keys("cancel", action: "Use CUA pressKey Escape to cancel the marked pinyin.", codes: [53])
            try await wait { !view.textView.hasMarkedText() && !view.binding.hasPendingWork }
            let cancelled = try await state()
            try require(cancelled.projection.text == committed && view.textView.string == committed, "Escape changed committed prose")
            cases.append(["name": "system-Escape-cancel-keeps-prose", "status": "passed"])

            // A separate synthetic peer supplies real Yjs updates. No TextKit
            // method injects composition or candidate text into either view.
            let peer = LabCore(directory: URL(fileURLWithPath: directory).deletingLastPathComponent().appendingPathComponent("peer/apple-native-lab"))
            let _: LabState = try await result { peer.open(completion: $0) }
            let exported: NativeCheckpoint = try await result { core.exportDocument(completion: $0) }
            let synced: LabDocumentState = try await result { peer.applyRemote(exported.update, completion: $0) }
            let paragraph = synced.projection.blocks.first { $0.id == "fixture-paragraph" }!
            let remoteOnly: LabDocumentState = try await result { peer.document("documentReplace", edit: ["revision": synced.projection.revision,
                "range": ["location": paragraph.range.location, "length": 0], "text": "远端"], completion: $0) }
            let remote: NativeCheckpoint = try await result { peer.exportDocument(completion: $0) }
            try await compose("type-remote", expected: committed)
            let markedText = view.textView.string
            view.binding.store.applyRemote(remote.update)
            try await wait { !view.binding.store.hasPendingCommits }
            try require(view.textView.hasMarkedText() && view.textView.string == markedText,
                        "Remote delivery replaced the native system composition")
            let received = try await state()
            try require(received.projection.text == remoteOnly.projection.text, "Remote prose did not persist during system composition")
            cases.append(["name": "remote-disjoint-paragraph-preserves-system-marked-text", "status": "passed"])
            let merged = try await commit("commit-remote", previous: remoteOnly.projection.text)
            try await history("remote", before: remoteOnly.projection.text, after: merged)
            report["status"] = "passed"
            report["finalProseSha256"] = SHA256.hash(data: Data(merged.utf8)).map { String(format: "%02x", $0) }.joined()
        } catch {
            report["failure"] = (error as? LabError)?.errorDescription ?? "System IME observation failed; local logs retained"
            report["failureInputObservation"] = inputObservation()
        }
        // CUA restores the original source; this helper only observes TIS.
        do {
            if view != nil {
                try phase("restore-input-source", "Use CUA to cancel any remaining marked text with Escape, then restore originalInputSource through the app's Input Source menu.")
                try await wait { sourceID() == originalSource && !view.textView.hasMarkedText() }
            }
            report["originalInputSourceRestored"] = sourceID() == originalSource
        } catch { report["originalInputSourceRestored"] = false; report["status"] = "failed" }
        report["cases"] = cases
        report["keyboardObservations"] = keyboardObservations
        report["inputSourceSelections"] = inputSourceSelections
        report["keyboardDelivery"] = "CUA only; helper observes native keyDown and marked ranges"
        report["eventLoop"] = "NSApplication.run; asynchronous main-actor phase waits"
        report["inputSource"] = pinyin
        report["inputProvider"] = pinyin.hasPrefix("com.apple.inputmethod.SCIM.") ? "Apple Simplified Chinese Pinyin"
            : pinyin.hasPrefix("com.bytedance.inputmethod.doubaoime.") ? "Doubao Pinyin" : "Configured macOS input method"
        report["limits"] = ["hardwareKeyboard": "not-run", "backgroundInterruption": "not-run", "overlappingRemoteComposition": "not-run", "physicalDevice": "not-run"]
        do {
            try write(report, to: URL(fileURLWithPath: output))
            try write(["status": report["status"]!, "phase": "finished", "originalInputSourceRestored": report["originalInputSourceRestored"]!], to: phaseFile)
        } catch { fputs("Could not write system IME observation\n", stderr) }
    }
}

@MainActor
private final class SystemIMEAppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        Task { await SystemIMEAcceptance.observe() }
    }
}

@MainActor
private final class SystemIMEInputSourceMenuTarget: NSObject, NSMenuDelegate {
    func menuNeedsUpdate(_ menu: NSMenu) { SystemIMEAcceptance.updateInputSourceMenu(menu) }
    @objc func select(_ sender: NSMenuItem) { SystemIMEAcceptance.selectInputSourceFromMenu(sender) }
}

private extension CharacterSet {
    static var latinLettersForIME: CharacterSet { CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ") }
}
