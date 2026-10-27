// Jobby — the dashboard in its own window.
//
// Jobby.app's launch script compiles this on first use (and again only when this
// file is newer than the binary), so the project still has no build step: no
// Xcode project, no package, just the Cocoa and WebKit frameworks that ship with
// macOS. If there is no Swift toolchain, the launcher opens the dashboard in the
// browser instead.
//
// The window is a WKWebView on http://127.0.0.1:8787 for the same reason a
// browser tab is: the dashboard, its API and its documents all come from the
// local server. What the window adds is that it behaves like an app — one
// window, the Jobby name and icon, no tab bar, no address bar, and it closes
// (and the server then stops itself) when the window is closed.

import Cocoa
import WebKit

final class JobbyApp: NSObject, NSApplicationDelegate, NSWindowDelegate, WKUIDelegate,
                      WKNavigationDelegate, WKDownloadDelegate, WKScriptMessageHandler {
    private let startURL: URL
    private var mainWindow: NSWindow?
    private var webView: WKWebView?
    private var extraWindows: [NSWindow] = []
    // The dashboard page's id with the server, so closing the window can tell
    // the server this page has gone even if the page itself is torn down first.
    private var clientId: String?

    init(url: URL) {
        startURL = url
        super.init()
    }

    // MARK: - Lifecycle

    func applicationDidFinishLaunching(_ notification: Notification) {
        buildMenu()

        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1280, height: 860),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "Jobby"
        window.minSize = NSSize(width: 960, height: 620)
        window.delegate = self
        if !window.setFrameUsingName("JobbyMainWindow") {
            window.center()
        }
        window.setFrameAutosaveName("JobbyMainWindow")

        let web = makeWebView(frame: window.contentLayoutRect)
        window.contentView = web
        window.makeKeyAndOrderFront(nil)

        mainWindow = window
        webView = web
        NSApp.activate(ignoringOtherApps: true)
        web.load(URLRequest(url: startURL))
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        true
    }

    func applicationWillTerminate(_ notification: Notification) {
        sayGoodbye()
    }

    // The page sends its own goodbye on pagehide; this is the same goodbye from
    // the app side, because a window closing can take the web view down without
    // the page ever getting the chance.
    private func sayGoodbye() {
        guard let client = clientId, !client.isEmpty else { return }
        guard let url = URL(string: "/api/bye", relativeTo: startURL) else { return }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("text/plain", forHTTPHeaderField: "Content-Type")
        request.timeoutInterval = 1
        request.httpBody = try? JSONSerialization.data(withJSONObject: ["client": client])
        let done = DispatchSemaphore(value: 0)
        URLSession.shared.dataTask(with: request) { _, _, _ in done.signal() }.resume()
        _ = done.wait(timeout: .now() + 1.0)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        webView.evaluateJavaScript("sessionStorage.getItem('jobpipe:dashboard')") { [weak self] value, _ in
            if let id = value as? String, !id.isEmpty {
                self?.clientId = id
            }
        }
    }

    // MARK: - The window's web view

    private func makeWebView(frame: NSRect) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        // The dashboard keeps its profile, theme and view in localStorage, so the
        // store has to be the persistent one rather than a throwaway.
        configuration.websiteDataStore = .default()
        configuration.userContentController = makeUserContentController()

        let web = WKWebView(frame: frame, configuration: configuration)
        web.autoresizingMask = [.width, .height]
        web.navigationDelegate = self
        web.uiDelegate = self
        return web
    }

    private func makeUserContentController() -> WKUserContentController {
        let controller = WKUserContentController()
        controller.addUserScript(printSupport())
        controller.addUserScript(downloadSupport())
        controller.add(self, name: "jobbyPrint")
        controller.add(self, name: "jobbyDownload")
        return controller
    }

    // WKWebView has no window.print of its own. The resume editor's Print button
    // opens a blank window, writes the resumé into it and calls print(), so that
    // call is routed back here and run as a real macOS print panel.
    private func printSupport() -> WKUserScript {
        let script = """
        (function () {
          if (window.__jobbyPrintHooked) { return; }
          window.__jobbyPrintHooked = true;
          window.print = function () {
            try { window.webkit.messageHandlers.jobbyPrint.postMessage(""); } catch (error) {}
          };
        })();
        """
        return WKUserScript(source: script, injectionTime: .atDocumentStart, forMainFrameOnly: false)
    }

    // The dashboard's downloads are all links with a download attribute — a blob
    // for an export, a signed API URL for a document — and WKWebView will not
    // hand those to the download delegate on its own (blob URLs never become a
    // navigation at all). So the click is caught in the page, the bytes are read
    // there and sent here, and this side writes the file: the same place the
    // browser would put it, without a second save dialog in the normal case.
    private func downloadSupport() -> WKUserScript {
        let script = """
        (function () {
          if (window.__jobbyDownloadHooked) { return; }
          window.__jobbyDownloadHooked = true;
          document.addEventListener("click", function (event) {
            var link = event.target && event.target.closest ? event.target.closest("a[download]") : null;
            if (!link || !link.href) { return; }
            event.preventDefault();
            var name = link.getAttribute("download");
            if (!name) {
              try { name = decodeURIComponent(new URL(link.href).pathname.split("/").pop() || "download"); }
              catch (error) { name = "download"; }
            }
            fetch(link.href).then(function (response) {
              if (!response.ok) { throw new Error("download failed"); }
              return response.blob();
            }).then(function (blob) {
              return blob.arrayBuffer();
            }).then(function (buffer) {
              var bytes = new Uint8Array(buffer);
              var binary = "";
              var chunk = 0x8000;
              for (var index = 0; index < bytes.length; index += chunk) {
                binary += String.fromCharCode.apply(null, bytes.subarray(index, index + chunk));
              }
              window.webkit.messageHandlers.jobbyDownload.postMessage({ name: name, data: btoa(binary) });
            }).catch(function () {
              // Could not read the bytes here: let a window have the URL rather
              // than navigating the dashboard away from itself.
              window.open(link.href, "_blank");
            });
          }, true);
        })();
        """
        return WKUserScript(source: script, injectionTime: .atDocumentStart, forMainFrameOnly: true)
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        switch message.name {
        case "jobbyPrint":
            guard let web = message.webView,
                  web.responds(to: NSSelectorFromString("printOperationWithPrintInfo:")) else { return }
            let selector = NSSelectorFromString("printOperationWithPrintInfo:")
            let result = web.perform(selector, with: NSPrintInfo.shared)
            (result?.takeUnretainedValue() as? NSPrintOperation)?.run()

        case "jobbyDownload":
            guard let body = message.body as? [String: Any],
                  let name = body["name"] as? String,
                  let encoded = body["data"] as? String,
                  let bytes = Data(base64Encoded: encoded, options: .ignoreUnknownCharacters) else { return }
            saveDownload(bytes, name: name)

        default:
            break
        }
    }

    // MARK: - Links, new windows and downloads

    func webView(
        _ webView: WKWebView,
        createWebViewWith configuration: WKWebViewConfiguration,
        for navigationAction: WKNavigationAction,
        windowFeatures: WKWindowFeatures
    ) -> WKWebView? {
        guard let url = navigationAction.request.url else { return nil }
        let scheme = url.scheme?.lowercased() ?? ""

        if scheme == "http" || scheme == "https" {
            // A real web page — a job posting, or a link inside a resumé. It
            // belongs in the browser, where the rest of the web lives.
            NSWorkspace.shared.open(url)
            return nil
        }

        // about:blank (the print window) and blob: (a document preview) only
        // mean something inside this app, so they get a window of their own.
        let child = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 900, height: 700),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        child.title = "Jobby"
        child.delegate = self
        let copy = configuration.copy() as? WKWebViewConfiguration ?? configuration
        copy.userContentController = makeUserContentController()
        let web = WKWebView(frame: child.contentLayoutRect, configuration: copy)
        web.autoresizingMask = [.width, .height]
        web.navigationDelegate = self
        web.uiDelegate = self
        child.contentView = web
        child.center()
        child.makeKeyAndOrderFront(nil)
        extraWindows.append(child)
        web.load(URLRequest(url: url))
        return web
    }

    func windowWillClose(_ notification: Notification) {
        guard let window = notification.object as? NSWindow, window !== mainWindow else { return }
        extraWindows.removeAll { $0 === window }
    }

    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
    ) {
        // A download attribute (the backup zip, a saved PDF, a .tex file) asks
        // for a file rather than a page; let the download machinery take it.
        decisionHandler(navigationAction.shouldPerformDownload ? .download : .allow)
    }

    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationResponse: WKNavigationResponse,
        decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void
    ) {
        let disposition = (navigationResponse.response as? HTTPURLResponse)?
            .value(forHTTPHeaderField: "Content-Disposition")?.lowercased() ?? ""
        let attachment = disposition.contains("attachment")
        decisionHandler(navigationResponse.canShowMIMEType && !attachment ? .allow : .download)
    }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        download.delegate = self
    }

    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
        download.delegate = self
    }

    func download(
        _ download: WKDownload,
        decideDestinationUsing response: URLResponse,
        suggestedFilename: String,
        completionHandler: @escaping (URL?) -> Void
    ) {
        let folder = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask).first
            ?? FileManager.default.homeDirectoryForCurrentUser
        completionHandler(uniqueDestination(in: folder, name: suggestedFilename))
    }

    // Same place the browser would put it, and never over the top of an earlier
    // download: "cv.pdf", "cv 2.pdf", "cv 3.pdf"…
    private func uniqueDestination(in folder: URL, name: String) -> URL {
        let clean = (name as NSString).lastPathComponent
        let base = (clean as NSString).deletingPathExtension
        let extensionPart = (clean as NSString).pathExtension
        var destination = folder.appendingPathComponent(clean)
        var counter = 2
        while FileManager.default.fileExists(atPath: destination.path) {
            let candidate = extensionPart.isEmpty ? "\(base) \(counter)" : "\(base) \(counter).\(extensionPart)"
            destination = folder.appendingPathComponent(candidate)
            counter += 1
        }
        return destination
    }

    // Downloads is where a browser would write, and the first choice here too.
    // If the system will not allow that folder, the file goes next to the app
    // rather than nowhere, and Finder opens on it so it can be found; if even
    // that fails, the user picks a place themselves.
    private func saveDownload(_ data: Data, name: String) {
        let clean = (name as NSString).lastPathComponent
        if let folder = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask).first {
            let target = uniqueDestination(in: folder, name: clean)
            if (try? data.write(to: target, options: .atomic)) != nil { return }
        }
        if let folder = projectDownloadsFolder() {
            try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            let target = uniqueDestination(in: folder, name: clean)
            if (try? data.write(to: target, options: .atomic)) != nil {
                NSWorkspace.shared.activateFileViewerSelecting([target])
                return
            }
        }
        let panel = NSSavePanel()
        panel.nameFieldStringValue = clean
        panel.canCreateDirectories = true
        if panel.runModal() == .OK, let target = panel.url {
            try? data.write(to: target, options: .atomic)
        }
    }

    // The folder next to Jobby.app's project, created on demand. Only used when
    // Downloads is refused, so a refused download still ends up somewhere the
    // user is shown.
    private func projectDownloadsFolder() -> URL? {
        let bundle = Bundle.main.bundleURL
        guard bundle.pathExtension == "app" else { return nil }
        let root = bundle.deletingLastPathComponent()
        guard FileManager.default.fileExists(atPath: root.appendingPathComponent("server.py").path) else {
            return nil
        }
        return root.appendingPathComponent("data/downloads", isDirectory: true)
    }

    func downloadDidFinish(_ download: WKDownload) {}

    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {}

    // MARK: - Menu

    private func buildMenu() {
        let mainMenu = NSMenu()

        let appItem = NSMenuItem()
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "About Jobby", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Hide Jobby", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        appMenu.addItem(withTitle: "Quit Jobby", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu
        mainMenu.addItem(appItem)

        let editItem = NSMenuItem()
        let editMenu = NSMenu(title: "Edit")
        editMenu.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        editMenu.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "Z")
        editMenu.addItem(.separator())
        editMenu.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        editMenu.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        editMenu.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = editMenu
        mainMenu.addItem(editItem)

        let viewItem = NSMenuItem()
        let viewMenu = NSMenu(title: "View")
        let reload = NSMenuItem(title: "Reload", action: #selector(reloadPage), keyEquivalent: "r")
        reload.target = self
        viewMenu.addItem(reload)
        let browser = NSMenuItem(title: "Open in Browser", action: #selector(openInBrowser), keyEquivalent: "O")
        browser.target = self
        viewMenu.addItem(browser)
        viewItem.submenu = viewMenu
        mainMenu.addItem(viewItem)

        let windowItem = NSMenuItem()
        let windowMenu = NSMenu(title: "Window")
        windowMenu.addItem(withTitle: "Minimize", action: #selector(NSWindow.miniaturize(_:)), keyEquivalent: "m")
        windowMenu.addItem(withTitle: "Close", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        windowItem.submenu = windowMenu
        mainMenu.addItem(windowItem)

        NSApp.mainMenu = mainMenu
    }

    @objc private func reloadPage() {
        webView?.reload()
    }

    @objc private func openInBrowser() {
        NSWorkspace.shared.open(startURL)
    }
}

// MARK: - Entry point

guard CommandLine.arguments.count > 1, let address = URL(string: CommandLine.arguments[1]) else {
    FileHandle.standardError.write(Data("JobbyWindow: pass the dashboard URL as the first argument\n".utf8))
    exit(2)
}

let app = NSApplication.shared
let delegate = JobbyApp(url: address)
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
