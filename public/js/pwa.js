/* Job Pipeline — installable app.
   Registers the service worker and keeps the browser chrome in step with the
   theme. ES module, no build step. Open the dashboard through server.py. */

const THEME_COLOURS = { dark: "#05060b", light: "#e8ecf7" };

/* Registers public/sw.js (served from the root, so it controls the dashboard).
   Missing support or a file:// start screen is fine: the app works either way. */
export function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  if (location.protocol !== "http:" && location.protocol !== "https:") return;
  navigator.serviceWorker.register("/sw.js").catch(() => {
    /* The dashboard still works; it just cannot be installed. */
  });
}

/* The meta theme-color tints the title bar of an installed window. */
export function syncThemeColor(theme) {
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", THEME_COLOURS[theme] || THEME_COLOURS.dark);
}

/* An installed window reopened while the server is down: reuse the start screen
   from the file:// case so the way out is on screen instead of a bare error. */
export function showOfflineScreen() {
  document.documentElement.classList.add("is-offline");
  const title = document.getElementById("file-guard-title");
  if (title) title.textContent = "Start the Job Pipeline server";
  const lead = document.getElementById("file-guard-lead");
  if (lead) {
    lead.textContent =
      "The dashboard opened, but the small Python server that keeps your jobs, documents and goals is not running." +
      " Start it with the command below, then check again.";
  }
  const status = document.getElementById("file-guard-status");
  if (status) {
    status.classList.remove("is-found");
    status.classList.add("is-error");
    status.textContent = "No answer from the server yet.";
  }
  const retry = document.getElementById("file-guard-retry");
  if (retry) retry.addEventListener("click", () => window.location.reload());
  const open = document.getElementById("file-guard-open");
  if (open) open.hidden = true;
  // The launcher usually brings the server back seconds after this screen
  // appears, so keep looking and step into the dashboard as soon as it answers.
  window.setInterval(() => {
    if (document.hidden) return;
    fetch("/api/health", { cache: "no-store" })
      .then(() => window.location.reload())
      .catch(() => {});
  }, 4000);
}
