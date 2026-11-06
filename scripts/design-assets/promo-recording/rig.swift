// The promo recording rig (scripts/design-assets/promo-recording/README.md).
//
// One process that records one window of the app with ScreenCaptureKit and
// drives the real pointer and keyboard with system events, so everything it
// does is stamped on the same clock as the recorded frames: the host time
// clock, which is also what Node's process.hrtime reads on macOS.
//
//   promo-rig --log <events.jsonl>
//
// Commands arrive one JSON object per line on stdin and are answered one JSON
// object per line on stdout ({"id", "ok": true, ...} or {"id", "error"}); they
// run one after another, while recording runs on its own queue. Every input
// it posts is appended to the event log as {"t": <host seconds>, "type", ...},
// pointer positions in points relative to the target window's top-left.

import AVFoundation
import Carbon
import CoreGraphics
import CoreMedia
import Foundation
import ScreenCaptureKit

// MARK: - Clock and output

func hostNow() -> Double { CMClockGetTime(CMClockGetHostTimeClock()).seconds }

let stdoutLock = NSLock()
func reply(_ object: [String: Any]) {
  guard let data = try? JSONSerialization.data(withJSONObject: object), let line = String(data: data, encoding: .utf8) else { return }
  stdoutLock.lock()
  FileHandle.standardOutput.write((line + "\n").data(using: .utf8)!)
  stdoutLock.unlock()
}

final class EventLog {
  private let handle: FileHandle
  private let lock = NSLock()
  init(path: String) throws {
    FileManager.default.createFile(atPath: path, contents: nil)
    guard let handle = FileHandle(forWritingAtPath: path) else { throw RigError("Cannot write the event log at \(path)") }
    self.handle = handle
  }
  func write(_ type: String, _ fields: [String: Any] = [:], at t: Double = hostNow()) {
    var event = fields
    event["t"] = t
    event["type"] = type
    guard let data = try? JSONSerialization.data(withJSONObject: event, options: [.sortedKeys]) else { return }
    lock.lock()
    handle.write(data)
    handle.write("\n".data(using: .utf8)!)
    lock.unlock()
  }
  func close() { lock.lock(); try? handle.close(); lock.unlock() }
}

struct RigError: Error, CustomStringConvertible {
  let description: String
  init(_ description: String) { self.description = description }
}

// MARK: - The target window

struct WindowFrame { let id: CGWindowID; let x: Double; let y: Double; let width: Double; let height: Double }

/** The process's largest ordinary on-screen window, in global points (top-left origin). */
func mainWindow(pid: pid_t) -> WindowFrame? {
  guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { return nil }
  var best: WindowFrame?
  for info in list {
    guard (info[kCGWindowOwnerPID as String] as? pid_t) == pid, (info[kCGWindowLayer as String] as? Int) == 0,
          let id = info[kCGWindowNumber as String] as? CGWindowID,
          let bounds = info[kCGWindowBounds as String] as? [String: Double] else { continue }
    let frame = WindowFrame(id: id, x: bounds["X"] ?? 0, y: bounds["Y"] ?? 0, width: bounds["Width"] ?? 0, height: bounds["Height"] ?? 0)
    if frame.height > 200, frame.width * frame.height > (best.map { $0.width * $0.height } ?? 0) { best = frame }
  }
  return best
}

// MARK: - Recording

final class Recorder: NSObject, SCStreamOutput, SCStreamDelegate {
  private let queue = DispatchQueue(label: "promo-rig.recorder")
  private var stream: SCStream?
  private var writer: AVAssetWriter?
  private var input: AVAssetWriterInput?
  private var adaptor: AVAssetWriterInputPixelBufferAdaptor?
  private var firstFrame: CMTime?
  private var lastFrame: CMTime?
  private(set) var frames = 0
  private(set) var dropped = 0
  private var stopError: Error?
  private var lastContent: [Double] = []
  let log: EventLog
  var pixelSize = CGSize.zero
  var pointSize = CGSize.zero

  init(log: EventLog) { self.log = log }

