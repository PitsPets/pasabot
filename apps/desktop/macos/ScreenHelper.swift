// PasaBot Screen Helper (W16): the ONLY PasaBot process that holds Screen Recording and Accessibility.
//
// Why a separate app: macOS gives those permissions to the *responsible* process. The server's agent CLIs are its
// children, so a permission on the server would be every agent's permission, with no approval and no log. This
// helper is launched through LaunchServices (`open -a`), so it is its own responsible process, and it does only a
// fixed list of things, only for the PasaBot server, only with a fresh single-use grant per action:
//
//   - talks ONLY over a unix socket `$PASABOT_HOME/run/screen.sock` (0600 in a 0700 folder; no TCP port), to a peer
//     of the same user that proves it knows the per-launch key in `run/screen.key` (HMAC challenge; the key never
//     crosses the socket);
//   - verbs: screenshot (main display, scaled to <= 1600 wide), displays, move, click, type, key; plus status, stop,
//     open_settings (only two fixed panes) and resume. Every verb that sees or touches the screen needs a grant
//     HMAC-signed for exactly that verb and those arguments, at most 60 s ahead, never used before;
//   - rate limit; a menu-bar dot and an orange border while it is in control; holding Esc for 1 s, its menu's Stop
//     or PasaBot's Stop all cut control at once;
//   - never types while a password box has the keyboard (secure input), never touches System Settings, password or
//     keychain prompts, permission prompts or its own windows.
//
// The same rules live in modules/computer/src/helper/{protocol,guard}.ts; `--selftest` checks the shared vector and
// every refusal without any permission. Build: macos/build-screen-helper.sh.

import AppKit
import ApplicationServices
import Carbon.HIToolbox
import CryptoKit
import Darwin
import ScreenCaptureKit

let helperVersion = "0.1.0"
let ownBundleId = Bundle.main.bundleIdentifier ?? "ai.pasabot.screenhelper"
let shotMaxWidth = 1600
let grantMaxAheadMs = 60_000.0

// MARK: - words (en + fil; the rest of the app's languages fall back to English here)

let isFilipino: Bool = {
  let l = (Locale.preferredLanguages.first ?? "en").lowercased()
  return l.hasPrefix("fil") || l.hasPrefix("tl")
}()
func w(_ en: String, _ fil: String) -> String { isFilipino ? fil : en }

// MARK: - protocol (mirrors modules/computer/src/helper/protocol.ts)

func hex<S: Sequence>(_ d: S) -> String where S.Element == UInt8 { d.map { String(format: "%02x", $0) }.joined() }
func hmacHex(_ key: SymmetricKey, _ s: String) -> String {
  hex(HMAC<SHA256>.authenticationCode(for: Data(s.utf8), using: key))
}
func sha256Hex(_ s: String) -> String { hex(SHA256.hash(data: Data(s.utf8))) }
func sameHex(_ a: String, _ b: String) -> Bool {
  let x = Array(a.utf8), y = Array(b.utf8)
  guard x.count == y.count else { return false }
  var r: UInt8 = 0
  for i in 0..<x.count { r |= x[i] ^ y[i] }
  return r == 0
}
func parseKey(_ text: String) -> SymmetricKey? {
  let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
  guard t.count == 64 else { return nil }
  var bytes: [UInt8] = []
  var i = t.startIndex
  while i < t.endIndex {
    let j = t.index(i, offsetBy: 2)
    guard let b = UInt8(t[i..<j], radix: 16), t[i..<j].lowercased() == t[i..<j] else { return nil }
    bytes.append(b)
    i = j
  }
  return SymmetricKey(data: bytes)
}
func intArg(_ v: Any?) -> Int? {
  guard let n = v as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID() else { return nil }
  let d = n.doubleValue
  guard d == d.rounded(), abs(d) <= 100_000 else { return nil }
  return Int(d)
}
let actionVerbs: Set<String> = ["screenshot", "displays", "move", "click", "type", "key", "resume"]
let inputVerbs: Set<String> = ["move", "click", "type", "key"]

/// the signed form of a request's arguments; nil = malformed
func canonicalArgs(_ verb: String, _ a: [String: Any]) -> String? {
  switch verb {
  case "move":
    guard let x = intArg(a["x"]), let y = intArg(a["y"]) else { return nil }
    return "\(x)|\(y)"
  case "click":
    guard let x = intArg(a["x"]), let y = intArg(a["y"]), let b = a["button"] as? String, b == "left" || b == "right"
    else { return nil }
    return "\(x)|\(y)|\(b)"
  case "type":
    guard let t = a["text"] as? String, !t.isEmpty, t.count <= 2000 else { return nil }
    return sha256Hex(t)
  case "key":
    guard let k = a["keys"] as? String, chords(k) != nil else { return nil }
    return k
  case "screenshot", "displays", "resume": return ""
  default: return nil
  }
}
func grantMessage(_ id: String, _ exp: Int64, _ verb: String, _ canon: String) -> String {
  "grant|\(id)|\(exp)|\(verb)|\(canon)"
}

// MARK: - keys

let keyCodes: [String: CGKeyCode] = [
  "return": 36, "enter": 36, "tab": 48, "space": 49, "backspace": 51, "escape": 53, "esc": 53, "delete": 117,
  "left": 123, "right": 124, "down": 125, "up": 126, "home": 115, "end": 119, "pageup": 116, "pagedown": 121,
  "prior": 116, "next": 121,
  "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97, "f7": 98, "f8": 100, "f9": 101, "f10": 109,
  "f11": 103, "f12": 111,
  "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9, "b": 11, "q": 12, "w": 13,
  "e": 14, "r": 15, "y": 16, "t": 17, "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "9": 25, "7": 26,
  "8": 28, "0": 29, "o": 31, "u": 32, "i": 34, "p": 35, "l": 37, "j": 38, "k": 40, "n": 45, "m": 46,
  "minus": 27, "equal": 24,
]
let modifierFlags: [String: CGEventFlags] = [
  "ctrl": .maskControl, "control": .maskControl, "shift": .maskShift, "alt": .maskAlternate,
  "option": .maskAlternate, "cmd": .maskCommand, "super": .maskCommand, "meta": .maskCommand,
]
/// `ctrl+a Return` → key codes with modifier flags; nil when any part is unknown
func chords(_ keys: String) -> [(CGKeyCode, CGEventFlags)]? {
  let tokens = keys.split(separator: " ").map(String.init)
  guard !tokens.isEmpty, tokens.count <= 16 else { return nil }
  var out: [(CGKeyCode, CGEventFlags)] = []
  for tok in tokens {
    var parts = tok.split(separator: "+", omittingEmptySubsequences: false).map { $0.lowercased() }
    guard let last = parts.popLast(), !last.isEmpty else { return nil }
    var flags: CGEventFlags = []
    for m in parts {
      guard let f = modifierFlags[m] else { return nil }
      flags.insert(f)
    }
    guard let code = keyCodes[last.replacingOccurrences(of: "_", with: "")] else { return nil }
    out.append((code, flags))
  }
  return out
}

