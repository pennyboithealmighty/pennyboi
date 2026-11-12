// Builds the trial images for the Gate of the Almighty (TG_GATE_ENABLED):
// assets/telegram/gate/gate-NN.jpg plus manifest.json (file -> correct cell).
//
// Each image is a 2x2 grid, cells numbered 1-4 (1 top-left, 2 top-right,
// 3 bottom-left, 4 bottom-right). One cell holds the OFFICIAL crowned-P coin
// (assets/black_pfp.png), drawn whole and only scaled to fit — never cropped,
// recoloured or redrawn. The other three hold DECOYS: plain flat coins drawn
// here in code, each with a different symbol and no crown, so they are clearly
// not official art. Which cell holds the true coin, and which decoys appear
// where, differs from image to image; Mouth picks an image at random per trial.
//
// Uses macOS's built-in frameworks, so nothing needs installing. The output is
// deterministic: the same script always writes the same set.
// Run from the repo root:   swift scripts/make-gate-grids.swift

import AppKit
import CoreText

let SIZE = 640, COUNT = 32
let coinPath = "assets/black_pfp.png"
let outDir = "assets/telegram/gate"

let rgb = CGColorSpaceCreateDeviceRGB()
func color(_ r: CGFloat, _ g: CGFloat, _ b: CGFloat, _ a: CGFloat = 1) -> CGColor {
  CGColor(colorSpace: rgb, components: [r / 255, g / 255, b / 255, a])!
}
guard let img = NSImage(contentsOfFile: coinPath), let coin = img.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
  fputs("cannot read \(coinPath)\n", stderr); exit(1)
}

// A small deterministic generator, so the set is reproducible.
struct LCG { var s: UInt64
  mutating func next() -> UInt64 { s = s &* 6364136223846793005 &+ 1442695040888963407; return s >> 33 }
  mutating func pick(_ n: Int) -> Int { Int(next() % UInt64(n)) }
}

// Decoys: flat colour, flat rim, one symbol. Some share the true coin's warm
// tones or a P-like letter, so "the gold one" is not the answer by itself.
struct Decoy { let symbol: String; let face: (CGFloat, CGFloat, CGFloat); let ink: (CGFloat, CGFloat, CGFloat) }
let decoys: [Decoy] = [
  Decoy(symbol: "B", face: (201, 150, 62), ink: (74, 48, 12)),
  Decoy(symbol: "R", face: (178, 112, 52), ink: (58, 30, 8)),
  Decoy(symbol: "D", face: (214, 170, 80), ink: (86, 58, 16)),
  Decoy(symbol: "F", face: (150, 96, 48), ink: (40, 22, 8)),
  Decoy(symbol: "9", face: (190, 134, 58), ink: (64, 40, 10)),
  Decoy(symbol: "$", face: (118, 158, 110), ink: (24, 52, 28)),
  Decoy(symbol: "?", face: (128, 136, 168), ink: (28, 34, 64)),
  Decoy(symbol: "X", face: (168, 168, 172), ink: (48, 48, 54)),
  Decoy(symbol: "8", face: (164, 120, 160), ink: (56, 26, 56)),
  Decoy(symbol: "Z", face: (110, 160, 168), ink: (18, 54, 62)),
  Decoy(symbol: "&", face: (176, 126, 110), ink: (64, 28, 20)),
  Decoy(symbol: "#", face: (150, 150, 110), ink: (48, 48, 18)),
  Decoy(symbol: "%", face: (132, 148, 132), ink: (30, 44, 30)),
  Decoy(symbol: "Q", face: (206, 158, 96), ink: (78, 46, 14)),
]

func font(_ size: CGFloat, _ names: [String]) -> CTFont {
  for name in names {
    let f = CTFontCreateWithName(name as CFString, size, nil)
    if (CTFontCopyPostScriptName(f) as String) == name { return f }
  }
  return CTFontCreateWithName("Helvetica-Bold" as CFString, size, nil)
}
func drawCentered(_ ctx: CGContext, _ s: String, _ f: CTFont, _ c: CGColor, at p: CGPoint) {
  let attrs: [NSAttributedString.Key: Any] = [
    NSAttributedString.Key(kCTFontAttributeName as String): f,
    NSAttributedString.Key(kCTForegroundColorAttributeName as String): c,
  ]
  let line = CTLineCreateWithAttributedString(NSAttributedString(string: s, attributes: attrs))
  let b = CTLineGetBoundsWithOptions(line, .useGlyphPathBounds)
  ctx.textPosition = CGPoint(x: p.x - b.midX, y: p.y - b.midY)
  CTLineDraw(line, ctx)
}

