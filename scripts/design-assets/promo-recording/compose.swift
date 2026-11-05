// Renders a planned promo video (plan.ts) from a take's raw recording
// (README.md): every output frame shows the recording at the planned instant,
// the window on its backdrop, framed by the planned camera, with the pointer,
// its click ripples and the speed badge drawn on top; the opening's Dock and
// the window opening from it; the closing card.
//
//   promo-compose --plan <plan.json> --source <raw.mov> --out <video.mov> [--theme light|dark] [--icon <png>]
//
// Everything is drawn with Core Image on the GPU; the window is scaled from
// its Retina pixels with a Lanczos filter, so text stays sharp at any zoom.

import AppKit
import AVFoundation
import CoreImage
import CoreImage.CIFilterBuiltins
import Foundation

struct PlanFrame: Decodable {
  let s: Double, cx: Double, cy: Double, z: Double
  let px: Double, py: Double, pa: Double, pp: Double
  let r: [[Double]]
  let b: String?
  let ba: Double
  let k: [Double]?
  let w: [Double]?
  let d: [Double]?
  let e: Double?
}

struct Plan: Decodable {
  struct Size: Decodable { let width: Double; let height: Double }
  struct Box: Decodable { let x: Double; let y: Double; let width: Double; let height: Double }
  let fps: Int, width: Int, height: Int
  let canvas: Size
  let window: Box
  let pixelScale: Double
  struct Dock: Decodable { let x: Double; let y: Double; let size: Double }
  let dock: Dock?
  struct Card: Decodable { let title: String; let line: String; let url: String }
  let card: Card?
  let frames: [PlanFrame]
}

func fail(_ message: String) -> Never {
  FileHandle.standardError.write("promo-compose: \(message)\n".data(using: .utf8)!)
  exit(1)
}

func argument(_ name: String) -> String? {
  guard let index = CommandLine.arguments.firstIndex(of: name), index + 1 < CommandLine.arguments.count else { return nil }
  return CommandLine.arguments[index + 1]
}

// MARK: - Fixed artwork

let sRGB = CGColorSpace(name: CGColorSpace.sRGB)!

func bitmap(width: Int, height: Int, draw: (CGContext) -> Void) -> CIImage {
  let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0, space: sRGB,
                          bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
  draw(context)
  return CIImage(cgImage: context.makeImage()!)
}

/**
 * The macOS arrow, drawn as a vector at `scale` pixels per point: black with
 * a white rim, tip at the image's top-left, 17 points tall at scale 1.
 */
func arrow(scale: Double) -> (image: CIImage, tip: CGPoint) {
  let points: [(Double, Double)] = [(0, 0), (0, 16.2), (3.9, 12.5), (6.4, 18.3), (9.0, 17.2), (6.5, 11.5), (11.8, 11.5)]
  let margin = 3.0
  let width = Int(ceil((12 + margin * 2) * scale)), height = Int(ceil((19 + margin * 2) * scale))
  let image = bitmap(width: width, height: height) { context in
    context.translateBy(x: 0, y: CGFloat(height))
    context.scaleBy(x: CGFloat(scale), y: CGFloat(-scale))
    context.translateBy(x: CGFloat(margin), y: CGFloat(margin))
    let path = CGMutablePath()
    path.move(to: CGPoint(x: points[0].0, y: points[0].1))
    for point in points.dropFirst() { path.addLine(to: CGPoint(x: point.0, y: point.1)) }
    path.closeSubpath()
    context.setShadow(offset: CGSize(width: 0, height: 0.8), blur: 2.2, color: CGColor(gray: 0, alpha: 0.35))
    context.setLineJoin(.round)
    context.addPath(path)
    context.setStrokeColor(CGColor(gray: 1, alpha: 1))
    context.setLineWidth(2.4)
    context.strokePath()
    context.setShadow(offset: .zero, blur: 0, color: nil)
    context.addPath(path)
    context.setFillColor(CGColor(gray: 0.05, alpha: 1))
    context.fillPath()
  }
  // Image space is bottom-left; the tip sits `margin` in from the top-left.
  return (image, CGPoint(x: margin * scale, y: Double(height) - margin * scale))
}

