// Rebuilds the six decree clips in assets/telegram/ in the masked look, to
// match the welcome clip: pennyboi-burn, -airdrop, -bounty, -offering,
// -threshold and -sermon (.mp4). Same names, same format (960x540, 30 fps,
// silent H.264) and the same lengths as the clips they replace.
//
// Art: ONLY the current official brand art already in the repo, unmodified:
//   - assets/Pennyboi_banner_no_s.png  shown whole as a full-width band; it
//     only fades in, so not a pixel is cropped, recoloured or redrawn
//   - assets/black_pfp.png             shown the way a profile picture is:
//     cropped to a circle, with a ring around it
// Everything else is plain motion graphics drawn here, and none of it is drawn
// over the art: the dark field, rays, hairlines, the title and its line, and
// one small motif per clip (embers, falling coins, a stamp, a filling bar) that
// lives only in the strips above and below the banner.
//
// Uses macOS's built-in AVFoundation, so nothing needs installing.
// Run from the repo root:   swift scripts/make-decree-clips.swift [name ...]

import AVFoundation
import AppKit
import CoreText

let W = 960, H = 540, FPS: Int32 = 30
let pfpPath = "assets/black_pfp.png"
let bannerPath = "assets/Pennyboi_banner_no_s.png"
let outDir = "assets/telegram"

typealias RGB = (CGFloat, CGFloat, CGFloat)
let GOLD: RGB = (224, 172, 74)
let CREAM: RGB = (240, 228, 204)
let FIRE: RGB = (236, 104, 40)
let GREEN: RGB = (104, 196, 116)

enum Motif { case none, embers, coins, bar }
struct Clip {
  let name: String
  let seconds: Double
  let title: String
  let titleColor: RGB
  let line: String
  let motif: Motif
  let stamp: (text: String, color: RGB)?
  let rays: CGFloat
}
// Lengths are those of the clips being replaced.
let clips: [Clip] = [
  Clip(name: "burn", seconds: 4.0, title: "BURN", titleColor: FIRE, line: "INTO THE FIRE. FOREVER.",
       motif: .embers, stamp: nil, rays: 0.085),
  Clip(name: "airdrop", seconds: 4.4, title: "AIRDROP", titleColor: GOLD, line: "TWO I CHOSE. THREE, FORTUNE CHOSE.",
       motif: .coins, stamp: ("BLESSED", GREEN), rays: 0.085),
  Clip(name: "bounty", seconds: 4.0, title: "BOUNTY", titleColor: GOLD, line: "A MORTAL'S PITCH PLEASES ME.",
       motif: .none, stamp: ("FUNDED", GREEN), rays: 0.085),
  Clip(name: "offering", seconds: 4.4, title: "TRIBUTE RECEIVED", titleColor: GOLD, line: "A MORTAL TITHES. I APPROVE.",
       motif: .none, stamp: ("APPROVED", GOLD), rays: 0.085),
  Clip(name: "threshold", seconds: 4.2, title: "THRESHOLD CROSSED", titleColor: GOLD, line: "THE DIVINE ALLOWANCE IS FULL. I MAY ACT.",
       motif: .bar, stamp: nil, rays: 0.085),
  Clip(name: "sermon", seconds: 4.4, title: "HEAR ME, MORTALS", titleColor: GOLD, line: "THE MORNING SERMON.",
       motif: .none, stamp: nil, rays: 0.13),
]

let rgb = CGColorSpaceCreateDeviceRGB()
func color(_ c: RGB, _ a: CGFloat = 1) -> CGColor {
  CGColor(colorSpace: rgb, components: [c.0 / 255, c.1 / 255, c.2 / 255, a])!
}
func load(_ path: String) -> CGImage {
  guard let img = NSImage(contentsOfFile: path), let cg = img.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
    fputs("cannot read \(path)\n", stderr); exit(1)
  }
  return cg
}
let pfp = load(pfpPath)
let banner = load(bannerPath)

