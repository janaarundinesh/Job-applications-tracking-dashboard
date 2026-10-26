/* Job Pipeline — The job detail drawer, its documents and the document preview.
   ES module, no build step. Open the dashboard through server.py. */

import { $, DOC_LABEL, ICON, MODE_LABEL, STATUS_LABEL, api, daysSince, download, dueLabel, esc, fetchFile, fmtDate, formatSize, formatTimestamp, isOverdue, jobHref, matchBadge, matchBand, matchPct, needsReview, relativeDays, state, statusSelectOptions, toast } from "./core.js";
import { updateLocal } from "./data.js";


export async function openDrawer(id) {
  const sameApp = state.drawerId === id;
  const app = state.apps.find((item) => item.id === id);
  if (!app) return;
  state.drawerId = id;
  if (!sameApp) {
    state.drawerEvents = [];
    state.drawerDocuments = [];
  }
  const scrim = $("#drawer-scrim");
  const drawer = $("#drawer");
  const previousBody = drawer.querySelector(".drawer-body");
  const scrollTop = sameApp && previousBody ? previousBody.scrollTop : 0;
  const wasOpen = drawer.classList.contains("is-open");
  drawer.hidden = false;
  scrim.hidden = false;
  drawer.innerHTML = drawerHTML(app, state.drawerEvents, state.drawerDocuments);
  const initialBody = drawer.querySelector(".drawer-body");
  if (initialBody) initialBody.scrollTop = scrollTop;
  wireNotes(app);
  requestAnimationFrame(() => {
    // A close (or another job) that landed before this frame must not be undone
    // by it: the drawer would stay open and never hide again.
    if (state.drawerId !== id) return;
    drawer.classList.add("is-open");
    scrim.classList.add("is-open");
  });
  if (!wasOpen) {
    const closeButton = drawer.querySelector(".drawer-close");
    if (closeButton) closeButton.focus({ preventScroll: true });
  }
  try {
    const payload = await api("/api/applications/" + id);
    if (state.drawerId !== id) return;
    state.drawerEvents = payload.events || [];
    state.drawerDocuments = payload.documents || [];
    if (payload.application) {
      const index = state.apps.findIndex((item) => item.id === payload.application.id);
      if (index !== -1) state.apps[index] = payload.application;
      const currentBody = drawer.querySelector(".drawer-body");
      const keepScroll = currentBody ? currentBody.scrollTop : 0;
      drawer.innerHTML = drawerHTML(payload.application, state.drawerEvents, state.drawerDocuments);
      const nextBody = drawer.querySelector(".drawer-body");
      if (nextBody) nextBody.scrollTop = keepScroll;
      wireNotes(payload.application);
    }
  } catch (error) {
    toast(error.message, true);
  }
}


