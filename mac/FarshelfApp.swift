// Native macOS shell for Farshelf: a real window (WKWebView) with a Dock icon and menus.
// It starts the bundled Farshelf daemon if it is not already running, signs in with the local token,
// and stops the daemon it started when you quit. Built by scripts/build-macos-app.sh with swiftc.
import Cocoa
import WebKit

final class AppDelegate: NSObject, NSApplicationDelegate, WKUIDelegate, WKNavigationDelegate {
  private var window: NSWindow!
  private var webView: WKWebView!
  private var daemon: Process?
  private var quitting = false
  private let env = ProcessInfo.processInfo.environment
  private lazy var port: Int = Int(env["FARSHELF_PORT"] ?? "") ?? 7420

  private var dataDir: URL {
    if let home = env["FARSHELF_HOME"], !home.isEmpty { return URL(fileURLWithPath: home) }
    let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
    return support.appendingPathComponent("Farshelf")
  }

  private var logURL: URL {
    FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Logs/Farshelf.log")
  }

  // MARK: launch

  func applicationDidFinishLaunching(_ notification: Notification) {
    buildMenu()
    buildWindow()
    showMessage("Starting Farshelf…")
    NSApp.activate(ignoringOtherApps: true)
    DispatchQueue.global(qos: .userInitiated).async { self.connect() }
  }

  private func connect() {
    if !isUp() { startDaemon() }
    var token: String?
    for _ in 0..<120 {  // up to 30 s
      if isUp(), let t = readToken() { token = t; break }
      if let d = daemon, !d.isRunning { break }
      usleep(250_000)
    }
    DispatchQueue.main.async {
      guard let token = token else {
        self.showMessage("Farshelf could not start. Details are in ~/Library/Logs/Farshelf.log")
        return
      }
      let url = URL(string: "http://127.0.0.1:\(self.port)/login#t=\(token)")!
      self.webView.load(URLRequest(url: url))
    }
  }

  /// Any HTTP answer (even 401) means the daemon is listening.
  private func isUp() -> Bool {
    var up = false
    let done = DispatchSemaphore(value: 0)
    var req = URLRequest(url: URL(string: "http://127.0.0.1:\(port)/api/state")!)
    req.timeoutInterval = 1
    URLSession.shared.dataTask(with: req) { _, response, _ in
      up = response is HTTPURLResponse
      done.signal()
    }.resume()
    _ = done.wait(timeout: .now() + 2)
    return up
  }

  private func readToken() -> String? {
    guard let data = try? Data(contentsOf: dataDir.appendingPathComponent("auth.json")),
      let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    else { return nil }
    return json["apiToken"] as? String
  }

  private func startDaemon() {
    guard let res = Bundle.main.resourceURL else { return }
    let p = Process()
    p.executableURL = res.appendingPathComponent("node")
    p.arguments = [
      res.appendingPathComponent("node_modules/farshelf/dist/server/server/cli.js").path,
      "start", "--port", String(port), "--no-open",
    ]
    try? FileManager.default.createDirectory(at: logURL.deletingLastPathComponent(), withIntermediateDirectories: true)
    if !FileManager.default.fileExists(atPath: logURL.path) {
      FileManager.default.createFile(atPath: logURL.path, contents: nil)
    }
    if let log = try? FileHandle(forWritingTo: logURL) {
      log.seekToEndOfFile()
      log.write("=== Farshelf started \(Date()) ===\n".data(using: .utf8)!)
      p.standardOutput = log
      p.standardError = log
    }
    p.terminationHandler = { proc in
      DispatchQueue.main.async {
        guard !self.quitting else { return }
        if proc.terminationStatus == 0 {
          NSApp.terminate(nil)  // "Quit Farshelf" in Settings stops the daemon: close the app too.
        } else {
          self.showMessage("Farshelf stopped unexpectedly. Details are in ~/Library/Logs/Farshelf.log")
        }
      }
    }
    do {
      try p.run()
      daemon = p
    } catch {
      DispatchQueue.main.async { self.showMessage("Could not start Farshelf: \(error.localizedDescription)") }
    }
  }