/** A soft disc for click ripples, `size` pixels across. */
func disc(size: Int, dark: Bool) -> CIImage {
  bitmap(width: size, height: size) { context in
    let colors = [CGColor(gray: dark ? 1 : 0.1, alpha: 0.0), CGColor(gray: dark ? 1 : 0.1, alpha: 0.55), CGColor(gray: dark ? 1 : 0.1, alpha: 0.0)] as CFArray
    let gradient = CGGradient(colorsSpace: sRGB, colors: colors, locations: [0.55, 0.86, 1.0])!
    let centre = CGPoint(x: size / 2, y: size / 2)
    context.drawRadialGradient(gradient, startCenter: centre, startRadius: 0, endCenter: centre, endRadius: CGFloat(size) / 2, options: [])
  }
}

/** The speed badge: a quiet pill with the multiplier. */
func badge(_ text: String, height: Double, dark: Bool) -> CIImage {
  let font = NSFont.monospacedDigitSystemFont(ofSize: CGFloat(height * 0.5), weight: .semibold)
  let attributes: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: dark ? NSColor(white: 0.95, alpha: 1) : NSColor(white: 0.12, alpha: 1)]
  let string = NSAttributedString(string: text, attributes: attributes)
  let textSize = string.size()
  let width = Int(ceil(textSize.width + height * 0.9)), pixelHeight = Int(ceil(height))
  return bitmap(width: width, height: pixelHeight) { context in
    let rect = CGRect(x: 0.5, y: 0.5, width: CGFloat(width) - 1, height: CGFloat(pixelHeight) - 1)
    context.addPath(CGPath(roundedRect: rect, cornerWidth: rect.height / 2, cornerHeight: rect.height / 2, transform: nil))
    context.setFillColor(dark ? CGColor(gray: 0.16, alpha: 0.82) : CGColor(gray: 1, alpha: 0.82))
    context.fillPath()
    context.addPath(CGPath(roundedRect: rect, cornerWidth: rect.height / 2, cornerHeight: rect.height / 2, transform: nil))
    context.setStrokeColor(dark ? CGColor(gray: 1, alpha: 0.14) : CGColor(gray: 0, alpha: 0.1))
    context.setLineWidth(1)
    context.strokePath()
    let graphics = NSGraphicsContext(cgContext: context, flipped: false)
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = graphics
    string.draw(at: NSPoint(x: (CGFloat(width) - textSize.width) / 2, y: (CGFloat(pixelHeight) - textSize.height) / 2))
    NSGraphicsContext.restoreGraphicsState()
  }
}

/** `image` at `opacity`. */
func faded(_ image: CIImage, _ opacity: Double) -> CIImage {
  opacity >= 0.999 ? image : image.applyingFilter("CIColorMatrix", parameters: ["inputAVector": CIVector(x: 0, y: 0, z: 0, w: CGFloat(max(0, opacity)))])
}

/** The Dock's shelf behind one icon: frosted, rounded, a hairline rim. `scale` pixels per point. */
func dockShelf(icon: Double, pad: Double, scale: Double, dark: Bool) -> CIImage {
  let margin = 24.0
  let width = icon + pad * 2 + 28, height = icon + pad * 2
  return bitmap(width: Int(ceil((width + margin * 2) * scale)), height: Int(ceil((height + margin * 2) * scale))) { context in
    context.scaleBy(x: CGFloat(scale), y: CGFloat(scale))
    let rect = CGRect(x: margin, y: margin, width: width, height: height)
    let path = CGPath(roundedRect: rect, cornerWidth: 17, cornerHeight: 17, transform: nil)
    context.setShadow(offset: CGSize(width: 0, height: -4), blur: 16, color: CGColor(gray: 0, alpha: dark ? 0.45 : 0.16))
    context.addPath(path)
    context.setFillColor(dark ? CGColor(gray: 0.22, alpha: 0.78) : CGColor(gray: 1, alpha: 0.62))
    context.fillPath()
    context.setShadow(offset: .zero, blur: 0, color: nil)
    context.addPath(path)
    context.setStrokeColor(dark ? CGColor(gray: 1, alpha: 0.16) : CGColor(gray: 1, alpha: 0.85))
    context.setLineWidth(0.8)
    context.strokePath()
  }
}

