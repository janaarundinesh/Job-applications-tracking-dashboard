/* Job Pipeline — The Applied / To apply / Trash workspace: table, board and filters.
   ES module, no build step. Open the dashboard through server.py. */

import { $, $$, ICON, MODE_LABEL, STATUSES, STATUS_LABEL, TABS, daysSince, emptyState, esc, fmtDate, fmtShortDate, isOverdue, jobHref, matchBadge, matchBand, matchPct, needsReview, parseDateOnly, relativeDays, state, statusSelectOptions } from "./core.js";
import { appsIn, renderProfileChrome, updateBulkBar, visibleApps } from "./data.js";
import { renderOverview } from "./overview.js";
import { renderResumePanel } from "./resume.js";


export function render() {
  renderProfileChrome();
  renderTabs();
  renderViewSwitch();
  renderOverview();
  renderWorkspace();
  renderResumePanel();
  syncFilterOptions();
  syncDatalists();
  $("#last-updated").textContent = new Date().toLocaleDateString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}


export function renderViewSwitch() {
  $$(".view-btn").forEach((button) => {
    const active = button.dataset.view === state.view;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-selected", active ? "true" : "false");
  });
}


export function setTab(tab) {
  const next = TABS.includes(tab) ? tab : "overview";
  // Each list keeps its own rows, so a selection never carries across tabs.
  if (next !== state.tab) state.selection.clear();
  state.tab = next;
  render();
}


export function renderTabs() {
  const applied = appsIn("applied").length;
  const toApply = appsIn("to_apply").length;
  $("#count-applied").textContent = state.loading ? "…" : applied;
  $("#count-toapply").textContent = state.loading ? "…" : toApply;
  $("#count-trash").textContent = state.loading ? "…" : state.trash.length;
  $$(".tab").forEach((button) => {
    const active = button.dataset.tab === state.tab;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-selected", active ? "true" : "false");
  });
  $("#panel-overview").hidden = state.tab !== "overview";
  $("#workspace").hidden = state.tab === "overview" || state.tab === "resume";
  $("#panel-resume").hidden = state.tab !== "resume";
  // The job-specific header actions make no sense on the resume tab.
  document.body.classList.toggle("tab-resume", state.tab === "resume");
}


