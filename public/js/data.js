/* Jobby — Loading, filtering and mutating data (jobs, documents, bulk actions).
   ES module, no build step. Open the dashboard through server.py. */

import { $, CLOSED, DEFAULT_GOALS, DOC_LABEL, MAX_UPLOAD, STATUSES, STATUS_LABEL, api, appliedDays, bestStreak, currentStreak, dayDiff, download, fetchFile, isoOf, matchPct, needsReview, parseDateOnly, startOfDay, startOfWeek, state, toast, todayISO, tokenFor } from "./core.js";
import { chooseSavedFile, confirmAction } from "./dialogs.js";
import { closeDrawer, openDrawer } from "./drawer.js";
import { openUnlock } from "./profiles.js";
import { render, setTab } from "./workspace.js";
import { maybeNotify } from "./reminders.js";


export function profileNeedsUnlock() {
  const profile = activeProfile();
  return !!(profile && profile.locked && !tokenFor(profile.id));
}


export async function loadApps() {
  if (profileNeedsUnlock()) {
    // Nothing is fetched for a locked profile: the server would refuse it.
    state.apps = [];
    state.trash = [];
    state.settings = Object.assign({}, DEFAULT_GOALS);
    state.loading = false;
    render();
    openUnlock(state.profileId);
    return;
  }
  state.loading = true;
  render();
  try {
    const results = await Promise.all([
      api("/api/applications"),
      api("/api/applications?trash=1"),
      api("/api/settings"),
    ]);
    state.apps = Array.isArray(results[0]) ? results[0] : [];
    state.trash = Array.isArray(results[1]) ? results[1] : [];
    state.settings = Object.assign({}, DEFAULT_GOALS, results[2] || {});
  } catch (error) {
    toast(error.message, true);
    state.apps = [];
    state.trash = [];
  } finally {
    state.loading = false;
    render();
    // A reminder is due once a day, whatever opened the dashboard.
    maybeNotify();
  }
}


export function updateLocal(app) {
  const index = state.apps.findIndex((item) => item.id === app.id);
  if (index === -1) state.apps.push(app);
  else state.apps[index] = app;
  render();
}


export function appsIn(phase) {
  return state.apps.filter((app) => (app.phase === "to_apply" ? "to_apply" : "applied") === phase);
}


function inMatchBand(band, app) {
  if (!band) return true;
  const pct = matchPct(app);
  if (band === "none") return pct === null;
  if (pct === null) return false;
  if (band === "under40") return pct < 40;
  if (band === "80") return pct >= 80;
  if (band === "60") return pct >= 60 && pct < 80;
  if (band === "40") return pct >= 40 && pct < 60;
  return true;
}


export function visibleApps(phase) {
  const query = state.filters.q.trim().toLowerCase();
  const { status, mode, source, match } = state.filters;
  const list = appsIn(phase).filter((app) => {
    if (phase === "applied" && status && app.status !== status) return false;
    if (mode && app.work_mode !== mode) return false;
    if (source && app.source !== source) return false;
    if (!inMatchBand(match, app)) return false;
    if (!query) return true;
    return [app.company, app.role, app.location, app.source, app.notes, app.description, app.next_step, app.contact_name]
      .join(" ")
      .toLowerCase()
      .includes(query);
  });
  return sortApps(list, state.sort[phase]);
}


export function sortApps(list, sort) {
  const { key, dir } = sort;
  const factor = dir === "asc" ? 1 : -1;
  if (key === "match_pct") {
    // A job with no estimate is not a low match: it always sinks to the end.
    return list.slice().sort((a, b) => {
      const left = matchPct(a);
      const right = matchPct(b);
      if (left === null && right === null) return b.id - a.id;
      if (left === null) return 1;
      if (right === null) return -1;
      if (left !== right) return (left - right) * factor;
      return b.id - a.id;
    });
  }
  return list.slice().sort((a, b) => {
    const left = a[key] == null ? "" : String(a[key]);
    const right = b[key] == null ? "" : String(b[key]);
    if (key === "id") return (a.id - b.id) * factor;
    const comparison = left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" });
    if (comparison !== 0) return comparison * factor;
    return b.id - a.id;
  });
}