/** The closing card: the icon, the name, one line and the address, centred on the backdrop's colours. */
func closingCard(_ card: Plan.Card, icon: CIImage?, width: Int, height: Int, dark: Bool) -> CIImage {
  let H = Double(height)
  let ink = dark ? NSColor(white: 0.94, alpha: 1) : NSColor(white: 0.12, alpha: 1)
  let quiet = dark ? NSColor(white: 0.7, alpha: 1) : NSColor(white: 0.38, alpha: 1)
  let serif = NSFont(name: "Songti SC Bold", size: CGFloat(H * 0.074)) ?? NSFont.systemFont(ofSize: CGFloat(H * 0.074), weight: .semibold)
  let body = NSFont(name: "Songti SC", size: CGFloat(H * 0.03)) ?? NSFont.systemFont(ofSize: CGFloat(H * 0.03))
  let small = NSFont.systemFont(ofSize: CGFloat(H * 0.024), weight: .medium)
  let title = NSAttributedString(string: card.title, attributes: [.font: serif, .foregroundColor: ink, .kern: H * 0.002])
  let line = NSAttributedString(string: card.line, attributes: [.font: body, .foregroundColor: quiet])
  let url = NSAttributedString(string: card.url, attributes: [.font: small, .foregroundColor: quiet, .kern: H * 0.001])
  let iconSize = H * 0.15
  var image = bitmap(width: width, height: height) { context in
    let graphics = NSGraphicsContext(cgContext: context, flipped: false)
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = graphics
    var y = H * 0.5 + iconSize * 0.25
    let titleSize = title.size()
    title.draw(at: NSPoint(x: (Double(width) - titleSize.width) / 2, y: y - titleSize.height))
    y -= titleSize.height + H * 0.03
    let lineSize = line.size()
    line.draw(at: NSPoint(x: (Double(width) - lineSize.width) / 2, y: y - lineSize.height))
    y -= lineSize.height + H * 0.035
    let urlSize = url.size()
    url.draw(at: NSPoint(x: (Double(width) - urlSize.width) / 2, y: y - urlSize.height))
    NSGraphicsContext.restoreGraphicsState()
  }
  if let icon {
    let k = iconSize / Double(icon.extent.height)
    image = icon.transformed(by: CGAffineTransform(scaleX: CGFloat(k), y: CGFloat(k))
      .concatenating(CGAffineTransform(translationX: CGFloat((Double(width) - iconSize) / 2), y: CGFloat(H * 0.5 + iconSize * 0.25 + H * 0.035))))
      .composited(over: image)
  }
  return image
}

// MARK: - Rendering

@main
struct Compose {
  static func main() async {
    guard let planPath = argument("--plan"), let sourcePath = argument("--source"), let outPath = argument("--out") else {
      fail("usage: promo-compose --plan <plan.json> --source <raw.mov> --out <video.mov> [--theme light|dark]")
    }
    let dark = argument("--theme") == "dark"
    let appIcon: CIImage? = argument("--icon").flatMap { CIImage(contentsOf: URL(fileURLWithPath: $0)) }
    let plan: Plan
    do { plan = try JSONDecoder().decode(Plan.self, from: Data(contentsOf: URL(fileURLWithPath: planPath))) } catch { fail("plan: \(error)") }

    // Source frames, decoded in order with their alpha.
    let asset = AVURLAsset(url: URL(fileURLWithPath: sourcePath))
    guard let track = try? await asset.loadTracks(withMediaType: .video).first else { fail("no video track in \(sourcePath)") }
    let reader: AVAssetReader
    do { reader = try AVAssetReader(asset: asset) } catch { fail("reader: \(error)") }
    let output = AVAssetReaderTrackOutput(track: track, outputSettings: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA])
    output.alwaysCopiesSampleData = false
    reader.add(output)
    guard reader.startReading() else { fail("reader did not start: \(reader.error?.localizedDescription ?? "?")") }

