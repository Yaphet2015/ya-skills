// Opt-in AppKit fixture for computer-use native acceptance. Never launched by
// the default test suite. Usage: fixture <absolute-output-dir> [--block-press]
// The panel cannot become key/main, even when background input reaches it.
import AppKit

guard CommandLine.arguments.count >= 2, CommandLine.arguments[1].hasPrefix("/") else {
    fputs("usage: fixture <absolute-output-dir> [--block-press]\n", stderr)
    exit(2)
}
let outputDirectory = CommandLine.arguments[1]
let blockPress = CommandLine.arguments.dropFirst(2).contains("--block-press")
try FileManager.default.createDirectory(atPath: outputDirectory, withIntermediateDirectories: true)
let app = NSApplication.shared
app.setActivationPolicy(.prohibited)
let initialFrontmost = NSWorkspace.shared.frontmostApplication?.processIdentifier ?? -1
var activations: [[String: Any]] = []
var events: [[String: Any]] = []
var buttonClicks = 0
var canvasClicks = 0
var keyEvents = 0
var scrollEvents = 0
var alternateColor = false

@Sendable
func writeJSON(_ value: [String: Any], to name: String) {
    guard let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) else { return }
    try? data.write(to: URL(fileURLWithPath: outputDirectory + "/" + name), options: .atomic)
}

@MainActor
func record(_ kind: String) {
    events.append(["kind": kind, "at": Date().timeIntervalSince1970])
    publish()
}

final class NonKeyPanel: NSPanel {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

final class Handler: NSObject {
    @MainActor @objc func clicked(_ sender: Any?) {
        buttonClicks += 1
        record("button")
    }
}

// A real AX action enters this callback before the cancellation test proceeds.
// The external probe releases it after receiving the terminal request result.
final class BlockingButton: NSButton {
    override func accessibilityPerformPress() -> Bool {
        writeJSON([
            "kind": "AXPress entered",
            "at": Date().timeIntervalSince1970,
            "pid": ProcessInfo.processInfo.processIdentifier
        ], to: "entered.json")
        let deadline = Date().addingTimeInterval(15)
        while Date() < deadline && !FileManager.default.fileExists(atPath: outputDirectory + "/release") {
            Thread.sleep(forTimeInterval: 0.01)
        }
        buttonClicks += 1
        record("blocking-button-completed")
        return true
    }
}

final class Canvas: NSView {
    override var isFlipped: Bool { true }
    override var acceptsFirstResponder: Bool { false }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override func isAccessibilityElement() -> Bool { false }
    override func draw(_ dirtyRect: NSRect) {
        (alternateColor ? NSColor.systemGreen : NSColor.systemBlue).setFill()
        bounds.fill()
        ("Canvas" as NSString).draw(at: NSPoint(x: 25, y: 25), withAttributes: [.foregroundColor: NSColor.white])
    }
    override func mouseDown(with event: NSEvent) {
        canvasClicks += 1
        record("canvas")
    }
    override func keyDown(with event: NSEvent) {
        keyEvents += 1
        record("key")
    }
    override func scrollWheel(with event: NSEvent) {
        scrollEvents += 1
        record("scroll")
    }
}

let handler = Handler()
let panel = NonKeyPanel(
    contentRect: NSRect(x: 80, y: 100, width: 520, height: 300),
    styleMask: [.titled, .nonactivatingPanel], backing: .buffered, defer: false
)
panel.title = "YK native acceptance fixture"
panel.hidesOnDeactivate = false
let button: NSButton = blockPress
    ? BlockingButton(title: "Block Increment", target: handler, action: #selector(Handler.clicked(_:)))
    : NSButton(title: "Increment", target: handler, action: #selector(Handler.clicked(_:)))
button.frame = NSRect(x: 20, y: 220, width: 140, height: 36)
let field = NSTextField(frame: NSRect(x: 20, y: 150, width: 280, height: 32))
field.isEditable = true
field.isSelectable = true
field.isEnabled = true
field.setAccessibilityLabel("Fixture input")
let canvas = Canvas(frame: NSRect(x: 330, y: 70, width: 160, height: 150))
canvas.setAccessibilityHidden(true)
panel.contentView?.addSubview(button)
panel.contentView?.addSubview(field)
panel.contentView?.addSubview(canvas)

@MainActor
func publish() {
    writeJSON([
        "at": Date().timeIntervalSince1970,
        "pid": ProcessInfo.processInfo.processIdentifier,
        "windowId": panel.windowNumber,
        "initialFrontmostPid": initialFrontmost,
        "frontmostPid": NSWorkspace.shared.frontmostApplication?.processIdentifier ?? -1,
        "activationChanges": activations,
        "isKeyWindow": panel.isKeyWindow,
        "isMainWindow": panel.isMainWindow,
        "isOnActiveSpace": panel.isOnActiveSpace,
        "firstResponderClass": panel.firstResponder.map { String(describing: type(of: $0)) } ?? "none",
        "clicks": buttonClicks,
        "canvasClicks": canvasClicks,
        "keyEvents": keyEvents,
        "scrollEvents": scrollEvents,
        "events": events,
        "value": field.stringValue,
        "windowX": panel.frame.minX,
        "windowY": panel.frame.minY,
        "windowWidth": panel.frame.width,
        "windowHeight": panel.frame.height,
        "scale": panel.backingScaleFactor,
        "screenScales": NSScreen.screens.map { $0.backingScaleFactor }
    ], to: "state.json")
}

let observer = NSWorkspace.shared.notificationCenter.addObserver(
    forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main
) { notification in
    MainActor.assumeIsolated {
        if let active = notification.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication {
            activations.append(["pid": active.processIdentifier, "at": Date().timeIntervalSince1970])
            publish()
        }
    }
}
panel.orderFrontRegardless()
MainActor.assumeIsolated { publish() }
Timer.scheduledTimer(withTimeInterval: 0.05, repeats: true) { _ in
    MainActor.assumeIsolated {
        let controlURL = URL(fileURLWithPath: outputDirectory + "/control.json")
        if let data = try? Data(contentsOf: controlURL),
           let command = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            try? FileManager.default.removeItem(at: controlURL)
            if let x = command["x"] as? Double, let y = command["y"] as? Double {
                panel.setFrameOrigin(NSPoint(x: x, y: y))
                record("move")
            }
            if let width = command["width"] as? Double, let height = command["height"] as? Double {
                panel.setContentSize(NSSize(width: width, height: height))
                record("resize")
            }
            if command["changeColor"] as? Bool == true {
                alternateColor.toggle()
                canvas.needsDisplay = true
                record("visual-change")
            }
            if command["quit"] as? Bool == true {
                publish()
                app.terminate(nil)
            }
        }
        publish()
    }
}
Timer.scheduledTimer(withTimeInterval: 900, repeats: false) { _ in MainActor.assumeIsolated { app.terminate(nil) } }
app.run()
