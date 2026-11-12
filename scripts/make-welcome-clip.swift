// Builds assets/telegram/pennyboi-welcome.mp4: the Telegram welcome clip
// (TG_WELCOME_CLIP_ENABLED). 960x540, 30 fps, 5 s, silent H.264 — the same
// format as the decree clips in assets/telegram/.
//
// Art: ONLY the current official brand art already in the repo, unmodified:
//   - assets/Pennyboi_banner_no_s.png  the black-and-gold banner, shown whole
//     as a full-width band (scaled uniformly, nothing redrawn or recoloured)
//   - assets/black_pfp.png             the crowned-P PfP, shown the way a
//     profile picture is: cropped to a circle, with a ring around it
// Everything else on screen is plain motion graphics drawn here: the dark
// field, slow gold rays, two hairlines and the title. No character art is
// generated or altered.
//
// Uses macOS's built-in AVFoundation, so nothing needs installing.
// Run from the repo root:   swift scripts/make-welcome-clip.swift [pfp.png] [banner.png] [out.mp4]

import AVFoundation
import AppKit
import CoreText

let W = 960, H = 540, FPS: Int32 = 30, SECONDS = 5.0
let args = CommandLine.arguments
let pfpPath = args.count > 1 ? args[1] : "assets/black_pfp.png"
let bannerPath = args.count > 2 ? args[2] : "assets/Pennyboi_banner_no_s.png"
let outPath = args.count > 3 ? args[3] : "assets/telegram/pennyboi-welcome.mp4"

let rgb = CGColorSpaceCreateDeviceRGB()
func color(_ r: CGFloat, _ g: CGFloat, _ b: CGFloat, _ a: CGFloat = 1) -> CGColor {
  CGColor(colorSpace: rgb, components: [r / 255, g / 255, b / 255, a])!
}
let GOLD: (CGFloat, CGFloat, CGFloat) = (224, 172, 74)

func load(_ path: String) -> CGImage {
  guard let img = NSImage(contentsOfFile: path), let cg = img.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
    fputs("cannot read \(path)\n", stderr); exit(1)
  }
  return cg
}
let pfp = load(pfpPath)
let banner = load(bannerPath)