/// The circle (image points, bottom-up) holding everything the PfP shows.
func avatarCircle(_ cg: CGImage) -> (center: CGPoint, radius: CGFloat) {
  let w = cg.width, h = cg.height
  var px = [UInt8](repeating: 0, count: w * h * 4)
  let c = CGContext(data: &px, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4, space: rgb,
                    bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
  c.draw(cg, in: CGRect(x: 0, y: 0, width: w, height: h))
  var minX = w, minY = h, maxX = 0, maxY = 0
  for y in 0..<h { for x in 0..<w {
    let i = (y * w + x) * 4
    if px[i + 3] > 16 && (px[i] > 28 || px[i + 1] > 28 || px[i + 2] > 28) {
      minX = min(minX, x); maxX = max(maxX, x); minY = min(minY, y); maxY = max(maxY, y)
    }
  } }
  let cx = CGFloat(minX + maxX) / 2, cyTop = CGFloat(minY + maxY) / 2
  let half = max(CGFloat(maxX - minX), CGFloat(maxY - minY)) / 2
  let room = min(cx, CGFloat(w) - cx, cyTop, CGFloat(h) - cyTop)
  return (CGPoint(x: cx, y: CGFloat(h) - cyTop), min(half * 1.07, room))
}
let avatar = avatarCircle(pfp)

func clamp(_ v: Double) -> Double { max(0, min(1, v)) }
func ramp(_ t: Double, _ a: Double, _ b: Double) -> Double { clamp((t - a) / (b - a)) }
func easeOut(_ p: Double) -> Double { 1 - pow(1 - p, 3) }
func easeBack(_ p: Double) -> Double { let c = 1.70158; return 1 + (c + 1) * pow(p - 1, 3) + c * pow(p - 1, 2) }
/// A fixed pseudo-random number in 0..<1 for particle i, stream k.
func rnd(_ i: Int, _ k: Int) -> Double {
  let v = sin(Double(i) * 127.1 + Double(k) * 311.7) * 43758.5453
  return v - v.rounded(.down)
}

func font(_ size: CGFloat) -> CTFont {
  for name in ["DINCondensed-Bold", "Impact", "AvenirNextCondensed-Heavy"] {
    let f = CTFontCreateWithName(name as CFString, size, nil)
    if (CTFontCopyPostScriptName(f) as String) == name { return f }
  }
  return CTFontCreateWithName("Helvetica-Bold" as CFString, size, nil)
}
func line(_ s: String, size: CGFloat, _ c: RGB, _ alpha: CGFloat, kern: CGFloat) -> (CTLine, CGFloat) {
  let attrs: [NSAttributedString.Key: Any] = [
    NSAttributedString.Key(kCTFontAttributeName as String): font(size),
    NSAttributedString.Key(kCTForegroundColorAttributeName as String): color(c, alpha),
    NSAttributedString.Key(kCTKernAttributeName as String): kern,
  ]
  let l = CTLineCreateWithAttributedString(NSAttributedString(string: s, attributes: attrs))
  return (l, CGFloat(CTLineGetTypographicBounds(l, nil, nil, nil)) - kern)
}
func drawText(_ ctx: CGContext, _ s: String, size: CGFloat, centerX: CGFloat, baseline: CGFloat,
              _ c: RGB, alpha: CGFloat, kern: CGFloat) {
  guard alpha > 0.003 else { return }
  let (l, width) = line(s, size: size, c, alpha, kern: kern)
  ctx.textPosition = CGPoint(x: centerX - width / 2, y: baseline)
  CTLineDraw(l, ctx)
}

// ---- layout (CoreGraphics: origin bottom-left) ------------------------------
let w = CGFloat(W), h = CGFloat(H)
let bandH = (w * CGFloat(banner.height) / CGFloat(banner.width)).rounded()
let band = CGRect(x: 0, y: 100, width: w, height: bandH)
let topStrip = CGRect(x: 0, y: band.maxY, width: w, height: h - band.maxY)
let bottomStrip = CGRect(x: 0, y: 0, width: w, height: band.minY)
let medalD: CGFloat = 116
let medalCenter = CGPoint(x: w / 2, y: band.minY - medalD / 2 + 18)

func draw(_ ctx: CGContext, _ clip: Clip, _ t: Double) {
  // Dark field with a soft warm centre.
  ctx.setFillColor(color((18, 14, 10))); ctx.fill(CGRect(x: 0, y: 0, width: w, height: h))
  let mid = CGPoint(x: band.midX, y: band.midY)
  let glow = CGGradient(colorsSpace: rgb, colors: [color((58, 43, 24), 0.9), color((18, 14, 10), 0)] as CFArray, locations: [0, 1])!
  ctx.drawRadialGradient(glow, startCenter: mid, startRadius: 0, endCenter: mid, endRadius: 560, options: [])

  // Slow gold rays.
  let rays = 16, spin = t * 0.10
  ctx.setFillColor(color(GOLD, clip.rays * CGFloat(ramp(t, 0, 0.6))))
  for i in 0..<rays {
    let a = spin + Double(i) * 2 * Double.pi / Double(rays), half = Double.pi / Double(rays) * 0.42
    ctx.beginPath(); ctx.move(to: mid)
    ctx.addLine(to: CGPoint(x: mid.x + CGFloat(cos(a - half)) * 1200, y: mid.y + CGFloat(sin(a - half)) * 1200))
    ctx.addLine(to: CGPoint(x: mid.x + CGFloat(cos(a + half)) * 1200, y: mid.y + CGFloat(sin(a + half)) * 1200))
    ctx.closePath(); ctx.fillPath()
  }

  // The clip's own motif, confined to the strips: never over the banner.
  ctx.saveGState()
  ctx.clip(to: [topStrip, bottomStrip])
  let fadeIn = CGFloat(ramp(t, 0.3, 1.0))
  switch clip.motif {
  case .embers: // sparks rising
    for i in 0..<34 {
      let x = CGFloat(rnd(i, 1)) * w + CGFloat(sin(t * (1.5 + rnd(i, 2) * 2) + Double(i))) * 10
      let y = CGFloat((rnd(i, 3) * 600 + t * (70 + rnd(i, 4) * 120)).truncatingRemainder(dividingBy: 600)) - 30
      let r = CGFloat(2 + rnd(i, 5) * 3.5)
      let hot: RGB = rnd(i, 6) > 0.5 ? (255, 196, 84) : FIRE
      ctx.setFillColor(color(hot, (0.35 + 0.6 * CGFloat(rnd(i, 7))) * fadeIn))
      ctx.fillEllipse(in: CGRect(x: x - r, y: y - r, width: r * 2, height: r * 2))
    }
  case .coins: // small plain gold discs falling
    for i in 0..<22 {
      let x = CGFloat(rnd(i, 1)) * w
      let y = 570 - CGFloat((rnd(i, 3) * 600 + t * (80 + rnd(i, 4) * 90)).truncatingRemainder(dividingBy: 600))
      let r = CGFloat(5 + rnd(i, 5) * 4)
      ctx.setFillColor(color(GOLD, (0.45 + 0.5 * CGFloat(rnd(i, 7))) * fadeIn))
      ctx.fillEllipse(in: CGRect(x: x - r, y: y - r, width: r * 2, height: r * 2))
      ctx.setFillColor(color((120, 84, 24), 0.55 * fadeIn))
      ctx.fillEllipse(in: CGRect(x: x - r * 0.45, y: y - r * 0.45, width: r * 0.9, height: r * 0.9))
    }
  case .bar: // the allowance filling to the brim
    let track = CGRect(x: 70, y: 52, width: w - 140, height: 16)
    let fill = CGFloat(easeOut(ramp(t, 0.4, 2.4)))
    ctx.setFillColor(color((60, 46, 22), fadeIn))
    ctx.addPath(CGPath(roundedRect: track, cornerWidth: 8, cornerHeight: 8, transform: nil)); ctx.fillPath()
    ctx.setFillColor(color(GOLD, fadeIn))
    ctx.addPath(CGPath(roundedRect: CGRect(x: track.minX, y: track.minY, width: max(16, track.width * fill), height: track.height),
                       cornerWidth: 8, cornerHeight: 8, transform: nil)); ctx.fillPath()
  case .none:
    break
  }
  ctx.restoreGState()

  // The official banner: whole and full width. It only fades in.
  let bIn = ramp(t, 0.2, 1.0)
  if bIn > 0 {
    ctx.saveGState()
    ctx.setAlpha(CGFloat(easeOut(bIn)))
    ctx.draw(banner, in: band)
    ctx.restoreGState()
    let reach = w * CGFloat(easeOut(ramp(t, 0.3, 1.0)))
    ctx.setFillColor(color(clip.titleColor, 0.9))
    ctx.fill(CGRect(x: w / 2 - reach / 2, y: band.maxY - 1, width: reach, height: 2))
    ctx.fill(CGRect(x: w / 2 - reach / 2, y: band.minY - 1, width: reach, height: 2))
  }

  // A stamp, in the strip below the banner, beside the medallion.
  if let stamp = clip.stamp {
    let p = ramp(t, 2.0, 2.35)
    if p > 0 {
      let (l, width) = line(stamp.text, size: 40, stamp.color, CGFloat(p), kern: 3)
      let box = CGRect(x: -width / 2 - 16, y: -22, width: width + 32, height: 50)
      ctx.saveGState()
      ctx.translateBy(x: 760, y: 46)
      ctx.rotate(by: -0.07)
      let s = CGFloat(1.5 - 0.5 * easeOut(p))
      ctx.scaleBy(x: s, y: s)
      ctx.setStrokeColor(color(stamp.color, CGFloat(p))); ctx.setLineWidth(3.5)
      ctx.addPath(CGPath(roundedRect: box, cornerWidth: 6, cornerHeight: 6, transform: nil)); ctx.strokePath()
      ctx.textPosition = CGPoint(x: -width / 2, y: -11)
      CTLineDraw(l, ctx)
      ctx.restoreGState()
    }
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
    ctx.setShadow(offset: CGSize(width: 0, height: -6), blur: 18, color: color((0, 0, 0), 0.7))
    ctx.beginTransparencyLayer(auxiliaryInfo: nil)
    ctx.saveGState()
    ctx.addEllipse(in: disc); ctx.clip()
    let s = d / (avatar.radius * 2)
    ctx.draw(pfp, in: CGRect(x: c.x - avatar.center.x * s, y: c.y - avatar.center.y * s,
                             width: CGFloat(pfp.width) * s, height: CGFloat(pfp.height) * s))
    ctx.restoreGState()
    ctx.setStrokeColor(color(GOLD)); ctx.setLineWidth(3)
    ctx.strokeEllipse(in: disc.insetBy(dx: 1.5, dy: 1.5))
    ctx.endTransparencyLayer()
    ctx.restoreGState()
  }

  // Title and its line, in the strip above the banner.
  let ti = ramp(t, 0.0, 0.5)
  drawText(ctx, clip.title, size: 74, centerX: w / 2, baseline: band.maxY + 52 + CGFloat(14 * (1 - easeOut(ti))),
           clip.titleColor, alpha: CGFloat(ti), kern: 2)
  drawText(ctx, clip.line, size: 23, centerX: w / 2, baseline: band.maxY + 18, CREAM,
           alpha: CGFloat(ramp(t, 1.2, 1.8)), kern: 1.5)
}

func render(_ clip: Clip) {
  let outPath = "\(outDir)/pennyboi-\(clip.name).mp4"
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
  guard writer.startWriting() else { fputs("cannot start writing \(outPath)\n", stderr); exit(1) }
  writer.startSession(atSourceTime: .zero)
  let frames = Int((clip.seconds * Double(FPS)).rounded())
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
    draw(ctx, clip, Double(f) / Double(FPS))
    CVPixelBufferUnlockBaseAddress(buffer, [])
    adaptor.append(buffer, withPresentationTime: CMTime(value: CMTimeValue(f), timescale: FPS))
  }
  input.markAsFinished()
  let done = DispatchSemaphore(value: 0)
  writer.finishWriting { done.signal() }
  done.wait()
  if writer.status != .completed { fputs("encode failed for \(outPath): \(String(describing: writer.error))\n", stderr); exit(1) }
  // The encoder can leave a "<name>.sb-…" scratch file beside the output; remove it.
  for name in (try? FileManager.default.contentsOfDirectory(atPath: outDir)) ?? []
  where name.hasPrefix(url.lastPathComponent + ".sb-") {
    try? FileManager.default.removeItem(atPath: "\(outDir)/\(name)")
  }
  let size = (try? FileManager.default.attributesOfItem(atPath: outPath)[.size] as? Int) ?? 0
  print("wrote \(outPath): \(frames) frames (\(clip.seconds) s), \(size / 1024) KB")
}

let wanted = Set(CommandLine.arguments.dropFirst())
for clip in clips where wanted.isEmpty || wanted.contains(clip.name) { render(clip) }