    // The intermediate, H.264 at a bitrate high enough that x264 re-encodes
    // text edges, not the hardware encoder's artifacts around them.
    let outURL = URL(fileURLWithPath: outPath)
    try? FileManager.default.removeItem(at: outURL)
    let writer: AVAssetWriter
    do { writer = try AVAssetWriter(outputURL: outURL, fileType: .mov) } catch { fail("writer: \(error)") }
    let bitrate = plan.width >= 3000 ? 160_000_000 : plan.width >= 2000 ? 80_000_000 : 40_000_000
    let input = AVAssetWriterInput(mediaType: .video, outputSettings: [
      AVVideoCodecKey: AVVideoCodecType.h264, AVVideoWidthKey: plan.width, AVVideoHeightKey: plan.height,
      AVVideoCompressionPropertiesKey: [
        AVVideoAverageBitRateKey: bitrate, AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel,
        AVVideoExpectedSourceFrameRateKey: plan.fps, AVVideoMaxKeyFrameIntervalKey: plan.fps * 2,
      ],
      AVVideoColorPropertiesKey: [
        AVVideoColorPrimariesKey: AVVideoColorPrimaries_ITU_R_709_2,
        AVVideoTransferFunctionKey: AVVideoTransferFunction_ITU_R_709_2,
        AVVideoYCbCrMatrixKey: AVVideoYCbCrMatrix_ITU_R_709_2,
      ],
    ])
    input.expectsMediaDataInRealTime = false
    let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: [
      kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
      kCVPixelBufferWidthKey as String: plan.width, kCVPixelBufferHeightKey as String: plan.height,
      kCVPixelBufferIOSurfacePropertiesKey as String: [:],
    ])
    writer.add(input)
    guard writer.startWriting() else { fail("writer did not start: \(writer.error?.localizedDescription ?? "?")") }
    writer.startSession(atSourceTime: .zero)

    let context = CIContext(options: [.workingColorSpace: sRGB, .outputColorSpace: sRGB, .cacheIntermediates: false])
    let W = Double(plan.width), H = Double(plan.height)
    let canvas = plan.canvas, window = plan.window

    // The backdrop, in canvas points (y down): a quiet diagonal wash and the window's shadow.
    let top = dark ? CIColor(red: 0.13, green: 0.13, blue: 0.14) : CIColor(red: 0.925, green: 0.914, blue: 0.894)
    let bottom = dark ? CIColor(red: 0.07, green: 0.07, blue: 0.08) : CIColor(red: 0.851, green: 0.835, blue: 0.808)
    let gradient = CIFilter.linearGradient()
    gradient.point0 = CGPoint(x: 0, y: canvas.height)
    gradient.point1 = CGPoint(x: canvas.width, y: 0)
    gradient.color0 = top
    gradient.color1 = bottom
    let backdropCanvas = gradient.outputImage!.cropped(to: CGRect(x: 0, y: 0, width: canvas.width, height: canvas.height))
    let shadowScale = 2.0
    let shadow = bitmap(width: Int(canvas.width * shadowScale), height: Int(canvas.height * shadowScale)) { context in
      context.scaleBy(x: CGFloat(shadowScale), y: CGFloat(shadowScale))
      let rect = CGRect(x: window.x, y: canvas.height - window.y - window.height, width: window.width, height: window.height)
      context.setShadow(offset: CGSize(width: 0, height: -14), blur: 46, color: CGColor(gray: 0, alpha: dark ? 0.6 : 0.26))
      context.addPath(CGPath(roundedRect: rect.insetBy(dx: 2, dy: 2), cornerWidth: 12, cornerHeight: 12, transform: nil))
      context.setFillColor(CGColor(gray: 0, alpha: 1))
      context.fillPath()
    }.transformed(by: CGAffineTransform(scaleX: CGFloat(1 / shadowScale), y: CGFloat(1 / shadowScale)))
    let backdrop = backdropCanvas
    let runningDot = bitmap(width: 64, height: 64) { context in
      context.setFillColor(dark ? CGColor(gray: 0.92, alpha: 1) : CGColor(gray: 0.2, alpha: 1))
      context.fillEllipse(in: CGRect(x: 4, y: 4, width: 56, height: 56))
    }
    let dockShelfImage = plan.dock.map { dockShelf(icon: $0.size, pad: 7, scale: 4, dark: dark) }
    let card = plan.card.map { closingCard($0, icon: appIcon, width: plan.width, height: plan.height, dark: dark) }
    let cardBackdrop = gradient.outputImage!.transformed(by: CGAffineTransform(scaleX: CGFloat(Double(plan.width) / canvas.width), y: CGFloat(Double(plan.height) / canvas.height)))
      .cropped(to: CGRect(x: 0, y: 0, width: plan.width, height: plan.height))

    let cursorScale = 1.25
    let (cursor, tip) = arrow(scale: 6)
    let ring = disc(size: 256, dark: dark)
    var badges: [String: CIImage] = [:]

    var current: CIImage?
    var currentTime = -Double.infinity
    var pending: CMSampleBuffer? = output.copyNextSampleBuffer()
    let started = Date()

    for (index, frame) in plan.frames.enumerated() {
      // The newest recorded frame at or before the planned instant.
      while let sample = pending, sample.presentationTimeStamp.seconds <= frame.s + 1e-4 {
        if let pixels = sample.imageBuffer {
          current = CIImage(cvPixelBuffer: pixels)
          currentTime = sample.presentationTimeStamp.seconds
        }
        pending = output.copyNextSampleBuffer()
      }
      _ = currentTime

      // Canvas points → output pixels for this camera, with y flipped for Core Image.
      let camWidth = canvas.width / frame.z, camHeight = canvas.height / frame.z
      let scale = W / camWidth
      let originX = frame.cx - camWidth / 2, originY = frame.cy - camHeight / 2
      let toOutput = { (x: Double, y: Double) -> CGPoint in CGPoint(x: (x - originX) * scale, y: H - (y - originY) * scale) }
      let canvasTransform = CGAffineTransform(translationX: CGFloat(-originX), y: CGFloat(-(canvas.height - originY - camHeight)))
        .concatenating(CGAffineTransform(scaleX: CGFloat(scale), y: CGFloat(scale)))
      var image = backdrop.transformed(by: canvasTransform)

      // The opening: the window grows in from a little smaller and fades up.
      let windowOpacity = frame.w.map { $0[0] } ?? 1
      let windowScale = frame.w.map { $0[1] } ?? 1
      let windowCentre = toOutput(window.x + window.width / 2, window.y + window.height / 2)
      let opening = CGAffineTransform(translationX: -windowCentre.x, y: -windowCentre.y)
        .concatenating(CGAffineTransform(scaleX: CGFloat(windowScale), y: CGFloat(windowScale)))
        .concatenating(CGAffineTransform(translationX: windowCentre.x, y: windowCentre.y))
      if windowOpacity > 0.001 {
        image = faded(shadow.transformed(by: canvasTransform).transformed(by: opening), windowOpacity).composited(over: image)
      }

      if var current, windowOpacity > 0.001 {
        // Undo a capture that shrank the window to fit something attached to
        // it: content scaled by k[0] from its top-left at (k[1], k[2]) points.
        if let k = frame.k, k.count == 3, k[0] > 0.2 {
          let s = k[0], extent = current.extent
          let ox = k[1] * plan.pixelScale, oy = k[2] * plan.pixelScale
          current = current.transformed(by: CGAffineTransform(a: CGFloat(1 / s), b: 0, c: 0, d: CGFloat(1 / s),
            tx: CGFloat(-ox / s), ty: CGFloat(extent.height - (extent.height - oy) / s)))
            .cropped(to: extent)
        }
        let lanczos = CIFilter.lanczosScaleTransform()
        lanczos.inputImage = current
        lanczos.scale = Float(scale / plan.pixelScale)
        lanczos.aspectRatio = 1
        let windowTopLeft = toOutput(window.x, window.y)
        let scaled = lanczos.outputImage!
        let placed = scaled.transformed(by: CGAffineTransform(translationX: windowTopLeft.x - scaled.extent.minX,
                                                              y: windowTopLeft.y - scaled.extent.height - scaled.extent.minY))
        image = faded(placed.transformed(by: opening), windowOpacity).composited(over: image)
      }

      // The Dock, with Drifting in it: it bounces once when clicked, then the Dock hides.
      if let dock = plan.dock, let shelfImage = dockShelfImage, let d = frame.d, d.count == 4, d[0] > 0.01 {
        let centre = toOutput(dock.x, dock.y + d[1])
        let shelfScale = scale / 4
        let shelf = shelfImage.transformed(by: CGAffineTransform(scaleX: CGFloat(shelfScale), y: CGFloat(shelfScale)))
        image = faded(shelf.transformed(by: CGAffineTransform(translationX: centre.x - shelf.extent.width / 2, y: centre.y - shelf.extent.height / 2)), d[0])
          .composited(over: image)
        if let appIcon {
          let size = dock.size * scale
          let k = size / Double(appIcon.extent.height)
          let iconCentre = toOutput(dock.x, dock.y + d[1] - d[2])
          let placedIcon = appIcon.transformed(by: CGAffineTransform(scaleX: CGFloat(k), y: CGFloat(k))
            .concatenating(CGAffineTransform(translationX: iconCentre.x - size / 2, y: iconCentre.y - size / 2)))
          image = faded(placedIcon, d[0]).composited(over: image)
        }
        if d[3] > 0.01 {
          // The running dot under the icon, 4 points across.
          let dotCentre = toOutput(dock.x, dock.y + d[1] + dock.size / 2 + 4.5)
          let k = 4 * scale / Double(runningDot.extent.width)
          let dot = runningDot.transformed(by: CGAffineTransform(scaleX: CGFloat(k), y: CGFloat(k))
            .concatenating(CGAffineTransform(translationX: dotCentre.x - 2 * scale, y: dotCentre.y - 2 * scale)))
          image = faded(dot, d[0] * d[3]).composited(over: image)
        }
      }

      for ripple in frame.r where ripple.count == 4 && ripple[3] > 0.01 {
        let centre = toOutput(ripple[0], ripple[1])
        let diameter = ripple[2] * 2 * scale
        let k = diameter / Double(ring.extent.width)
        let faded = ring.applyingFilter("CIColorMatrix", parameters: ["inputAVector": CIVector(x: 0, y: 0, z: 0, w: CGFloat(ripple[3] / 0.55))])
        image = faded.transformed(by: CGAffineTransform(scaleX: CGFloat(k), y: CGFloat(k))
          .concatenating(CGAffineTransform(translationX: centre.x - diameter / 2, y: centre.y - diameter / 2))).composited(over: image)
      }

      if frame.pa > 0.01 {
        let k = cursorScale * frame.pp * scale / 6
        let at = toOutput(frame.px, frame.py)
        let faded = frame.pa >= 0.99 ? cursor : cursor.applyingFilter("CIColorMatrix", parameters: ["inputAVector": CIVector(x: 0, y: 0, z: 0, w: CGFloat(frame.pa))])
        image = faded.transformed(by: CGAffineTransform(scaleX: CGFloat(k), y: CGFloat(k))
          .concatenating(CGAffineTransform(translationX: at.x - tip.x * k, y: at.y - tip.y * k))).composited(over: image)
      }

      if let text = frame.b, frame.ba > 0.01 {
        let pill = badges[text] ?? badge(text, height: H * 0.052, dark: dark)
        badges[text] = pill
        let margin = H * 0.045
        let faded = frame.ba >= 0.99 ? pill : pill.applyingFilter("CIColorMatrix", parameters: ["inputAVector": CIVector(x: 0, y: 0, z: 0, w: CGFloat(frame.ba))])
        image = faded.transformed(by: CGAffineTransform(translationX: W - margin - pill.extent.width, y: margin)).composited(over: image)
      }

      // The closing card fades in over everything.
      if let e = frame.e, e > 0.001, let card {
        image = faded(card.composited(over: cardBackdrop), e).composited(over: image)
      }

      while !input.isReadyForMoreMediaData { usleep(2000) }
      guard let pool = adaptor.pixelBufferPool else { fail("no pixel buffer pool") }
      var buffer: CVPixelBuffer?
      CVPixelBufferPoolCreatePixelBuffer(nil, pool, &buffer)
      guard let buffer else { fail("no pixel buffer") }
      context.render(image.cropped(to: CGRect(x: 0, y: 0, width: W, height: H)), to: buffer,
                     bounds: CGRect(x: 0, y: 0, width: W, height: H), colorSpace: sRGB)
      adaptor.append(buffer, withPresentationTime: CMTime(value: CMTimeValue(index), timescale: CMTimeScale(plan.fps)))
      if index % (plan.fps * 5) == 0 {
        let elapsed = Date().timeIntervalSince(started)
        print("frame \(index)/\(plan.frames.count) \(String(format: "%.0f", elapsed)) s")
        fflush(stdout)
      }
    }

    input.markAsFinished()
    await writer.finishWriting()
    if writer.status != .completed { fail("writing failed: \(writer.error?.localizedDescription ?? "status \(writer.status.rawValue)")") }
    print("wrote \(outPath)")
  }
}