// MARK: - what the helper never touches

/// PasaBot's own app (apps/desktop/macos/Info.plist): its window shows the approval cards and the switches
let pasabotAppBundleId = "local.pasabot.desktop"
let protectedBundles: Set<String> = [
  "com.apple.systempreferences", "com.apple.Settings", "com.apple.SecurityAgent", "com.apple.keychainaccess",
  "com.apple.UserNotificationCenter", "com.apple.coreservices.uiagent", "com.apple.LocalAuthentication.UIAgent",
  "com.apple.CoreAuthentication.UIAgent", "com.apple.universalaccessAuthWarn", ownBundleId, pasabotAppBundleId,
]
let protectedOwners: Set<String> = [
  "System Settings", "System Preferences", "SecurityAgent", "Keychain Access", "UserNotificationCenter",
  "universalAccessAuthWarn", "coreautha", "CoreServicesUIAgent", "LocalAuthenticationUIAgent", "tccd",
  "PasaBot Screen Helper", "PasaBot",
]
/// a browser tab showing the PasaBot web app is titled "PasaBot" (apps/web/index.html): its approval cards, the
/// "control this Mac" switch and Take over are never clicked or typed into by the helper
func isPasaBotTitle(_ title: String?) -> Bool { (title ?? "").contains("PasaBot") }
/// prompts that float above everything (password, keychain, permission): while one is up, no input at all
let promptOwners: Set<String> = [
  "SecurityAgent", "universalAccessAuthWarn", "coreautha", "UserNotificationCenter", "LocalAuthenticationUIAgent",
  "tccd",
]
func isProtected(bundle: String?, owner: String?, title: String? = nil) -> Bool {
  if let b = bundle, protectedBundles.contains(b) { return true }
  if let o = owner, protectedOwners.contains(o) { return true }
  return isPasaBotTitle(title)
}

// MARK: - long actions are re-checked step by step

/// one step of a `type` or `key` action
enum Step: Equatable {
  case text([UniChar])
  case press(CGKeyCode, UInt64)
}
/// `type` as steps: text in chunks of at most 16 characters, Return and Tab as their own key presses
func typeSteps(_ text: String) -> [Step] {
  var out: [Step] = []
  var chunk: [UniChar] = []
  func flush() {
    var i = 0
    while i < chunk.count {
      out.append(.text(Array(chunk[i..<min(i + 16, chunk.count)])))
      i += 16
    }
    chunk = []
  }
  for ch in text {
    if ch == "\n" || ch == "\r\n" || ch == "\r" { flush(); out.append(.press(36, 0)) } else if ch == "\t" {
      flush()
      out.append(.press(48, 0))
    } else { chunk.append(contentsOf: String(ch).utf16) }
  }
  flush()
  return out
}
/// `key` as steps, one chord each
func keySteps(_ keys: String) -> [Step] {
  (chords(keys) ?? []).map { .press($0.0, $0.1.rawValue) }
}
/// chords that switch apps or open a launcher: the rest of the action would land in whatever comes to the front
func isSwitchingChord(_ code: CGKeyCode, _ flags: UInt64) -> Bool {
  let cmd = flags & CGEventFlags.maskCommand.rawValue != 0
  let ctrl = flags & CGEventFlags.maskControl.rawValue != 0
  if cmd && (code == 48 || code == 49) { return true }  // cmd+tab, cmd+space (Spotlight)
  if ctrl && code == 49 { return true }  // ctrl+space (input source / launcher)
  if ctrl && (123...126).contains(code) { return true }  // ctrl+arrows (Spaces, Mission Control)
  return false
}
/// a `type`/`key` action refused before any step runs (nil = may run)
func stepsRefusal(_ verb: String, _ steps: [Step]) -> [String: Any]? {
  if verb == "key", steps.contains(where: { if case .press(let c, let f) = $0 { return isSwitchingChord(c, f) } else { return false } }) {
    return ["ok": false, "code": "focus_moved", "message": "keys that switch apps are not pressed; click the app instead"]
  }
  // each Return or Tab waits a moment for the focus to settle: a bounded number, so one action stays short
  if steps.filter({ if case .press = $0 { return true } else { return false } }).count > 100 {
    return ["ok": false, "code": "bad_request", "message": "too many line breaks or tabs in one go; split the text"]
  }
  return nil
}
/// Runs the steps, asking `refusal` before EVERY step (a Return, a Tab or a chord such as cmd+space can move the
/// keyboard to a password box or bring a protected app to the front): the first refusal stops the action there.
/// Returns nil when every step ran, else the refusal code and how many steps ran.
func runSteps(_ steps: [Step], refusal: () -> String?, run: (Step) -> Void) -> (String, Int)? {
  for (i, step) in steps.enumerated() {
    if let code = refusal() { return (code, i) }
    run(step)
  }
  return nil
}

// MARK: - the guard (mirrors modules/computer/src/helper/guard.ts, same order)

final class Guard {
  var key: SymmetricKey
  var used: [String: Double] = [:]
  var inputTimes: [Double] = []
  var shotTimes: [Double] = []
  var stopped = false
  var now: () -> Double = { Date().timeIntervalSince1970 * 1000 }
  var secureInput: () -> Bool = { false }
  var protectedTarget: (String, [String: Any]) -> Bool = { _, _ in false }
  var screenRecording: () -> Bool = { false }
  var accessibility: () -> Bool = { false }
  let lock = NSLock()
  init(key: SymmetricKey) { self.key = key }

