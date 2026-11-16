// PasaBot for macOS (W26): a real app with its own window. Thin on purpose: it starts the launcher
// (`apps/desktop/dist/main.js` with the bundled node), shows the local web app in a WKWebView window, draws a small
// menu-bar icon as a second control, and sends commands back, one JSON object per line. All words arrive translated
// from the launcher (`labels`). Quitting, or being killed, closes the launcher's stdin; the launcher then stops the
// server, so nothing keeps running behind the person's back. ⌘W only hides the window: the server keeps running.
// Opening the app again (Finder, Dock, a second launch) brings the window back.
// Web view safety: only the server's own loopback origins load inside (see `navigationVerdict`); everything else opens
// in the default browser. No file:// access, no user scripts, no developer extras unless PASABOT_DESKTOP_DEVTOOLS=1;
// downloads go through a save panel; camera/mic only for the app origin. One script message handler, `pasabotSetup`:
// the claim page of the app's own origin (main frame only, `acceptsSetupLinkAsk`) may say "need-setup-link"; the
// launcher then asks the server over its private channel and the window moves to the fresh `#/setup?token=` link. The
// page never gets anything back through the handler; when no link comes it hears one data-less
// `pasabot:no-setup-link` event and says to reopen.
// Build: macos/build-app.sh (swiftc from the Command Line Tools; no Xcode project).
// `PasaBot --selftest` runs the pure decisions below without a GUI (smoke.sh does).
import AppKit
import WebKit

// MARK: - pure decisions (no AppKit state; `--selftest`)

/// scheme://host:port, or nil when the URL has no web origin
func origin(of url: URL?) -> String? {
  guard let u = url, let scheme = u.scheme?.lowercased(), ["http", "https"].contains(scheme), let host = u.host?.lowercased()
  else { return nil }
  let port = u.port ?? (scheme == "https" ? 443 : 80)
  return "\(scheme)://\(host):\(port)"
}

enum NavigationVerdict: Equatable { case allow, browser, cancel }

/// What the window does with a navigation. Main frame: only the app's own origin loads inside; any other http(s)
/// URL (chat links, store pages, OAuth, the sites origin as a whole page) opens in the default browser; anything else
/// (file:, custom schemes) is refused. Frames inside the page: the app origin and the sandboxed sites origin, plus
/// about:blank/srcdoc and blob: (the page's own content); other frames are refused, never opened in a browser.
func navigationVerdict(url: URL?, mainFrame: Bool, appOrigin: String?, sitesOrigin: String?) -> NavigationVerdict {
  guard let url = url, let scheme = url.scheme?.lowercased() else { return .cancel }
  let o = origin(of: url)
  if mainFrame {
    if let o = o, o == appOrigin { return .allow }
    return o != nil ? .browser : .cancel
  }
  if scheme == "about" || scheme == "blob" { return .allow }
  if let o = o, o == appOrigin || o == sitesOrigin { return .allow }
  return .cancel
}

/// camera/mic: the app origin only (voice), and only as a normal system prompt
func mayAskForMedia(requestOrigin: String?, appOrigin: String?) -> Bool {
  requestOrigin != nil && requestOrigin == appOrigin
}

/// `scheme://host:port` of a WKSecurityOrigin (port 0 = the scheme's default)
func securityOrigin(_ proto: String, _ host: String, _ port: Int) -> String {
  let p = proto.lowercased()
  return "\(p)://\(host.lowercased()):\(port == 0 ? (p == "https" ? 443 : 80) : port)"
}

/// the one script message handler the window installs (see the top of this file)
let setupBridgeName = "pasabotSetup"

/// The claim page asks for a fresh setup link: only from the main frame of the app's own origin, only that one word.
/// A frame (the sandboxed sites origin, an embed) or any other origin is refused.
func acceptsSetupLinkAsk(isMainFrame: Bool, frameOrigin: String?, appOrigin: String?, body: Any?) -> Bool {
  isMainFrame && frameOrigin != nil && frameOrigin == appOrigin && (body as? String) == "need-setup-link"
}

/// The launcher's fresh setup link, taken only for the app's own origin and the claim route (`#/setup?token=`).
func setupLinkTarget(_ s: String?, appOrigin: String?) -> URL? {
  guard let s = s, let u = URL(string: s), let o = origin(of: u), o == appOrigin, let frag = u.fragment,
    frag.hasPrefix("/setup?token=")
  else { return nil }
  return u
}

enum IconState: Equatable { case running, stopped, problem }

/// server: the launcher's `server` field (nil = no status yet); launcherFailed: the launcher could not start at all
func iconState(server: String?, allStopped: Bool, launcherFailed: Bool) -> IconState {
  if launcherFailed { return .problem }
  switch server {
  case "failed": return .problem
  case "stopped": return .stopped
  case "running", "external": return allStopped ? .stopped : .running
  default: return .running  // starting, stopping, or no status yet
  }
}

/// Should the window come up at launch? Yes, unless a headless run (smoke) asked for no browser and did not ask for
/// the window explicitly.
func showWindowAtLaunch(env: [String: String]) -> Bool {
  if env["PASABOT_DESKTOP_WINDOW"] == "1" { return true }
  return env["PASABOT_DESKTOP_NO_BROWSER"] != "1"
}

/// Where the window's size and position are remembered (UserDefaults "NSWindow Frame <name>").
let windowAutosaveName = "PasaBotWindow"