  func start(windowID: CGWindowID, output: URL, fps: Int, codec: String) async throws {
    let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
    guard let window = content.windows.first(where: { $0.windowID == windowID }) else {
      throw RigError("Window \(windowID) is not on screen (is Screen Recording allowed for this terminal?)")
    }
    let filter = SCContentFilter(desktopIndependentWindow: window)
    let scale = CGFloat(filter.pointPixelScale)
    pointSize = filter.contentRect.size
    pixelSize = CGSize(width: (pointSize.width * scale).rounded(), height: (pointSize.height * scale).rounded())
    let config = SCStreamConfiguration()
    config.width = Int(pixelSize.width)
    config.height = Int(pixelSize.height)
    config.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(fps))
    config.pixelFormat = kCVPixelFormatType_32BGRA
    config.colorSpaceName = CGColorSpace.sRGB
    config.showsCursor = false
    config.queueDepth = 8
    config.ignoreShadowsSingleWindow = true
    config.shouldBeOpaque = false

    try? FileManager.default.removeItem(at: output)
    let writer = try AVAssetWriter(outputURL: output, fileType: .mov)
    let settings: [String: Any]
    if codec == "prores4444" {
      settings = [AVVideoCodecKey: AVVideoCodecType.proRes4444, AVVideoWidthKey: config.width, AVVideoHeightKey: config.height]
    } else {
      settings = [
        AVVideoCodecKey: AVVideoCodecType.hevcWithAlpha, AVVideoWidthKey: config.width, AVVideoHeightKey: config.height,
        AVVideoCompressionPropertiesKey: [AVVideoQualityKey: 0.92, AVVideoExpectedSourceFrameRateKey: fps],
        AVVideoColorPropertiesKey: [
          AVVideoColorPrimariesKey: AVVideoColorPrimaries_ITU_R_709_2,
          AVVideoTransferFunctionKey: AVVideoTransferFunction_ITU_R_709_2,
          AVVideoYCbCrMatrixKey: AVVideoYCbCrMatrix_ITU_R_709_2,
        ],
      ]
    }
    let input = AVAssetWriterInput(mediaType: .video, outputSettings: settings)
    input.expectsMediaDataInRealTime = true
    let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: nil)
    guard writer.canAdd(input) else { throw RigError("The writer refused the video input") }
    writer.add(input)
    guard writer.startWriting() else { throw RigError("The writer did not start: \(writer.error?.localizedDescription ?? "?")") }
    writer.startSession(atSourceTime: .zero)
    self.writer = writer
    self.input = input
    self.adaptor = adaptor

    let stream = SCStream(filter: filter, configuration: config, delegate: self)
    try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: queue)
    try await stream.startCapture()
    self.stream = stream
  }

  func stream(_ stream: SCStream, didOutputSampleBuffer sample: CMSampleBuffer, of type: SCStreamOutputType) {
    guard type == .screen, sample.isValid,
          let attachments = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
          let statusValue = attachments.first?[.status] as? Int, SCFrameStatus(rawValue: statusValue) == .complete,
          let pixels = sample.imageBuffer, let input, let adaptor else { return }
    let pts = sample.presentationTimeStamp
    if firstFrame == nil {
      firstFrame = pts
      log.write("frames.start", ["hostTime": pts.seconds], at: pts.seconds)
    }
    // ScreenCaptureKit shrinks the window to fit when something attached to
    // it (a tooltip, an input indicator) widens what it captures; note every
    // change, so composing can undo it.
    let info = attachments.first!
    let scale = (info[.contentScale] as? NSNumber)?.doubleValue ?? 1
    var rect = CGRect.zero
    if let dictionary = info[.contentRect] as? NSDictionary { rect = CGRect(dictionaryRepresentation: dictionary as CFDictionary) ?? .zero }
    let content = [scale, rect.origin.x, rect.origin.y, rect.width, rect.height].map { ($0 * 1000).rounded() / 1000 }
    if content != lastContent {
      lastContent = content
      log.write("frames.content", ["scale": content[0], "x": content[1], "y": content[2], "width": content[3], "height": content[4],
                                   "pointPixelScale": (info[.scaleFactor] as? NSNumber)?.doubleValue ?? 0], at: pts.seconds)
    }
    let time = CMTimeSubtract(pts, firstFrame!)
    if let lastFrame, CMTimeCompare(time, lastFrame) <= 0 { return }
    if input.isReadyForMoreMediaData, adaptor.append(pixels, withPresentationTime: time) {
      frames += 1
      lastFrame = time
    } else {
      dropped += 1
    }
  }

  func stream(_ stream: SCStream, didStopWithError error: Error) { stopError = error }

  func stop() async throws -> [String: Any] {
    guard let stream, let writer, let input else { throw RigError("Not recording") }
    try? await stream.stopCapture()
    await withCheckedContinuation { (done: CheckedContinuation<Void, Never>) in
      queue.async {
        input.markAsFinished()
        if let lastFrame = self.lastFrame { writer.endSession(atSourceTime: CMTimeAdd(lastFrame, CMTime(value: 1, timescale: 60))) }
        writer.finishWriting { done.resume() }
      }
    }
    self.stream = nil
    if writer.status != .completed { throw RigError("The recording did not finish: \(writer.error?.localizedDescription ?? "status \(writer.status.rawValue)")") }
    if let stopError { throw RigError("Capture stopped early: \(stopError.localizedDescription)") }
    return [
      "file": writer.outputURL.path, "frames": frames, "dropped": dropped,
      "firstFrameHostTime": firstFrame?.seconds ?? NSNull(),
      "pixelWidth": pixelSize.width, "pixelHeight": pixelSize.height,
      "pointWidth": pointSize.width, "pointHeight": pointSize.height,
    ]
  }
}