/// The circle (in image points, bottom-up) that holds everything the PfP shows:
/// centred on its non-black content and just wide enough to contain it.
func avatarCircle(_ cg: CGImage) -> (center: CGPoint, radius: CGFloat) {
  let w = cg.width, h = cg.height
  var px = [UInt8](repeating: 0, count: w * h * 4)
  let c = CGContext(data: &px, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4, space: rgb,
                    bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
  c.draw(cg, in: CGRect(x: 0, y: 0, width: w, height: h))
  var minX = w, minY = h, maxX = 0, maxY = 0
  for y in 0..<h { for x in 0..<w {
    let i = (y * w + x) * 4
    if px[i + 3] > 16 && (px[i] > 28 || px[i + 1] > 28 || px[i + 2] > 28) { // neither clear nor backdrop black
      minX = min(minX, x); maxX = max(maxX, x); minY = min(minY, y); maxY = max(maxY, y)
    }
  } }
  let cx = CGFloat(minX + maxX) / 2, cyTop = CGFloat(minY + maxY) / 2
  let half = max(CGFloat(maxX - minX), CGFloat(maxY - minY)) / 2
  // A little air around the art, but never past the edge of the image.
  let room = min(cx, CGFloat(w) - cx, cyTop, CGFloat(h) - cyTop)
  return (CGPoint(x: cx, y: CGFloat(h) - cyTop), min(half * 1.07, room))
}
let avatar = avatarCircle(pfp)

// ---- easing ----------------------------------------------------------------
func clamp(_ v: Double) -> Double { max(0, min(1, v)) }
func ramp(_ t: Double, _ a: Double, _ b: Double) -> Double { clamp((t - a) / (b - a)) }
func easeOut(_ p: Double) -> Double { 1 - pow(1 - p, 3) }
func easeBack(_ p: Double) -> Double { let c = 1.70158; return 1 + (c + 1) * pow(p - 1, 3) + c * pow(p - 1, 2) }

func font(_ size: CGFloat) -> CTFont {
  for name in ["DINCondensed-Bold", "Impact", "AvenirNextCondensed-Heavy"] {
    let f = CTFontCreateWithName(name as CFString, size, nil)
    if (CTFontCopyPostScriptName(f) as String) == name { return f }
  }
  return CTFontCreateWithName("Helvetica-Bold" as CFString, size, nil)
}
func drawText(_ ctx: CGContext, _ s: String, size: CGFloat, centerX: CGFloat, baseline: CGFloat,
              rgbv: (CGFloat, CGFloat, CGFloat), alpha: CGFloat, kern: CGFloat) {
  guard alpha > 0.003 else { return }
  let attrs: [NSAttributedString.Key: Any] = [
    NSAttributedString.Key(kCTFontAttributeName as String): font(size),
    NSAttributedString.Key(kCTForegroundColorAttributeName as String): color(rgbv.0, rgbv.1, rgbv.2, alpha),
    NSAttributedString.Key(kCTKernAttributeName as String): kern,
  ]
  let line = CTLineCreateWithAttributedString(NSAttributedString(string: s, attributes: attrs))
  let width = CGFloat(CTLineGetTypographicBounds(line, nil, nil, nil)) - kern
  ctx.textPosition = CGPoint(x: centerX - width / 2, y: baseline)
  CTLineDraw(line, ctx)
}

// ---- layout (CoreGraphics: origin bottom-left) ------------------------------
let w = CGFloat(W), h = CGFloat(H)
let bandH = (w * CGFloat(banner.height) / CGFloat(banner.width)).rounded() // the banner at full width
let band = CGRect(x: 0, y: 100, width: w, height: bandH)
let medalD: CGFloat = 116
let medalCenter = CGPoint(x: w / 2, y: band.minY - medalD / 2 + 18) // sits on the band's lower edge

// ---- one frame -------------------------------------------------------------
func draw(_ ctx: CGContext, _ t: Double) {
  // Dark field with a soft warm centre, like the decree clips.
  ctx.setFillColor(color(18, 14, 10)); ctx.fill(CGRect(x: 0, y: 0, width: w, height: h))
  let mid = CGPoint(x: band.midX, y: band.midY)
  let glow = CGGradient(colorsSpace: rgb, colors: [color(58, 43, 24, 0.9), color(18, 14, 10, 0)] as CFArray, locations: [0, 1])!
  ctx.drawRadialGradient(glow, startCenter: mid, startRadius: 0, endCenter: mid, endRadius: 560, options: [])

  // Slow gold rays, seen above and below the banner.
  let rays = 16, spin = t * 0.10
  ctx.setFillColor(color(GOLD.0, GOLD.1, GOLD.2, 0.085 * CGFloat(ramp(t, 0, 0.6))))
  for i in 0..<rays {
    let a = spin + Double(i) * 2 * Double.pi / Double(rays), half = Double.pi / Double(rays) * 0.42
    ctx.beginPath(); ctx.move(to: mid)
    ctx.addLine(to: CGPoint(x: mid.x + CGFloat(cos(a - half)) * 1200, y: mid.y + CGFloat(sin(a - half)) * 1200))
    ctx.addLine(to: CGPoint(x: mid.x + CGFloat(cos(a + half)) * 1200, y: mid.y + CGFloat(sin(a + half)) * 1200))
    ctx.closePath(); ctx.fillPath()
  }

  // The official banner: whole and full width. It only fades in — no zoom or
  // pan, so not a pixel of it is cropped.
  let bIn = ramp(t, 0.2, 1.0)
  if bIn > 0 {
    ctx.saveGState()
    ctx.setAlpha(CGFloat(easeOut(bIn)))
    ctx.draw(banner, in: band)
    ctx.restoreGState()
    // Gold hairlines along its top and bottom edges, drawn out from the centre.
    let reach = w * CGFloat(easeOut(ramp(t, 0.3, 1.0)))
    ctx.setFillColor(color(GOLD.0, GOLD.1, GOLD.2, 0.9))
    ctx.fill(CGRect(x: w / 2 - reach / 2, y: band.maxY - 1, width: reach, height: 2))
    ctx.fill(CGRect(x: w / 2 - reach / 2, y: band.minY - 1, width: reach, height: 2))
  }

  // The official PfP as a ringed medallion: circle-cropped like any profile picture.
  let pop = ramp(t, 0.9, 1.6)
  if pop > 0 {
    let scale = CGFloat(0.4 + 0.6 * easeBack(pop))
    let bob = CGFloat(sin(max(0, t - 1.6) * 2 * Double.pi / 2.6) * 2.5)
    let d = medalD * scale
    let c = CGPoint(x: medalCenter.x, y: medalCenter.y + bob)
    let disc = CGRect(x: c.x - d / 2, y: c.y - d / 2, width: d, height: d)
    ctx.saveGState()
    ctx.setAlpha(CGFloat(ramp(t, 0.9, 1.25)))
    ctx.setShadow(offset: CGSize(width: 0, height: -6), blur: 18, color: color(0, 0, 0, 0.7))
    ctx.beginTransparencyLayer(auxiliaryInfo: nil)
    ctx.saveGState()
    ctx.addEllipse(in: disc); ctx.clip()
    let s = d / (avatar.radius * 2)
    ctx.draw(pfp, in: CGRect(x: c.x - avatar.center.x * s, y: c.y - avatar.center.y * s,
                             width: CGFloat(pfp.width) * s, height: CGFloat(pfp.height) * s))
    ctx.restoreGState()
    ctx.setStrokeColor(color(GOLD.0, GOLD.1, GOLD.2)); ctx.setLineWidth(3)
    ctx.strokeEllipse(in: disc.insetBy(dx: 1.5, dy: 1.5))
    ctx.endTransparencyLayer()
    ctx.restoreGState()
  }

  // Title, centred in the strip above the banner.
  let ti = ramp(t, 0.0, 0.5)
  let stripMid = (band.maxY + h) / 2
  drawText(ctx, "WELCOME, MORTAL", size: 84, centerX: w / 2, baseline: stripMid - 28 + CGFloat(16 * (1 - easeOut(ti))),
           rgbv: GOLD, alpha: CGFloat(ti), kern: 2)
}

// ---- encode ----------------------------------------------------------------
let url = URL(fileURLWithPath: outPath)
try? FileManager.default.removeItem(at: url)
let writer = try! AVAssetWriter(outputURL: url, fileType: .mp4)
writer.shouldOptimizeForNetworkUse = true
let input = AVAssetWriterInput(mediaType: .video, outputSettings: [
  AVVideoCodecKey: AVVideoCodecType.h264,
  AVVideoWidthKey: W, AVVideoHeightKey: H,
  AVVideoCompressionPropertiesKey: [
    AVVideoAverageBitRateKey: 700_000,
    AVVideoMaxKeyFrameIntervalKey: 30,
    AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel,
  ],
])
input.expectsMediaDataInRealTime = false
let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: [
  kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
  kCVPixelBufferWidthKey as String: W, kCVPixelBufferHeightKey as String: H,
])
writer.add(input)
guard writer.startWriting() else { fputs("cannot start writing: \(String(describing: writer.error))\n", stderr); exit(1) }
writer.startSession(atSourceTime: .zero)