export function drawerHTML(app, events, documents) {
  const saved = app.phase === "to_apply";
  const review = needsReview(app);
  const meta = [app.location, MODE_LABEL[app.work_mode] || ""].filter(Boolean);
  const pct = matchPct(app);
  const detail = (label, value, extra) => {
    const content = value ? extra || esc(value) : '<span class="is-empty">Not set</span>';
    return '<div class="kv"><dt>' + esc(label) + "</dt><dd" + (value ? "" : ' class="is-empty"') + ">" + content + "</dd></div>";
  };
  const contact = [app.contact_name, app.contact_email].filter(Boolean).join(" · ");
  const href = jobHref(app.job_url);
  const jobLink = href
    ? '<a href="' + esc(href) + '" target="_blank" rel="noopener noreferrer" title="' +
      esc(String(app.job_url).trim()) + '">Open posting ↗</a>'
    : app.job_url
      ? esc(app.job_url)
      : "";

  const nextStepBox =
    app.next_step || app.next_step_on
      ? '<div class="next-step-box">' +
        '<div class="next-step-title">' + esc(app.next_step || "Follow up") + "</div>" +
        (app.next_step_on
          ? '<div class="next-step-when ' + (isOverdue(app.next_step_on) ? "is-overdue" : "") + '">' +
            esc(dueLabel(app.next_step_on)) + " · " + esc(fmtDate(app.next_step_on)) + "</div>"
          : "") +
        "</div>"
      : '<div class="next-step-box is-empty">No next step set. Add one so it shows up in your follow-up list.</div>';

  const timeline = events.length
    ? events
        .slice()
        .reverse()
        .map((event) => {
          let label;
          if (event.from_status) label = STATUS_LABEL[event.from_status] + " → " + STATUS_LABEL[event.to_status];
          else label = saved ? "Saved to apply" : "Added as " + STATUS_LABEL[event.to_status];
          return (
            '<div class="timeline-item" data-status="' + esc(event.to_status) + '">' +
            '<div class="timeline-label">' + esc(label) + "</div>" +
            '<div class="timeline-meta">' + esc(formatTimestamp(event.created_at)) + "</div>" +
            "</div>"
          );
        })
        .join("")
    : '<div class="timeline-item"><div class="timeline-meta">No history yet.</div></div>';

  const docs = documents.length
    ? documents
        .map((doc) => {
          const name =
            '<button type="button" class="doc-name doc-preview" data-preview-doc="' + doc.id + '"' +
            ' title="Preview ' + esc(doc.filename) + '">' + esc(doc.filename) + "</button>";
          return (
            '<li class="doc-item">' +
            '<span class="doc-icon">' + ICON.file + "</span>" +
            '<div class="doc-main">' +
            name +
            '<span class="doc-meta">' + esc(DOC_LABEL[doc.kind] || "File") + " · " + esc(formatSize(doc.size)) +
            " · " + esc(fmtDate(doc.uploaded_at)) +
            (doc.preview ? "" : " · no preview") +
            "</span>" +
            "</div>" +
            '<button type="button" class="doc-action" data-doc-download="' + doc.id + '"' +
            ' title="Download ' + esc(doc.filename) + '">Download</button>' +
            '<button type="button" class="doc-action danger" data-doc-delete="' + doc.id + '" aria-label="Remove ' + esc(doc.filename) + '">' + ICON.trash + "</button>" +
            "</li>"
          );
        })
        .join("")
    : '<li class="doc-empty">No documents attached yet.</li>';

  const description = app.description
    ? '<div class="description-box">' + esc(app.description) + "</div>"
    : '<div class="description-box is-empty">No job description saved yet. Add one with Edit.</div>';

  return (
    '<header class="drawer-head">' +
    '<div class="drawer-head-main">' +
    '<div class="drawer-eyebrow">' + esc(app.company) + "</div>" +
    '<h2 class="drawer-title">' + esc(app.role) + "</h2>" +
    '<div class="drawer-sub">' +
    (meta.length ? "<span>" + esc(meta.join(" · ")) + "</span>" : "") +
    (saved
      ? '<span class="status-pill" data-status="saved">Saved to apply</span>'
      : '<span class="status-pill" data-status="' + esc(app.status) + '">' + STATUS_LABEL[app.status] + "</span>") +
    matchBadge(app) +
    "</div></div>" +
    '<button class="btn btn-icon drawer-close" data-action="close-drawer" aria-label="Close details">' + ICON.close + "</button>" +
    "</header>" +
    '<div class="drawer-body">' +
    (saved
      ? '<div class="drawer-callout">Not applied yet. When you send it, mark it as applied to start tracking the pipeline.</div>'
      : "") +
    (review
      ? '<div class="drawer-callout is-warning">' +
        "<strong>Applied " + daysSince(app.applied_on) + " days ago.</strong> " +
        "Is this position still open?" +
        '<div class="review-actions">' +
        '<button class="btn btn-primary" data-action="mark-reviewed" data-id="' + app.id + '">Still open</button>' +
        '<button class="btn btn-ghost" data-action="close-position" data-id="' + app.id + '">No longer open</button>' +
        "</div></div>"
      : "") +
    (!saved
      ? '<section class="drawer-section">' +
        "<h3>Stage</h3>" +
        '<div class="drawer-select-row">' +
        '<select class="stage-select is-large" data-status="' + esc(app.status) + '" data-drawer-status="' + app.id + '">' +
        statusSelectOptions(app.status, false) +
        "</select>" +
        '<span class="panel-hint">Applied ' + esc(relativeDays(app.applied_on)) + "</span>" +
        "</div></section>"
      : "") +
    '<section class="drawer-section">' +
    "<h3>Details</h3>" +
    '<dl class="kv-grid">' +
    (saved
      ? detail("Saved on", fmtDate(app.created_at))
      : detail("Applied on", fmtDate(app.applied_on))) +
    (app.reviewed_at ? detail("Last reviewed", fmtDate(app.reviewed_at)) : "") +
    detail(
      "Resume match",
      pct === null ? "" : pct + "%",
      pct === null
        ? ""
        : '<span class="match-value is-' + matchBand(pct) + '">' + esc(pct + "%") +
          '</span><span class="kv-hint">estimated fit with your resume</span>'
    ) +
    detail("Location type", MODE_LABEL[app.work_mode]) +
    detail("Source", app.source) +
    detail("Salary", app.salary) +
    detail("Contact", contact) +
    detail("Job posting", jobLink, jobLink) +
    "</dl></section>" +
    '<section class="drawer-section">' +
    "<h3>Next step</h3>" +
    nextStepBox +
    "</section>" +
    '<section class="drawer-section">' +
    "<h3>Job description</h3>" +
    description +
    "</section>" +
    '<section class="drawer-section">' +
    "<h3>Documents</h3>" +
    '<div class="doc-drop" data-doc-drop>' +
    '<div class="doc-uploads">' +
    '<label class="btn btn-ghost doc-upload" data-drop-kind="resume">' + ICON.attach + "Resume" +
    '<input type="file" data-doc-kind="resume" hidden multiple /></label>' +
    '<label class="btn btn-ghost doc-upload" data-drop-kind="cover_letter">' + ICON.attach + "Cover letter" +
    '<input type="file" data-doc-kind="cover_letter" hidden multiple /></label>' +
    '<label class="btn btn-ghost doc-upload" data-drop-kind="other">' + ICON.attach + "Other" +
    '<input type="file" data-doc-kind="other" hidden multiple /></label>' +
    '<button type="button" class="btn btn-ghost doc-upload" data-action="pick-saved"' +
    ' title="Attach a file saved with one of your resumes">' + ICON.file + "From saved files</button>" +
    "</div>" +
    '<p class="doc-drop-hint" data-drop-hint>Drag files here to attach them — drop onto a button to set its type.</p>' +
    "</div>" +
    '<ul class="doc-list">' + docs + "</ul>" +
    "</section>" +
    '<section class="drawer-section">' +
    "<h3>Personal notes</h3>" +
    '<textarea class="notes-area" id="drawer-notes" placeholder="Add notes about this job…">' + esc(app.notes || "") + "</textarea>" +
    '<div class="notes-foot"><span id="notes-status">All changes saved</span>' +
    '<button class="btn btn-ghost" data-action="save-notes" id="notes-save" disabled>Save notes</button></div>' +
    "</section>" +
    '<section class="drawer-section"><h3>Timeline</h3><div class="timeline">' + timeline + "</div></section>" +
    "</div>" +
    '<footer class="drawer-foot">' +
    '<button class="btn btn-ghost danger-text" data-action="delete" data-id="' + app.id + '">Move to trash</button>' +
    '<div class="drawer-foot-actions">' +
    '<button class="btn" data-action="open-resume" data-id="' + app.id + '" title="Open or tailor a resume for this job">Resume</button>' +
    '<button class="btn" data-action="edit" data-id="' + app.id + '">Edit</button>' +
    (saved
      ? '<button class="btn btn-primary" data-action="mark-applied" data-id="' + app.id + '">Mark as applied</button>'
      : "") +
    "</div></footer>"
  );
}