  /// nil = may run (the grant is spent); else (code, message)
  func check(_ verb: String, _ args: [String: Any], _ grant: [String: Any]?) -> (String, String)? {
    lock.lock()
    defer { lock.unlock() }
    guard actionVerbs.contains(verb), let canon = canonicalArgs(verb, args) else {
      return ("bad_request", "this is not a request the helper knows")
    }
    let t = now()
    guard let g = grant, let id = g["id"] as? String, let mac = g["mac"] as? String, let expN = g["exp"] as? NSNumber
    else { return ("grant_missing", "no approval came with this request") }
    guard id.count >= 8, id.count <= 64 else { return ("grant_invalid", "the approval is not valid") }
    let exp = expN.int64Value
    guard sameHex(hmacHex(key, grantMessage(id, exp, verb, canon)), mac) else {
      return ("grant_invalid", "the approval does not match this action")
    }
    if Double(exp) <= t { return ("grant_expired", "the approval ran out of time") }
    if Double(exp) - t > grantMaxAheadMs { return ("grant_invalid", "the approval is not valid") }
    used = used.filter { $0.value > t }
    if used[id] != nil { return ("grant_replayed", "this approval was already used") }
    used[id] = Double(exp)
    if verb == "resume" {
      stopped = false
      return nil
    }
    if stopped { return ("stopped", "control was stopped; the owner has to allow it again") }
    let isShot = verb == "screenshot" || verb == "displays"
    if isShot && !screenRecording() { return ("no_screen_recording", "Screen Recording is off for PasaBot Screen Helper") }
    if inputVerbs.contains(verb) && !accessibility() {
      return ("no_accessibility", "Accessibility is off for PasaBot Screen Helper")
    }
    let window = 2000.0
    let burst = isShot ? 6 : 8
    if isShot {
      shotTimes = shotTimes.filter { $0 > t - window }
      if shotTimes.count >= burst { return ("rate_limited", "too many actions in a short time") }
      shotTimes.append(t)
    } else {
      inputTimes = inputTimes.filter { $0 > t - window }
      if inputTimes.count >= burst { return ("rate_limited", "too many actions in a short time") }
      inputTimes.append(t)
    }
    if (verb == "type" || verb == "key") && secureInput() {
      return ("secure_input", "a password box has the keyboard: type it yourself")
    }
    if inputVerbs.contains(verb) && protectedTarget(verb, args) {
      return ("protected_window", "that is a protected window (settings, a password prompt)")
    }
    return nil
  }
  func stop() {
    lock.lock()
    stopped = true
    lock.unlock()
  }
}

// MARK: - the screen (real macOS calls; never used by --selftest)

/// screenshot pixel size for a display of `pw` x `ph` points
func shotSize(pw: Int, ph: Int) -> (Int, Int) {
  let width = min(pw, shotMaxWidth)
  return (width, Int((Double(ph) * Double(width) / Double(max(pw, 1))).rounded()))
}
enum Screen {
  static func bounds() -> CGRect { CGDisplayBounds(CGMainDisplayID()) }
  static func size() -> (w: Int, h: Int, pw: Int, ph: Int) {
    let b = bounds()
    let pw = Int(b.width.rounded()), ph = Int(b.height.rounded())
    let (w, h) = shotSize(pw: pw, ph: ph)
    return (w, h, pw, ph)
  }
  /// screenshot pixels → global points
  static func point(_ x: Int, _ y: Int) -> CGPoint? {
    let s = size()
    guard x >= 0, y >= 0, x < s.w, y < s.h else { return nil }
    let b = bounds()
    return CGPoint(x: b.origin.x + Double(x) * b.width / Double(s.w), y: b.origin.y + Double(y) * b.height / Double(s.h))
  }
  static func screenRecording() -> Bool { CGPreflightScreenCaptureAccess() }
  static func accessibility() -> Bool { AXIsProcessTrusted() }