/// The window's first frame, when no size or position is saved yet: nearly full screen, i.e. the screen's visible
/// frame (without the menu bar and the Dock) minus a small margin (12 pt) on every side, centered; never below the
/// minimum.
func firstLaunchFrame(visible: CGRect, minSize: CGSize) -> CGRect {
  let margin: CGFloat = 12
  let w = max(minSize.width, visible.width - 2 * margin)
  let h = max(minSize.height, visible.height - 2 * margin)
  return CGRect(x: (visible.midX - w / 2).rounded(), y: (visible.midY - h / 2).rounded(), width: w, height: h)
}

func selfTest() -> Bool {
  var failed = 0
  var count = 0
  func check(_ ok: Bool, _ what: String) {
    count += 1
    if !ok {
      failed += 1
      print("selftest: FAIL \(what)")
    }
  }
  let app = origin(of: URL(string: "http://127.0.0.1:7777/"))
  let sites = origin(of: URL(string: "http://127.0.0.1:7778/"))
  let v = { (s: String, main: Bool) in navigationVerdict(url: URL(string: s), mainFrame: main, appOrigin: app, sitesOrigin: sites) }
  check(app == "http://127.0.0.1:7777", "origin keeps scheme, host and port")
  check(origin(of: URL(string: "https://example.com/x")) == "https://example.com:443", "default https port")
  check(origin(of: URL(string: "file:///etc/passwd")) == nil, "file: has no origin")
  check(v("http://127.0.0.1:7777/chat", true) == .allow, "the app loads in the window")
  check(v("http://127.0.0.1:7777/setup?token=x", true) == .allow, "the setup link loads in the window")
  check(v("http://localhost:7777/", true) == .browser, "another host name is another origin: browser")
  check(v("http://127.0.0.1:7779/", true) == .browser, "another port: browser")
  check(v("https://example.com/", true) == .browser, "a chat link: browser")
  check(v("https://accounts.example.com/oauth", true) == .browser, "OAuth: browser")
  check(v("http://127.0.0.1:7778/site/1", true) == .browser, "the sites origin as a whole page: browser")
  check(v("file:///etc/passwd", true) == .cancel, "file: never loads")
  check(v("javascript:alert(1)", true) == .cancel, "javascript: as a page never loads")
  check(v("pasabot://x", true) == .cancel, "custom schemes are refused")
  check(v("http://127.0.0.1:7778/site/1", false) == .allow, "the sandboxed sites origin may load in a frame")
  check(v("http://127.0.0.1:7777/embed", false) == .allow, "the app origin may load in a frame")
  check(v("about:blank", false) == .allow, "about:blank frames")
  check(v("https://example.com/", false) == .cancel, "foreign frames are refused, not opened")
  check(v("file:///tmp/x", false) == .cancel, "file: frames are refused")
  check(navigationVerdict(url: URL(string: "http://127.0.0.1:7777/"), mainFrame: true, appOrigin: nil, sitesOrigin: nil) == .browser,
        "before the server is known nothing loads inside")
  check(mayAskForMedia(requestOrigin: app, appOrigin: app), "mic for the app origin")
  check(!mayAskForMedia(requestOrigin: sites, appOrigin: app), "no mic for the sites origin")
  check(!mayAskForMedia(requestOrigin: nil, appOrigin: app), "no mic without an origin")
  check(securityOrigin("http", "127.0.0.1", 7777) == app, "a security origin compares like a URL origin")
  check(securityOrigin("HTTPS", "Example.com", 0) == "https://example.com:443", "security origin default port")
  let ask = { (main: Bool, o: String?, body: Any?) in acceptsSetupLinkAsk(isMainFrame: main, frameOrigin: o, appOrigin: app, body: body) }
  check(ask(true, app, "need-setup-link"), "the claim page may ask for a fresh setup link")
  check(!ask(false, app, "need-setup-link"), "a frame of the app origin may not ask")
  check(!ask(false, sites, "need-setup-link"), "the sandboxed sites origin may not ask")
  check(!ask(true, sites, "need-setup-link"), "another origin as the page may not ask")
  check(!ask(true, nil, "need-setup-link"), "no origin, no ask")
  check(!ask(true, app, "give-me-a-token"), "only that one word")
  check(!ask(true, app, ["need-setup-link"]), "only a plain string")
  check(!acceptsSetupLinkAsk(isMainFrame: true, frameOrigin: app, appOrigin: nil, body: "need-setup-link"),
        "before the server is known nobody may ask")
  check(setupLinkTarget("http://127.0.0.1:7777/#/setup?token=abc", appOrigin: app) != nil, "a fresh setup link is taken")
  check(setupLinkTarget("http://127.0.0.1:7778/#/setup?token=abc", appOrigin: app) == nil, "not for the sites origin")
  check(setupLinkTarget("https://example.com/#/setup?token=abc", appOrigin: app) == nil, "not for another origin")
  check(setupLinkTarget("http://127.0.0.1:7777/#/chat", appOrigin: app) == nil, "only the claim route")
  check(setupLinkTarget(nil, appOrigin: app) == nil, "null: nothing to take")
  check(iconState(server: "running", allStopped: false, launcherFailed: false) == .running, "running icon")
  check(iconState(server: "running", allStopped: true, launcherFailed: false) == .stopped, "all stopped icon")
  check(iconState(server: "stopped", allStopped: false, launcherFailed: false) == .stopped, "stopped icon")
  check(iconState(server: "failed", allStopped: false, launcherFailed: false) == .problem, "failed icon")
  check(iconState(server: nil, allStopped: false, launcherFailed: true) == .problem, "launcher failed icon")
  check(showWindowAtLaunch(env: [:]), "a normal start shows the window")
  check(!showWindowAtLaunch(env: ["PASABOT_DESKTOP_NO_BROWSER": "1"]), "a headless smoke run shows no window")
  check(
    showWindowAtLaunch(env: ["PASABOT_DESKTOP_NO_BROWSER": "1", "PASABOT_DESKTOP_WINDOW": "1"]),
    "the window can be asked for explicitly")
  let minSize = CGSize(width: 390, height: 500)
  let laptop = CGRect(x: 0, y: 0, width: 1440, height: 875)  // 1440x900 minus the menu bar
  let f = firstLaunchFrame(visible: laptop, minSize: minSize)
  check(f == CGRect(x: 12, y: 12, width: 1416, height: 851), "first launch: the visible frame minus 12 pt a side")
  check(f.midX == laptop.midX && f.midY == laptop.midY, "first launch: centered")
  let side = CGRect(x: 1440, y: 120, width: 1920, height: 1055)  // a second screen with a Dock at the bottom
  let g = firstLaunchFrame(visible: side, minSize: minSize)
  check(side.contains(g) && g.midX == side.midX && g.width == 1920 - 24, "first launch: on the screen it opens on")
  let tiny = firstLaunchFrame(visible: CGRect(x: 0, y: 0, width: 640, height: 480), minSize: minSize)
  check(tiny.width >= 390 && tiny.height >= 500, "first launch: never below the minimum size")
  check(windowAutosaveName != "PasaBotMain", "first launch: an old small saved frame is not restored")
  let qa = firstLaunchFrame(visible: CGRect(x: 0, y: 0, width: 1440, height: 826), minSize: minSize)
  check(qa == CGRect(x: 12, y: 12, width: 1416, height: 802), "first launch on QA's 1440x826 screen: nearly full screen")
  print("selftest: \(failed == 0 ? "PASS" : "FAIL") \(count - failed)/\(count) checks")
  return failed == 0
}