export function wireNotes(app) {
  const notes = $("#drawer-notes");
  const save = $("#notes-save");
  const status = $("#notes-status");
  if (!notes || !save) return;
  notes.addEventListener("input", () => {
    const dirty = notes.value !== (app.notes || "");
    save.disabled = !dirty;
    status.textContent = dirty ? "Unsaved changes" : "All changes saved";
  });
  save.addEventListener("click", async () => {
    try {
      const updated = await api("/api/applications/" + app.id, {
        method: "PATCH",
        body: JSON.stringify({ notes: notes.value }),
      });
      app.notes = updated.notes;
      updateLocal(updated);
      status.textContent = "Notes saved";
      save.disabled = true;
      toast("Notes saved");
    } catch (error) {
      toast(error.message, true);
    }
  });
}


export function closeDrawer() {
  const drawer = $("#drawer");
  const scrim = $("#drawer-scrim");
  drawer.classList.remove("is-open");
  scrim.classList.remove("is-open");
  state.drawerId = null;
  state.drawerEvents = [];
  state.drawerDocuments = [];
  window.setTimeout(() => {
    if (!drawer.classList.contains("is-open")) {
      drawer.hidden = true;
      scrim.hidden = true;
    }
  }, 260);
}


export const PREVIEW_TEXT_LIMIT = 400000;


