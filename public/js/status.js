/* Job Pipeline — is the local server still answering?

   Every screen here is backed by the small Python server on this machine, so a
   server that stops has to be visible instead of turning into a run of failed
   clicks. The pill in the topbar answers from GET /api/health (the one endpoint
   that needs no token): it goes red the moment a request cannot reach the
   server, keeps checking quietly on a short backoff until it is back, and
   offers Retry for a check the user asks for. A browser cannot start a process
   on this machine, so the launcher scripts keep the server running; this only
   reports what it finds.

   ES module, no build step. Open the dashboard through server.py. */

import { $, state, toast } from "./core.js";

const STEADY_MS = 20000; // heartbeat while the server answers
const RETRY_MIN_MS = 2000; // first wait once it stops answering
const RETRY_MAX_MS = 20000; // slowest wait while it stays away
const PROBE_TIMEOUT_MS = 4000; // a socket that hangs is not an answer either
const BLIP_MS = 5000; // shorter than this and it was a hiccup, not an outage

let timer = null;
let probing = false;
let wait = RETRY_MIN_MS;
let online = null; // null until the first answer: "checking"
let seen = false; // the server has answered at least once in this tab
let downSince = 0; // when the current outage began; 0 while it answers


function address() {
  return window.location.origin && window.location.origin !== "null"
    ? window.location.origin
    : "http://127.0.0.1:8787";
}


function paint() {
  const pill = $("#server-status");
  if (!pill) return;
  const current = online === null ? "checking" : online ? "online" : "offline";
  pill.dataset.state = current;
  const label = $("#server-status-text");
  if (label) {
    label.textContent =
      current === "online"
        ? "Server active"
        : current === "offline"
        ? "Server offline"
        : "Checking server…";
  }
  const retry = $("#server-status-retry");
  if (retry) {
    retry.hidden = current !== "offline";
    retry.disabled = false;
  }
  pill.title =
    current === "online"
      ? "The tracker server at " + address() + " is answering."
      : current === "offline"
      ? "No answer from " + address() + ". Double-click “Start Job Pipeline.command” (macOS) or " +
        "“Start Job Pipeline.bat” (Windows) to start it again — Retry checks again at once."
      : "Checking whether the tracker server is running…";
}


function schedule(ms) {
  window.clearTimeout(timer);
  timer = window.setTimeout(probe, ms);
}


/* The wait after a failed check grows, so a server that is down for an hour is
   not asked every two seconds, and shrinks back as soon as it answers. */
function nextWait() {
  const ms = wait;
  wait = Math.min(Math.round(wait * 1.6), RETRY_MAX_MS);
  return ms;
}


function note(reachable) {
  if (reachable) {
    const outage = downSince ? Date.now() - downSince : 0;
    if (seen && outage >= BLIP_MS) {
      // Only an outage the user could have noticed is worth saying out loud,
      // and reloading is a choice: an open editor may hold unsaved text.
      toast("The tracker server is back", false, null, {
        label: "Reload",
        onClick: () => window.location.reload(),
      });
    }
    seen = true;
    downSince = 0;
    online = true;
    wait = RETRY_MIN_MS;
    state.serverOnline = true;
    paint();
    schedule(STEADY_MS);
    return;
  }
  // Already known to be down: the heartbeat below is running, and a burst of
  // failed requests must not walk the backoff out from under it.
  if (online === false) return;
  if (!downSince) downSince = Date.now();
  online = false;
  state.serverOnline = false;
  paint();
  schedule(nextWait());
}


async function probe() {
  if (probing) return;
  // A tab nobody is looking at can skip its steady heartbeat; coming back into
  // view asks for a check straight away.
  if (document.hidden && online !== false) {
    schedule(STEADY_MS);
    return;
  }
  probing = true;
  let reachable = false;
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  const abort = controller ? window.setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS) : null;
  try {
    const response = await fetch("/api/health", {
      cache: "no-store",
      signal: controller ? controller.signal : undefined,
    });
    reachable = response.ok;
    // Read the body out: a response left hanging keeps this request open, and
    // the page would then never look idle to anything watching its network.
    await response.text();
  } catch (error) {
    reachable = false;
  } finally {
    if (abort) window.clearTimeout(abort);
    probing = false;
  }
  note(reachable);
}


function retryNow() {
  // A retry the user asked for goes back to the fast cadence and checks at once
  // rather than waiting out a backoff.
  wait = RETRY_MIN_MS;
  online = null;
  paint();
  window.clearTimeout(timer);
  probe();
}


export function startServerWatch() {
  if (!$("#server-status")) return;
  paint();
  const retry = $("#server-status-retry");
  if (retry) retry.addEventListener("click", retryNow);
  // A request that cannot reach the server turns the pill red at once, without
  // waiting for the next heartbeat; one that gets through clears it.
  document.addEventListener("jobpipe:server-error", () => note(false));
  document.addEventListener("jobpipe:server-ok", () => {
    if (online === false) note(true);
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) return;
    window.clearTimeout(timer);
    probe();
  });
  window.addEventListener("online", () => {
    window.clearTimeout(timer);
    probe();
  });
  probe();
}