// MARK: - drawing

/// Our own mark, "Silip": two eyes. Template image, so macOS tints it for light and dark menu bars.
func eyesIcon(_ state: IconState) -> NSImage {
  let image = NSImage(size: NSSize(width: 18, height: 18), flipped: false) { _ in
    NSColor.black.set()
    for cx in [4.6, 13.4] as [CGFloat] {
      let eye = NSRect(x: cx - 3, y: 4.5, width: 6, height: 9)
      switch state {
      case .running:
        let outline = NSBezierPath(ovalIn: eye)
        outline.lineWidth = 1.4
        outline.stroke()
        // pupils look to the side: peeking
        NSBezierPath(ovalIn: NSRect(x: cx - 0.5, y: 6.8, width: 2.8, height: 3.4)).fill()
      case .stopped:
        let lid = NSBezierPath()
        lid.move(to: NSPoint(x: cx - 3, y: 9.5))
        lid.curve(
          to: NSPoint(x: cx + 3, y: 9.5), controlPoint1: NSPoint(x: cx - 1.6, y: 6.5),
          controlPoint2: NSPoint(x: cx + 1.6, y: 6.5))
        lid.lineWidth = 1.6
        lid.lineCapStyle = .round
        lid.stroke()
      case .problem:
        let outline = NSBezierPath(ovalIn: eye)
        outline.lineWidth = 1.4
        outline.stroke()
        let x = NSBezierPath()
        x.move(to: NSPoint(x: cx - 1.2, y: 7.8))
        x.line(to: NSPoint(x: cx + 1.2, y: 10.2))
        x.move(to: NSPoint(x: cx - 1.2, y: 10.2))
        x.line(to: NSPoint(x: cx + 1.2, y: 7.8))
        x.lineWidth = 1.3
        x.lineCapStyle = .round
        x.stroke()
      }
    }
    return true
  }
  image.isTemplate = true
  return image
}

/// Run on the main thread from the run loop (also inside the modal loop `terminateLater` runs). A main-queue
/// block cannot be used for the terminate dance: it would run inside another main-queue block and never drain.
func onMain(_ work: @escaping () -> Void) {
  RunLoop.main.perform(inModes: [.common, .modalPanel], block: work)
  CFRunLoopWakeUp(CFRunLoopGetMain())
}

// MARK: - the shell

/// Hands the claim page's message to the shell, holding it weakly (a WKUserContentController keeps its handlers alive).
final class SetupBridge: NSObject, WKScriptMessageHandler {
  private weak var shell: Shell?
  init(_ shell: Shell) { self.shell = shell }
  func userContentController(_ c: WKUserContentController, didReceive message: WKScriptMessage) {
    shell?.setupBridgeMessage(message)
  }
}

