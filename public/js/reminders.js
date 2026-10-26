/* Jobby — One browser notification a day for follow-ups and reviews.
   ES module, no build step. Open the dashboard through server.py. */

import { $, state, todayISO } from "./core.js";
import { computeStats } from "./data.js";

const KEY = "jobpipe:reminders";

function store() {
  try {
    return window.localStorage;
  } catch (error) {
    return null;
  }
}

function remembered() {
  const storage = store();
  if (!storage) return "";
  try {
    return storage.getItem(KEY) || "";
  } catch (error) {
    return "";
  }
}

function remember(value) {
  const storage = store();
  if (!storage) return;
  try {
    storage.setItem(KEY, value);
  } catch (error) {
    /* private mode: the setting simply does not stick */
  }
}

export function notificationsSupported() {
  return typeof window.Notification === "function";
}

export function notificationPermission() {
  return notificationsSupported() ? window.Notification.permission : "unsupported";
}

export function remindersOn() {
  return remembered() === "on" && notificationPermission() === "granted";
}

export async function enableReminders() {
  if (!notificationsSupported()) {
    throw new Error("This browser cannot show notifications.");
  }
  // Some environments never settle this promise because no prompt appears, so
  // give up after a while instead of leaving the button spinning forever.
  const result = await Promise.race([
    window.Notification.requestPermission(),
    new Promise((resolve) => window.setTimeout(() => resolve("timeout"), 15000)),
  ]);
  if (result === "denied") {
    throw new Error(
      "Notifications are blocked for this page. Allow them in the browser's site settings, then try again."
    );
  }
  if (result === "timeout") {
    throw new Error("The browser did not answer the permission prompt. Try again.");
  }
  if (result !== "granted") {
    throw new Error("Notifications were not allowed, so reminders stay off.");
  }
  remember("on");
}

export function disableReminders() {
  remember("off");
}

export function renderReminderSettings() {
  const status = $("#settings-reminders-status");
  if (!status) return;
  const permission = notificationPermission();
  const on = remindersOn();
  let text = "Off — no notifications.";
  if (permission === "unsupported") text = "This browser cannot show notifications.";
  else if (on) text = "On — one summary a day while the dashboard is open.";
  else if (permission === "denied") {
    text = "Blocked by the browser. Allow notifications for this page to turn reminders on.";
  }
  status.textContent = text;
  $("#settings-reminders-on").hidden = on;
  $("#settings-reminders-off").hidden = !on;
  const error = $("#settings-reminders-error");
  error.hidden = true;
  error.textContent = "";
}

export function reminderSummary() {
  const stats = computeStats();
  const parts = [];
  if (stats.followUps) {
    parts.push(stats.followUps + " follow-up" + (stats.followUps === 1 ? "" : "s") + " due");
  }
  if (stats.reviewCount) {
    parts.push(stats.reviewCount + " job" + (stats.reviewCount === 1 ? "" : "s") + " to review");
  }
  return parts.join(" · ");
}

/* The installed app posts through the service worker, where a page is not
   allowed to raise a notification itself. */
function workerRegistration() {
  if (!("serviceWorker" in navigator)) return Promise.resolve(null);
  return Promise.race([
    navigator.serviceWorker.ready.catch(() => null),
    new Promise((resolve) => window.setTimeout(() => resolve(null), 2000)),
  ]);
}

async function post(title, options) {
  try {
    new window.Notification(title, options);
    return true;
  } catch (error) {
    // Mobile browsers and installed windows only allow the service worker.
  }
  const registration = await workerRegistration();
  if (!registration || typeof registration.showNotification !== "function") return false;
  try {
    await registration.showNotification(title, options);
    return true;
  } catch (error) {
    return false;
  }
}

/* At most one notification per profile per day, and only when the dashboard is
   open: this is a local tracker, not a background service. */
export async function maybeNotify() {
  if (!remindersOn()) return false;
  const summary = reminderSummary();
  if (!summary) return false;
  const seen = "jobpipe:reminded:" + (state.profileId || 0) + ":" + todayISO();
  const storage = store();
  try {
    if (storage && storage.getItem(seen)) return false;
  } catch (error) {
    /* carry on: a duplicate note is better than none */
  }
  const shown = await post("Jobby", {
    body: summary,
    tag: "jobpipe-reminders",
    icon: "icon-192.png",
    badge: "icon-192.png",
  });
  if (!shown) return false;
  try {
    if (storage) storage.setItem(seen, "1");
  } catch (error) {
    /* nothing to do */
  }
  return true;
}
