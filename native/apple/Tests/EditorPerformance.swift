import AppKit
import QuartzCore
import Darwin

private struct ScaleCorpus: Decodable {
    struct Case: Decodable { let id: String; let utf16Length: Int; let plainText: String; let paragraphCount: Int }
    struct Range: Decodable { let location: Int; let length: Int }
    let kind: String; let corpusSha256: String; let samplesPerCase: Int; let warmSwitchSamples: Int
    let scrollSteps: Int; let editRange: Range; let editText: String; let cases: [Case]
}

/// A visible AppKit experiment using the unchanged product text view and queue.
/// Display-link callbacks are paint opportunities, not displayed-pixel probes.
private final class DisplayProbe: NSObject {
    var ticks = 0
    var times: [Double] = []
    var link: CADisplayLink?
    init(view: NSView) {
        super.init()
        link = view.displayLink(target: self, selector: #selector(tick))
        link?.add(to: .current, forMode: .common)
    }
    @objc private func tick(_ link: CADisplayLink) { ticks += 1; times.append(ProcessInfo.processInfo.systemUptime) }
    deinit { link?.invalidate() }
}

private final class StartMeasurement: NSObject {
    var requested = false
    @objc func start(_ sender: Any?) { requested = true }
}

@main
struct EditorPerformance {
    static func clock() -> Double { ProcessInfo.processInfo.systemUptime }
    static func require(_ condition: @autoclosure () -> Bool, _ message: String) throws {
        if !condition() {throw LabError.message(message)}
    }
    static func wait(_ condition: () -> Bool, timeout: TimeInterval = 60, line: UInt = #line) throws {
        let deadline = clock() + timeout
        while !condition() && clock() < deadline {
            // This standalone collector owns AppKit's event pump; RunLoop alone
            // delivers display callbacks without dispatching window activation.
            for _ in 0..<64 {
                guard let event = NSApplication.shared.nextEvent(matching:.any,until:Date(),inMode:.default,dequeue:true) else { break }
                NSApplication.shared.sendEvent(event)
            }
            NSApplication.shared.updateWindows()
            _ = RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.001))
        }
        try require(condition(), "Timed out waiting for the visible editor or its durable queue at line \(line)")
    }
    private static func frames(_ probe: DisplayProbe, window: NSWindow) throws {
        let target = probe.ticks + 2
        window.displayIfNeeded()
        try wait({ probe.ticks >= target }, timeout: 10)
        try require(NSApplication.shared.isActive && window.isKeyWindow && window.isVisible && window.occlusionState.contains(.visible),
                    "Benchmark window must be visible and active: active=\(NSApplication.shared.isActive), key=\(window.isKeyWindow), visible=\(window.isVisible), occlusion=\(window.occlusionState.rawValue)")
    }
    static func resident() -> UInt64 {
        var info = mach_task_basic_info()
        var count = mach_msg_type_number_t(MemoryLayout<mach_task_basic_info>.size / MemoryLayout<natural_t>.size)
        let result = withUnsafeMutablePointer(to: &info) { pointer in
            pointer.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
                task_info(mach_task_self_, task_flavor_t(MACH_TASK_BASIC_INFO), $0, &count)
            }
        }
        return result == KERN_SUCCESS ? info.resident_size : 0
    }
    static func metric(_ samples: [Double]) -> [String: Any] {
        let sorted = samples.sorted()
        return ["samplesMs":samples,"medianMs":sorted[sorted.count / 2],"p95Ms":sorted[max(0,Int(ceil(Double(sorted.count) * 0.95)) - 1)],"maxMs":sorted.last!]
    }
    static func main() {
        do { try run() }
        catch { fputs("Native performance collection failed: \(error)\n",stderr); exit(1) }
    }
    static func run() throws {
        let args = CommandLine.arguments
        try require(args.count == 4 || (args.count == 5 && args[4] == "--interactive"),"Expected corpus.json owned-case-directory report.json [--interactive]")
        let corpus = try JSONDecoder().decode(ScaleCorpus.self,from:Data(contentsOf:URL(fileURLWithPath:args[1])))
        try require(corpus.kind == "apple-editor-performance-corpus" && corpus.samplesPerCase >= 30,"Invalid synthetic corpus")
        let app = NSApplication.shared
        app.setActivationPolicy(.regular); app.finishLaunching()
        let window = NSWindow(contentRect:NSRect(x:160,y:100,width:1100,height:780),styleMask:[.titled,.closable,.resizable],backing:.buffered,defer:false)
        window.title = "Drifting · Synthetic editor performance"
        window.isReleasedWhenClosed = false
        let host = NSView(frame:window.contentView!.bounds)
        host.autoresizingMask = [.width,.height]; window.contentView = host
        window.center()
        window.makeKeyAndOrderFront(nil); app.activate(ignoringOtherApps:true)
        if args.count == 5 {
            let start = StartMeasurement()
            let button = NSButton(title:"开始合成文档性能测试",target:start,action:#selector(StartMeasurement.start(_:)))
            button.setAccessibilityIdentifier("start-performance-measurement")
            button.frame = NSRect(x:host.bounds.midX - 150,y:host.bounds.midY,width:300,height:44)
            host.addSubview(button)
            try wait({start.requested},timeout:300)
            button.removeFromSuperview()
        }
        let display = DisplayProbe(view:host)
        try wait({app.isActive && window.isKeyWindow && window.isVisible && window.occlusionState.contains(.visible)},timeout:10)
        try frames(display,window:window)
        var cases: [[String:Any]] = []
        var cores: [LabCore] = []; var views: [NativeDocumentView] = []
        for entry in corpus.cases {
            let begin = clock()
            let directory = URL(fileURLWithPath:args[2]).appendingPathComponent(entry.id).appendingPathComponent("apple-native-lab")
            let core = LabCore(directory:directory)
            var opened:Result<LabState,Error>?
            core.open {opened = $0}; try wait {opened != nil}; _ = try opened!.get()
            let view = NativeDocumentView(core:core)
            for child in host.subviews {child.removeFromSuperview()}
            view.frame = host.bounds; view.autoresizingMask = [.width,.height]; host.addSubview(view)
            view.binding.load(); try wait {view.binding.state != nil && !view.binding.hasPendingWork}
            try require(view.textView.string == entry.plainText,"Native corpus load changed text")
            window.makeFirstResponder(view.textView)
            try frames(display,window:window)
            let load = (clock() - begin) * 1000
            var paint: [Double] = []; var durable: [Double] = []; var synchronous: [Double] = []
            for _ in 0..<corpus.samplesPerCase {
                let range = NSRange(location:corpus.editRange.location,length:corpus.editRange.length)
                view.textView.setSelectedRange(range)
                view.textView.scrollRangeToVisible(range)
                try wait {!view.binding.hasPendingWork}
                try require(view.textView.isEditable && view.binding.canEdit && window.firstResponder === view.textView,
                            "Measured editor must accept focused input")
                let inserted = (entry.plainText as NSString).replacingCharacters(in:range,with:corpus.editText)
                var settledAt:Double?
                view.onActivity = { busy in
                    if !busy && view.binding.state?.saved == true && view.binding.state?.projection.text == inserted && settledAt == nil {
                        settledAt = clock()
                    }
                }
                let started = clock()
                view.textView.insertText(corpus.editText,replacementRange:range)
                synchronous.append((clock() - started) * 1000)
                try require(view.textView.string == inserted,"Measured input was rejected")
                try frames(display,window:window)
                paint.append((clock() - started) * 1000)
                try require(view.textView.string == inserted,"Measured input disappeared before display opportunity")
                try wait {settledAt != nil && !view.binding.hasPendingWork}
                durable.append((settledAt! - started) * 1000)
                view.onActivity = nil
                try require(view.binding.state?.saved == true && view.binding.state?.projection.text == inserted,"Native edit was not durably saved")
                view.textView.insertText("",replacementRange:NSRange(location:range.location,length:(corpus.editText as NSString).length))
                try wait {!view.binding.hasPendingWork}
                try require(view.textView.string == entry.plainText && view.binding.state?.projection.text == entry.plainText,
                            "Measured insert/delete changed corpus prose")
            }
            var scroll:[Double] = []
            for step in 0..<corpus.scrollSteps {
                let started = clock()
                view.textView.scrollRangeToVisible(NSRange(location:(step % 2 == 0 ? 0 : entry.utf16Length - 1),length:0))
                try frames(display,window:window)
                scroll.append((clock() - started) * 1000)
            }
            var checkpoint:Result<NativeCheckpoint,Error>?
            core.exportDocument {checkpoint = $0}; try wait {checkpoint != nil}
            let exported = try checkpoint!.get()
            let attributes = view.textView.textStorage!.attributes(at:49,effectiveRange:nil)
            let font = attributes[.font] as! NSFont
            let paragraph = attributes[.paragraphStyle] as! NSParagraphStyle
            cases.append(["id":entry.id,"utf16Length":entry.utf16Length,"paragraphCount":entry.paragraphCount,
                "loadToTwoFramesMs":load,"dispatchToTwoFrames":metric(paint),"dispatchToDurableSettled":metric(durable),
                "synchronousDispatch":metric(synchronous),"scrollToTwoFrames":metric(scroll),"residentBytes":resident(),
                "retainedCommentCount":view.binding.state!.projection.comments.count,"updateBase64":exported.update,
                "bodyTypography":["font":font.fontName,"pointSize":font.pointSize,"lineSpacing":paragraph.lineSpacing,
                                  "paragraphSpacing":paragraph.paragraphSpacing,"textContainerWidth":view.textView.textContainer!.size.width],
                "proseUnchanged":true])
            cores.append(core); views.append(view)
        }
        var switches:[Double] = []; var switchCases:[String] = []
        for sample in 0..<corpus.warmSwitchSamples {
            let view = views[sample % views.count]
            let begin = clock()
            for child in host.subviews {child.removeFromSuperview()}
            view.frame = host.bounds; host.addSubview(view); window.makeFirstResponder(view.textView)
            try frames(display,window:window)
            switches.append((clock() - begin) * 1000)
            switchCases.append(corpus.cases[sample % corpus.cases.count].id)
        }
        var reopenResident:[UInt64] = []
        for _ in 0..<10 {
            for (index,core) in cores.enumerated() {
                var reopened:Result<LabState,Error>?
                core.reopen {reopened = $0}; try wait {reopened != nil}; _ = try reopened!.get()
                views[index].binding.load(); try wait {!views[index].binding.hasPendingWork}
                try require(views[index].textView.string == corpus.cases[index].plainText,"Reopening changed synthetic prose")
            }
            try frames(display,window:window)
            reopenResident.append(resident())
        }
        let gaps = zip(display.times.dropFirst(),display.times).map {($0 - $1) * 1000}
        let report:[String:Any] = ["schemaVersion":1,"kind":"apple-native-editor-performance-sample","status":"measured",
            "corpusSha256":corpus.corpusSha256,"cases":cases,"cachedSurfaceSwitch":metric(switches),"cachedSurfaceSwitchCaseIds":switchCases,
            "reopenResidentBytes":reopenResident,"displayCadence":metric(gaps),
            "limits":["physicalInput":"not-run","displayedPixels":"not-measured","fullWorkspaceSwitch":"not-run",
                      "minimumOS":"not-run","mainThreadLongTasks":"not-measured"],
            "environment":["os":ProcessInfo.processInfo.operatingSystemVersionString,"physicalMemory":ProcessInfo.processInfo.physicalMemory,
                           "windowWidth":host.bounds.width,"windowHeight":host.bounds.height,"backingScaleFactor":window.backingScaleFactor]]
        try JSONSerialization.data(withJSONObject:report,options:[.prettyPrinted,.sortedKeys]).write(to:URL(fileURLWithPath:args[3]),options:.atomic)
        display.link?.invalidate()
        for view in views {try require(view.binding.detach(),"Native benchmark left a pending view")}
        window.close()
        print("Measured native editor corpus \(corpus.corpusSha256)")
    }
}