export function computeStats() {
  const applied = appsIn("applied");
  const total = applied.length;
  const byStatus = STATUSES.reduce((acc, status) => {
    acc[status.key] = 0;
    return acc;
  }, {});
  applied.forEach((app) => {
    if (byStatus[app.status] == null) byStatus[app.status] = 0;
    byStatus[app.status] += 1;
  });
  const active = byStatus.applied + byStatus.screening + byStatus.interview;
  const interviews = byStatus.interview + byStatus.offer;
  const offers = byStatus.offer;
  const replied = total - byStatus.applied - byStatus.withdrawn;
  const responseRate = total ? Math.round((Math.max(replied, 0) / total) * 100) : 0;
  const followUps = applied.filter((app) => {
    if (!app.next_step_on || CLOSED.includes(app.status)) return false;
    const diff = dayDiff(app.next_step_on);
    return diff != null && diff <= 7;
  }).length;
  const reviewCount = applied.filter(needsReview).length;
  const days = appliedDays();
  const today = todayISO();
  const monday = isoOf(startOfWeek(new Date()));
  const todayCount = applied.filter(
    (app) => String(app.applied_on || "").slice(0, 10) === today
  ).length;
  const weekCount = applied.filter((app) => {
    const sent = String(app.applied_on || "").slice(0, 10);
    return sent && sent >= monday && sent <= today;
  }).length;
  return {
    total,
    byStatus,
    active,
    interviews,
    offers,
    responseRate,
    replied,
    followUps,
    reviewCount,
    toApply: appsIn("to_apply").length,
    todayCount,
    weekCount,
    streak: currentStreak(days),
    bestStreak: bestStreak(days),
    days,
  };
}


export function weeklyBuckets() {
  const weeks = [];
  const now = startOfDay(new Date());
  const monday = new Date(now);
  const weekday = (now.getDay() + 6) % 7;
  monday.setDate(now.getDate() - weekday);
  for (let index = 7; index >= 0; index -= 1) {
    const start = new Date(monday);
    start.setDate(monday.getDate() - index * 7);
    const end = new Date(start);
    end.setDate(start.getDate() + 6);
    weeks.push({ start, end, count: 0 });
  }
  appsIn("applied").forEach((app) => {
    const applied = parseDateOnly(app.applied_on);
    if (!applied) return;
    const bucket = weeks.find((week) => applied >= week.start && applied <= week.end);
    if (bucket) bucket.count += 1;
  });
  return weeks;
}


export function activeProfile() {
  return (
    state.profiles.find((profile) => profile.id === state.profileId) || state.profiles[0] || null
  );
}


export function initials(name) {
  const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}


export function persistProfile() {
  if (state.profileId) localStorage.setItem("jobpipe:profile", String(state.profileId));
  else localStorage.removeItem("jobpipe:profile");
}


export function rememberSession(profileId) {
  try {
    if (profileId) sessionStorage.setItem("jobpipe:session", String(profileId));
    else sessionStorage.removeItem("jobpipe:session");
  } catch (error) {
    /* storage disabled: the picker simply shows again on the next load */
  }
}


export function renderProfileChrome() {
  const button = $("#profile-btn");
  if (!button) return;
  const profile = activeProfile();
  $("#profile-avatar").textContent = initials(profile ? profile.name : "");
  $("#profile-chip-name").textContent = profile ? profile.name : "Profile";
  button.title = profile ? "Switch profile — " + profile.name : "Switch profile";
}


export async function loadProfiles() {
  const list = await api("/api/profiles");
  state.profiles = Array.isArray(list) ? list : [];
  const stored = Number(localStorage.getItem("jobpipe:profile"));
  const known = state.profiles.some((profile) => profile.id === stored);
  state.profileId = known ? stored : state.profiles.length ? state.profiles[0].id : null;
  persistProfile();
  renderProfileChrome();
}


export async function patchApplication(id, payload, successMessage, options) {
  const previous = state.apps.find((item) => item.id === id) || null;
  try {
    const updated = await api("/api/applications/" + id, {
      method: "PATCH",
      body: JSON.stringify(payload),
    });
    updateLocal(updated);
    if (state.drawerId === id) openDrawer(id);
    if (successMessage) toast(successMessage);
    if (!options || options.promptReject !== false) promptRejectDelete(updated, previous);
    return updated;
  } catch (error) {
    toast(error.message, true);
    render();
    return null;
  }
}


export function patchStatus(id, status) {
  patchApplication(id, { status: status }, "Moved to " + STATUS_LABEL[status]);
}