export function renderWorkspace() {
  if (state.tab === "overview" || state.tab === "resume") return;
  const isToApply = state.tab === "to_apply";
  const isTrash = state.tab === "trash";
  const isApplied = state.tab === "applied";
  $("#workspace-title").textContent = isTrash ? "Trash" : isToApply ? "To apply" : "Applied";
  $("#workspace-toolbar").hidden = isTrash;
  $("#trash-toolbar").hidden = !isTrash;
  $("#empty-trash-btn").disabled = !state.trash.length;
  $("#view-switch").hidden = isToApply || isTrash;
  $("#filter-status").hidden = isToApply || isTrash;

  $("#bulk-bar").hidden = true;
  const appliedShell = $("#applied-table-shell");
  const toApplyShell = $("#toapply-table-shell");
  const trashShell = $("#trash-table-shell");
  const trashBody = $("#trash-table-body");
  const trashEmpty = $("#trash-empty");
  const board = $("#board");
  const appliedBody = $("#applied-table-body");
  const toApplyBody = $("#toapply-table-body");
  const appliedEmpty = $("#applied-empty");
  const toApplyEmpty = $("#toapply-empty");
  const showBoard = isApplied && state.view === "board";

  if (state.loading) {
    $("#workspace-sub").textContent = "Loading…";
    appliedBody.innerHTML = "";
    toApplyBody.innerHTML = "";
    appliedShell.hidden = isToApply || isTrash;
    toApplyShell.hidden = !isToApply;
    trashShell.hidden = true;
    board.hidden = true;
    return;
  }

  if (isTrash) {
    appliedShell.hidden = true;
    toApplyShell.hidden = true;
    trashShell.hidden = false;
    board.hidden = true;
    $("#workspace-sub").textContent = state.trash.length
      ? state.trash.length + " deleted job" + (state.trash.length === 1 ? "" : "s") +
        (state.trash.length === 1
          ? " — restore it or delete it permanently."
          : " — restore them or delete them permanently.")
      : "Deleted jobs land here first.";
    trashBody.innerHTML = state.trash.map(trashRow).join("");
    trashEmpty.hidden = state.trash.length > 0;
    if (!state.trash.length) {
      trashEmpty.innerHTML = emptyState({
        icon: ICON.trash,
        title: "Trash is empty",
        text: "Deleted jobs land here. Restore them, or delete them permanently to remove their notes and attached files.",
      });
    }
    return;
  }

  trashShell.hidden = true;
  const list = visibleApps(state.tab);
  const total = appsIn(state.tab).length;
  const hasFilters = Boolean(
    state.filters.q || state.filters.mode || state.filters.source || (isApplied && state.filters.status)
  );

  if (isToApply) {
    $("#workspace-sub").textContent =
      total + " saved job" + (total === 1 ? "" : "s") + (hasFilters && list.length !== total ? " · " + list.length + " shown" : "");
    appliedShell.hidden = true;
    toApplyShell.hidden = false;
    board.hidden = true;
    const visibleIds = new Set(list.map((app) => app.id));
    Array.from(state.selection).forEach((id) => {
      if (!visibleIds.has(id)) state.selection.delete(id);
    });
    toApplyBody.innerHTML = list.map(toApplyRow).join("");
    updateBulkBar(list);
    const showEmpty = list.length === 0;
    toApplyEmpty.hidden = !showEmpty;
    if (showEmpty) {
      toApplyEmpty.innerHTML = hasFilters
        ? emptyState({
            icon: ICON.search,
            title: "No matches",
            text: "No saved jobs match your search and filters.",
            action: "clear-filters",
            actionLabel: "Clear filters",
          })
        : emptyState({
            icon: ICON.bookmark,
            title: "No saved jobs yet",
            text: "Save roles you plan to apply to, then move them to Applied once you have sent your application.",
            action: "new",
            actionLabel: "Add a New Application",
            primary: true,
          });
    }
    renderSortIndicators("to_apply");
    return;
  }

  $("#workspace-sub").textContent =
    total + " application" + (total === 1 ? "" : "s") + (hasFilters && list.length !== total ? " · " + list.length + " shown" : "");
  toApplyShell.hidden = true;
  // Set even while the table is empty: the headers stay sortable either way.
  renderSortIndicators("applied");

  if (!total) {
    appliedShell.hidden = false;
    board.hidden = true;
    appliedBody.innerHTML = "";
    appliedEmpty.hidden = false;
    appliedEmpty.innerHTML = emptyState({
      icon: ICON.spark,
      title: "No applications yet",
      text: appsIn("to_apply").length
        ? "Your saved jobs are in the To apply tab. Move one over once you have sent it."
        : "Add a job you applied to and it will show up here with pipeline stats, a board and follow-up reminders.",
      action: appsIn("to_apply").length ? "go-to-apply" : "new",
      actionLabel: appsIn("to_apply").length ? "View saved jobs" : "Add application",
      primary: true,
    });
    return;
  }

  appliedShell.hidden = showBoard;
  board.hidden = !showBoard;

  if (showBoard) {
    renderBoard(list);
    return;
  }

  const visibleIds = new Set(list.map((app) => app.id));
  Array.from(state.selection).forEach((id) => {
    if (!visibleIds.has(id)) state.selection.delete(id);
  });
  appliedBody.innerHTML = list.map(appliedRow).join("");
  updateBulkBar(list);
  appliedEmpty.hidden = list.length > 0;
  if (!list.length) {
    appliedEmpty.innerHTML = emptyState({
      icon: ICON.search,
      title: "No matches",
      text: "Nothing matches your search and filters. Try a different query or reset the filters.",
      action: "clear-filters",
      actionLabel: "Clear filters",
    });
  }
  renderSortIndicators("applied");
}


