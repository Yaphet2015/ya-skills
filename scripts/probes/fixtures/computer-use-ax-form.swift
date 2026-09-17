// Opt-in AppKit fixture for AX form acceptance.
//
// This fixture is intentionally not part of the default test suite. It owns a
// non-activating panel that cannot become key or main. The only mutation path
// for field values is the AX driver under test; the control file accepts only
// `quit`, so the fixture never synthesizes or observes user input.
//
// Usage: fixture <absolute-output-dir>
import AppKit

guard CommandLine.arguments.count == 2, CommandLine.arguments[1].hasPrefix("/") else {
    fputs("usage: fixture <absolute-output-dir>\n", stderr)
    exit(2)
}

let outputDirectory = CommandLine.arguments[1]
try FileManager.default.createDirectory(
    atPath: outputDirectory,
    withIntermediateDirectories: true
)

let app = NSApplication.shared
app.setActivationPolicy(.prohibited)
let initialFrontmostPid = NSWorkspace.shared.frontmostApplication?.processIdentifier ?? -1
let initialMouseLocation = NSEvent.mouseLocation
var sampledPointerChanged = false

var submitCount = 0
var result = "waiting"

final class NonKeyPanel: NSPanel {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

let panel = NonKeyPanel(
    contentRect: NSRect(x: 80, y: 100, width: 620, height: 420),
    styleMask: [.titled, .nonactivatingPanel],
    backing: .buffered,
    defer: false
)
panel.title = "YK AX form fixture"
panel.hidesOnDeactivate = false
// Keep accidental physical pointer input from reaching this acceptance panel.
// AX actions still address its controls by token.
panel.ignoresMouseEvents = true

let nameField = NSTextField(frame: NSRect(x: 180, y: 325, width: 380, height: 32))
nameField.isEditable = true
nameField.isSelectable = true
nameField.isEnabled = true
nameField.setAccessibilityLabel("Name")
nameField.setAccessibilityIdentifier("ax-form-name")

let emailField = NSTextField(frame: NSRect(x: 180, y: 265, width: 380, height: 32))
emailField.isEditable = true
emailField.isSelectable = true
emailField.isEnabled = true
emailField.setAccessibilityLabel("Email")
emailField.setAccessibilityIdentifier("ax-form-email")

let messageField = NSTextField(frame: NSRect(x: 180, y: 205, width: 380, height: 32))
messageField.isEditable = true
messageField.isSelectable = true
messageField.isEnabled = true
messageField.setAccessibilityLabel("Message")
messageField.setAccessibilityIdentifier("ax-form-message")

let nameLabel = NSTextField(labelWithString: "Name")
nameLabel.frame = NSRect(x: 40, y: 325, width: 120, height: 32)
nameLabel.setAccessibilityLabel("Name label")

let emailLabel = NSTextField(labelWithString: "Email")
emailLabel.frame = NSRect(x: 40, y: 265, width: 120, height: 32)
emailLabel.setAccessibilityLabel("Email label")

let messageLabel = NSTextField(labelWithString: "Message")
messageLabel.frame = NSRect(x: 40, y: 205, width: 120, height: 32)
messageLabel.setAccessibilityLabel("Message label")

// Selectable read-only text remains an indexed AX element in the SDK's
// structured observation. Plain labels are only included in its Markdown.
let resultField = NSTextField(frame: NSRect(x: 180, y: 70, width: 380, height: 32))
resultField.stringValue = result
resultField.isEditable = false
resultField.isSelectable = true
resultField.isBezeled = false
resultField.drawsBackground = false
resultField.setAccessibilityLabel("AX form result")
resultField.setAccessibilityIdentifier("ax-form-result")

@MainActor
func publish() {
    let mouseLocation = NSEvent.mouseLocation
    sampledPointerChanged = sampledPointerChanged || mouseLocation != initialMouseLocation
    resultField.stringValue = result
    let state: [String: Any] = [
        "schemaVersion": 1,
        "pid": ProcessInfo.processInfo.processIdentifier,
        "windowId": panel.windowNumber,
        "initialFrontmostPid": initialFrontmostPid,
        "frontmostPid": NSWorkspace.shared.frontmostApplication?.processIdentifier ?? -1,
        "initialMouseX": initialMouseLocation.x,
        "initialMouseY": initialMouseLocation.y,
        "mouseX": mouseLocation.x,
        "mouseY": mouseLocation.y,
        "sampledPointerChanged": sampledPointerChanged,
        "isKeyWindow": panel.isKeyWindow,
        "isMainWindow": panel.isMainWindow,
        "isOnActiveSpace": panel.isOnActiveSpace,
        "ignoresMouseEvents": panel.ignoresMouseEvents,
        "firstResponderClass": panel.firstResponder.map { String(describing: type(of: $0)) } ?? "none",
        "submitCount": submitCount,
        "result": result,
        "fields": [
            "name": nameField.stringValue,
            "email": emailField.stringValue,
            "message": messageField.stringValue
        ],
        "windowX": panel.frame.minX,
        "windowY": panel.frame.minY,
        "windowWidth": panel.frame.width,
        "windowHeight": panel.frame.height,
        "scale": panel.backingScaleFactor,
        "screenScales": NSScreen.screens.map { $0.backingScaleFactor }
    ]
    guard let data = try? JSONSerialization.data(withJSONObject: state, options: [.sortedKeys]) else {
        return
    }
    try? data.write(
        to: URL(fileURLWithPath: outputDirectory + "/state.json"),
        options: .atomic
    )
}

@MainActor
func submitForm() {
    submitCount += 1
    let fields = [nameField.stringValue, emailField.stringValue, messageField.stringValue]
    result = fields.allSatisfy { !$0.isEmpty } ? "submitted" : "validation_failed"
    publish()
}

final class FormHandler: NSObject {
    @MainActor @objc func submit(_ sender: Any?) {
        submitForm()
    }
}

let formHandler = FormHandler()
let submitButton = NSButton(
    title: "Submit AX form",
    target: formHandler,
    action: #selector(FormHandler.submit(_:))
)
submitButton.frame = NSRect(x: 180, y: 125, width: 180, height: 36)
submitButton.setAccessibilityLabel("Submit AX form")
submitButton.isEnabled = true

panel.contentView?.addSubview(nameLabel)
panel.contentView?.addSubview(emailLabel)
panel.contentView?.addSubview(messageLabel)
panel.contentView?.addSubview(nameField)
panel.contentView?.addSubview(emailField)
panel.contentView?.addSubview(messageField)
panel.contentView?.addSubview(submitButton)
panel.contentView?.addSubview(resultField)

panel.orderBack(nil)
MainActor.assumeIsolated { publish() }

// The control protocol is lifecycle-only. It has no text, key, click, or
// coordinate command, which keeps all form mutations on the AX path.
Timer.scheduledTimer(withTimeInterval: 0.05, repeats: true) { _ in
    MainActor.assumeIsolated {
        let controlURL = URL(fileURLWithPath: outputDirectory + "/control.json")
        guard let data = try? Data(contentsOf: controlURL),
              let command = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            publish()
            return
        }
        try? FileManager.default.removeItem(at: controlURL)
        if command["quit"] as? Bool == true {
            publish()
            app.terminate(nil)
            return
        }
        publish()
    }
}

Timer.scheduledTimer(withTimeInterval: 900, repeats: false) { _ in
    MainActor.assumeIsolated { app.terminate(nil) }
}

app.run()