export function markApplied(id) {
  const app = state.apps.find((item) => item.id === id);
  if (!app) return;
  const payload = { phase: "applied", status: "applied" };
  if (!app.applied_on || isNaN(Date.parse(app.applied_on))) payload.applied_on = todayISO();
  patchApplication(id, payload, app.company + " marked as applied").then((updated) => {
    if (updated && state.tab === "to_apply") setTab("applied");
  });
}


export function markReviewed(id) {
  patchApplication(id, { mark_reviewed: true }, "Marked as still open");
}


export function closePosition(id) {
  patchApplication(
    id,
    { status: "rejected", mark_reviewed: true },
    "Position marked as closed",
    { promptReject: false }
  );
}


export async function restoreJob(id) {
  try {
    const restored = await api("/api/applications/" + id + "/restore", { method: "POST" });
    state.trash = state.trash.filter((item) => item.id !== id);
    state.apps = [restored].concat(state.apps.filter((item) => item.id !== id));
    render();
    toast("Restored to " + (restored.phase === "to_apply" ? "To apply" : "Applied"));
  } catch (error) {
    toast(error.message, true);
  }
}


export async function uploadDocument(appId, kind, file, options) {
  if (!file) return false;
  const quiet = options && options.quiet;
  if (file.size > MAX_UPLOAD) {
    if (!quiet) toast("Files must be 10 MB or smaller", true);
    throw new Error("Files must be 10 MB or smaller");
  }
  try {
    const data = await readFileBase64(file);
    await api("/api/applications/" + appId + "/documents", {
      method: "POST",
      body: JSON.stringify({
        kind: kind,
        filename: file.name,
        content_type: file.type || "application/octet-stream",
        data: data,
      }),
    });
    if (!quiet) {
      toast("Attached " + file.name);
      openDrawer(appId);
    }
    return true;
  } catch (error) {
    if (!quiet) toast(error.message, true);
    throw error;
  }
}


export async function uploadDocuments(appId, kind, files) {
  const list = Array.from(files || []).filter(Boolean);
  if (!appId || !list.length) return;
  const zone = $("[data-doc-drop]");
  if (zone && zone.classList.contains("is-busy")) return;
  const hint = zone ? zone.querySelector("[data-drop-hint]") : null;
  if (zone) zone.classList.add("is-busy");
  if (hint) {
    hint.textContent =
      "Uploading " + list.length + " file" + (list.length === 1 ? "" : "s") + "…";
  }
  let done = 0;
  let tooBig = 0;
  let failed = 0;
  for (const file of list) {
    if (file.size > MAX_UPLOAD) {
      tooBig += 1;
      continue;
    }
    try {
      await uploadDocument(appId, kind || inferDocKind(file.name), file, { quiet: true });
      done += 1;
    } catch (error) {
      failed += 1;
    }
  }
  if (done) {
    toast(
      list.length === 1 && done === 1
        ? "Attached " + list[0].name
        : "Attached " + done + " document" + (done === 1 ? "" : "s")
    );
  }
  if (tooBig) toast(tooBig + " file" + (tooBig === 1 ? "" : "s") + " over the 10 MB limit skipped", true);
  if (failed) toast(failed + " file" + (failed === 1 ? "" : "s") + " could not be attached", true);
  if (done && state.drawerId === appId) openDrawer(appId);
}


/* Save a job's document to the machine. A plain download link cannot carry the
   unlock token a PIN-protected profile needs, so the bytes come through fetch. */
export async function downloadDocument(appId, docId) {
  const doc = state.drawerDocuments.find((item) => item.id === docId);
  if (!doc) return;
  try {
    const blob = await fetchFile(doc.url);
    download(doc.filename, blob, blob.type || "application/octet-stream");
  } catch (error) {
    toast(error.message, true);
  }
}


