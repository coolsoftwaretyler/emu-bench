// Helper for src/photon.js's `autoDetectRegionViaCoreGraphics` (ticket T09,
// PLAN.md §4 Group 4 "Input-to-photon, secondary", SPEC.md §10). Prints one
// "x,y,w,h" line per on-screen window whose owning process name contains
// `CommandLine.arguments[1]` (case-insensitive) -- src/photon.js picks the
// largest-area match as the device window's on-screen bounds.
//
// Invoked as a FILE ARGUMENT (`swift src/photon-window-list.swift <pattern>`),
// never piped via stdin -- see the doc comment on
// `autoDetectRegionViaCoreGraphics` in src/photon.js for why: an earlier
// stdin-piped version of this same script (`swift -` with the script text
// passed as `execFile`'s `input` option) reproducibly hung indefinitely
// under Node's `child_process.execFile`, even though the identical script
// text worked instantly through a plain shell pipe -- isolated to something
// specific about how Node's execFile writes+closes the stdin pipe vs. how
// `swift -` expects it. A file argument sidesteps the whole issue and is
// faster besides (~100ms observed vs. a 15s+ hang).
import CoreGraphics
import Foundation

guard CommandLine.arguments.count > 1 else {
    FileHandle.standardError.write("usage: swift photon-window-list.swift <process-name-pattern>\n".data(using: .utf8)!)
    exit(2)
}
let pattern = CommandLine.arguments[1]

guard let list = CGWindowListCopyWindowInfo(.optionOnScreenOnly, kCGNullWindowID) as? [[String: AnyObject]] else {
    exit(1)
}

for w in list {
    let owner = (w[kCGWindowOwnerName as String] as? String) ?? ""
    guard owner.localizedCaseInsensitiveContains(pattern) else { continue }
    guard let b = w[kCGWindowBounds as String] as? [String: Any],
          let x = b["X"] as? Double, let y = b["Y"] as? Double,
          let width = b["Width"] as? Double, let height = b["Height"] as? Double else { continue }
    print("\(x),\(y),\(width),\(height)")
}