export function appliedRow(app) {
  const meta = [app.location, MODE_LABEL[app.work_mode] || ""].filter(Boolean).join(" · ");
  const review = needsReview(app);
  return (
    '<tr data-app-id="' + app.id + '" tabindex="0"' +
    (state.selection.has(app.id) ? ' class="is-selected"' : "") + ">" +
    '<td class="select-col"><input type="checkbox" data-select-id="' + app.id + '"' +
    (state.selection.has(app.id) ? " checked" : "") +
    ' aria-label="Select ' + esc(app.company) + " " + esc(app.role) + '" /></td>' +
    '<td class="company-cell">' +
    '<div class="company-name">' + esc(app.company) +
    (review ? '<span class="review-flag" title="Applied ' + daysSince(app.applied_on) + ' days ago — check whether this role is still open">Review</span>' : "") +
    "</div>" +
    (meta ? '<div class="company-meta">' + esc(meta) + "</div>" : "") +
    "</td>" +
    '<td class="role-cell" title="' + esc(app.role) + '">' + esc(app.role) + "</td>" +
    '<td><select class="stage-select" data-status="' + esc(app.status) + '" data-inline-status="' + app.id + '" aria-label="Stage for ' + esc(app.company) + '">' +
    statusSelectOptions(app.status, false) +
    "</select></td>" +
    '<td class="date-cell">' + esc(fmtDate(app.applied_on)) +
    '<span class="rel">' + esc(relativeDays(app.applied_on)) + "</span></td>" +
    linkCell(app) +
    '<td><span class="source-chip' + (app.source ? "" : " is-empty") + '">' +
    esc(app.source || "—") + "</span></td>" +
    '<td class="salary-cell"><span>' + esc(app.salary || "—") + "</span></td>" +
    matchCell(app) +
    '<td class="actions-col"><div class="row-actions">' +
    '<button type="button" data-action="edit" data-id="' + app.id + '" title="Edit" aria-label="Edit ' + esc(app.company) + '">' + ICON.pencil + "</button>" +
    '<button type="button" class="danger" data-action="delete" data-id="' + app.id + '" title="Move to trash" aria-label="Move ' + esc(app.company) + ' to trash">' + ICON.trash + "</button>" +
    "</div></td>" +
    "</tr>"
  );
}


export function toApplyRow(app) {
  const meta = [app.location, MODE_LABEL[app.work_mode] || ""].filter(Boolean).join(" · ");
  return (
    '<tr data-app-id="' + app.id + '" tabindex="0"' +
    (state.selection.has(app.id) ? ' class="is-selected"' : "") + ">" +
    '<td class="select-col"><input type="checkbox" data-select-id="' + app.id + '"' +
    (state.selection.has(app.id) ? " checked" : "") +
    ' aria-label="Select ' + esc(app.company) + " " + esc(app.role) + '" /></td>' +
    '<td class="company-cell">' +
    '<div class="company-name">' + esc(app.company) + "</div>" +
    (meta ? '<div class="company-meta">' + esc(meta) + "</div>" : "") +
    "</td>" +
    '<td class="role-cell" title="' + esc(app.role) + '">' + esc(app.role) + "</td>" +
    '<td class="date-cell">' + esc(fmtDate(app.created_at)) +
    '<span class="rel">' + esc(relativeDays(app.created_at)) + "</span></td>" +
    '<td><span class="source-chip' + (app.source ? "" : " is-empty") + '">' +
    esc(app.source || "—") + "</span></td>" +
    '<td class="salary-cell"><span>' + esc(app.salary || "—") + "</span></td>" +
    matchCell(app) +
    linkCell(app) +
    '<td class="actions-col"><div class="row-actions">' +
    '<button type="button" class="mark-applied" data-action="mark-applied" data-id="' + app.id + '" title="Mark as applied" aria-label="Mark ' + esc(app.company) + ' as applied">' + ICON.check + "</button>" +
    '<button type="button" data-action="edit" data-id="' + app.id + '" title="Edit" aria-label="Edit ' + esc(app.company) + '">' + ICON.pencil + "</button>" +
    '<button type="button" class="danger" data-action="delete" data-id="' + app.id + '" title="Move to trash" aria-label="Move ' + esc(app.company) + ' to trash">' + ICON.trash + "</button>" +
    "</div></td>" +
    "</tr>"
  );
}