/* Attach one of the files saved with a resume, instead of uploading it again. */
export async function attachSavedFileToJob(appId) {
  const app = state.apps.find((item) => item.id === appId) || null;
  let files;
  try {
    files = await api("/api/files");
  } catch (error) {
    toast(error.message, true);
    return;
  }
  if (!files.length) {
    toast("Nothing saved yet — compile a resume and press Save PDF first", true);
    return;
  }
  const choice = await chooseSavedFile({
    title: "Attach a saved file",
    text: app ? app.company + " — " + app.role : "",
    files: files,
    existing: state.drawerDocuments,
  });
  if (!choice) return;
  try {
    await api("/api/files/" + choice.file.id + "/attach", {
      method: "POST",
      body: JSON.stringify({
        application_id: appId,
        kind: choice.kind,
        replace: choice.replace,
      }),
    });
    const kindWord =
      choice.kind === "resume" ? "resume" : choice.kind === "cover_letter" ? "cover letter" : "file";
    toast(
      choice.replace
        ? "Replaced the " + kindWord + " on " + (app ? app.company : "the job") +
          " with " + choice.file.filename
        : "Attached " + choice.file.filename + " as " + (DOC_LABEL[choice.kind] || "a file")
    );
    openDrawer(appId);
  } catch (error) {
    toast(error.message, true);
  }
}


export async function deleteDocument(appId, docId) {
  try {
    await api("/api/applications/" + appId + "/documents/" + docId, { method: "DELETE" });
    toast("Document removed");
    openDrawer(appId);
  } catch (error) {
    toast(error.message, true);
  }
}


export function inferDocKind(filename) {
  const name = String(filename || "").toLowerCase();
  if (/cover[\s_-]*letter/.test(name)) return "cover_letter";
  if (/(^|[^a-z])(resume|resumé|cv)([^a-z]|$)/.test(name)) return "resume";
  return "other";
}


export function readFileBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || "");
      resolve(result.includes(",") ? result.split(",", 2)[1] : result);
    };
    reader.onerror = () => reject(new Error("Could not read that file"));
    reader.readAsDataURL(file);
  });
}


/* Apply a list of { id, payload } one by one, keeping local state in step. */
async function patchEach(changes) {
  let done = 0;
  let failed = 0;
  for (const change of changes) {
    try {
      const updated = await api("/api/applications/" + change.id, {
        method: "PATCH",
        body: JSON.stringify(change.payload),
      });
      const index = state.apps.findIndex((item) => item.id === change.id);
      if (index === -1) state.apps.push(updated);
      else state.apps[index] = updated;
      done += 1;
    } catch (error) {
      failed += 1;
    }
  }
  return { done, failed };
}


/* Offer a way back from a bulk change while the toast is still on screen. */
function offerUndo(message, isError, changes) {
  toast(
    message,
    isError,
    undefined,
    changes.length
      ? {
          label: "Undo",
          onClick: async () => {
            const result = await patchEach(changes);
            render();
            if (result.failed) {
              toast("Could not undo every job — " + result.failed + " failed", true);
              return;
            }
            toast("Undone");
          },
        }
      : undefined
  );
}


export async function bulkMarkApplied() {
  const ids = Array.from(state.selection);
  if (!ids.length) return;
  const button = $("#bulk-apply");
  button.disabled = true;
  const changes = [];
  let done = 0;
  let failed = 0;
  for (const id of ids) {
    const app = state.apps.find((item) => item.id === id);
    if (!app) {
      failed += 1;
      continue;
    }
    const payload = { phase: "applied", status: "applied" };
    if (!app.applied_on || Number.isNaN(Date.parse(app.applied_on))) payload.applied_on = todayISO();
    try {
      const updated = await api("/api/applications/" + id, {
        method: "PATCH",
        body: JSON.stringify(payload),
      });
      const index = state.apps.findIndex((item) => item.id === id);
      if (index === -1) state.apps.push(updated);
      else state.apps[index] = updated;
      // Sending it was the change; undoing puts it back under To apply.
      changes.push({
        id,
        payload: { phase: "to_apply", status: "applied", applied_on: "" },
      });
      done += 1;
    } catch (error) {
      failed += 1;
    }
  }
  state.selection.clear();
  button.disabled = false;
  render();
  offerUndo(
    done + " job" + (done === 1 ? "" : "s") + " marked as applied" +
      (failed ? " — " + failed + " failed" : ""),
    false,
    changes
  );
}