export async function openPreview(doc) {
  if (!doc) return;
  // Opening another file while one is showing: its blob is no longer needed.
  releasePreviewUrl();
  state.previewDoc = doc;
  $("#preview-kind").textContent = DOC_LABEL[doc.kind] || "File";
  $("#preview-title").textContent = doc.filename;
  $("#preview-meta").textContent = [formatSize(doc.size), fmtDate(doc.uploaded_at)]
    .filter(Boolean)
    .join(" · ");

  const body = $("#preview-body");
  body.innerHTML = '<div class="preview-loading">Loading preview…</div>';
  $("#preview-backdrop").hidden = false;
  const closeButton = $("#preview-close");
  if (closeButton) closeButton.focus({ preventScroll: true });

  let blob;
  try {
    // inline=1 asks for the bytes as they are rather than as a download.
    blob = await fetchFile(doc.url + "?inline=1");
  } catch (error) {
    if (state.previewDoc !== doc) return;
    showPreviewError(doc, error.message);
    return;
  }
  // The user may have closed the panel, or opened another file, while this was
  // in flight.
  if (state.previewDoc !== doc) return;
  const url = URL.createObjectURL(blob);
  state.previewUrl = url;
  const download = $("#preview-download");
  download.href = url;
  download.setAttribute("download", doc.filename);
  $("#preview-open").href = url;

  if (doc.preview === "pdf") {
    body.innerHTML =
      '<iframe class="preview-frame" src="' + esc(url) + '" title="' + esc(doc.filename) + '"></iframe>';
  } else if (doc.preview === "image") {
    body.innerHTML =
      '<img class="preview-image" src="' + esc(url) + '" alt="' + esc(doc.filename) + '">';
  } else if (doc.preview === "text") {
    renderTextPreview(doc, await blob.text(), body);
  } else {
    body.innerHTML =
      '<div class="preview-fallback">' + ICON.file +
      "<p>This file type can’t be previewed in the browser.</p>" +
      '<a class="btn btn-primary" href="' + esc(url) + '" download="' + esc(doc.filename) + '">Download ' +
      esc(doc.filename) + "</a></div>";
  }
}


function renderTextPreview(doc, text, body) {
  if (state.previewDoc !== doc) return;
  const truncated = text.length > PREVIEW_TEXT_LIMIT;
  if (truncated) text = text.slice(0, PREVIEW_TEXT_LIMIT);
  body.innerHTML = '<pre class="preview-text"></pre>';
  body.querySelector("pre").textContent = text;
  if (truncated) {
    body.insertAdjacentHTML(
      "beforeend",
      '<p class="preview-note">Preview truncated — download the file to read all of it.</p>'
    );
  }
}


function showPreviewError(doc, message) {
  const body = $("#preview-body");
  body.innerHTML =
    '<div class="preview-fallback">' + ICON.file +
    "<p>" + esc(message) + "</p>" +
    '<button type="button" class="btn btn-primary" id="preview-retry">Try again</button></div>';
  const retry = $("#preview-retry");
  if (retry) retry.addEventListener("click", () => openPreview(doc));
}


function releasePreviewUrl() {
  if (state.previewUrl) URL.revokeObjectURL(state.previewUrl);
  state.previewUrl = null;
}


export function closePreview() {
  if ($("#preview-backdrop").hidden) return;
  $("#preview-backdrop").hidden = true;
  $("#preview-body").innerHTML = "";
  $("#preview-download").removeAttribute("href");
  $("#preview-open").removeAttribute("href");
  releasePreviewUrl();
  state.previewDoc = null;
}
