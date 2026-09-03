// Helper for src/photon.js's `findScreenCaptureDeviceIndex` (ticket T09,
// PLAN.md §4 Group 4 "Input-to-photon, secondary", SPEC.md §10). Given a
// window's bounds (x,y,w,h, in the same global screen-coordinate space
// src/photon-window-list.swift reports), prints ONE line:
// "<index>,<displayOriginX>,<displayOriginY>,<displayWidth>,<displayHeight>"
// -- `index` is the containing display's position in
// `CGGetActiveDisplayList`'s own enumeration order (the same order
// avfoundation's "Capture screen N" device numbering follows -- verified
// empirically during this ticket's own fix: capturing avfoundation index 0
// on a two-display Mac produced a frame at exactly the built-in display's
// own (Retina-scaled) resolution, and index 1 produced a frame at exactly
// the external display's own resolution, in the same order
// CGGetActiveDisplayList returned them). The trailing four numbers are
// that SAME display's own `CGDisplayBounds` origin+size, so the caller can
// translate a global-coordinate-space region into that display's own
// LOCAL (capture-frame) coordinate space by subtracting the origin --
// verified empirically (this fix's own development) that avfoundation's
// per-display capture frame uses the identical top-left-origin, Y-down
// convention as CGDisplayBounds for the SAME display (no axis flip): a
// window at known global bounds, once its display's own origin was
// subtracted from it, cropped out of a real probe frame at exactly that
// window's own top-left corner.
//
// Fixes a real bug found via this ticket's own live verification:
// src/photon.js previously always recorded avfoundation's first-listed
// screen device, regardless of which physical display the target device
// window (emulator or simulator) actually sits on -- correct on a
// single-display Mac (there is only one display to be wrong about) but
// silently wrong on a multi-display Mac whenever the target window is on
// a non-primary display, producing a recording that never shows the
// window the resolved crop region describes.
//
// Invoked as a FILE ARGUMENT with the window's bounds as four CLI args
// (`swift src/photon-display-index.swift <x> <y> <w> <h>`) -- same
// file-argument convention as photon-window-list.swift (a stdin-piped
// `swift -` invocation was found, in this same ticket's earlier work, to
// hang indefinitely under Node's execFile).
import CoreGraphics
import Foundation

guard CommandLine.arguments.count > 4,
      let x = Double(CommandLine.arguments[1]),
      let y = Double(CommandLine.arguments[2]),
      let w = Double(CommandLine.arguments[3]),
      let h = Double(CommandLine.arguments[4]) else {
    FileHandle.standardError.write("usage: swift photon-display-index.swift <x> <y> <w> <h>\n".data(using: .utf8)!)
    exit(2)
}

// The window's own center point, not its top-left corner: a window that
// straddles a display boundary (rare, but possible near the edge of a
// multi-monitor arrangement) is more sensibly attributed to whichever
// display holds most of it, and the center is a simple, robust proxy for
// that without needing an actual area-of-intersection computation.
let centerX = x + w / 2
let centerY = y + h / 2

var count: UInt32 = 0
guard CGGetActiveDisplayList(0, nil, &count) == .success, count > 0 else {
    FileHandle.standardError.write("photon-display-index: CGGetActiveDisplayList failed to report any displays\n".data(using: .utf8)!)
    exit(1)
}
var ids = [CGDirectDisplayID](repeating: 0, count: Int(count))
CGGetActiveDisplayList(count, &ids, &count)

for (index, displayId) in ids.enumerated() {
    let bounds = CGDisplayBounds(displayId)
    if bounds.contains(CGPoint(x: centerX, y: centerY)) {
        print("\(index),\(bounds.origin.x),\(bounds.origin.y),\(bounds.size.width),\(bounds.size.height)")
        exit(0)
    }
}

// No display's bounds contain the window's center -- e.g. a window that
// reports stale/off-screen coordinates. Fall back to the main display's
// own index (never necessarily 0 in CGGetActiveDisplayList's own
// ordering, though it usually is) rather than failing outright: a wrong-
// but-plausible guess here still gives the caller SOME recording to
// analyze, and the existing "0/N taps resolved" safety net in
// src/photon.js catches a genuinely wrong guess the same way it already
// catches every other region-mismatch failure mode.
let mainId = CGMainDisplayID()
let mainBounds = CGDisplayBounds(mainId)
if let mainIndex = ids.firstIndex(of: mainId) {
    print("\(mainIndex),\(mainBounds.origin.x),\(mainBounds.origin.y),\(mainBounds.size.width),\(mainBounds.size.height)")
} else {
    print("0,\(mainBounds.origin.x),\(mainBounds.origin.y),\(mainBounds.size.width),\(mainBounds.size.height)")
}