export async function bulkSetStatus() {
  const select = $("#bulk-status");
  const status = select ? select.value : "";
  const ids = Array.from(state.selection);
  if (!status || !ids.length) return;
  const button = $("#bulk-stage-apply");
  const label = button ? button.textContent : "";
  if (button) {
    button.disabled = true;
    button.textContent = "Saving…";
  }
  const changes = [];
  let done = 0;
  let failed = 0;
  for (const id of ids) {
    const app = state.apps.find((item) => item.id === id);
    const previousStatus = app ? app.status : null;
    try {
      const updated = await api("/api/applications/" + id, {
        method: "PATCH",
        body: JSON.stringify({ status: status }),
      });
      const index = state.apps.findIndex((item) => item.id === id);
      if (index === -1) state.apps.push(updated);
      else state.apps[index] = updated;
      if (previousStatus) changes.push({ id, payload: { status: previousStatus } });
      done += 1;
    } catch (error) {
      failed += 1;
    }
  }
  state.selection.clear();
  if (button) button.textContent = label;
  if (select) select.value = "";
  render();
  offerUndo(
    done + " job" + (done === 1 ? "" : "s") + " moved to " + STATUS_LABEL[status] +
      (failed ? " — " + failed + " failed" : ""),
    false,
    changes
  );
}


export function bulkDelete() {
  const ids = Array.from(state.selection);
  if (!ids.length) return;
  const count = ids.length;
  confirmAction({
    title: "Move " + count + " job" + (count === 1 ? "" : "s") + " to trash?",
    text:
      "They move to the Trash tab with their notes, timeline and documents intact." +
      " You can restore them from there; nothing is deleted permanently yet.",
    okLabel: "Move to trash",
    onConfirm: async () => {
      let done = 0;
      let failed = 0;
      for (const id of ids) {
        try {
          const result = await api("/api/applications/" + id, { method: "DELETE" });
          const trashed = result && result.application ? result.application : null;
          state.apps = state.apps.filter((item) => item.id !== id);
          if (trashed) state.trash = [trashed].concat(state.trash.filter((item) => item.id !== id));
          done += 1;
        } catch (error) {
          failed += 1;
        }
      }
      state.selection.clear();
      render();
      toast(
        done + " job" + (done === 1 ? "" : "s") + " moved to trash" +
          (failed ? " — " + failed + " failed" : "")
      );
    },
  });
}


export function updateBulkBar(list) {
  const bar = $("#bulk-bar");
  const count = state.selection.size;
  const isSaved = state.tab === "to_apply";
  const isApplied = state.tab === "applied";
  bar.hidden = !(isSaved || isApplied) || count === 0;
  // Marking as applied only means something for jobs that were never sent;
  // moving stage only means something for jobs that have been sent.
  $("#bulk-apply").hidden = !isSaved;
  const stageSelect = $("#bulk-status");
  const stageButton = $("#bulk-stage-apply");
  stageSelect.hidden = !isApplied;
  stageButton.hidden = !isApplied;
  if (!isApplied) stageSelect.value = "";
  stageButton.disabled = !isApplied || !stageSelect.value;
  if (!bar.hidden) $("#bulk-count").textContent = count + " selected";
  const activeBox = isApplied ? $("#select-all-applied") : $("#select-all-toapply");
  const otherBox = isApplied ? $("#select-all-toapply") : $("#select-all-applied");
  if (otherBox) {
    otherBox.checked = false;
    otherBox.indeterminate = false;
  }
  if (!activeBox) return;
  const visible = list.map((app) => app.id);
  const chosen = visible.filter((id) => state.selection.has(id)).length;
  activeBox.disabled = visible.length === 0;
  activeBox.checked = visible.length > 0 && chosen === visible.length;
  activeBox.indeterminate = chosen > 0 && chosen < visible.length;
}


export function promptRejectDelete(updated, previous) {
  if (!updated || !previous) return;
  if (updated.status !== "rejected" || previous.status === "rejected") return;
  if (updated.phase === "to_apply") return;
  confirmAction({
    title: "Delete rejected application?",
    text:
      updated.company + " — " + updated.role +
      " is now marked rejected. Delete it together with its resume, cover letter and any other attached files?" +
      " Its notes and timeline are removed from the database too, and this cannot be undone." +
      " Cancel keeps the job in Applied as rejected.",
    okLabel: "Delete job and files",
    onConfirm: async () => {
      await api("/api/applications/" + updated.id, { method: "DELETE" });
      await api("/api/applications/" + updated.id + "?permanent=1", { method: "DELETE" });
      state.apps = state.apps.filter((item) => item.id !== updated.id);
      state.trash = state.trash.filter((item) => item.id !== updated.id);
      if (state.drawerId === updated.id) closeDrawer();
      render();
      toast("Job and its files deleted");
    },
  });
}