export function trashRow(app) {
  const saved = app.phase === "to_apply";
  const meta = [app.location, MODE_LABEL[app.work_mode] || ""].filter(Boolean).join(" · ");
  return (
    '<tr data-trash-id="' + app.id + '">' +
    '<td class="company-cell">' +
    '<div class="company-name">' + esc(app.company) + "</div>" +
    (meta ? '<div class="company-meta">' + esc(meta) + "</div>" : "") +
    "</td>" +
    '<td class="role-cell" title="' + esc(app.role) + '">' + esc(app.role) + "</td>" +
    '<td><span class="status-pill" data-status="' + (saved ? "saved" : esc(app.status)) + '">' +
    (saved ? "Saved to apply" : STATUS_LABEL[app.status]) + "</span></td>" +
    '<td class="date-cell">' + esc(fmtDate(app.deleted_at)) +
    '<span class="rel">' + esc(relativeDays(app.deleted_at)) + "</span></td>" +
    '<td class="actions-col"><div class="row-actions is-visible">' +
    '<button type="button" class="restore" data-action="restore" data-id="' + app.id + '" title="Restore" aria-label="Restore ' + esc(app.company) + '">' + ICON.restore + "</button>" +
    '<button type="button" class="danger" data-action="purge" data-id="' + app.id + '" title="Delete permanently" aria-label="Delete ' + esc(app.company) + ' permanently">' + ICON.trash + "</button>" +
    "</div></td></tr>"
  );
}


/*
 * The job posting link, as its own column: one "Open position" link on every
 * row whose job has a web address, with the address it opens in the tooltip,
 * so the column reads the same all the way down instead of showing a wall of
 * URLs. A value that is not a web address (notes people paste by hand) stays
 * visible as the text that was saved, dim and unlinked.
 */
function linkCell(app) {
  const raw = String(app.job_url || "").trim();
  if (!raw) return '<td class="link-cell is-empty">—</td>';
  const href = jobHref(raw);
  if (!href) {
    return (
      '<td class="link-cell" title="' + esc(raw) + '">' +
      '<span class="link-plain">' + esc(raw) + "</span></td>"
    );
  }
  return (
    '<td class="link-cell">' +
    '<a class="link-open" href="' + esc(href) + '" target="_blank" rel="noopener noreferrer"' +
    ' title="' + esc(href) + '">Open position ↗</a></td>'
  );
}


function matchCell(app) {
  const pct = matchPct(app);
  if (pct === null) {
    return '<td class="match-cell is-empty" title="No match estimate saved">—</td>';
  }
  const band = matchBand(pct);
  return (
    '<td class="match-cell' + (band ? " is-" + band : "") + '"' +
    ' title="Estimated match with your resume">' + pct + "%</td>"
  );
}


export function renderSortIndicators(phase) {
  const sort = state.sort[phase];
  $$("th.sortable").forEach((th) => {
    const table = th.closest("table");
    const shell = table ? table.closest(".table-shell") : null;
    const expected = phase === "applied" ? "#applied-table-shell" : "#toapply-table-shell";
    if (!shell || !shell.matches(expected)) return;
    const isSorted = th.dataset.sort === sort.key;
    th.classList.toggle("is-sorted", isSorted);
    th.setAttribute(
      "aria-sort",
      isSorted ? (sort.dir === "asc" ? "ascending" : "descending") : "none"
    );
    const existing = $(".sort-caret", th);
    if (existing) existing.remove();
    if (isSorted) {
      const caret = document.createElement("span");
      caret.className = "sort-caret";
      caret.textContent = sort.dir === "asc" ? "▲" : "▼";
      th.appendChild(caret);
    }
  });
}


