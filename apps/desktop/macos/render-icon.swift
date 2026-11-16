// Renders an SVG to a square PNG: render-icon <in.svg> <pixels> <out.png>. AppKit only (Command Line Tools SDK).
import AppKit
let a = CommandLine.arguments
guard a.count == 4, let px = Int(a[2]), let img = NSImage(contentsOf: URL(fileURLWithPath: a[1])) else {
  FileHandle.standardError.write("render-icon: bad args or unreadable svg\n".data(using: .utf8)!); exit(2)
}
guard let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: px, pixelsHigh: px, bitsPerSample: 8, samplesPerPixel: 4,
  hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0) else { exit(2) }
rep.size = NSSize(width: px, height: px)
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
NSColor.clear.set(); NSRect(x: 0, y: 0, width: px, height: px).fill(using: .copy)
img.draw(in: NSRect(x: 0, y: 0, width: px, height: px), from: .zero, operation: .sourceOver, fraction: 1)
NSGraphicsContext.restoreGraphicsState()
try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: a[3]))