let frames = Int(SECONDS * Double(FPS))
for f in 0..<frames {
  while !input.isReadyForMoreMediaData { usleep(2000) }
  var pb: CVPixelBuffer?
  CVPixelBufferPoolCreatePixelBuffer(nil, adaptor.pixelBufferPool!, &pb)
  let buffer = pb!
  CVPixelBufferLockBaseAddress(buffer, [])
  let ctx = CGContext(data: CVPixelBufferGetBaseAddress(buffer), width: W, height: H, bitsPerComponent: 8,
                      bytesPerRow: CVPixelBufferGetBytesPerRow(buffer), space: rgb,
                      bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue)!
  ctx.interpolationQuality = .high
  draw(ctx, Double(f) / Double(FPS))
  CVPixelBufferUnlockBaseAddress(buffer, [])
  adaptor.append(buffer, withPresentationTime: CMTime(value: CMTimeValue(f), timescale: FPS))
}
input.markAsFinished()
let done = DispatchSemaphore(value: 0)
writer.finishWriting { done.signal() }
done.wait()
if writer.status != .completed { fputs("encode failed: \(String(describing: writer.error))\n", stderr); exit(1) }
// The encoder can leave a "<name>.sb-…" scratch file beside the output; remove it.
let outDir = url.deletingLastPathComponent()
for name in (try? FileManager.default.contentsOfDirectory(atPath: outDir.path)) ?? []
where name.hasPrefix(url.lastPathComponent + ".sb-") {
  try? FileManager.default.removeItem(at: outDir.appendingPathComponent(name))
}
let size = (try? FileManager.default.attributesOfItem(atPath: outPath)[.size] as? Int) ?? 0
print("wrote \(outPath): \(W)x\(H), \(frames) frames at \(FPS) fps (\(SECONDS) s), \(size / 1024) KB | banner band \(Int(band.width))x\(Int(band.height)) | avatar circle r=\(Int(avatar.radius)) of \(pfp.width)px")