export function renderBoard(list) {
  const board = $("#board");
  board.innerHTML = STATUSES.map((status) => {
    const cards = list.filter((app) => app.status === status.key);
    return (
      '<section class="board-col" data-status="' + status.key + '" data-drop-status="' + status.key + '">' +
      '<header class="board-col-head">' +
      '<span class="col-dot"></span>' +
      "<h3>" + status.label + "</h3>" +
      '<span class="col-count">' + cards.length + "</span>" +
      "</header>" +
      '<div class="board-cards">' +
      (cards.length
        ? cards.map(boardCard).join("")
        : '<div class="col-empty">No applications</div>') +
      "</div></section>"
    );
  }).join("");
}


export function boardCard(app) {
  const step = app.next_step || app.next_step_on;
  const overdue = app.next_step_on && isOverdue(app.next_step_on);
  const hasDocs = Number(app.document_count || 0) > 0;
  const review = needsReview(app);
  return (
    '<article class="app-card" draggable="true" tabindex="0" data-app-id="' + app.id + '">' +
    '<button type="button" class="card-delete" data-action="delete" data-id="' + app.id + '" title="Move to trash" aria-label="Delete ' + esc(app.company) + '">' + ICON.trash + "</button>" +
    '<div class="card-role">' + esc(app.role) + "</div>" +
    '<div class="card-company">' + esc(app.company) + matchBadge(app, "is-card") + "</div>" +
    '<div class="card-foot">' +
    '<span>' + esc(fmtShortDate(parseDateOnly(app.applied_on) || new Date())) + "</span>" +
    (review ? '<span class="review-flag is-card" title="Applied ' + daysSince(app.applied_on) + ' days ago">Review</span>' : "") +
    (hasDocs ? '<span class="card-docs">' + ICON.attach + "</span>" : "") +
    (step
      ? '<span class="card-step' + (overdue ? " is-overdue" : "") + '">' + esc(step) + "</span>"
      : "") +
    "</div></article>"
  );
}


export function syncFilterOptions() {
  const statusSelect = $("#filter-status");
  if (!statusSelect.options.length) {
    statusSelect.innerHTML = statusSelectOptions(state.filters.status, true);
  }
  const sources = Array.from(new Set(state.apps.map((app) => app.source).filter(Boolean))).sort((a, b) =>
    a.localeCompare(b)
  );
  const unique = new Set(sources);
  $$("#filter-source option").forEach((option) => {
    if (option.value && !unique.has(option.value)) option.remove();
  });
  const existing = new Set(Array.from($("#filter-source").options).map((option) => option.value));
  sources.forEach((source) => {
    if (existing.has(source)) return;
    const option = document.createElement("option");
    option.value = source;
    option.textContent = source;
    $("#filter-source").appendChild(option);
    existing.add(source);
  });
  if (state.filters.source && !unique.has(state.filters.source)) state.filters.source = "";
  $("#filter-source").value = state.filters.source;
  $("#filter-status").value = state.filters.status;
  $("#filter-mode").value = state.filters.mode;
  $("#filter-match").value = state.filters.match;
  if ($("#search").value !== state.filters.q) $("#search").value = state.filters.q;
  $("#clear-filters").hidden = !(
    state.filters.q ||
    state.filters.status ||
    state.filters.mode ||
    state.filters.source ||
    state.filters.match
  );
}


export function syncDatalists() {
  const companies = Array.from(new Set(state.apps.map((app) => app.company).filter(Boolean))).sort((a, b) =>
    a.localeCompare(b)
  );
  const sources = Array.from(new Set(state.apps.map((app) => app.source).filter(Boolean))).sort((a, b) =>
    a.localeCompare(b)
  );
  $("#company-list").innerHTML = companies.map((value) => '<option value="' + esc(value) + '"></option>').join("");
  $("#source-list").innerHTML =
    sources.map((value) => '<option value="' + esc(value) + '"></option>').join("") +
    '<option value="LinkedIn"></option><option value="Referral"></option><option value="Company site"></option>' +
    '<option value="Recruiter"></option><option value="Job board"></option>';
}


export function clearFilters() {
  state.filters = { q: "", status: "", mode: "", source: "", match: "" };
  $("#search").value = "";
  $("#filter-status").value = "";
  $("#filter-mode").value = "";
  $("#filter-source").value = "";
  $("#filter-match").value = "";
  render();
}