final class Shell: NSObject, NSApplicationDelegate, NSMenuDelegate, NSWindowDelegate, WKNavigationDelegate,
  WKUIDelegate, WKDownloadDelegate
{
  private let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
  private let launcher = Process()
  private let toLauncher = Pipe()
  private let fromLauncher = Pipe()
  private var buffer = Data()
  private var status: [String: Any] = [:]
  private var quitting = false
  private var launcherFailed = false
  private var window: NSWindow?
  private var web: WKWebView?
  /// the first-launch frame, held while the window first comes on screen and first comes to the front: Stage Manager
  /// moves a window that enters the stage to the right of its strip and narrows it to fit (QA: 1221x776 at x=219 on a
  /// 1440-wide screen, 219 being the strip), after the window is ordered in, so it is applied again on the next
  /// run-loop turn and a little later. Dropped once the user resizes or drags the window, or the hold is over.
  private var firstFrame: CGRect?
  private var heldOnKey = false
  /// what the window should show once it exists (the setup link wins over the plain app URL)
  private var pendingURL: URL?
  private var loadedOnce = false
  /// the window comes up with the first status, i.e. once this copy holds the lock: a second copy that only hands
  /// off never flashes a window of its own
  private lazy var windowAtLaunch = showWindowAtLaunch(env: env)
  private let env = ProcessInfo.processInfo.environment

  /// the server's origins, kept while it is stopped so the open page keeps the same rules
  private var appOrigin: String?
  private var sitesOrigin: String?
  private func label(_ k: String, _ fallback: String) -> String {
    let v = (status["labels"] as? [String: String])?[k] ?? ""
    return v.isEmpty ? fallback : v
  }

  func applicationDidFinishLaunching(_ note: Notification) {
    // set the Dock icon from the bundled .icns so it shows even before LaunchServices refreshes its icon cache
    if let f = Bundle.main.path(forResource: "PasaBot", ofType: "icns"), let img = NSImage(contentsOfFile: f) {
      NSApp.applicationIconImage = img
    }
    item.button?.imagePosition = .imageOnly
    refreshItem()
    rebuildMenu()
    rebuildMainMenu()
    startLauncher()
    // diagnostics only: what AppKit says about the menu-bar item (a full bar can hide it; the window does not care)
    DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in self?.logItem() }
  }

  private func logItem() {
    let w = item.button?.window
    NSLog(
      "PasaBot: menu-bar item isVisible=\(item.isVisible) window=\(w != nil) frame=\(w?.frame ?? .zero) occlusionVisible=\(w?.occlusionState.contains(.visible) ?? false)"
    )
  }

  private func resources() -> URL { Bundle.main.resourceURL ?? URL(fileURLWithPath: ".") }

  private func startLauncher() {
    let res = resources()
    let payloadURL = res.appendingPathComponent("payload.json")
    var root = res.appendingPathComponent("pasabot").path
    if let data = try? Data(contentsOf: payloadURL),
      let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
      let r = obj["root"] as? String
    {
      root = r.hasPrefix("/") ? r : res.appendingPathComponent(r).path
    }
    let node = res.appendingPathComponent("node").path
    launcher.executableURL = URL(fileURLWithPath: node)
    var args = [
      "\(root)/apps/desktop/dist/main.js", "--payload", payloadURL.path, "--app", Bundle.main.bundlePath,
      "--locale", Locale.preferredLanguages.first ?? "en", "--window",
    ]
    if env["PASABOT_DESKTOP_NO_BROWSER"] == "1" { args.append("--no-browser") }
    launcher.arguments = args
    launcher.standardInput = toLauncher
    launcher.standardOutput = fromLauncher
    launcher.terminationHandler = { _ in onMain { NSApp.terminate(nil) } }
    fromLauncher.fileHandleForReading.readabilityHandler = { [weak self] h in
      let chunk = h.availableData
      // EOF: the launcher is gone; stop listening, or this handler fires forever
      if chunk.isEmpty {
        h.readabilityHandler = nil
        return
      }
      DispatchQueue.main.async { self?.receive(chunk) }
    }
    do { try launcher.run() } catch {
      launcherFailed = true
      refreshItem()
      NSLog("PasaBot: could not start the launcher: \(error)")
    }
  }

  private func receive(_ chunk: Data) {
    buffer.append(chunk)
    while let nl = buffer.firstIndex(of: 0x0A) {
      let line = buffer.subdata(in: buffer.startIndex..<nl)
      buffer.removeSubrange(buffer.startIndex...nl)
      guard let obj = try? JSONSerialization.jsonObject(with: line) as? [String: Any],
        let event = obj["event"] as? String
      else { continue }
      handle(event, obj)
    }
  }

  private func handle(_ event: String, _ obj: [String: Any]) {
    switch event {
    case "status":
      status = obj
      if let o = origin(of: (obj["url"] as? String).flatMap(URL.init(string:))) { appOrigin = o }
      if let o = origin(of: (obj["sitesUrl"] as? String).flatMap(URL.init(string:))) { sitesOrigin = o }
      refreshItem()
      rebuildMenu()
      rebuildMainMenu()
      window?.title = label("title", "PasaBot")
      // the first time the server is up, the window shows the app (unless the setup link already went in)
      if !loadedOnce, let s = obj["url"] as? String, let url = URL(string: s) { load(url) }
      if windowAtLaunch {
        windowAtLaunch = false
        showWindow(reason: "launch")
      }
    case "open":
      // the setup link and "Open PasaBot" are the app's own origin: in the window; update pages etc.: the browser
      guard let s = obj["url"] as? String, let url = URL(string: s) else { break }
      if origin(of: url) != nil && origin(of: url) == appOrigin {
        load(url)
        showWindow(reason: "open")
      } else {
        openInBrowser(url)
      }
    case "setup-link":
      // the answer to the claim page's ask (or to the window coming back): null once an owner exists; never logged
      guard let url = setupLinkTarget(obj["url"] as? String, appOrigin: appOrigin) else {
        NSLog("PasaBot: no fresh setup link (an owner exists, or the server is not running)")
        noSetupLink()
        break
      }
      NSLog("PasaBot: fresh setup link received")
      useSetupLink(url)
    case "already-running":
      // handed off: the first copy brings up its own window; else (an older first copy) open its web app
      if obj["handedOff"] as? Bool == true {
        NSLog("PasaBot: already running; asked the running copy to show its window")
      } else if let s = obj["url"] as? String, let url = URL(string: s) {
        openInBrowser(url)
      }
      NSApp.terminate(nil)
    case "show":
      NSLog("PasaBot: show window (second launch)")
      showWindow(reason: "second launch")
      refreshSetupLink(why: "second launch")
    case "reveal":
      if let p = obj["path"] as? String {
        NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: p)])
      }
    case "notice":
      if let text = obj["text"] as? String {
        let alert = NSAlert()
        alert.messageText = text
        alert.runModal()
      }
    default:
      break
    }
  }

  private func openInBrowser(_ url: URL) {
    guard ["http", "https"].contains(url.scheme?.lowercased() ?? "") else { return }
    NSWorkspace.shared.open(url)
  }

  private func send(_ cmd: [String: Any]) {
    guard launcher.isRunning, var data = try? JSONSerialization.data(withJSONObject: cmd) else { return }
    data.append(0x0A)
    toLauncher.fileHandleForWriting.write(data)
  }

  // MARK: the window

  private func makeWindow() -> NSWindow {
    let config = WKWebViewConfiguration()
    // no user scripts; one handler only: the claim page's "need-setup-link" (checked in `setupBridgeMessage`)
    let content = WKUserContentController()
    content.add(SetupBridge(self), name: setupBridgeName)
    config.userContentController = content
    config.websiteDataStore = .default()  // keeps the sign-in between launches
    config.preferences.javaScriptCanOpenWindowsAutomatically = false
    if env["PASABOT_DESKTOP_DEVTOOLS"] == "1" { config.preferences.setValue(true, forKey: "developerExtrasEnabled") }
    let wv = WKWebView(frame: NSRect(x: 0, y: 0, width: 1200, height: 800), configuration: config)
    wv.navigationDelegate = self
    wv.uiDelegate = self
    wv.allowsBackForwardNavigationGestures = true
    wv.allowsMagnification = true
    if #available(macOS 13.3, *) { wv.isInspectable = env["PASABOT_DESKTOP_DEVTOOLS"] == "1" }
    let w = NSWindow(
      contentRect: NSRect(x: 0, y: 0, width: 1200, height: 800),
      styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
    w.isReleasedWhenClosed = false
    w.minSize = NSSize(width: 390, height: 500)
    w.contentView = wv
    w.title = label("title", "PasaBot")
    w.delegate = self
    w.center()
    // a new name on purpose: frames saved under the old "PasaBotMain" were the small 1200x800 default (QA saw
    // 1200x826 on a 1440x826 screen), and restoring them meant the first launch never came up nearly full screen
    let autosave = windowAutosaveName
    let saved = UserDefaults.standard.string(forKey: "NSWindow Frame \(autosave)") != nil
    w.setFrameAutosaveName(autosave)  // remembers the size and position the user leaves (restores a saved one)
    // first launch: nearly full screen on the screen it opens on, centered (then remembered like any other frame)
    if !saved, let visible = (NSScreen.main ?? NSScreen.screens.first)?.visibleFrame {
      let f = firstLaunchFrame(visible: visible, minSize: w.minSize)
      w.setFrame(f, display: false)
      firstFrame = f
      NSLog("PasaBot: main window first launch frame \(Int(w.frame.width))x\(Int(w.frame.height)) on visible \(Int(visible.width))x\(Int(visible.height))")
    } else {
      NSLog("PasaBot: main window restored frame \(Int(w.frame.width))x\(Int(w.frame.height))")
    }
    web = wv
    return w
  }

  private func showWindow(reason: String) {
    let w = window ?? makeWindow()
    window = w
    if let u = pendingURL {
      pendingURL = nil
      load(u)
    }
    w.makeKeyAndOrderFront(nil)
    if #available(macOS 14.0, *) { NSApp.activate() } else { NSApp.activate(ignoringOtherApps: true) }
    holdFirstFrame(w, why: reason, last: false)
    NSLog("PasaBot: main window shown (\(reason)) id=\(w.windowNumber) frame=\(Int(w.frame.width))x\(Int(w.frame.height))")
    DispatchQueue.main.asyncAfter(deadline: .now() + 1) {
      NSLog("PasaBot: main window settled frame=\(Int(w.frame.width))x\(Int(w.frame.height)) at \(Int(w.frame.minX)),\(Int(w.frame.minY))")
    }
  }

  private func load(_ url: URL) {
    guard navigationVerdict(url: url, mainFrame: true, appOrigin: appOrigin, sitesOrigin: sitesOrigin) == .allow else {
      return openInBrowser(url)
    }
    loadedOnce = true
    guard let wv = web else {
      pendingURL = url
      return
    }
    // never the query: the first-run setup link carries a one-time token there
    NSLog("PasaBot: main window loads \(url.scheme ?? "")://\(url.host ?? ""):\(url.port ?? 0)\(url.path.isEmpty ? "/" : url.path)")
    wv.load(URLRequest(url: url))
  }

  /// A fresh setup link replaces the page's address in place: the same document (a hash change, no reload), so the name
  /// and password the person typed stay. The link is never logged.
  private func useSetupLink(_ url: URL) {
    guard let wv = web, origin(of: wv.url) != nil, origin(of: wv.url) == appOrigin else { return load(url) }
    if #available(macOS 11.0, *) {
      wv.callAsyncJavaScript("location.replace(u)", arguments: ["u": url.absoluteString], in: nil, in: .page) { _ in }
    } else {
      wv.load(URLRequest(url: url))
    }
  }

  /// No fresh link came: the claim page of the app origin hears it at once (one event, no data) and says to reopen
  /// the app, instead of waiting out its own timer. Nothing else is told, and nothing is ever handed to the page.
  private func noSetupLink() {
    guard let wv = web, origin(of: wv.url) != nil, origin(of: wv.url) == appOrigin else { return }
    if #available(macOS 11.0, *) {
      wv.callAsyncJavaScript(
        "window.dispatchEvent(new Event('pasabot:no-setup-link'))", arguments: [:], in: nil, in: .page
      ) { _ in }
    }
  }

  /// the window came back (Dock, opening the app again, a second launch, the menu): while there is no owner, its claim
  /// page gets a fresh setup link, so a code that expired while the window sat there is never asked for; with an owner
  /// the launcher answers null and nothing changes
  private func refreshSetupLink(why: String) {
    // running: the launcher asks its server; external (`pasabot start`): it mints from the data dir, as the CLI does
    guard let s = status["server"] as? String, s == "running" || s == "external" else { return }
    NSLog("PasaBot: asking for a fresh setup link (\(why))")
    send(["cmd": "setup-link"])
  }

  /// the claim page's ask, from `SetupBridge`: the app origin's main frame, that one word; anything else is dropped
  func setupBridgeMessage(_ message: WKScriptMessage) {
    let f = message.frameInfo
    let o = securityOrigin(f.securityOrigin.protocol, f.securityOrigin.host, f.securityOrigin.port)
    guard message.webView === web,
      acceptsSetupLinkAsk(isMainFrame: f.isMainFrame, frameOrigin: o, appOrigin: appOrigin, body: message.body)
    else {
      NSLog("PasaBot: refused a page message (main frame: \(f.isMainFrame))")
      return
    }
    NSLog("PasaBot: the claim page asked for a fresh setup link")
    send(["cmd": "setup-link"])
  }

  /// Puts the first-launch frame back now, on the next run-loop turn and up to 2 s later, if something else (Stage
  /// Manager) changed it and the user has not; `last` ends the hold after its final check.
  private func holdFirstFrame(_ w: NSWindow, why: String, last: Bool) {
    guard let f = firstFrame else { return }
    let ticks: [Double] = [0, 0.05, 0.3, 1, 2]
    for (i, d) in ticks.enumerated() {
      let check = { [weak self] in
        guard let self, self.firstFrame == f else { return }
        // the user is resizing right now: theirs from here on
        if w.inLiveResize {
          self.firstFrame = nil
          return
        }
        if w.frame != f {
          let was = w.frame
          w.setFrame(f, display: true)
          NSLog(
            "PasaBot: first frame held (\(why) +\(d)s): was \(Int(was.width))x\(Int(was.height)) at \(Int(was.minX)),\(Int(was.minY)), now \(Int(w.frame.width))x\(Int(w.frame.height)) at \(Int(w.frame.minX)),\(Int(w.frame.minY))"
          )
        }
        if last && i == ticks.count - 1 { self.firstFrame = nil }
      }
      if d == 0 { check() } else { DispatchQueue.main.asyncAfter(deadline: .now() + d, execute: check) }
    }
  }

  /// the first time the window comes to the front (at launch, or later from the Stage Manager strip or the Dock)
  /// Stage Manager lays it out again: hold the first-launch frame once more, then let it go
  func windowDidBecomeKey(_ note: Notification) {
    guard !heldOnKey, firstFrame != nil, let w = note.object as? NSWindow else { return }
    heldOnKey = true
    NSLog("PasaBot: main window first to the front frame=\(Int(w.frame.width))x\(Int(w.frame.height)) at \(Int(w.frame.minX)),\(Int(w.frame.minY))")
    holdFirstFrame(w, why: "front", last: true)
  }

  /// a size or place the user sets is theirs (and remembered by the frame autosave), never fought; a move counts as
  /// theirs only when it starts from a mouse press in this window (a title-bar drag), not when Stage Manager moves it
  func windowWillStartLiveResize(_ note: Notification) { firstFrame = nil }
  func windowWillMove(_ note: Notification) {
    guard let e = NSApp.currentEvent, e.window === (note.object as? NSWindow) else { return }
    if e.type == .leftMouseDown || e.type == .leftMouseDragged { firstFrame = nil }
  }

  /// ⌘W and the close button only hide the window; the server keeps running
  func windowShouldClose(_ sender: NSWindow) -> Bool {
    sender.orderOut(nil)
    return false
  }

  /// a Dock click or opening the app again (Finder, `open`) while it runs
  func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
    showWindow(reason: "reopen")
    refreshSetupLink(why: "reopen")
    return false
  }

  func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

  // MARK: web view policy

  func webView(
    _ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
    decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
  ) {
    if action.shouldPerformDownload { return decisionHandler(.download) }
    let main = action.targetFrame?.isMainFrame ?? true
    switch navigationVerdict(url: action.request.url, mainFrame: main, appOrigin: appOrigin, sitesOrigin: sitesOrigin) {
    case .allow: decisionHandler(.allow)
    case .browser:
      if let u = action.request.url { openInBrowser(u) }
      decisionHandler(.cancel)
    case .cancel: decisionHandler(.cancel)
    }
  }

  func webView(
    _ webView: WKWebView, decidePolicyFor response: WKNavigationResponse,
    decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void
  ) {
    let disposition = (response.response as? HTTPURLResponse)?.value(forHTTPHeaderField: "Content-Disposition") ?? ""
    if !response.canShowMIMEType || disposition.lowercased().hasPrefix("attachment") {
      return decisionHandler(.download)
    }
    decisionHandler(.allow)
  }

  func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
    download.delegate = self
  }

  func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
    download.delegate = self
  }

  /// every download asks where to save it
  func download(
    _ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String,
    completionHandler: @escaping (URL?) -> Void
  ) {
    let panel = NSSavePanel()
    panel.nameFieldStringValue = suggestedFilename
    panel.canCreateDirectories = true
    let done = { (r: NSApplication.ModalResponse) in completionHandler(r == .OK ? panel.url : nil) }
    if let w = window { panel.beginSheetModal(for: w, completionHandler: done) } else { done(panel.runModal()) }
  }

  /// target=_blank and window.open: our own pages load in this window, anything else in the browser
  func webView(
    _ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction,
    windowFeatures: WKWindowFeatures
  ) -> WKWebView? {
    guard let u = action.request.url else { return nil }
    switch navigationVerdict(url: u, mainFrame: true, appOrigin: appOrigin, sitesOrigin: sitesOrigin) {
    case .allow: webView.load(URLRequest(url: u))
    case .browser: openInBrowser(u)
    case .cancel: break
    }
    return nil
  }

  @available(macOS 12.0, *)
  func webView(
    _ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin, initiatedByFrame frame: WKFrameInfo,
    type: WKMediaCaptureType, decisionHandler: @escaping (WKPermissionDecision) -> Void
  ) {
    let o = "\(origin.protocol)://\(origin.host):\(origin.port == 0 ? (origin.protocol == "https" ? 443 : 80) : origin.port)"
    decisionHandler(mayAskForMedia(requestOrigin: o, appOrigin: appOrigin) ? .prompt : .deny)
  }

  func webView(
    _ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo,
    completionHandler: @escaping () -> Void
  ) {
    let a = NSAlert()
    a.messageText = message
    a.addButton(withTitle: label("ok", "OK"))
    a.runModal()
    completionHandler()
  }

  func webView(
    _ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo,
    completionHandler: @escaping (Bool) -> Void
  ) {
    let a = NSAlert()
    a.messageText = message
    a.addButton(withTitle: label("ok", "OK"))
    a.addButton(withTitle: label("cancel", "Cancel"))
    completionHandler(a.runModal() == .alertFirstButtonReturn)
  }

  func webView(
    _ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?,
    initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (String?) -> Void
  ) {
    let a = NSAlert()
    a.messageText = prompt
    let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 280, height: 24))
    field.stringValue = defaultText ?? ""
    a.accessoryView = field
    a.addButton(withTitle: label("ok", "OK"))
    a.addButton(withTitle: label("cancel", "Cancel"))
    completionHandler(a.runModal() == .alertFirstButtonReturn ? field.stringValue : nil)
  }

  /// <input type=file>: the system open panel (the page only gets the files picked)
  func webView(
    _ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo,
    completionHandler: @escaping ([URL]?) -> Void
  ) {
    let panel = NSOpenPanel()
    panel.allowsMultipleSelection = parameters.allowsMultipleSelection
    panel.canChooseDirectories = parameters.allowsDirectories
    panel.canChooseFiles = true
    let done = { (r: NSApplication.ModalResponse) in completionHandler(r == .OK ? panel.urls : nil) }
    if let w = window { panel.beginSheetModal(for: w, completionHandler: done) } else { done(panel.runModal()) }
  }

  // MARK: menus

  private func refreshItem() {
    let labels = status["labels"] as? [String: String] ?? [:]
    let state = iconState(
      server: status["server"] as? String, allStopped: status["allStopped"] as? Bool ?? false,
      launcherFailed: launcherFailed)
    guard let b = item.button else { return }
    b.image = eyesIcon(state)
    // the words live in the tooltip and for VoiceOver, never in the bar
    let title = labels["title"] ?? "PasaBot"
    b.toolTip = labels["status"].map { $0.isEmpty ? title : $0 } ?? title
    b.setAccessibilityLabel(title)
    b.setAccessibilityHelp(labels["status"])
  }

  private func entry(_ title: String, _ action: Selector?, enabled: Bool = true, on: Bool? = nil) -> NSMenuItem {
    let m = NSMenuItem(title: title, action: action, keyEquivalent: "")
    m.target = self
    m.isEnabled = enabled && action != nil
    if let on = on { m.state = on ? .on : .off }
    return m
  }

  private func rebuildMenu() {
    let labels = status["labels"] as? [String: String] ?? [:]
    let can = status["can"] as? [String: Bool] ?? [:]
    let l = { (k: String) in labels[k] ?? "" }
    let menu = NSMenu()
    menu.autoenablesItems = false
    menu.addItem(entry(l("status").isEmpty ? "PasaBot" : l("status"), nil, enabled: false))
    if let url = status["url"] as? String { menu.addItem(entry(url, nil, enabled: false)) }
    menu.addItem(.separator())
    menu.addItem(entry(label("open", "Open PasaBot"), #selector(openWindow)))
    menu.addItem(entry(label("openInBrowser", "Open in browser"), #selector(openBrowser), enabled: can["open"] ?? false))
    menu.addItem(entry(l("stopAll"), #selector(stopAll), enabled: can["stopAll"] ?? false))
    menu.addItem(.separator())
    if can["stop"] ?? false {
      menu.addItem(entry(l("stop"), #selector(stopServer)))
    } else {
      menu.addItem(entry(l("start"), #selector(startServer), enabled: can["start"] ?? false))
    }
    menu.addItem(.separator())
    menu.addItem(
      entry(
        l("autostart"), #selector(toggleAutostart), enabled: status["autostartAvailable"] as? Bool ?? false,
        on: status["autostart"] as? Bool ?? false))
    let updates = status["updateCheck"] as? Bool ?? false
    menu.addItem(entry(l("updateCheck"), #selector(toggleUpdates), on: updates))
    if updates { menu.addItem(entry(l("checkNow"), #selector(checkNow))) }
    if let line = status["updateLine"] as? String {
      let hasPage = status["updatePage"] is String
      menu.addItem(entry(line, hasPage ? #selector(openUpdate) : nil, enabled: hasPage))
    }
    menu.addItem(.separator())
    menu.addItem(entry(l("logs"), #selector(logs)))
    menu.addItem(entry(label("quit", "Quit PasaBot"), #selector(quit)))
    item.menu = menu
  }

  /// the standard app menus; titles come from the launcher (English until the first status arrives)
  private func rebuildMainMenu() {
    func std(_ title: String, _ action: Selector, _ key: String, _ mods: NSEvent.ModifierFlags = .command) -> NSMenuItem {
      let m = NSMenuItem(title: title, action: action, keyEquivalent: key)
      m.keyEquivalentModifierMask = mods
      return m
    }
    func sub(_ title: String, _ items: [NSMenuItem]) -> NSMenuItem {
      let m = NSMenuItem(title: title, action: nil, keyEquivalent: "")
      let menu = NSMenu(title: title)
      items.forEach(menu.addItem)
      m.submenu = menu
      return m
    }
    let about = entry(label("about", "About PasaBot"), #selector(about))
    let hide = std(label("hide", "Hide PasaBot"), #selector(NSApplication.hide(_:)), "h")
    let quitItem = entry(label("quit", "Quit PasaBot"), #selector(quit))
    quitItem.keyEquivalent = "q"
    let reload = entry(label("reload", "Reload"), #selector(reloadPage))
    reload.keyEquivalent = "r"
    let actual = entry(label("actualSize", "Actual Size"), #selector(zoomReset))
    actual.keyEquivalent = "0"
    let zin = entry(label("zoomIn", "Zoom In"), #selector(zoomIn))
    zin.keyEquivalent = "+"
    let zout = entry(label("zoomOut", "Zoom Out"), #selector(zoomOut))
    zout.keyEquivalent = "-"
    let windowMenu = sub(
      label("window", "Window"),
      [
        std(label("minimize", "Minimize"), #selector(NSWindow.performMiniaturize(_:)), "m"),
        std(label("zoom", "Zoom"), #selector(NSWindow.performZoom(_:)), ""),
        std(label("close", "Close Window"), #selector(NSWindow.performClose(_:)), "w"),
      ])
    let bar = NSMenu()
    bar.addItem(sub("PasaBot", [about, .separator(), hide, .separator(), quitItem]))
    bar.addItem(
      sub(
        label("edit", "Edit"),
        [
          std(label("undo", "Undo"), Selector(("undo:")), "z"),
          std(label("redo", "Redo"), Selector(("redo:")), "z", [.command, .shift]),
          .separator(),
          std(label("cut", "Cut"), #selector(NSText.cut(_:)), "x"),
          std(label("copy", "Copy"), #selector(NSText.copy(_:)), "c"),
          std(label("paste", "Paste"), #selector(NSText.paste(_:)), "v"),
          std(label("selectAll", "Select All"), #selector(NSText.selectAll(_:)), "a"),
        ]))
    bar.addItem(sub(label("view", "View"), [reload, .separator(), actual, zin, zout]))
    bar.addItem(windowMenu)
    NSApp.mainMenu = bar
    NSApp.windowsMenu = windowMenu.submenu
  }

  @objc private func openWindow() {
    if web?.url == nil, let s = status["url"] as? String, let url = URL(string: s) { load(url) }
    showWindow(reason: "menu")
    refreshSetupLink(why: "menu")
  }
  @objc private func openBrowser() {
    if let s = status["url"] as? String, let url = URL(string: s) { openInBrowser(url) }
  }
  @objc private func about() {
    NSApp.orderFrontStandardAboutPanel(nil)
    if #available(macOS 14.0, *) { NSApp.activate() } else { NSApp.activate(ignoringOtherApps: true) }
  }
  @objc private func reloadPage() {
    if web?.url == nil, let s = status["url"] as? String, let url = URL(string: s) { load(url) } else { web?.reload() }
  }
  @objc private func zoomIn() { web.map { $0.pageZoom = min($0.pageZoom + 0.1, 3) } }
  @objc private func zoomOut() { web.map { $0.pageZoom = max($0.pageZoom - 0.1, 0.5) } }
  @objc private func zoomReset() { web?.pageZoom = 1 }
  @objc private func stopAll() { send(["cmd": "stop-all"]) }
  @objc private func startServer() { send(["cmd": "start"]) }
  @objc private func stopServer() { send(["cmd": "stop"]) }
  @objc private func toggleAutostart() { send(["cmd": "autostart", "on": !(status["autostart"] as? Bool ?? false)]) }
  @objc private func toggleUpdates() { send(["cmd": "update-check", "on": !(status["updateCheck"] as? Bool ?? false)]) }
  @objc private func checkNow() { send(["cmd": "check-now"]) }
  @objc private func openUpdate() { send(["cmd": "open-update"]) }
  @objc private func logs() { send(["cmd": "logs"]) }
  @objc private func quit() { NSApp.terminate(nil) }

  func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
    if quitting || !launcher.isRunning { return .terminateNow }
    quitting = true
    // closing stdin is the quit signal; the launcher stops the server, says bye and exits
    try? toLauncher.fileHandleForWriting.close()
    DispatchQueue.global().async { [launcher] in
      let deadline = Date().addingTimeInterval(15)
      while launcher.isRunning && Date() < deadline { usleep(50_000) }
      if launcher.isRunning { launcher.terminate() }
      onMain { NSApp.reply(toApplicationShouldTerminate: true) }
    }
    return .terminateLater
  }
}

if CommandLine.arguments.contains("--selftest") { exit(selfTest() ? 0 : 1) }

// SIGTERM (logout, `kill`) goes through the same clean quit as the menu
signal(SIGTERM, SIG_IGN)
let term = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
term.setEventHandler { onMain { NSApp.terminate(nil) } }
term.resume()

let app = NSApplication.shared
let shell = Shell()
app.delegate = shell
app.setActivationPolicy(.regular)
app.run()
