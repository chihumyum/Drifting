// Measures WebKit's macOS text-input lookup (NSTextInputClient
// attributedSubstring) at the end of an editor that is followed by hidden,
// retained editor surfaces. Synthetic markup only; no app code or data.
// See docs/renderer-performance/ime-text-lookup.md.
//
//   swiftc -O -o /tmp/measure-webkit-ime-lookup scripts/measure-webkit-ime-lookup.swift
//   /tmp/measure-webkit-ime-lookup
import AppKit
import WebKit

setvbuf(stdout, nil, _IONBF, 0)

// Must match TextInputLookupStop.tsx.
let stop = "<span data-text-input-lookup-stop=\"\" aria-hidden=\"true\" style=\"position:absolute;top:0;left:0;width:0;height:0;overflow:hidden;pointer-events:none;user-select:text;-webkit-user-select:text\">\u{200B}</span>"
let sentence = String(repeating: "她把那封信折好，放进抽屉，又拿出来看了一遍。窗外的雨一直没有停。", count: 6)
func paragraphs(_ count: Int) -> String { (0..<count).map { _ in "<p>\(sentence)</p>" }.joined() }
func editor(_ body: String) -> String { "<div class=\"ProseMirror\" contenteditable=\"true\" style=\"white-space:pre-wrap\">\(body)</div>" }
func surface(_ inner: String, visible: Bool) -> String {
  "<div style=\"position:absolute;inset:0;overflow:hidden;visibility:\(visible ? "visible" : "hidden")\">\(inner)</div>"
}
let activeBody = paragraphs(25) + String(repeating: "<p><br class=\"ProseMirror-trailingBreak\"></p>", count: 3)
func stage(hiddenParagraphs: Int, withStop: Bool) -> String {
  let active = surface(editor(activeBody) + (withStop ? stop : ""), visible: true)
  let hidden = surface(editor(paragraphs(hiddenParagraphs)) + (withStop ? stop : ""), visible: false)
  return "<main style=\"position:relative;height:800px\">\(active)\(hidden)</main><aside>侧栏文字</aside>"
}

let cases: [(name: String, html: String, hiddenChars: Int)] = [
  ("no hidden surfaces", stage(hiddenParagraphs: 0, withStop: false), 0),
  ("hidden surfaces, no stop", stage(hiddenParagraphs: 200, withStop: false), 200 * sentence.count),
  ("hidden surfaces, with stop", stage(hiddenParagraphs: 200, withStop: true), 200 * sentence.count),
  ("4x hidden surfaces, no stop", stage(hiddenParagraphs: 800, withStop: false), 800 * sentence.count),
  ("4x hidden surfaces, with stop", stage(hiddenParagraphs: 800, withStop: true), 800 * sentence.count),
]

final class Harness: NSObject, WKNavigationDelegate {
  let web = WKWebView(frame: NSRect(x: 0, y: 0, width: 1000, height: 800))
  let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1000, height: 800), styleMask: [.titled], backing: .buffered, defer: false)
  var loaded: (() -> Void)?

  override init() {
    super.init()
    window.contentView = web
    window.orderFront(nil)
    web.navigationDelegate = self
  }

  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { loaded?() }

  func substring(_ range: NSRange, _ done: @escaping (Double) -> Void) {
    typealias Reply = @convention(block) (NSAttributedString?, NSRange) -> Void
    typealias Send = @convention(c) (AnyObject, Selector, NSRange, Reply) -> Void
    let selector = NSSelectorFromString("attributedSubstringForProposedRange:completionHandler:")
    let start = CFAbsoluteTimeGetCurrent()
    let reply: Reply = { _, _ in done((CFAbsoluteTimeGetCurrent() - start) * 1000) }
    unsafeBitCast(web.method(for: selector)!, to: Send.self)(web, selector, range, reply)
  }

  func selectedRange(_ done: @escaping (NSRange) -> Void) {
    typealias Reply = @convention(block) (NSRange) -> Void
    typealias Send = @convention(c) (AnyObject, Selector, Reply) -> Void
    let selector = NSSelectorFromString("selectedRangeWithCompletionHandler:")
    let reply: Reply = { done($0) }
    unsafeBitCast(web.method(for: selector)!, to: Send.self)(web, selector, reply)
  }
}

let harness = Harness()

func median(_ values: [Double]) -> Double { values.sorted()[values.count / 2] }

func measure(_ ranges: [NSRange], _ index: Int = 0, _ worst: Double = 0, _ done: @escaping (Double) -> Void) {
  guard index < ranges.count else { return done(worst) }
  var samples: [Double] = []
  func repeatProbe() {
    harness.substring(ranges[index]) { ms in
      samples.append(ms)
      if samples.count < 6 { return repeatProbe() }
      measure(ranges, index + 1, max(worst, median(Array(samples.dropFirst()))), done)
    }
  }
  repeatProbe()
}

func run(_ index: Int) {
  guard index < cases.count else { return NSApp.terminate(nil) }
  let current = cases[index]
  harness.loaded = {
    let caretAtEnd = "const e=document.querySelector('.ProseMirror');e.focus();getSelection().selectAllChildren(e);getSelection().collapseToEnd();"
    harness.web.evaluateJavaScript(caretAtEnd) { _, _ in
      harness.selectedRange { caret in
        let end = caret.location
        // Every range the input method could request around the caret.
        var ranges: [NSRange] = []
        for location in (end - 4)...(end + 2) { for length in 0...4 { ranges.append(NSRange(location: location, length: length)) } }
        measure(ranges) { worst in
          print(String(format: "{\"case\":\"%@\",\"hiddenChars\":%d,\"worstMedianMs\":%.2f}", current.name, current.hiddenChars, worst))
          run(index + 1)
        }
      }
    }
  }
  harness.web.loadHTMLString("<!doctype html><meta charset=\"utf-8\"><body style=\"margin:0;font:16px -apple-system\">\(current.html)</body>", baseURL: nil)
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
DispatchQueue.main.async { run(0) }
app.run()