// MARK: - Input

final class Puppet {
  let log: EventLog
  let source = CGEventSource(stateID: .hidSystemState)
  var pid: pid_t = 0
  var previousInputSource: TISInputSource?
  var buttonDown = false
  private var random: UInt64 = 0x9E37_79B9_7F4A_7C15

  init(log: EventLog) { self.log = log }

  func seed(_ value: UInt64) { random = value == 0 ? 0x9E37_79B9_7F4A_7C15 : value }
  /** xorshift64*, in [0, 1). */
  func next() -> Double {
    random ^= random >> 12; random ^= random << 25; random ^= random >> 27
    return Double((random &* 2_685_821_657_736_338_717) >> 11) / Double(1 << 53)
  }

  func window() throws -> WindowFrame {
    guard pid != 0, let frame = mainWindow(pid: pid) else { throw RigError("No target window (target a pid first)") }
    return frame
  }

  func pointerLocation() -> CGPoint { CGEvent(source: nil)?.location ?? .zero }

  /**
   * Input must only ever reach the target app. Before every keystroke, click
   * and scroll the rig asks the window server which app owns the frontmost
   * ordinary window (and, for the pointer, the window under it); if it is
   * not the target the input is not posted and the command fails, so a
   * recording stops instead of typing into whatever came to the front.
   */
  func ownerOfFrontWindow(at point: CGPoint? = nil) -> pid_t? {
    guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { return nil }
    for info in list {
      guard (info[kCGWindowLayer as String] as? Int) == 0,
            let owner = info[kCGWindowOwnerPID as String] as? Int,
            let bounds = info[kCGWindowBounds as String] as? [String: Double] else { continue }
      let alpha = info[kCGWindowAlpha as String] as? Double ?? 1
      if alpha <= 0.01 { continue }
      let rect = CGRect(x: bounds["X"] ?? 0, y: bounds["Y"] ?? 0, width: bounds["Width"] ?? 0, height: bounds["Height"] ?? 0)
      if rect.width < 40 || rect.height < 40 { continue }
      if let point, !rect.contains(point) { continue }
      return pid_t(owner)
    }
    return nil
  }

