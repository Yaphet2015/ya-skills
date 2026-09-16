import AppKit
let root = "/tmp/ya-native-20260916/matrix-nonkey"
try? FileManager.default.createDirectory(atPath: root, withIntermediateDirectories: true)
let app = NSApplication.shared
app.setActivationPolicy(.prohibited)
let initial = NSWorkspace.shared.frontmostApplication?.processIdentifier ?? -1
var changes: [[String: Any]] = []
var clicks = 0
var canvasClicks = 0
var keyEvents = 0
var scrollEvents = 0
var events: [[String: Any]] = []
func record(_ kind: String) { events.append(["kind": kind, "at": Date().timeIntervalSince1970]); publish() }
final class Handler: NSObject {
 @objc func clicked(_ sender: Any?) { clicks += 1; record("button") }
}
final class Canvas: NSView {
 override var isFlipped: Bool { true }
 override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
 override var acceptsFirstResponder: Bool { false }
 override func isAccessibilityElement() -> Bool { false }
 override func draw(_ dirtyRect: NSRect) {
  NSColor.systemBlue.setFill(); bounds.fill()
  ("Canvas" as NSString).draw(at: NSPoint(x: 25, y: 25), withAttributes: [.foregroundColor: NSColor.white])
 }
 override func mouseDown(with event: NSEvent) { canvasClicks += 1; record("canvas") }
 override func keyDown(with event: NSEvent) { keyEvents += 1; record("key") }
 override func scrollWheel(with event: NSEvent) { scrollEvents += 1; record("scroll") }
}
let handler = Handler()
final class NonKeyPanel: NSPanel {
 override var canBecomeKey: Bool { false }
 override var canBecomeMain: Bool { false }
}
let panel = NonKeyPanel(contentRect: NSRect(x: 80, y: 100, width: 520, height: 300), styleMask: [.titled, .nonactivatingPanel], backing: .buffered, defer: false)
panel.title = "YK native acceptance fixture"
panel.hidesOnDeactivate = false
let button = NSButton(title: "Increment", target: handler, action: #selector(Handler.clicked(_:)))
button.frame = NSRect(x: 20, y: 220, width: 140, height: 36)
let field = NSTextField(frame: NSRect(x: 20, y: 150, width: 280, height: 32))
field.setAccessibilityLabel("Fixture input")
let canvas = Canvas(frame: NSRect(x: 330, y: 70, width: 160, height: 150))
canvas.setAccessibilityHidden(true)
panel.contentView?.addSubview(button); panel.contentView?.addSubview(field); panel.contentView?.addSubview(canvas)
func publish() {
 let data: [String: Any] = ["at": Date().timeIntervalSince1970, "pid": ProcessInfo.processInfo.processIdentifier, "windowId": panel.windowNumber, "initialFrontmostPid": initial, "frontmostPid": NSWorkspace.shared.frontmostApplication?.processIdentifier ?? -1, "activationChanges": changes, "clicks": clicks, "canvasClicks": canvasClicks, "keyEvents": keyEvents, "scrollEvents": scrollEvents, "events": events, "value": field.stringValue, "windowX": panel.frame.minX, "windowY": panel.frame.minY, "isKeyWindow": panel.isKeyWindow, "isMainWindow": panel.isMainWindow, "scale": panel.backingScaleFactor, "screenScales": NSScreen.screens.map { $0.backingScaleFactor }]
 if let json = try? JSONSerialization.data(withJSONObject: data, options: [.sortedKeys]) { try? json.write(to: URL(fileURLWithPath: root + "/state.json"), options: .atomic) }
}
let observer = NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main) { note in
 if let active = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication { changes.append(["pid": active.processIdentifier, "at": Date().timeIntervalSince1970]); publish() }
}
panel.orderFrontRegardless(); publish()
Timer.scheduledTimer(withTimeInterval: 0.05, repeats: true) { _ in
 let url = URL(fileURLWithPath: root + "/control.json")
 if let data = try? Data(contentsOf: url), let command = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
  try? FileManager.default.removeItem(at: url)
  if let x = command["x"] as? Double, let y = command["y"] as? Double { panel.setFrameOrigin(NSPoint(x: x, y: y)); record("move") }
  if command["quit"] as? Bool == true { publish(); app.terminate(nil) }
 }
 publish()
}
Timer.scheduledTimer(withTimeInterval: 1800, repeats: false) { _ in app.terminate(nil) }
app.run()