let cell = CGFloat(SIZE) / 2
/// Cell n (1-4) in CoreGraphics coordinates (origin bottom-left).
func cellRect(_ n: Int) -> CGRect {
  let col = CGFloat((n - 1) % 2), rowFromTop = CGFloat((n - 1) / 2)
  return CGRect(x: col * cell, y: (1 - rowFromTop) * cell, width: cell, height: cell)
}

func drawDecoy(_ ctx: CGContext, _ d: Decoy, in r: CGRect) {
  let dia = cell * 0.60
  let disc = CGRect(x: r.midX - dia / 2, y: r.midY - dia / 2 - 6, width: dia, height: dia)
  ctx.setFillColor(color(d.ink.0, d.ink.1, d.ink.2)); ctx.fillEllipse(in: disc)             // rim
  ctx.setFillColor(color(d.face.0, d.face.1, d.face.2)); ctx.fillEllipse(in: disc.insetBy(dx: 9, dy: 9))
  ctx.setStrokeColor(color(d.ink.0, d.ink.1, d.ink.2, 0.55)); ctx.setLineWidth(2)
  ctx.strokeEllipse(in: disc.insetBy(dx: 20, dy: 20))
  drawCentered(ctx, d.symbol, font(dia * 0.52, ["Georgia-Bold", "TimesNewRomanPS-BoldMT"]),
               color(d.ink.0, d.ink.1, d.ink.2), at: CGPoint(x: disc.midX, y: disc.midY))
}

try? FileManager.default.createDirectory(atPath: outDir, withIntermediateDirectories: true)
for name in (try? FileManager.default.contentsOfDirectory(atPath: outDir)) ?? [] where name.hasPrefix("gate-") {
  try? FileManager.default.removeItem(atPath: "\(outDir)/\(name)")
}

var rng = LCG(s: 0x50454E4E59)
var manifest: [[String: Any]] = []
for i in 0..<COUNT {
  let answer = i % 4 + 1 // each cell is the answer equally often
  var pool = Array(decoys.indices)
  var chosen: [Decoy] = []
  for _ in 0..<3 { chosen.append(decoys[pool.remove(at: rng.pick(pool.count))]) }

  let ctx = CGContext(data: nil, width: SIZE, height: SIZE, bitsPerComponent: 8, bytesPerRow: SIZE * 4, space: rgb,
                      bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
  ctx.interpolationQuality = .high
  ctx.setFillColor(color(0, 0, 0)); ctx.fill(CGRect(x: 0, y: 0, width: SIZE, height: SIZE))

  var next = 0
  for n in 1...4 {
    let r = cellRect(n)
    if n == answer {
      // The official coin: the whole image, scaled uniformly into the cell.
      let side = cell * 0.94
      ctx.draw(coin, in: CGRect(x: r.midX - side / 2, y: r.midY - side / 2, width: side, height: side))
    } else {
      drawDecoy(ctx, chosen[next], in: r); next += 1
    }
  }
  // Gold dividers and the cell numbers the buttons refer to.
  ctx.setFillColor(color(224, 172, 74, 0.9))
  ctx.fill(CGRect(x: cell - 1, y: 0, width: 2, height: CGFloat(SIZE)))
  ctx.fill(CGRect(x: 0, y: cell - 1, width: CGFloat(SIZE), height: 2))
  for n in 1...4 {
    let r = cellRect(n)
    let badge = CGRect(x: r.minX + 10, y: r.maxY - 52, width: 42, height: 42)
    ctx.setFillColor(color(224, 172, 74)); ctx.fillEllipse(in: badge)
    drawCentered(ctx, "\(n)", font(28, ["DINCondensed-Bold", "Impact"]), color(0, 0, 0),
                 at: CGPoint(x: badge.midX, y: badge.midY))
  }

  let file = String(format: "gate-%02d.jpg", i + 1)
  let rep = NSBitmapImageRep(cgImage: ctx.makeImage()!)
  let data = rep.representation(using: .jpeg, properties: [.compressionFactor: 0.8])!
  try! data.write(to: URL(fileURLWithPath: "\(outDir)/\(file)"))
  manifest.append(["file": file, "answer": answer])
}
let json = try! JSONSerialization.data(withJSONObject: ["cells": 4, "grids": manifest], options: [.prettyPrinted, .sortedKeys])
try! json.write(to: URL(fileURLWithPath: "\(outDir)/manifest.json"))
print("wrote \(COUNT) grids + manifest.json to \(outDir)")