  /**
   * The app in front, as LaunchServices has it (`lsappinfo front`): the one
   * the system routes the keyboard to. Asked fresh each time; a long-running
   * tool's own workspace notifications would go stale.
   */
  func frontApplication() -> pid_t? {
    func run(_ arguments: [String]) -> String? {
      let process = Process()
      process.executableURL = URL(fileURLWithPath: "/usr/bin/lsappinfo")
      process.arguments = arguments
      let pipe = Pipe()
      process.standardOutput = pipe
      process.standardError = FileHandle.nullDevice
      do { try process.run() } catch { return nil }
      let data = pipe.fileHandleForReading.readDataToEndOfFile()
      process.waitUntilExit()
      return String(data: data, encoding: .utf8)
    }
    guard let asn = run(["front"])?.trimmingCharacters(in: .whitespacesAndNewlines), !asn.isEmpty,
          let info = run(["info", "-only", "pid", asn]),
          let range = info.range(of: #"pid = [0-9]+"#, options: .regularExpression),
          let value = info[range].split(separator: " ").last else { return nil }
    return pid_t(String(value))
  }

  func requireTarget(at point: CGPoint? = nil, for what: String) throws {
    guard pid != 0 else { throw RigError("No target (target a pid first)") }
    let front = frontApplication()
    let window = point == nil ? pid : ownerOfFrontWindow(at: point)
    if front == pid && window == pid { return }
    let stray = front != pid ? front : window
    let name = stray.flatMap { NSRunningApplication(processIdentifier: $0)?.localizedName } ?? "nothing"
    log.write("guard", ["what": what, "app": name, "front": Int(front ?? 0), "window": Int(window ?? 0)])
    throw RigError("Stopped before \(what): \(name) is \(front != pid ? "in front" : "under the pointer"), not the target app")
  }

  func sleep(_ seconds: Double) async {
    if seconds > 0 { try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000)) }
  }

  // Pointer

  func postMouse(_ type: CGEventType, at point: CGPoint, clickState: Int64 = 1) {
    guard let event = CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: point, mouseButton: .left) else { return }
    event.setIntegerValueField(.mouseEventClickState, value: clickState)
    event.post(tap: .cghidEventTap)
  }

  /**
   * Moves the pointer to (x, y) in window points along a gentle arc, eased in
   * and out, sampled at 120 Hz. Without a duration it takes longer for longer
   * distances, like a hand.
   */
  func move(to target: CGPoint, duration: Double?, arc: Double) async throws {
    let frame = try window()
    let end = CGPoint(x: frame.x + target.x, y: frame.y + target.y)
    let start = pointerLocation()
    let dx = end.x - start.x, dy = end.y - start.y
    let distance = (dx * dx + dy * dy).squareRoot()
    let seconds = duration ?? min(1.1, max(0.32, 0.28 + distance / 1500))
    // One control point off the straight line, to the left or right.
    let side: Double = next() < 0.5 ? -1 : 1
    let bend = distance * arc * side
    let control = CGPoint(x: (start.x + end.x) / 2 - dy / max(distance, 1) * bend, y: (start.y + end.y) / 2 + dx / max(distance, 1) * bend)
    let begin = hostNow()
    let type: CGEventType = buttonDown ? .leftMouseDragged : .mouseMoved
    var t = 0.0
    while t < 1 {
      let elapsed = hostNow() - begin
      t = seconds <= 0 ? 1 : min(1, elapsed / seconds)
      // Smootherstep: no jolt at either end.
      let e = t * t * t * (t * (t * 6 - 15) + 10)
      let u = 1 - e
      let point = CGPoint(x: u * u * start.x + 2 * u * e * control.x + e * e * end.x,
                          y: u * u * start.y + 2 * u * e * control.y + e * e * end.y)
      postMouse(type, at: point)
      log.write("pointer", ["x": point.x - frame.x, "y": point.y - frame.y])
      if t < 1 { await sleep(1.0 / 120) }
    }
  }

  func down() throws {
    let frame = try window()
    let at = pointerLocation()
    try requireTarget(at: at, for: "a press")
    postMouse(.leftMouseDown, at: at)
    buttonDown = true
    log.write("pointer.down", ["x": at.x - frame.x, "y": at.y - frame.y])
  }

  func up() throws {
    let frame = try window()
    let at = pointerLocation()
    postMouse(.leftMouseUp, at: at)
    buttonDown = false
    log.write("pointer.up", ["x": at.x - frame.x, "y": at.y - frame.y])
  }

  func click(count: Int) async throws {
    let frame = try window()
    let at = pointerLocation()
    try requireTarget(at: at, for: "a click")
    for index in 1...max(1, count) {
      postMouse(.leftMouseDown, at: at, clickState: Int64(index))
      log.write("pointer.down", ["x": at.x - frame.x, "y": at.y - frame.y, "click": index])
      await sleep(0.07 + next() * 0.03)
      postMouse(.leftMouseUp, at: at, clickState: Int64(index))
      log.write("pointer.up", ["x": at.x - frame.x, "y": at.y - frame.y, "click": index])
      if index < count { await sleep(0.09) }
    }
  }

  /**
   * Scrolls the content under the pointer by `dy` points (positive: further
   * down the page), as a trackpad would: small pixel steps, eased, at 60 Hz.
   */
  func scroll(dy: Double, duration: Double) async throws {
    try requireTarget(at: pointerLocation(), for: "a scroll")
    let steps = max(1, Int((duration * 60).rounded()))
    var sent = 0.0
    for step in 1...steps {
      let t = Double(step) / Double(steps)
      let e = t * t * (3 - 2 * t)
      let target = (dy * e).rounded()
      let delta = target - sent
      sent = target
      if delta != 0, let event = CGEvent(scrollWheelEvent2Source: source, units: .pixel, wheelCount: 1, wheel1: Int32(-delta), wheel2: 0, wheel3: 0) {
        try requireTarget(at: pointerLocation(), for: "a scroll")
        event.post(tap: .cghidEventTap)
      }
      log.write("scroll", ["dy": delta])
      await sleep(1.0 / 60)
    }
  }

  // Keyboard

  static let keyCodes: [String: CGKeyCode] = [
    "return": 36, "tab": 48, "space": 49, "backspace": 51, "escape": 53, "delete": 117,
    "left": 123, "right": 124, "down": 125, "up": 126, "home": 115, "end": 119,
    "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9, "b": 11, "q": 12,
    "w": 13, "e": 14, "r": 15, "y": 16, "t": 17, "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23,
    "9": 25, "7": 26, "8": 28, "0": 29, "o": 31, "u": 32, "i": 34, "p": 35, "l": 37, "j": 38, "k": 40,
    "n": 45, "m": 46, "\\": 42, ",": 43, "/": 44, ".": 47, "enter": 76,
  ]

  func press(_ name: String, modifiers: [String]) throws {
    guard let code = Puppet.keyCodes[name.lowercased()] else { throw RigError("Unknown key \(name)") }
    var flags = CGEventFlags()
    for modifier in modifiers {
      switch modifier {
      case "cmd": flags.insert(.maskCommand)
      case "shift": flags.insert(.maskShift)
      case "alt", "option": flags.insert(.maskAlternate)
      case "ctrl", "control": flags.insert(.maskControl)
      default: throw RigError("Unknown modifier \(modifier)")
      }
    }
    try requireTarget(for: "the key \(name)")
    for keyDown in [true, false] {
      guard let event = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: keyDown) else { continue }
      event.flags = flags
      event.postToPid(pid)
    }
    log.write("key", ["key": name, "modifiers": modifiers])
  }

  /** One character as the keyboard would send it: its own key where it has one, else the text itself. */
  /** Keys go to the target's process only (`postToPid`), never to whatever has the keyboard. */
  func typeCharacter(_ character: Character) {
    let text = String(character)
    if text == "\n" || text == "\r" {
      for keyDown in [true, false] { CGEvent(keyboardEventSource: source, virtualKey: 36, keyDown: keyDown)?.postToPid(pid) }
      log.write("key", ["key": "return"])
      return
    }
    let code: CGKeyCode = text == " " ? 49 : 0
    var units = Array(text.utf16)
    for keyDown in [true, false] {
      guard let event = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: keyDown) else { continue }
      event.keyboardSetUnicodeString(stringLength: units.count, unicodeString: &units)
      event.postToPid(pid)
    }
    log.write("type", ["text": text])
  }

  /**
   * Types `text` at about `cps` characters a second, each gap varied by
   * `jitter`, with longer rests after punctuation as a writer pauses
   * (`rests` scales them, for a writer typing faster).
   */
  func type(_ text: String, cps: Double, jitter: Double, pauses: Bool, rests: Double) async throws {
    let base = 1 / max(cps, 0.5)
    for (index, character) in text.enumerated() {
      // Every few characters, the target must still be in front: a recording
      // stops rather than typing on behind another app.
      if index % 6 == 0 { try requireTarget(for: "typing") }
      typeCharacter(character)
      var gap = base * (1 + (next() * 2 - 1) * jitter)
      if pauses {
        switch character {
        case "，", "、", ",", "；", "：": gap += (0.12 + next() * 0.12) * rests
        case "。", "！", "？", "…", ".", "!", "?": gap += (0.28 + next() * 0.25) * rests
        case "\n": gap += (0.45 + next() * 0.3) * rests
        default: break
        }
      }
      await sleep(gap)
    }
  }

  // Input source: the system's own text input methods would take the keys first.

  func selectKeyboardLayout() throws -> String {
    if previousInputSource == nil { previousInputSource = TISCopyCurrentKeyboardInputSource()?.takeRetainedValue() }
    for id in ["com.apple.keylayout.ABC", "com.apple.keylayout.US"] {
      let filter = [kTISPropertyInputSourceID as String: id] as CFDictionary
      if let list = TISCreateInputSourceList(filter, false)?.takeRetainedValue() as? [TISInputSource], let layout = list.first {
        let status = TISSelectInputSource(layout)
        if status == noErr { return id }
      }
    }
    throw RigError("No ABC or US keyboard layout is enabled")
  }

  func restoreInputSource() {
    if let previous = previousInputSource { TISSelectInputSource(previous) }
    previousInputSource = nil
  }
}