  static func capture() -> Result<(Data, Int, Int, Int, Int), Error> {
    let sem = DispatchSemaphore(value: 0)
    var out: Result<(Data, Int, Int, Int, Int), Error> = .failure(NSError(domain: "helper", code: 1))
    Task.detached {
      do {
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        guard let display = content.displays.first(where: { $0.displayID == CGMainDisplayID() }) ?? content.displays.first
        else { throw NSError(domain: "helper", code: 2, userInfo: [NSLocalizedDescriptionKey: "no display"]) }
        // the border and menus of this helper are never in the picture
        let mine = content.applications.filter { $0.bundleIdentifier == ownBundleId }
        let filter = SCContentFilter(display: display, excludingApplications: mine, exceptingWindows: [])
        let (w, h) = shotSize(pw: display.width, ph: display.height)
        let cfg = SCStreamConfiguration()
        cfg.width = w
        cfg.height = h
        cfg.showsCursor = true
        let img = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: cfg)
        let rep = NSBitmapImageRep(cgImage: img)
        guard let png = rep.representation(using: .png, properties: [:]) else {
          throw NSError(domain: "helper", code: 3, userInfo: [NSLocalizedDescriptionKey: "no png"])
        }
        out = .success((png, img.width, img.height, display.width, display.height))
      } catch {
        out = .failure(error)
      }
      sem.signal()
    }
    _ = sem.wait(timeout: .now() + 15)
    return out
  }

  static let source = CGEventSource(stateID: .hidSystemState)
  static func move(_ p: CGPoint) {
    CGEvent(mouseEventSource: source, mouseType: .mouseMoved, mouseCursorPosition: p, mouseButton: .left)?
      .post(tap: .cghidEventTap)
  }
  static func click(_ p: CGPoint, right: Bool) {
    move(p)
    let (d, u, b): (CGEventType, CGEventType, CGMouseButton) =
      right ? (.rightMouseDown, .rightMouseUp, .right) : (.leftMouseDown, .leftMouseUp, .left)
    CGEvent(mouseEventSource: source, mouseType: d, mouseCursorPosition: p, mouseButton: b)?.post(tap: .cghidEventTap)
    CGEvent(mouseEventSource: source, mouseType: u, mouseCursorPosition: p, mouseButton: b)?.post(tap: .cghidEventTap)
  }
  static func press(_ code: CGKeyCode, _ flags: CGEventFlags) {
    for down in [true, false] {
      let e = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: down)
      e?.flags = flags
      e?.post(tap: .cghidEventTap)
    }
  }
  /// posts one step; after a key press it waits a moment, so the next step's check sees where the focus went
  static func post(_ step: Step) {
    switch step {
    case .text(let chars):
      var part = chars
      for down in [true, false] {
        let e = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: down)
        e?.keyboardSetUnicodeString(stringLength: part.count, unicodeString: &part)
        e?.post(tap: .cghidEventTap)
      }
    case .press(let code, let flags):
      press(code, CGEventFlags(rawValue: flags))
      usleep(100_000)
    }
  }
  /// why the next step of a `type`/`key` action may not run (a password box has the keyboard, a protected window is
  /// in front), or nil
  static func stepRefusal(_ verb: String, front: Int32?) -> String? {
    if secureInput() { return "secure_input" }
    if protectedTarget(verb, [:]) { return "protected_window" }
    if frontPid() != front { return "focus_moved" }
    return nil
  }
  /// the app whose window is in front (the top normal window on screen)
  static func frontPid() -> Int32? {
    let me = ProcessInfo.processInfo.processIdentifier
    for win in windows() where ((win[kCGWindowLayer as String] as? NSNumber)?.intValue ?? -1) == 0 {
      let pid = (win[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value ?? 0
      if pid != me { return pid }
    }
    return nil
  }

  /// a password box has the keyboard (secure event input, or a focused secure text field)
  static func secureInput() -> Bool {
    if IsSecureEventInputEnabled() { return true }
    let sys = AXUIElementCreateSystemWide()
    var f: CFTypeRef?
    guard AXUIElementCopyAttributeValue(sys, kAXFocusedUIElementAttribute as CFString, &f) == .success, let el = f,
      CFGetTypeID(el) == AXUIElementGetTypeID()
    else { return false }
    var sub: CFTypeRef?
    _ = AXUIElementCopyAttributeValue(el as! AXUIElement, kAXSubroleAttribute as CFString, &sub)
    return (sub as? String) == (kAXSecureTextFieldSubrole as String)
  }
  static func windows() -> [[String: Any]] {
    (CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]])
      ?? []
  }
  static func owner(_ win: [String: Any]) -> (String?, String?) {
    let pid = (win[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value ?? 0
    return (NSRunningApplication(processIdentifier: pid)?.bundleIdentifier, win[kCGWindowOwnerName as String] as? String)
  }
  /// the action would land on (or type into) something the helper never touches
  static func protectedTarget(_ verb: String, _ args: [String: Any]) -> Bool {
    // window titles (a browser tab showing PasaBot) need Screen Recording: without it, nothing is touched
    if !screenRecording() { return true }
    let wins = windows()
    for win in wins where promptOwners.contains((win[kCGWindowOwnerName as String] as? String) ?? "") { return true }
    let me = ProcessInfo.processInfo.processIdentifier
    if verb == "type" || verb == "key" {
      let front = NSWorkspace.shared.frontmostApplication
      if isProtected(bundle: front?.bundleIdentifier, owner: front?.localizedName) { return true }
      // the window in front, by its title too (the PasaBot web app in a browser)
      for win in wins where ((win[kCGWindowLayer as String] as? NSNumber)?.intValue ?? -1) == 0 {
        let pid = (win[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value ?? 0
        if pid == me { continue }
        let (b, o) = owner(win)
        return isProtected(bundle: b, owner: o, title: win[kCGWindowName as String] as? String)
      }
      return false
    }
    guard let x = intArg(args["x"]), let y = intArg(args["y"]), let p = point(x, y) else { return true }
    for win in wins {
      let pid = (win[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value ?? 0
      if pid == me { continue }  // the border never takes clicks
      guard let bd = win[kCGWindowBounds as String] as? NSDictionary,
        let r = CGRect(dictionaryRepresentation: bd as CFDictionary), r.contains(p)
      else { continue }
      if ((win[kCGWindowAlpha as String] as? NSNumber)?.doubleValue ?? 1) == 0 { continue }
      let (b, o) = owner(win)
      return isProtected(bundle: b, owner: o, title: win[kCGWindowName as String] as? String)
    }
    return false
  }
}

// MARK: - the socket

final class Conn {
  let fd: Int32
  let lock = NSLock()
  var authed = false
  init(fd: Int32) { self.fd = fd }
  func send(_ obj: [String: Any]) {
    guard var data = try? JSONSerialization.data(withJSONObject: obj) else { return }
    data.append(0x0a)
    lock.lock()
    defer { lock.unlock() }
    data.withUnsafeBytes { buf in
      var off = 0
      while off < buf.count {
        let n = Darwin.write(fd, buf.baseAddress! + off, buf.count - off)
        if n <= 0 { return }
        off += n
      }
    }
  }
}

final class Server {
  let path: String
  let guardian: Guard
  var listenFd: Int32 = -1
  var conns: [Int32: Conn] = [:]
  let lock = NSLock()
  /// runs a verb that passed the guard; returns the answer fields
  var perform: (String, [String: Any]) -> [String: Any] = { _, _ in ["ok": false, "code": "bad_request"] }
  var free: (String, [String: Any]) -> [String: Any] = { _, _ in ["ok": false, "code": "bad_request"] }
  var onAction: () -> Void = {}

  init(path: String, guardian: Guard) {
    self.path = path
    self.guardian = guardian
  }

  func start() throws {
    unlink(path)
    let fd = socket(AF_UNIX, SOCK_STREAM, 0)
    guard fd >= 0 else { throw NSError(domain: "helper", code: 10) }
    var addr = sockaddr_un()
    addr.sun_family = sa_family_t(AF_UNIX)
    let bytes = Array(path.utf8)
    guard bytes.count < MemoryLayout.size(ofValue: addr.sun_path) else { throw NSError(domain: "helper", code: 11) }
    withUnsafeMutableBytes(of: &addr.sun_path) { p in
      for (i, b) in bytes.enumerated() { p[i] = b }
      p[bytes.count] = 0
    }
    let old = umask(0o177)  // the socket is born 0600
    let rc = withUnsafePointer(to: &addr) {
      $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
    }
    umask(old)
    guard rc == 0 else { throw NSError(domain: "helper", code: 12, userInfo: [NSLocalizedDescriptionKey: "bind failed"]) }
    chmod(path, 0o600)
    guard listen(fd, 8) == 0 else { throw NSError(domain: "helper", code: 13) }
    listenFd = fd
    Thread.detachNewThread { [self] in
      while true {
        let c = accept(fd, nil, nil)
        if c < 0 { if errno == EINTR { continue } else { return } }
        Thread.detachNewThread { [self] in self.serve(c) }
      }
    }
  }

  func broadcast(_ obj: [String: Any]) {
    lock.lock()
    let all = Array(conns.values).filter { $0.authed }
    lock.unlock()
    for c in all { c.send(obj) }
  }
  var hasClient: Bool {
    lock.lock()
    defer { lock.unlock() }
    return conns.values.contains { $0.authed }
  }
  func dropAll() {
    lock.lock()
    for c in conns.values { shutdown(c.fd, SHUT_RDWR) }
    lock.unlock()
  }

  func serve(_ fd: Int32) {
    var nosig: Int32 = 1
    setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &nosig, socklen_t(MemoryLayout<Int32>.size))
    // the peer must be this same user
    var uid: uid_t = 0
    var gid: gid_t = 0
    guard getpeereid(fd, &uid, &gid) == 0, uid == getuid() else {
      close(fd)
      return
    }
    let conn = Conn(fd: fd)
    lock.lock()
    conns[fd] = conn
    lock.unlock()
    defer {
      lock.lock()
      conns[fd] = nil
      lock.unlock()
      close(fd)
    }
    var nonceBytes = [UInt8](repeating: 0, count: 16)
    _ = SecRandomCopyBytes(kSecRandomDefault, 16, &nonceBytes)
    let nonce = hex(nonceBytes)
    conn.send(["hello": nonce, "v": 1])
    var buf = Data()
    var chunk = [UInt8](repeating: 0, count: 65536)
    while true {
      let n = read(fd, &chunk, chunk.count)
      if n <= 0 { return }
      buf.append(contentsOf: chunk[0..<n])
      if buf.count > 1_048_576 { return }
      while let nl = buf.firstIndex(of: 0x0a) {
        let line = buf[buf.startIndex..<nl]
        buf = Data(buf[(nl + 1)...])
        guard let msg = (try? JSONSerialization.jsonObject(with: line)) as? [String: Any] else { return }
        if !conn.authed {
          guard let auth = msg["auth"] as? String, sameHex(auth, hmacHex(guardian.key, "hello|\(nonce)")) else { return }
          conn.authed = true
          conn.send(["welcome": true])
          continue
        }
        let id = msg["id"] ?? NSNull()
        let verb = (msg["verb"] as? String) ?? ""
        let args = (msg["args"] as? [String: Any]) ?? [:]
        var answer: [String: Any]
        if ["status", "stop", "open_settings"].contains(verb) {
          answer = free(verb, args)
        } else if let (code, message) = guardian.check(verb, args, msg["grant"] as? [String: Any]) {
          answer = ["ok": false, "code": code, "message": message]
        } else {
          if verb != "resume" { onAction() }
          answer = perform(verb, args)
        }
        answer["id"] = id
        conn.send(answer)
      }
    }
  }
}

// MARK: - the one data folder the helper trusts

/// `~/.pasabot` of this user, from the user database (never $HOME, which `open --env` can set, and never argv):
/// agent sandboxes deny that folder (apps/server/src/runner/sandbox.ts), so only PasaBot itself can write its key
func canonicalHome() -> String? {
  guard let pw = getpwuid(getuid()), let dir = pw.pointee.pw_dir else { return nil }
  return ((String(cString: dir) as NSString).appendingPathComponent(".pasabot") as NSString).standardizingPath
}
/// The launcher passes `--home`: it may only name that same folder. Another folder (one an agent wrote a key into)
/// is refused, so a copy of the helper started by anyone else never trusts a key of theirs. nil = refuse to start.
func trustedHome(_ argv: [String], canonical: String) -> String? {
  guard let i = argv.firstIndex(of: "--home") else { return canonical }
  guard i + 1 < argv.count else { return nil }
  let given = (argv[i + 1] as NSString).standardizingPath
  return given == canonical ? canonical : nil
}
/// the key text when the home, its run folder and the key are this user's, private and not symlinks
func safeKeyText(home: String) -> String? {
  let run = (home as NSString).appendingPathComponent("run")
  let key = (run as NSString).appendingPathComponent("screen.key")
  var st = stat()
  guard lstat(home, &st) == 0, (st.st_mode & S_IFMT) == S_IFDIR, st.st_uid == getuid(), (st.st_mode & 0o022) == 0
  else { return nil }
  guard lstat(run, &st) == 0, (st.st_mode & S_IFMT) == S_IFDIR, st.st_uid == getuid(), (st.st_mode & 0o077) == 0
  else { return nil }
  guard lstat(key, &st) == 0, (st.st_mode & S_IFMT) == S_IFREG, st.st_uid == getuid(), (st.st_mode & 0o077) == 0
  else { return nil }
  let fd = open(key, O_RDONLY | O_NOFOLLOW)
  guard fd >= 0 else { return nil }
  defer { close(fd) }
  var buf = [UInt8](repeating: 0, count: 256)
  let n = read(fd, &buf, buf.count)
  guard n > 0 else { return nil }
  return String(decoding: buf[0..<n], as: UTF8.self)
}

// MARK: - the visible part: menu-bar dot, border, Esc

final class BorderView: NSView {
  override func draw(_ dirtyRect: NSRect) {
    NSColor.systemOrange.setStroke()
    let p = NSBezierPath(rect: bounds.insetBy(dx: 3, dy: 3))
    p.lineWidth = 6
    p.stroke()
    let text = w("PasaBot is using your screen. Hold Esc to stop.", "Ginagamit ng PasaBot ang screen mo. Pindutin nang matagal ang Esc para itigil.")
    let attrs: [NSAttributedString.Key: Any] = [
      .font: NSFont.boldSystemFont(ofSize: 13), .foregroundColor: NSColor.white,
    ]
    let size = (text as NSString).size(withAttributes: attrs)
    let box = NSRect(x: bounds.midX - size.width / 2 - 12, y: bounds.maxY - size.height - 40, width: size.width + 24, height: size.height + 10)
    NSColor.systemOrange.setFill()
    NSBezierPath(roundedRect: box, xRadius: 8, yRadius: 8).fill()
    (text as NSString).draw(at: NSPoint(x: box.minX + 12, y: box.minY + 5), withAttributes: attrs)
  }
}

final class Helper: NSObject, NSApplicationDelegate, NSMenuDelegate {
  let home: String
  var keyText = ""
  var server: Server!
  var guardian: Guard!
  let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
  var border: NSWindow?
  var lastAction: Date = .distantPast
  var escSince: Date?
  init(home: String) { self.home = home }

  var runDir: String { (home as NSString).appendingPathComponent("run") }
  var keyPath: String { (runDir as NSString).appendingPathComponent("screen.key") }

  /// the key file must be this user's and 0600 in a 0700 folder, and nothing on the way is a symlink (a link could
  /// point the trusted folder at a folder an agent can write)
  func readKey() -> String? { safeKeyText(home: home) }

  func applicationDidFinishLaunching(_ n: Notification) {
    // one helper per user: a second copy (`open -n`, a copy with another home) leaves at once
    let others = NSRunningApplication.runningApplications(withBundleIdentifier: ownBundleId)
      .filter { $0.processIdentifier != ProcessInfo.processInfo.processIdentifier }
    if !others.isEmpty { exit(0) }
    guard let text = readKey(), let key = parseKey(text) else {
      NSLog("PasaBot Screen Helper: no safe key file at \(keyPath); quitting")
      exit(2)
    }
    keyText = text
    guardian = Guard(key: key)
    guardian.secureInput = Screen.secureInput
    guardian.protectedTarget = Screen.protectedTarget
    guardian.screenRecording = Screen.screenRecording
    guardian.accessibility = Screen.accessibility
    server = Server(path: (runDir as NSString).appendingPathComponent("screen.sock"), guardian: guardian)
    server.onAction = { [weak self] in DispatchQueue.main.async { self?.lastAction = Date() } }
    server.perform = { verb, args in Helper.perform(verb, args) }
    server.free = { [weak self] verb, args in self?.free(verb, args) ?? ["ok": false] }
    do { try server.start() } catch {
      NSLog("PasaBot Screen Helper: could not open its socket: \(error)")
      exit(3)
    }
    setupMenu()
    // Esc held for one second cuts control (both a key monitor and the key state, whichever this Mac allows)
    NSEvent.addGlobalMonitorForEvents(matching: [.keyDown, .keyUp]) { [weak self] e in
      guard e.keyCode == 53 else { return }
      if e.type == .keyDown, !e.isARepeat { self?.escSince = Date() } else if e.type == .keyUp { self?.escSince = nil }
    }
    Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak self] _ in self?.tick() }
    Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in self?.watchKey() }
  }

  /// the launcher writes a new key each time PasaBot starts and removes it when PasaBot quits
  func watchKey() {
    guard let text = readKey(), let key = parseKey(text) else {
      NSLog("PasaBot Screen Helper: PasaBot quit (its key is gone); quitting too")
      exit(0)
    }
    if text != keyText {
      keyText = text
      guardian.lock.lock()
      guardian.key = key
      guardian.lock.unlock()
      server.dropAll()
    }
  }

  var controlling: Bool { Date().timeIntervalSince(lastAction) < 8 }

  func tick() {
    let down = CGEventSource.keyState(.combinedSessionState, key: 53)
    if down { if escSince == nil { escSince = Date() } } else if escSince != nil, !down {
      // the monitor may have missed the key-up: trust the key state
      escSince = nil
    }
    if let s = escSince, Date().timeIntervalSince(s) >= 1.0 {
      escSince = nil
      stop(by: "key")
    }
    let on = controlling && !guardian.stopped
    if on, border == nil { showBorder() } else if !on, border != nil { border?.orderOut(nil); border = nil }
    item.button?.title = on ? "● PasaBot" : "◦"
    item.button?.toolTip = on ? w("PasaBot is using your screen. Hold Esc to stop.", "Ginagamit ng PasaBot ang screen mo. Pindutin nang matagal ang Esc para itigil.") : "PasaBot Screen Helper"
  }

  func showBorder() {
    guard let screen = NSScreen.main else { return }
    let win = NSWindow(contentRect: screen.frame, styleMask: .borderless, backing: .buffered, defer: false)
    win.isOpaque = false
    win.backgroundColor = .clear
    win.level = .screenSaver
    win.ignoresMouseEvents = true
    win.hasShadow = false
    win.sharingType = .none
    win.collectionBehavior = [.canJoinAllSpaces, .stationary, .ignoresCycle, .fullScreenAuxiliary]
    win.contentView = BorderView(frame: NSRect(origin: .zero, size: screen.frame.size))
    win.orderFrontRegardless()
    border = win
  }

  func stop(by: String) {
    guardian.stop()
    lastAction = .distantPast
    server.broadcast(["event": "stopped", "by": by])
    NSLog("PasaBot Screen Helper: control stopped (\(by))")
  }

  func setupMenu() {
    item.button?.title = "◦"
    let menu = NSMenu()
    menu.delegate = self
    item.menu = menu
  }
  func menuNeedsUpdate(_ menu: NSMenu) {
    menu.removeAllItems()
    menu.addItem(withTitle: "PasaBot Screen Helper", action: nil, keyEquivalent: "")
    let tick = { (b: Bool) in b ? "✓" : "–" }
    menu.addItem(withTitle: "\(tick(Screen.screenRecording())) " + w("Screen Recording", "Screen Recording"), action: nil, keyEquivalent: "")
    menu.addItem(withTitle: "\(tick(Screen.accessibility())) " + w("Accessibility", "Accessibility"), action: nil, keyEquivalent: "")
    menu.addItem(.separator())
    let stopItem = NSMenuItem(title: w("Stop control now (or hold Esc)", "Itigil ngayon (o pindutin nang matagal ang Esc)"), action: #selector(stopFromMenu), keyEquivalent: "")
    stopItem.target = self
    menu.addItem(stopItem)
    let quit = NSMenuItem(title: w("Quit Screen Helper", "Isara ang Screen Helper"), action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
    menu.addItem(quit)
  }
  @objc func stopFromMenu() { stop(by: "menu") }

  func free(_ verb: String, _ args: [String: Any]) -> [String: Any] {
    switch verb {
    case "status":
      return [
        "ok": true, "screenRecording": Screen.screenRecording(), "accessibility": Screen.accessibility(),
        "stopped": guardian.stopped, "controlling": controlling, "version": helperVersion,
      ]
    case "stop":
      guardian.stop()
      DispatchQueue.main.async { self.lastAction = .distantPast }
      return ["ok": true]
    case "open_settings":
      // only these two panes; the helper adds itself to the list and opens it, the owner flips the switch
      let pane = args["pane"] as? String
      let url: String
      if pane == "screen" {
        url = "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"
        DispatchQueue.main.async { _ = CGRequestScreenCaptureAccess() }
      } else if pane == "accessibility" {
        url = "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"
        DispatchQueue.main.async {
          _ = AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary)
        }
      } else { return ["ok": false, "code": "bad_request", "message": "unknown pane"] }
      DispatchQueue.main.async { NSWorkspace.shared.open(URL(string: url)!) }
      return ["ok": true]
    default:
      return ["ok": false, "code": "bad_request"]
    }
  }

  static func perform(_ verb: String, _ args: [String: Any]) -> [String: Any] {
    let s = Screen.size()
    let sized: [String: Any] = ["ok": true, "width": s.w, "height": s.h, "pointsWidth": s.pw, "pointsHeight": s.ph]
    switch verb {
    case "resume": return ["ok": true]
    case "displays": return sized
    case "screenshot":
      switch Screen.capture() {
      case .success(let (png, w, h, pw, ph)):
        return ["ok": true, "png": png.base64EncodedString(), "width": w, "height": h, "pointsWidth": pw, "pointsHeight": ph]
      case .failure(let e):
        return ["ok": false, "code": "bad_request", "message": "screenshot failed: \(e.localizedDescription)"]
      }
    case "move", "click":
      guard let x = intArg(args["x"]), let y = intArg(args["y"]), let p = Screen.point(x, y) else {
        return ["ok": false, "code": "bad_request", "message": "outside the screen"]
      }
      if verb == "move" { Screen.move(p) } else { Screen.click(p, right: (args["button"] as? String) == "right") }
      return ["ok": true]
    case "type", "key":
      let steps = verb == "type" ? typeSteps((args["text"] as? String) ?? "") : keySteps((args["keys"] as? String) ?? "")
      if let why = stepsRefusal(verb, steps) { return why }
      // the guard checked once; every further step is checked again, and the first refusal stops the rest
      let front = Screen.frontPid()
      if let (code, done) = runSteps(steps, refusal: { Screen.stepRefusal(verb, front: front) }, run: Screen.post) {
        return [
          "ok": false, "code": code,
          "message": "stopped after \(done) of \(steps.count) steps: \(code == "secure_input" ? "a password box got the keyboard" : code == "focus_moved" ? "the keyboard moved to another app" : "a protected window came to the front")",
        ]
      }
      return ["ok": true]
    default:
      return ["ok": false, "code": "bad_request"]
    }
  }
}

// MARK: - --selftest (no permissions, no screen)

func selftest() -> Int32 {
  var passed = 0
  var failed = 0
  func check(_ ok: Bool, _ what: String) {
    if ok { passed += 1 } else {
      failed += 1
      print("FAIL: \(what)")
    }
  }
  // 1. the shared vector (modules/computer/src/helper/protocol.ts GRANT_VECTOR)
  let vkey = parseKey("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f")!
  let vmsg = grantMessage("g-vector-1", 1_900_000_000_000, "type", canonicalArgs("type", ["text": "héllo"])!)
  check(vmsg == "grant|g-vector-1|1900000000000|type|3c48591d8d098a4538f5e013dfcf406e948eac4d3277b10bf614e295d6068179", "vector message")
  check(hmacHex(vkey, vmsg) == "bd84e71ac3bdebd09753e6219876d15158e7777aa516949b4c4770aac5377a4c", "vector mac")
  check(parseKey("XY" + String(repeating: "0", count: 62)) == nil, "bad key refused")
  check(parseKey("AB" + String(repeating: "0", count: 62)) == nil, "upper-case key refused")

  // 2. the guard, in the same order as guard.ts
  let key = SymmetricKey(data: [UInt8](repeating: 7, count: 32))
  let g = Guard(key: key)
  var clock = 1_000_000.0
  g.now = { clock }
  g.screenRecording = { true }
  g.accessibility = { true }
  var secure = false
  var prot = false
  g.secureInput = { secure }
  g.protectedTarget = { _, _ in prot }
  var n = 0
  func grant(_ verb: String, _ args: [String: Any], exp: Double? = nil, id: String? = nil) -> [String: Any] {
    n += 1
    let gid = id ?? "g-selftest-\(n)"
    let e = Int64(exp ?? clock + 30_000)
    return ["id": gid, "exp": NSNumber(value: e), "mac": hmacHex(key, grantMessage(gid, e, verb, canonicalArgs(verb, args)!))]
  }
  let clickA: [String: Any] = ["x": 5, "y": 5, "button": "left"]
  check(g.check("click", clickA, nil)?.0 == "grant_missing", "no grant refused")
  let one = grant("click", clickA)
  check(g.check("click", clickA, one) == nil, "valid grant accepted")
  check(g.check("click", clickA, one)?.0 == "grant_replayed", "replayed grant refused")
  let old = grant("click", clickA, exp: clock + 10)
  clock += 11
  check(g.check("click", clickA, old)?.0 == "grant_expired", "expired grant refused")
  check(g.check("click", clickA, grant("click", clickA, exp: clock + 61_000))?.0 == "grant_invalid", "far-ahead grant refused")
  check(g.check("click", ["x": 6, "y": 5, "button": "left"], grant("click", clickA))?.0 == "grant_invalid", "grant for another point refused")
  check(g.check("type", ["text": "hellp"], grant("type", ["text": "hello"]))?.0 == "grant_invalid", "grant for other text refused")
  var forged = grant("click", clickA)
  forged["mac"] = String(repeating: "00", count: 32)
  check(g.check("click", clickA, forged)?.0 == "grant_invalid", "forged mac refused")
  check(g.check("shell", [:], grant("screenshot", [:]))?.0 == "bad_request", "unknown verb refused")
  secure = true
  check(g.check("type", ["text": "hunter2"], grant("type", ["text": "hunter2"]))?.0 == "secure_input", "secure input: typing refused")
  check(g.check("key", ["keys": "Return"], grant("key", ["keys": "Return"]))?.0 == "secure_input", "secure input: keys refused")
  check(g.check("click", clickA, grant("click", clickA)) == nil, "secure input: a click is still allowed")
  secure = false
  prot = true
  check(g.check("click", clickA, grant("click", clickA))?.0 == "protected_window", "protected window refused")
  prot = false
  clock += 5000
  for i in 0..<8 { check(g.check("click", clickA, grant("click", clickA)) == nil, "within rate \(i)") }
  check(g.check("click", clickA, grant("click", clickA))?.0 == "rate_limited", "rate limited")
  clock += 2001
  g.stop()
  check(g.check("click", clickA, grant("click", clickA))?.0 == "stopped", "stopped refuses")
  check(g.check("resume", [:], nil)?.0 == "grant_missing", "resume needs a grant")
  check(g.check("resume", [:], grant("resume", [:])) == nil, "granted resume lifts the stop")
  check(g.check("click", clickA, grant("click", clickA)) == nil, "works again after resume")
  g.accessibility = { false }
  check(g.check("click", clickA, grant("click", clickA))?.0 == "no_accessibility", "no accessibility refused")
  g.screenRecording = { false }
  check(g.check("screenshot", [:], grant("screenshot", [:]))?.0 == "no_screen_recording", "no screen recording refused")

  // 3. keys, protected windows, screenshot size
  if let c = chords("cmd+c Return") {
    check(c.count == 2 && c[0].0 == 8 && c[0].1 == .maskCommand && c[1].0 == 36 && c[1].1 == [], "chords parsed")
  } else { check(false, "chords parsed") }
  check(chords("hyper+a") == nil && chords("F99") == nil && chords("") == nil, "bad chords refused")
  check(isProtected(bundle: "com.apple.systempreferences", owner: nil), "System Settings protected")
  check(isProtected(bundle: nil, owner: "SecurityAgent"), "password prompt protected")
  check(isProtected(bundle: ownBundleId, owner: nil), "own windows protected")
  check(!isProtected(bundle: "com.apple.Safari", owner: "Safari"), "an ordinary app is not protected")
  check(isProtected(bundle: pasabotAppBundleId, owner: nil), "the PasaBot app window protected")
  check(isProtected(bundle: "com.google.Chrome", owner: "Google Chrome", title: "PasaBot"), "a browser tab showing PasaBot protected")
  check(!isProtected(bundle: "com.google.Chrome", owner: "Google Chrome", title: "Inbox"), "another browser tab is not protected")

  // 3b. long actions are checked before every step (security review: Tab/Return/cmd+space mid-action)
  let login = typeSteps("alice\thunter2\n")
  check(login == [.text(Array("alice".utf16)), .press(48, 0), .text(Array("hunter2".utf16)), .press(36, 0)], "type split at Tab and Return")
  check(typeSteps(String(repeating: "a", count: 40)).count == 3, "text in chunks of 16")
  var posted: [Step] = []
  var checks = 0
  // the username box is focused at first; after the Tab a password box has the keyboard
  let cut = runSteps(login, refusal: {
    checks += 1
    return posted.contains(.press(48, 0)) ? "secure_input" : nil
  }, run: { posted.append($0) })
  check(cut?.0 == "secure_input" && cut?.1 == 2 && posted.count == 2, "a password box after Tab stops the typing there")
  check(!posted.contains(.text(Array("hunter2".utf16))), "the password is never typed")
  check(checks == 3, "checked before each step up to the refusal")
  var ran = 0
  var asked = 0
  check(runSteps(keySteps("cmd+a cmd+c"), refusal: { asked += 1; return nil }, run: { _ in ran += 1 }) == nil && ran == 2 && asked == 2, "every step is checked")
  check(stepsRefusal("key", keySteps("cmd+space s y s t e m return tab tab space"))?["code"] as? String == "focus_moved", "cmd+space refused")
  check(stepsRefusal("key", keySteps("cmd+tab"))?["code"] as? String == "focus_moved", "cmd+tab refused")
  check(stepsRefusal("key", keySteps("ctrl+right"))?["code"] as? String == "focus_moved", "ctrl+arrow (Spaces) refused")
  check(stepsRefusal("key", keySteps("cmd+c Return")) == nil, "ordinary chords allowed")
  check(stepsRefusal("type", typeSteps(String(repeating: "a\n", count: 101)))?["code"] as? String == "bad_request", "too many line breaks refused")

  // 3c. the only trusted data folder is ~/.pasabot of this user (security review: `--home` from anyone)
  let canon = canonicalHome() ?? ""
  check(canon.hasSuffix("/.pasabot") && !canon.isEmpty, "canonical home is ~/.pasabot")
  check(trustedHome(["helper"], canonical: canon) == canon, "no --home: the canonical folder")
  check(trustedHome(["helper", "--home", canon + "/"], canonical: canon) == canon, "--home naming the canonical folder")
  check(trustedHome(["helper", "--home", "/tmp/ws"], canonical: canon) == nil, "--home elsewhere refused")
  check(trustedHome(["helper", "--home", canon + "/workspaces"], canonical: canon) == nil, "a folder inside it refused")
  check(trustedHome(["helper", "--home"], canonical: canon) == nil, "--home without a value refused")
  let kdir = NSTemporaryDirectory() + "pbsh-home-\(getpid())"
  mkdir(kdir, 0o700)
  mkdir(kdir + "/run", 0o700)
  FileManager.default.createFile(atPath: kdir + "/run/screen.key", contents: Data(String(repeating: "ab", count: 32).utf8), attributes: [.posixPermissions: 0o600])
  check(safeKeyText(home: kdir) == String(repeating: "ab", count: 32), "a private key file is read")
  let linked = NSTemporaryDirectory() + "pbsh-link-\(getpid())"
  symlink(kdir, linked)
  check(safeKeyText(home: linked) == nil, "a symlinked home is refused")
  chmod(kdir + "/run", 0o755)
  check(safeKeyText(home: kdir) == nil, "a run folder others can open is refused")
  chmod(kdir + "/run", 0o700)
  unlink(kdir + "/run/screen.key")
  symlink(kdir + "/elsewhere", kdir + "/run/screen.key")
  check(safeKeyText(home: kdir) == nil, "a symlinked key is refused")
  unlink(kdir + "/run/screen.key")
  unlink(linked)
  rmdir(kdir + "/run")
  rmdir(kdir)

  check(shotSize(pw: 1440, ph: 900) == (1440, 900), "small screen kept")
  check(shotSize(pw: 2560, ph: 1600) == (1600, 1000), "big screen scaled to 1600")

  // 4. the socket: 0600, same-user peer, HMAC handshake, no grant → refused
  let dir = NSTemporaryDirectory() + "pbsh-\(getpid())"
  mkdir(dir, 0o700)
  let sockPath = dir + "/s.sock"
  let sg = Guard(key: key)
  sg.screenRecording = { true }
  let srv = Server(path: sockPath, guardian: sg)
  srv.perform = { _, _ in ["ok": true, "width": 1, "height": 1, "pointsWidth": 1, "pointsHeight": 1] }
  srv.free = { verb, _ in verb == "status" ? ["ok": true] : ["ok": false] }
  do {
    try srv.start()
    var st = stat()
    check(stat(sockPath, &st) == 0 && (st.st_mode & 0o777) == 0o600, "socket is 0600")
    func connectLine(_ auth: (String) -> String, _ request: [String: Any]?) -> [[String: Any]] {
      let fd = socket(AF_UNIX, SOCK_STREAM, 0)
      var addr = sockaddr_un()
      addr.sun_family = sa_family_t(AF_UNIX)
      withUnsafeMutableBytes(of: &addr.sun_path) { p in
        for (i, b) in Array(sockPath.utf8).enumerated() { p[i] = b }
      }
      _ = withUnsafePointer(to: &addr) {
        $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
      }
      var tv = timeval(tv_sec: 2, tv_usec: 0)
      setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, socklen_t(MemoryLayout<timeval>.size))
      var out: [[String: Any]] = []
      var buf = Data()
      var chunk = [UInt8](repeating: 0, count: 4096)
      func readLine() -> [String: Any]? {
        while true {
          if let nl = buf.firstIndex(of: 0x0a) {
            let line = buf[buf.startIndex..<nl]
            buf = Data(buf[(nl + 1)...])
            return (try? JSONSerialization.jsonObject(with: line)) as? [String: Any]
          }
          let n = read(fd, &chunk, chunk.count)
          if n <= 0 { return nil }
          buf.append(contentsOf: chunk[0..<n])
        }
      }
      func write(_ o: [String: Any]) {
        var d = try! JSONSerialization.data(withJSONObject: o)
        d.append(0x0a)
        _ = d.withUnsafeBytes { Darwin.write(fd, $0.baseAddress!, d.count) }
      }
      if let hello = readLine(), let nonce = hello["hello"] as? String {
        write(["auth": auth(nonce)])
        if let welcome = readLine() {
          out.append(welcome)
          if let r = request {
            write(r)
            if let a = readLine() { out.append(a) }
          }
        }
      }
      close(fd)
      return out
    }
    let right = connectLine({ hmacHex(key, "hello|\($0)") }, ["id": 1, "verb": "screenshot", "args": [String: Any]()])
    check(right.first?["welcome"] as? Bool == true, "right key welcomed")
    check(right.count == 2 && right[1]["code"] as? String == "grant_missing", "no grant refused over the socket")
    let wrong = connectLine({ hmacHex(SymmetricKey(data: [UInt8](repeating: 9, count: 32)), "hello|\($0)") }, nil)
    check(wrong.isEmpty, "wrong key shut out")
    let granted = connectLine({ hmacHex(key, "hello|\($0)") }, ["id": 2, "verb": "screenshot", "args": [String: Any](), "grant": grant("screenshot", [:], exp: Date().timeIntervalSince1970 * 1000 + 20_000)])
    check(granted.count == 2 && granted[1]["ok"] as? Bool == true, "granted request answered over the socket")
  } catch {
    check(false, "socket started: \(error)")
  }
  unlink(sockPath)
  rmdir(dir)
  print("PasaBot Screen Helper selftest: \(passed) passed, \(failed) failed")
  return failed == 0 ? 0 : 1
}

// MARK: - main

let argv = CommandLine.arguments
if argv.contains("--selftest") { exit(selftest()) }
if argv.contains("--version") {
  print(helperVersion)
  exit(0)
}
guard let canonical = canonicalHome(), let home = trustedHome(argv, canonical: canonical) else {
  NSLog("PasaBot Screen Helper: it only works with PasaBot's standard data folder (~/.pasabot); quitting")
  exit(4)
}
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let delegate = Helper(home: home)
app.delegate = delegate
app.run()
