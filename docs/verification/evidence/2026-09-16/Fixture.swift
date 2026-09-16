import AppKit
let root = "/tmp/ya-native-20260916"
let app = NSApplication.shared
app.setActivationPolicy(.prohibited)
let initial = NSWorkspace.shared.frontmostApplication?.processIdentifier ?? -1
var changes: [Int32] = []
var clicks = 0
final class Handler: NSObject {
  @objc func clicked(_ sender: Any?) { clicks += 1; publish() }
}
let handler = Handler()
let panel = NSPanel(contentRect: NSRect(x: 80, y: 100, width: 420, height: 240), styleMask: [.titled, .nonactivatingPanel], backing: .buffered, defer: false)
panel.title = "YK owned background fixture"
panel.hidesOnDeactivate = false
let button = NSButton(title: "Increment", target: handler, action: #selector(Handler.clicked(_:)))
button.frame = NSRect(x: 20, y: 140, width: 140, height: 36)
let field = NSTextField(frame: NSRect(x: 20, y: 70, width: 280, height: 32))
field.setAccessibilityLabel("Fixture input")
panel.contentView?.addSubview(button)
panel.contentView?.addSubview(field)
func publish() {
  let data: [String: Any] = ["pid": ProcessInfo.processInfo.processIdentifier, "windowId": panel.windowNumber, "initialFrontmostPid": initial, "frontmostPid": NSWorkspace.shared.frontmostApplication?.processIdentifier ?? -1, "activationChanges": changes, "clicks": clicks, "value": field.stringValue, "windowX": panel.frame.minX, "windowY": panel.frame.minY, "scale": panel.backingScaleFactor]
  if let json = try? JSONSerialization.data(withJSONObject: data, options: [.sortedKeys]) { try? json.write(to: URL(fileURLWithPath: root + "/state.json"), options: .atomic) }
}
let observer = NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main) { note in
  if let active = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication { changes.append(active.processIdentifier); publish() }
}
panel.orderFrontRegardless()
publish()
Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { _ in publish() }
Timer.scheduledTimer(withTimeInterval: 180, repeats: false) { _ in app.terminate(nil) }
app.run()