// MARK: - Commands

@main
struct Rig {
  static func main() async {
    let arguments = CommandLine.arguments
    guard let index = arguments.firstIndex(of: "--log"), index + 1 < arguments.count else {
      FileHandle.standardError.write("Usage: promo-rig --log <events.jsonl>\n".data(using: .utf8)!)
      exit(2)
    }
    let log: EventLog
    do { log = try EventLog(path: arguments[index + 1]) } catch {
      FileHandle.standardError.write("\(error)\n".data(using: .utf8)!)
      exit(1)
    }
    let recorder = Recorder(log: log)
    let puppet = Puppet(log: log)
    signal(SIGPIPE, SIG_IGN)

    do {
      for try await line in FileHandle.standardInput.bytes.lines {
        guard let data = line.data(using: .utf8),
              let command = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let name = command["cmd"] as? String else { continue }
        let id = command["id"] ?? NSNull()
        do {
          var result: [String: Any] = [:]
          let number = { (key: String) -> Double? in (command[key] as? NSNumber)?.doubleValue }
          switch name {
          case "hello":
            result["t"] = hostNow()
          case "target":
            guard let pid = number("pid") else { throw RigError("target needs a pid") }
            puppet.pid = pid_t(pid)
            let frame = try puppet.window()
            result = ["window": frame.id, "x": frame.x, "y": frame.y, "width": frame.width, "height": frame.height]
          case "seed":
            puppet.seed(UInt64(number("seed") ?? 1))
          case "record.start":
            guard let out = command["out"] as? String else { throw RigError("record.start needs out") }
            let frame = try puppet.window()
            try await recorder.start(windowID: frame.id, output: URL(fileURLWithPath: out), fps: Int(number("fps") ?? 60),
                                     codec: command["codec"] as? String ?? "hevc-alpha")
            log.write("record.start", ["window": frame.id, "pixelWidth": recorder.pixelSize.width, "pixelHeight": recorder.pixelSize.height,
                                       "pointWidth": recorder.pointSize.width, "pointHeight": recorder.pointSize.height])
            result = ["pixelWidth": recorder.pixelSize.width, "pixelHeight": recorder.pixelSize.height]
          case "record.stop":
            result = try await recorder.stop()
            log.write("record.stop", ["frames": recorder.frames, "dropped": recorder.dropped])
          case "pointer.move":
            guard let x = number("x"), let y = number("y") else { throw RigError("pointer.move needs x and y") }
            try await puppet.move(to: CGPoint(x: x, y: y), duration: number("duration"), arc: number("arc") ?? 0.08)
          case "pointer.down": try puppet.down()
          case "pointer.up": try puppet.up()
          case "pointer.click": try await puppet.click(count: Int(number("count") ?? 1))
          case "pointer.scroll":
            try await puppet.scroll(dy: number("dy") ?? 0, duration: number("duration") ?? 0.6)
          case "pointer.where":
            let frame = try puppet.window()
            let at = puppet.pointerLocation()
            result = ["x": at.x - frame.x, "y": at.y - frame.y]
          case "key.press":
            guard let key = command["key"] as? String else { throw RigError("key.press needs key") }
            try puppet.press(key, modifiers: command["modifiers"] as? [String] ?? [])
          case "key.type":
            guard let text = command["text"] as? String else { throw RigError("key.type needs text") }
            try await puppet.type(text, cps: number("cps") ?? 8, jitter: number("jitter") ?? 0.35, pauses: command["pauses"] as? Bool ?? true, rests: number("rests") ?? 1)
          case "input.keyboard":
            result["source"] = try puppet.selectKeyboardLayout()
          case "input.restore":
            puppet.restoreInputSource()
          case "mark":
            log.write("mark", ["name": command["name"] as? String ?? "", "data": command["data"] ?? NSNull()])
          case "quit":
            puppet.restoreInputSource()
            log.close()
            reply(["id": id, "ok": true])
            exit(0)
          default:
            throw RigError("Unknown command \(name)")
          }
          result["id"] = id
          result["ok"] = true
          reply(result)
        } catch {
          reply(["id": id, "error": "\(error)"])
        }
      }
    } catch {
      FileHandle.standardError.write("stdin: \(error)\n".data(using: .utf8)!)
    }
    puppet.restoreInputSource()
    log.close()
  }
}