  func applicationWillTerminate(_ notification: Notification) {
    quitting = true
    guard let d = daemon, d.isRunning else { return }
    d.interrupt()  // SIGINT: the daemon saves state and re-queues running uploads
    let deadline = Date().addingTimeInterval(5)
    while d.isRunning && Date() < deadline { usleep(100_000) }
    if d.isRunning { d.terminate() }
  }

  func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

  func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
    window.makeKeyAndOrderFront(nil)
    return true
  }

  // MARK: window and menus

  private func buildWindow() {
    let config = WKWebViewConfiguration()
    config.websiteDataStore = .default()  // keeps the session cookie between launches
    webView = WKWebView(frame: .zero, configuration: config)
    webView.uiDelegate = self
    webView.navigationDelegate = self
    webView.setValue(false, forKey: "drawsBackground")
    window = NSWindow(
      contentRect: NSRect(x: 0, y: 0, width: 1200, height: 780),
      styleMask: [.titled, .closable, .miniaturizable, .resizable],
      backing: .buffered, defer: false)
    window.title = "Farshelf"
    window.minSize = NSSize(width: 720, height: 480)
    window.contentView = webView
    window.center()
    window.setFrameAutosaveName("FarshelfMain")
    window.isReleasedWhenClosed = false
    window.makeKeyAndOrderFront(nil)
  }

  private func showMessage(_ text: String) {
    let html = """
      <html><body style="font:15px -apple-system;display:flex;height:100vh;margin:0;align-items:center;justify-content:center;\
      color:#5e6b66;background:#f6f1e6"><p>\(text)</p></body></html>
      """
    webView.loadHTMLString(html, baseURL: nil)
  }

  private func buildMenu() {
    let main = NSMenu()
    let appItem = NSMenuItem()
    main.addItem(appItem)
    let appMenu = NSMenu()
    appMenu.addItem(withTitle: "About Farshelf", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
    appMenu.addItem(.separator())
    appMenu.addItem(withTitle: "Hide Farshelf", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
    appMenu.addItem(.separator())
    appMenu.addItem(withTitle: "Quit Farshelf", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
    appItem.submenu = appMenu

    let editItem = NSMenuItem()
    main.addItem(editItem)
    let edit = NSMenu(title: "Edit")
    edit.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
    edit.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "Z")
    edit.addItem(.separator())
    edit.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
    edit.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
    edit.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
    edit.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
    editItem.submenu = edit

    let viewItem = NSMenuItem()
    main.addItem(viewItem)
    let view = NSMenu(title: "View")
    view.addItem(withTitle: "Reload", action: #selector(reload), keyEquivalent: "r")
    view.addItem(withTitle: "Open in Browser", action: #selector(openInBrowser), keyEquivalent: "")
    viewItem.submenu = view

    let windowItem = NSMenuItem()
    main.addItem(windowItem)
    let win = NSMenu(title: "Window")
    win.addItem(withTitle: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
    win.addItem(withTitle: "Close", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
    windowItem.submenu = win
    NSApp.windowsMenu = win
    NSApp.mainMenu = main
  }

  @objc private func reload() { webView.reload() }

  @objc private func openInBrowser() {
    if let token = readToken(), let url = URL(string: "http://127.0.0.1:\(port)/login#t=\(token)") {
      NSWorkspace.shared.open(url)
    }
  }

  // MARK: web view behaviour

  /// Links that open a new tab (files, stream links, Google sign-in) go to the default browser or player.
  func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
               for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
    if let url = navigationAction.request.url { NSWorkspace.shared.open(url) }
    return nil
  }

  /// Keep the window on Farshelf itself; anything else opens externally.
  func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
               decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
    guard let url = navigationAction.request.url else { return decisionHandler(.allow) }
    let local = url.scheme == "about" || url.host == "127.0.0.1" || url.host == "localhost"
    if local || navigationAction.targetFrame?.isMainFrame == false {
      decisionHandler(.allow)
    } else {
      NSWorkspace.shared.open(url)
      decisionHandler(.cancel)
    }
  }

  /// <input type="file"> (the Upload button).
  func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters,
               initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
    let panel = NSOpenPanel()
    panel.allowsMultipleSelection = parameters.allowsMultipleSelection
    panel.canChooseDirectories = parameters.allowsDirectories
    panel.canChooseFiles = true
    panel.beginSheetModal(for: window) { result in
      completionHandler(result == .OK ? panel.urls : nil)
    }
  }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
