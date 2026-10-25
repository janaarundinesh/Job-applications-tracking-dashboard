/* Job Pipeline — frontend app (no build step, no dependencies) */
(() => {
  "use strict";

  const STATUSES = [
    { key: "applied", label: "Applied" },
    { key: "screening", label: "Screening" },
    { key: "interview", label: "Interview" },
    { key: "offer", label: "Offer" },
    { key: "rejected", label: "Rejected" },
    { key: "withdrawn", label: "Withdrawn" },
  ];
  const STATUS_LABEL = STATUSES.reduce((acc, item) => {
    acc[item.key] = item.label;
    return acc;
  }, {});
  const MODE_LABEL = { remote: "Remote", hybrid: "Hybrid", onsite: "On-site" };
  const DOC_LABEL = { resume: "Resume", cover_letter: "Cover letter", other: "Other" };
  const TABS = ["overview", "applied", "to_apply", "trash"];
  const CLOSED = ["rejected", "withdrawn"];
  const ACTIVE_STATUSES = ["applied", "screening", "interview"];
  const REVIEW_AFTER_DAYS = 30;
  const MAX_UPLOAD = 10 * 1024 * 1024;
  const DEFAULT_GOALS = { daily_goal: 3, weekly_goal: 10 };
  const DAY_NAMES = ["S", "M", "T", "W", "T", "F", "S"];

  const ICON = {
    pencil: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 20h4l10-10a2.8 2.8 0 10-4-4L4 16v4z"/></svg>',
    trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13"/></svg>',
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12.5l4.5 4.5L19 6.5"/></svg>',
    close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 6l12 12M18 6L6 18"/></svg>',
    spark: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M5 19V9M12 19V5M19 19v-6"/></svg>',
    search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/></svg>',
    bookmark: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M6 4h12v17l-6-4.5L6 21V4z"/></svg>',
    restore: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 10a8 8 0 111.6 7.5"/><path d="M4 4v6h6"/></svg>',
    file: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M6 3h8l4 4v14H6V3z"/><path d="M14 3v4h4"/></svg>',
    attach: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M8 12.5V8a4 4 0 118 0v8a6 6 0 11-12 0v-6"/></svg>',
    flame: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="M12 3c3 3.4 5 6.2 5 9a5 5 0 01-10 0c0-1.9.8-3.4 1.8-4.6.2 1.8 1.2 2.6 1.2 2.6S10.5 6.6 12 3z"/></svg>',
  };

  const state = {
    apps: [],
    trash: [],
    tab: "overview",
    view: localStorage.getItem("jobpipe:view") === "board" ? "board" : "table",
    sort: {
      applied: { key: "applied_on", dir: "desc" },
      to_apply: { key: "created_at", dir: "desc" },
    },
    filters: { q: "", status: "", mode: "", source: "" },
    modalMode: "manual",
    drawerId: null,
    drawerEvents: [],
    drawerDocuments: [],
    editingId: null,
    selection: new Set(),
    previewDoc: null,
    goalProgress: null,
    settings: Object.assign({}, DEFAULT_GOALS),
    loading: true,
  };

  const $ = (selector, scope) => (scope || document).querySelector(selector);
  const $$ = (selector, scope) => Array.from((scope || document).querySelectorAll(selector));

  /* ---------------- utilities ---------------- */

  function esc(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function parseDateOnly(iso) {
    if (!iso) return null;
    const parts = String(iso).slice(0, 10).split("-").map(Number);
    if (parts.length !== 3 || parts.some(Number.isNaN)) return null;
    return new Date(parts[0], parts[1] - 1, parts[2]);
  }

  function todayISO() {
    const now = new Date();
    return [
      now.getFullYear(),
      String(now.getMonth() + 1).padStart(2, "0"),
      String(now.getDate()).padStart(2, "0"),
    ].join("-");
  }

  function startOfDay(date) {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate());
  }

  function isoOf(date) {
    return [
      date.getFullYear(),
      String(date.getMonth() + 1).padStart(2, "0"),
      String(date.getDate()).padStart(2, "0"),
    ].join("-");
  }

  function startOfWeek(date) {
    const day = startOfDay(date);
    day.setDate(day.getDate() - ((day.getDay() + 6) % 7));
    return day;
  }

  function appliedDays() {
    const days = new Set();
    state.apps.forEach((app) => {
      if (app.phase === "to_apply" || !app.applied_on) return;
      days.add(String(app.applied_on).slice(0, 10));
    });
    return days;
  }

  /* Longest run of consecutive days with at least one application. */
  function bestStreak(days) {
    let best = 0;
    let run = 0;
    let previous = null;
    Array.from(days)
      .sort()
      .forEach((iso) => {
        if (previous) {
          const next = parseDateOnly(previous);
          next.setDate(next.getDate() + 1);
          run = isoOf(next) === iso ? run + 1 : 1;
        } else {
          run = 1;
        }
        best = Math.max(best, run);
        previous = iso;
      });
    return best;
  }

  /* A streak survives today being empty until the day is over, so it is counted
     from yesterday when nothing has been sent yet today. */
  function currentStreak(days) {
    const cursor = startOfDay(new Date());
    if (!days.has(isoOf(cursor))) {
      cursor.setDate(cursor.getDate() - 1);
      if (!days.has(isoOf(cursor))) return 0;
    }
    let count = 0;
    while (days.has(isoOf(cursor))) {
      count += 1;
      cursor.setDate(cursor.getDate() - 1);
    }
    return count;
  }

  function dayDiff(iso) {
    const date = parseDateOnly(iso);
    if (!date) return null;
    return Math.round((startOfDay(date) - startOfDay(new Date())) / 86400000);
  }

  function fmtDate(iso) {
    const date = parseDateOnly(iso);
    if (!date) return "—";
    return date.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
  }

  function fmtShortDate(date) {
    return date.toLocaleDateString(undefined, { day: "numeric", month: "short" });
  }

  function relativeDays(iso) {
    const diff = dayDiff(iso);
    if (diff == null) return "";
    if (diff === 0) return "today";
    if (diff === -1) return "yesterday";
    if (diff < 0) {
      const days = Math.abs(diff);
      if (days < 7) return days + " days ago";
      if (days < 30) return Math.round(days / 7) + "w ago";
      if (days < 365) return Math.round(days / 30) + "mo ago";
      return Math.round(days / 365) + "y ago";
    }
    if (diff === 1) return "tomorrow";
    if (diff < 7) return "in " + diff + " days";
    if (diff < 30) return "in " + Math.round(diff / 7) + " weeks";
    return "in " + Math.round(diff / 30) + " months";
  }

  function dueLabel(iso) {
    const diff = dayDiff(iso);
    if (diff == null) return "";
    if (diff === 0) return "Due today";
    if (diff < 0) return "Overdue by " + Math.abs(diff) + "d";
    if (diff === 1) return "Due tomorrow";
    return "Due in " + diff + "d";
  }

  function isOverdue(iso) {
    const diff = dayDiff(iso);
    return diff != null && diff < 0;
  }

  function daysSince(iso) {
    const diff = dayDiff(iso);
    return diff == null ? null : -diff;
  }

  /* Applied a month ago and still in play? Check whether the posting is still open,
     then either confirm it or close it. Reviewed jobs come back after another month. */
  function needsReview(app) {
    if (app.phase === "to_apply") return false;
    if (!ACTIVE_STATUSES.includes(app.status)) return false;
    const sinceApplied = daysSince(app.applied_on);
    if (sinceApplied == null || sinceApplied < REVIEW_AFTER_DAYS) return false;
    if (!app.reviewed_at) return true;
    const sinceReview = daysSince(app.reviewed_at);
    return sinceReview == null || sinceReview >= REVIEW_AFTER_DAYS;
  }

  function formatSize(bytes) {
    if (!bytes) return "0 KB";
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + " KB";
    return (bytes / (1024 * 1024)).toFixed(1) + " MB";
  }

  function formatTimestamp(iso) {
    if (!iso) return "";
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return "";
    return (
      date.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) +
      ", " +
      date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
    );
  }

  function statusSelectOptions(selected, includeAll) {
    const options = includeAll ? ['<option value="">All stages</option>'] : [];
    STATUSES.forEach((status) => {
      options.push(
        '<option value="' + status.key + '"' + (status.key === selected ? " selected" : "") + ">" +
          status.label +
          "</option>"
      );
    });
    return options.join("");
  }

  function emptyState(config) {
    return (
      '<div class="empty">' +
      '<div class="empty-icon">' + config.icon + "</div>" +
      "<h3>" + esc(config.title) + "</h3>" +
      "<p>" + esc(config.text) + "</p>" +
      (config.action
        ? '<button class="btn ' + (config.primary ? "btn-primary" : "") + '" data-action="' +
          config.action + '">' + esc(config.actionLabel) + "</button>"
        : "") +
      "</div>"
    );
  }

  /* ---------------- api ---------------- */

  async function api(path, options) {
    const response = await fetch(path, Object.assign({ headers: { "Content-Type": "application/json" } }, options));
    const text = await response.text();
    let payload = null;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch (error) {
        payload = null;
      }
    }
    if (!response.ok) {
      const message = payload && payload.error ? payload.error : "Request failed (" + response.status + ")";
      throw new Error(message);
    }
    return payload;
  }

  async function loadApps() {
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
    }
  }

  function updateLocal(app) {
    const index = state.apps.findIndex((item) => item.id === app.id);
    if (index === -1) state.apps.push(app);
    else state.apps[index] = app;
    render();
  }

  function appsIn(phase) {
    return state.apps.filter((app) => (app.phase === "to_apply" ? "to_apply" : "applied") === phase);
  }

  /* ---------------- derived data ---------------- */

  function visibleApps(phase) {
    const query = state.filters.q.trim().toLowerCase();
    const { status, mode, source } = state.filters;
    const list = appsIn(phase).filter((app) => {
      if (phase === "applied" && status && app.status !== status) return false;
      if (mode && app.work_mode !== mode) return false;
      if (source && app.source !== source) return false;
      if (!query) return true;
      return [app.company, app.role, app.location, app.source, app.notes, app.description, app.next_step, app.contact_name]
        .join(" ")
        .toLowerCase()
        .includes(query);
    });
    return sortApps(list, state.sort[phase]);
  }

  function sortApps(list, sort) {
    const { key, dir } = sort;
    const factor = dir === "asc" ? 1 : -1;
    return list.slice().sort((a, b) => {
      const left = a[key] == null ? "" : String(a[key]);
      const right = b[key] == null ? "" : String(b[key]);
      if (key === "id") return (a.id - b.id) * factor;
      const comparison = left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" });
      if (comparison !== 0) return comparison * factor;
      return b.id - a.id;
    });
  }

  function computeStats() {
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

  function weeklyBuckets() {
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

  /* ---------------- rendering ---------------- */

  function render() {
    renderTabs();
    renderViewSwitch();
    renderOverview();
    renderWorkspace();
    syncFilterOptions();
    syncDatalists();
    $("#last-updated").textContent = new Date().toLocaleDateString(undefined, {
      weekday: "short",
      day: "numeric",
      month: "short",
      year: "numeric",
    });
  }

  function renderViewSwitch() {
    $$(".view-btn").forEach((button) => {
      const active = button.dataset.view === state.view;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-selected", active ? "true" : "false");
    });
  }

  function setTab(tab) {
    state.tab = TABS.includes(tab) ? tab : "overview";
    if (state.tab !== "to_apply") state.selection.clear();
    render();
  }

  function renderTabs() {
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
    $("#workspace").hidden = state.tab === "overview";
    $("#new-btn-label").textContent = state.tab === "to_apply" ? "Save job" : "New job";
  }

  function renderOverview() {
    const stats = computeStats();
    const cards = [
      {
        label: "Total",
        value: stats.total,
        foot: stats.total ? "Since " + fmtDate(oldestApplicationDate()) : "No applications yet",
        tone: "var(--accent)",
      },
      {
        label: "Active",
        value: stats.active,
        foot: "Applied, screening or interview",
        tone: "var(--st-applied)",
      },
      {
        label: "Interviews",
        value: stats.interviews,
        foot: stats.offers ? "Includes " + stats.offers + " offer" + (stats.offers === 1 ? "" : "s") : "Reached interview stage",
        tone: "var(--st-interview)",
      },
      {
        label: "Offers",
        value: stats.offers,
        foot: stats.total ? Math.round((stats.offers / stats.total) * 100) + "% of applications" : "Keep going",
        tone: "var(--st-offer)",
      },
      {
        label: "Response rate",
        value: stats.responseRate + "<small>%</small>",
        foot: stats.replied + " of " + stats.total + " got a reply",
        tone: "var(--st-screening)",
      },
      {
        label: "To apply",
        value: stats.toApply,
        foot: stats.toApply ? "Saved, not sent yet" : "No saved jobs",
        tone: "var(--st-withdrawn)",
      },
    ];
    $("#stat-grid").innerHTML = cards
      .map(
        (card) =>
          '<article class="stat-card" style="--tone:' + card.tone + '">' +
          '<div class="stat-label">' + esc(card.label) + "</div>" +
          '<div class="stat-value">' + card.value + "</div>" +
          '<div class="stat-foot">' + esc(card.foot) + "</div>" +
          "</article>"
      )
      .join("");

    const parts = [];
    parts.push(stats.active + " active application" + (stats.active === 1 ? "" : "s"));
    if (stats.followUps) parts.push(stats.followUps + " follow-up" + (stats.followUps === 1 ? "" : "s") + " due");
    if (stats.reviewCount) parts.push(stats.reviewCount + " need" + (stats.reviewCount === 1 ? "s" : "") + " review");
    if (stats.toApply) parts.push(stats.toApply + " saved to apply");
    if (!stats.total && !stats.toApply) parts.length = 0;
    $("#overview-sub").textContent =
      parts.length ? parts.join(" · ") : "Add your first job to get started.";

    const max = Math.max(1, ...STATUSES.map((status) => stats.byStatus[status.key] || 0));
    $("#funnel").innerHTML = STATUSES.map((status) => {
      const count = stats.byStatus[status.key] || 0;
      const width = count ? Math.max(6, (count / max) * 100) : 0;
      return (
        '<div class="funnel-row" data-status="' + status.key + '">' +
        '<span class="funnel-name">' + status.label + "</span>" +
        '<span class="funnel-track"><span class="funnel-fill" style="width:' + width + '%"></span></span>' +
        '<span class="funnel-count">' + count + "</span>" +
        "</div>"
      );
    }).join("");

    renderGoals(stats);
    renderStreak(stats);
    renderWeeklyChart();
    renderFollowUps();
    renderReviewList();
  }

  function goalRing(key, label, count, target, foot) {
    const radius = 34;
    const circumference = 2 * Math.PI * radius;
    const ratio = Math.min(1, count / target);
    const offset = circumference * (1 - ratio);
    const complete = count >= target;
    return (
      '<div class="goal-block" data-goal="' + key + '">' +
      '<div class="goal-ring' + (complete ? " is-complete" : "") + '" role="img"' +
      ' aria-label="' + esc(label + ": " + count + " of " + target) + '">' +
      '<svg viewBox="0 0 84 84" aria-hidden="true">' +
      '<circle class="ring-track" cx="42" cy="42" r="' + radius + '"></circle>' +
      '<circle class="ring-fill" cx="42" cy="42" r="' + radius + '"' +
      ' style="stroke-dasharray:' + circumference.toFixed(2) + ";stroke-dashoffset:" + offset.toFixed(2) + '"></circle>' +
      "</svg>" +
      '<span class="goal-ring-value">' + count + "<small>/" + target + "</small></span>" +
      "</div>" +
      '<div class="goal-ring-label">' + esc(label) + "</div>" +
      '<div class="goal-foot">' + esc(foot) + "</div>" +
      "</div>"
    );
  }

  /* A short confetti burst around the goal rings. Skipped when the user asks for
     reduced motion; the toast still appears. */
  function confettiBurst() {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const layer = document.createElement("div");
    layer.className = "confetti-layer";
    layer.setAttribute("aria-hidden", "true");
    const anchor = $("#goal-list").getBoundingClientRect();
    const originX = anchor.width ? anchor.left + anchor.width / 2 : window.innerWidth / 2;
    const originY = anchor.height ? anchor.top + anchor.height * 0.4 : window.innerHeight / 3;
    const colors = ["var(--accent)", "var(--st-offer)", "var(--st-interview)", "#f2b544", "#ef6f9b"];
    for (let index = 0; index < 18; index += 1) {
      const piece = document.createElement("span");
      piece.className = "confetti-piece";
      piece.style.left = originX + (Math.random() * 150 - 75) + "px";
      piece.style.top = originY + (Math.random() * 26 - 13) + "px";
      piece.style.background = colors[index % colors.length];
      piece.style.setProperty("--dx", Math.round(Math.random() * 180 - 90) + "px");
      piece.style.setProperty("--rot", Math.round(Math.random() * 540 - 270) + "deg");
      piece.style.animationDelay = (Math.random() * 0.12).toFixed(2) + "s";
      layer.appendChild(piece);
    }
    document.body.appendChild(layer);
    window.setTimeout(() => layer.remove(), 1900);
  }

  /* Fire only when a count crosses a target during use — never on page load or
     when the target itself is changed. */
  function celebrateGoal(stats) {
    if (state.loading) return;
    const today = todayISO();
    const weekKey = isoOf(startOfWeek(new Date()));
    const dailyGoal = Math.max(1, Number(state.settings.daily_goal) || DEFAULT_GOALS.daily_goal);
    const weeklyGoal = Math.max(1, Number(state.settings.weekly_goal) || DEFAULT_GOALS.weekly_goal);
    const previous = state.goalProgress;
    const next = { dayKey: today, weekKey, daily: stats.todayCount, weekly: stats.weekCount };
    state.goalProgress = next;
    if (!previous || previous.dayKey !== today || previous.weekKey !== weekKey) return;
    const dailyHit = previous.daily < dailyGoal && next.daily >= dailyGoal;
    const weeklyHit = previous.weekly < weeklyGoal && next.weekly >= weeklyGoal;
    if (!dailyHit && !weeklyHit) return;
    confettiBurst();
    if (dailyHit) {
      toast("Daily goal complete — " + next.daily + " of " + dailyGoal + " today", false, "celebration");
    }
    if (weeklyHit) {
      toast("Weekly goal complete — " + next.weekly + " of " + weeklyGoal + " this week", false, "celebration");
    }
  }

  function renderGoals(stats) {
    celebrateGoal(stats);
    const dailyGoal = Math.max(1, Number(state.settings.daily_goal) || DEFAULT_GOALS.daily_goal);
    const weeklyGoal = Math.max(1, Number(state.settings.weekly_goal) || DEFAULT_GOALS.weekly_goal);
    const dailyLeft = Math.max(0, dailyGoal - stats.todayCount);
    const weeklyLeft = Math.max(0, weeklyGoal - stats.weekCount);
    const daysLeft = 7 - ((new Date().getDay() + 6) % 7);
    const dailyFoot = dailyLeft
      ? dailyLeft + " more today to stay on pace"
      : "Daily goal met — nice work";
    const weeklyFoot = weeklyLeft
      ? weeklyLeft + " more this week · " + daysLeft + " day" + (daysLeft === 1 ? "" : "s") + " left"
      : "Weekly goal met — anything else is a bonus";
    $("#goal-list").innerHTML =
      goalRing("daily_goal", "Daily", stats.todayCount, dailyGoal, dailyFoot) +
      goalRing("weekly_goal", "Weekly", stats.weekCount, weeklyGoal, weeklyFoot);
  }

  function renderStreak(stats) {
    const days = stats.days;
    const week = [];
    for (let offset = 6; offset >= 0; offset -= 1) {
      const date = startOfDay(new Date());
      date.setDate(date.getDate() - offset);
      week.push({ date, done: days.has(isoOf(date)) });
    }
    const dots = week
      .map((day) =>
        '<span class="streak-day' + (day.done ? " is-done" : "") +
        (isoOf(day.date) === todayISO() ? " is-today" : "") +
        '" title="' + esc(fmtDate(isoOf(day.date)) + (day.done ? " — applied" : " — nothing sent")) + '">' +
        '<span class="streak-dot"></span>' +
        '<span class="streak-dow">' + DAY_NAMES[day.date.getDay()] + "</span></span>"
      )
      .join("");
    const headline = stats.streak
      ? stats.streak + '<small>day' + (stats.streak === 1 ? "" : "s") + " in a row</small>"
      : 'No streak<small>send one today to start it</small>';
    $("#streak-body").innerHTML =
      '<div class="streak-main">' +
      '<span class="streak-flame' + (stats.streak ? " is-hot" : "") + '" aria-hidden="true">' + ICON.flame + "</span>" +
      '<span class="streak-value">' + headline + "</span>" +
      "</div>" +
      '<div class="streak-week">' + dots + "</div>" +
      '<div class="streak-foot">Best run: <strong>' + stats.bestStreak + " day" + (stats.bestStreak === 1 ? "" : "s") + "</strong>" +
      (stats.streak && stats.streak === stats.bestStreak ? " · at your best right now" : "") +
      "</div>";
  }

  function oldestApplicationDate() {
    const dates = appsIn("applied")
      .map((app) => app.applied_on)
      .filter(Boolean)
      .sort();
    return dates[0] || todayISO();
  }

  function renderWeeklyChart() {
    const weeks = weeklyBuckets();
    const max = Math.max(1, ...weeks.map((week) => week.count));
    const bars = weeks
      .map((week) => {
        const height = week.count ? Math.max(8, (week.count / max) * 100) : 2;
        return (
          '<div class="chart-bar-wrap" title="' +
          esc(fmtShortDate(week.start) + "–" + fmtShortDate(week.end) + ": " + week.count + " application(s)") +
          '">' +
          '<div class="chart-bar' + (week.count ? "" : " is-zero") + '" style="height:' + height + '%"></div>' +
          "</div>"
        );
      })
      .join("");
    const labels = weeks
      .map((week) => '<div class="chart-label">' + esc(fmtShortDate(week.start)) + "</div>")
      .join("");
    const total = weeks.reduce((sum, week) => sum + week.count, 0);
    const average = (total / weeks.length).toFixed(1).replace(/\.0$/, "");
    $("#weekly-chart").innerHTML =
      '<div class="chart-bars">' + bars + "</div>" +
      '<div class="chart-labels">' + labels + "</div>" +
      '<div class="chart-caption"><span><strong>' + total + "</strong> sent in 8 weeks</span><span>" + average + "/week avg</span></div>";
  }

  function renderFollowUps() {
    const list = appsIn("applied")
      .filter((app) => app.next_step_on && !CLOSED.includes(app.status))
      .filter((app) => {
        const diff = dayDiff(app.next_step_on);
        return diff != null && diff <= 7;
      })
      .sort((a, b) => (a.next_step_on < b.next_step_on ? -1 : 1));

    const container = $("#follow-list");
    if (!list.length) {
      container.innerHTML = '<li class="follow-empty">Nothing scheduled. Add a next step to a role you are waiting on.</li>';
      return;
    }
    container.innerHTML = list
      .map((app) => {
        const overdue = isOverdue(app.next_step_on);
        const dueClass = overdue ? "is-overdue" : dayDiff(app.next_step_on) <= 1 ? "is-soon" : "";
        return (
          '<li><button class="follow-item" data-open-app="' + app.id + '">' +
          '<span class="follow-main">' +
          '<span class="follow-company">' + esc(app.company) + "</span>" +
          '<span class="follow-step">' + esc(app.next_step || "Follow up") + " · " + esc(app.role) + "</span>" +
          "</span>" +
          '<span class="follow-due ' + dueClass + '">' + esc(dueLabel(app.next_step_on)) + "</span>" +
          "</button></li>"
        );
      })
      .join("");
  }

  function renderReviewList() {
    const list = appsIn("applied")
      .filter(needsReview)
      .sort((a, b) => daysSince(b.applied_on) - daysSince(a.applied_on));
    const container = $("#review-list");
    if (!list.length) {
      container.innerHTML =
        '<li class="follow-empty">Nothing to review. Applications older than 30 days show up here.</li>';
      return;
    }
    container.innerHTML = list
      .map((app) => {
        const days = daysSince(app.applied_on);
        return (
          '<li><button class="follow-item" data-open-app="' + app.id + '">' +
          '<span class="follow-main">' +
          '<span class="follow-company">' + esc(app.company) + "</span>" +
          '<span class="follow-step">' + esc(app.role) + " · applied " + days + " days ago</span>" +
          "</span>" +
          '<span class="follow-due is-review">' + days + "d</span>" +
          "</button></li>"
        );
      })
      .join("");
  }

  function renderWorkspace() {
    if (state.tab === "overview") return;
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
              actionLabel: "Save a job",
              primary: true,
            });
      }
      renderSortIndicators("to_apply");
      return;
    }

    $("#workspace-sub").textContent =
      total + " application" + (total === 1 ? "" : "s") + (hasFilters && list.length !== total ? " · " + list.length + " shown" : "");
    toApplyShell.hidden = true;

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

    appliedBody.innerHTML = list.map(appliedRow).join("");
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

  function appliedRow(app) {
    const meta = [app.location, MODE_LABEL[app.work_mode] || ""].filter(Boolean).join(" · ");
    const review = needsReview(app);
    const nextStep = app.next_step || (app.next_step_on ? "Follow up" : "");
    const nextCell = nextStep
      ? '<span class="step-text">' + esc(nextStep) + "</span>" +
        (app.next_step_on
          ? '<span class="due-text ' + (isOverdue(app.next_step_on) ? "is-overdue" : "") + '">' +
            esc(dueLabel(app.next_step_on)) + "</span>"
          : "")
      : '<span class="step-empty">—</span>';
    return (
      '<tr data-app-id="' + app.id + '" tabindex="0">' +
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
      '<td class="next-cell">' + nextCell + "</td>" +
      '<td><span class="source-chip' + (app.source ? "" : " is-empty") + '">' +
      esc(app.source || "—") + "</span></td>" +
      '<td class="salary-cell">' + esc(app.salary || "—") + "</td>" +
      '<td class="actions-col"><div class="row-actions">' +
      '<button type="button" data-action="edit" data-id="' + app.id + '" title="Edit" aria-label="Edit ' + esc(app.company) + '">' + ICON.pencil + "</button>" +
      '<button type="button" class="danger" data-action="delete" data-id="' + app.id + '" title="Move to trash" aria-label="Move ' + esc(app.company) + ' to trash">' + ICON.trash + "</button>" +
      "</div></td>" +
      "</tr>"
    );
  }

  function toApplyRow(app) {
    const meta = [app.location, MODE_LABEL[app.work_mode] || ""].filter(Boolean).join(" · ");
    const nextStep = app.next_step || (app.next_step_on ? "Follow up" : "");
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
      '<td class="salary-cell">' + esc(app.salary || "—") + "</td>" +
      '<td class="next-cell">' + (nextStep
        ? '<span class="step-text">' + esc(nextStep) + "</span>" +
          (app.next_step_on
            ? '<span class="due-text ' + (isOverdue(app.next_step_on) ? "is-overdue" : "") + '">' +
              esc(dueLabel(app.next_step_on)) + "</span>"
            : "")
        : '<span class="step-empty">—</span>') + "</td>" +
      '<td class="actions-col"><div class="row-actions">' +
      '<button type="button" class="mark-applied" data-action="mark-applied" data-id="' + app.id + '" title="Mark as applied" aria-label="Mark ' + esc(app.company) + ' as applied">' + ICON.check + "</button>" +
      '<button type="button" data-action="edit" data-id="' + app.id + '" title="Edit" aria-label="Edit ' + esc(app.company) + '">' + ICON.pencil + "</button>" +
      '<button type="button" class="danger" data-action="delete" data-id="' + app.id + '" title="Move to trash" aria-label="Move ' + esc(app.company) + ' to trash">' + ICON.trash + "</button>" +
      "</div></td>" +
      "</tr>"
    );
  }

  function trashRow(app) {
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

  function renderSortIndicators(phase) {
    const sort = state.sort[phase];
    $$("th.sortable").forEach((th) => {
      const table = th.closest("table");
      const shell = table ? table.closest(".table-shell") : null;
      const expected = phase === "applied" ? "#applied-table-shell" : "#toapply-table-shell";
      if (!shell || !shell.matches(expected)) return;
      const isSorted = th.dataset.sort === sort.key;
      th.classList.toggle("is-sorted", isSorted);
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

  function renderBoard(list) {
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

  function boardCard(app) {
    const step = app.next_step || app.next_step_on;
    const overdue = app.next_step_on && isOverdue(app.next_step_on);
    const hasDocs = Number(app.document_count || 0) > 0;
    const review = needsReview(app);
    return (
      '<article class="app-card" draggable="true" tabindex="0" data-app-id="' + app.id + '">' +
      '<button type="button" class="card-delete" data-action="delete" data-id="' + app.id + '" title="Move to trash" aria-label="Delete ' + esc(app.company) + '">' + ICON.trash + "</button>" +
      '<div class="card-role">' + esc(app.role) + "</div>" +
      '<div class="card-company">' + esc(app.company) + "</div>" +
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

  function syncFilterOptions() {
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
    if ($("#search").value !== state.filters.q) $("#search").value = state.filters.q;
    $("#clear-filters").hidden = !(
      state.filters.q || state.filters.status || state.filters.mode || state.filters.source
    );
  }

  function syncDatalists() {
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

  /* ---------------- drawer ---------------- */

  async function openDrawer(id) {
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

  function drawerHTML(app, events, documents) {
    const saved = app.phase === "to_apply";
    const review = needsReview(app);
    const meta = [app.location, MODE_LABEL[app.work_mode] || ""].filter(Boolean);
    const detail = (label, value, extra) => {
      const content = value ? extra || esc(value) : '<span class="is-empty">Not set</span>';
      return '<div class="kv"><dt>' + esc(label) + "</dt><dd" + (value ? "" : ' class="is-empty"') + ">" + content + "</dd></div>";
    };
    const contact = [app.contact_name, app.contact_email].filter(Boolean).join(" · ");
    const jobLink = /^https?:\/\//i.test(app.job_url || "")
      ? '<a href="' + esc(app.job_url) + '" target="_blank" rel="noopener noreferrer">Open posting ↗</a>'
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
              '<a class="doc-action" href="' + esc(doc.url) + '" download="' + esc(doc.filename) + '" title="Download ' + esc(doc.filename) + '">Download</a>' +
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
      '<button class="btn" data-action="edit" data-id="' + app.id + '">Edit</button>' +
      (saved
        ? '<button class="btn btn-primary" data-action="mark-applied" data-id="' + app.id + '">Mark as applied</button>'
        : "") +
      "</div></footer>"
    );
  }

  function wireNotes(app) {
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

  function closeDrawer() {
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

  /* ---------------- document preview ---------------- */

  const PREVIEW_TEXT_LIMIT = 400000;

  function openPreview(doc) {
    if (!doc) return;
    state.previewDoc = doc;
    const inlineUrl = doc.url + "?inline=1";
    $("#preview-kind").textContent = DOC_LABEL[doc.kind] || "File";
    $("#preview-title").textContent = doc.filename;
    $("#preview-meta").textContent = [formatSize(doc.size), fmtDate(doc.uploaded_at)]
      .filter(Boolean)
      .join(" · ");
    const download = $("#preview-download");
    download.href = doc.url;
    download.setAttribute("download", doc.filename);
    $("#preview-open").href = inlineUrl;

    const body = $("#preview-body");
    body.innerHTML = "";
    if (doc.preview === "pdf") {
      body.innerHTML =
        '<iframe class="preview-frame" src="' + esc(inlineUrl) + '" title="' + esc(doc.filename) + '"></iframe>';
    } else if (doc.preview === "image") {
      body.innerHTML =
        '<img class="preview-image" src="' + esc(inlineUrl) + '" alt="' + esc(doc.filename) + '">';
    } else if (doc.preview === "text") {
      body.innerHTML = '<div class="preview-loading">Loading preview…</div>';
      loadTextPreview(doc, inlineUrl, body);
    } else {
      body.innerHTML =
        '<div class="preview-fallback">' + ICON.file +
        "<p>This file type can’t be previewed in the browser.</p>" +
        '<a class="btn btn-primary" href="' + esc(doc.url) + '" download="' + esc(doc.filename) + '">Download ' +
        esc(doc.filename) + "</a></div>";
    }

    $("#preview-backdrop").hidden = false;
    const closeButton = $("#preview-close");
    if (closeButton) closeButton.focus({ preventScroll: true });
  }

  async function loadTextPreview(doc, url, body) {
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error("Could not load this file");
      let text = await response.text();
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
    } catch (error) {
      if (state.previewDoc !== doc) return;
      body.innerHTML =
        '<div class="preview-fallback">' + ICON.file +
        "<p>" + esc(error.message) + "</p>" +
        '<a class="btn btn-primary" href="' + esc(doc.url) + '" download="' + esc(doc.filename) + '">Download file</a></div>';
    }
  }

  function closePreview() {
    if ($("#preview-backdrop").hidden) return;
    $("#preview-backdrop").hidden = true;
    $("#preview-body").innerHTML = "";
    $("#preview-download").removeAttribute("href");
    $("#preview-open").removeAttribute("href");
    state.previewDoc = null;
  }

  /* ---------------- documents ---------------- */

  function readFileBase64(file) {
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

  async function uploadDocument(appId, kind, file, options) {
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

  /* Dropped files have no type, so guess from the name; anything unrecognised
     lands in Other. */
  function inferDocKind(filename) {
    const name = String(filename || "").toLowerCase();
    if (/cover[\s_-]*letter/.test(name)) return "cover_letter";
    if (/(^|[^a-z])(resume|resumé|cv)([^a-z]|$)/.test(name)) return "resume";
    return "other";
  }

  async function uploadDocuments(appId, kind, files) {
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

  async function deleteDocument(appId, docId) {
    try {
      await api("/api/applications/" + appId + "/documents/" + docId, { method: "DELETE" });
      toast("Document removed");
      openDrawer(appId);
    } catch (error) {
      toast(error.message, true);
    }
  }

  /* ---------------- phase changes ---------------- */

  async function patchApplication(id, payload, successMessage, options) {
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

  /* ---------------- settings ---------------- */

  function openSettings() {
    $("#settings-daily").value = state.settings.daily_goal;
    $("#settings-weekly").value = state.settings.weekly_goal;
    const error = $("#settings-error");
    error.hidden = true;
    error.textContent = "";
    $("#settings-backdrop").hidden = false;
    document.body.classList.add("no-scroll");
    window.setTimeout(() => $("#settings-daily").focus(), 30);
  }

  function closeSettings() {
    $("#settings-backdrop").hidden = true;
    document.body.classList.remove("no-scroll");
  }

  async function saveSettings(event) {
    event.preventDefault();
    const daily = Number($("#settings-daily").value);
    const weekly = Number($("#settings-weekly").value);
    const valid = (value) => Number.isInteger(value) && value >= 1 && value <= 100;
    const box = $("#settings-error");
    if (!valid(daily) || !valid(weekly)) {
      box.textContent = "Enter whole numbers between 1 and 100 for both goals.";
      box.hidden = false;
      return;
    }
    const button = $("#settings-save");
    button.disabled = true;
    try {
      const saved = await api("/api/settings", {
        method: "PATCH",
        body: JSON.stringify({ daily_goal: daily, weekly_goal: weekly }),
      });
      state.settings = Object.assign({}, state.settings, saved);
      render();
      closeSettings();
      toast("Goals updated");
    } catch (err) {
      box.hidden = false;
      box.textContent = err.message;
    } finally {
      button.disabled = false;
    }
  }

  function updateBulkBar(list) {
    const bar = $("#bulk-bar");
    const count = state.selection.size;
    bar.hidden = state.tab !== "to_apply" || count === 0;
    if (!bar.hidden) $("#bulk-count").textContent = count + " selected";
    const all = $("#select-all-toapply");
    if (!all) return;
    const visible = list.map((app) => app.id);
    const chosen = visible.filter((id) => state.selection.has(id)).length;
    all.disabled = visible.length === 0;
    all.checked = visible.length > 0 && chosen === visible.length;
    all.indeterminate = chosen > 0 && chosen < visible.length;
  }

  async function bulkMarkApplied() {
    const ids = Array.from(state.selection);
    if (!ids.length) return;
    const button = $("#bulk-apply");
    button.disabled = true;
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
        done += 1;
      } catch (error) {
        failed += 1;
      }
    }
    state.selection.clear();
    button.disabled = false;
    render();
    toast(
      done + " job" + (done === 1 ? "" : "s") + " marked as applied" +
        (failed ? " — " + failed + " failed" : "")
    );
  }

  function bulkDelete() {
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

  function markApplied(id) {
    const app = state.apps.find((item) => item.id === id);
    if (!app) return;
    const payload = { phase: "applied", status: "applied" };
    if (!app.applied_on || isNaN(Date.parse(app.applied_on))) payload.applied_on = todayISO();
    patchApplication(id, payload, app.company + " marked as applied").then((updated) => {
      if (updated && state.tab === "to_apply") setTab("applied");
    });
  }

  function patchStatus(id, status) {
    patchApplication(id, { status: status }, "Moved to " + STATUS_LABEL[status]);
  }

  /* Rejecting a job is often the end of it, so offer to clear it out — files
     included. Cancelling simply leaves it in the Applied list as rejected. */
  function promptRejectDelete(updated, previous) {
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

  function markReviewed(id) {
    patchApplication(id, { mark_reviewed: true }, "Marked as still open");
  }

  function closePosition(id) {
    patchApplication(
      id,
      { status: "rejected", mark_reviewed: true },
      "Position marked as closed",
      { promptReject: false }
    );
  }

  /* ---------------- modal ---------------- */

  function setModalMode(mode) {
    state.modalMode = mode;
    const isEditing = Boolean(state.editingId);
    const effective = isEditing ? "manual" : mode;
    $$(".mode-btn").forEach((button) => {
      const active = button.dataset.mode === effective;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-selected", active ? "true" : "false");
    });
    $("#panel-link").hidden = effective !== "link";
    $("#panel-file").hidden = effective !== "file";
    $("#app-form").hidden = effective !== "manual";
    $("#modal-foot").hidden = effective === "file";
    $("#modal-modes").hidden = isEditing;
    $("#modal-sub").hidden = isEditing;
    $("#modal-save").hidden = effective === "link";
    $("#modal-cancel").hidden = effective === "file";
  }

  function syncPhaseFields() {
    const phase = $("#form-phase").value;
    $$(".phase-applied-only").forEach((field) => {
      field.hidden = phase === "to_apply";
    });
  }

  function openModal(app) {
    state.editingId = app ? app.id : null;
    const form = $("#app-form");
    form.reset();
    const error = $("#form-error");
    error.hidden = true;
    error.textContent = "";
    error.classList.remove("is-warning");
    $$(".field.has-error").forEach((field) => field.classList.remove("has-error"));
    $("#form-status").innerHTML = statusSelectOptions(app ? app.status : "applied", false);
    $("#modal-title").textContent = app ? "Edit job" : "Add job";
    $("#modal-save").textContent = app ? "Save changes" : "Add job";

    const values = app || {
      status: "applied",
      work_mode: "onsite",
      applied_on: todayISO(),
      phase: state.tab === "to_apply" ? "to_apply" : "applied",
    };
    Object.keys(values).forEach((key) => {
      const field = form.elements.namedItem(key);
      if (field && values[key] != null) field.value = values[key];
    });
    if (!app) {
      form.elements.namedItem("applied_on").value = todayISO();
      form.elements.namedItem("work_mode").value = "onsite";
    }
    if (!form.elements.namedItem("phase").value) form.elements.namedItem("phase").value = "applied";
    $("#extract-url").value = "";
    $("#extract-status").hidden = true;
    $("#import-status").hidden = true;
    $("#modal-import-file").value = "";
    syncDatalists();
    syncPhaseFields();
    setModalMode("manual");
    $("#modal-backdrop").hidden = false;
    $("#modal-content").scrollTop = 0;
    document.body.classList.add("no-scroll");
    if (!app) window.setTimeout(() => form.elements.namedItem("company").focus(), 30);
  }

  function closeModal() {
    $("#modal-backdrop").hidden = true;
    state.editingId = null;
    document.body.classList.remove("no-scroll");
  }

  async function submitForm(event) {
    event.preventDefault();
    const form = $("#app-form");
    const data = {};
    Array.from(form.elements).forEach((field) => {
      if (!field.name) return;
      data[field.name] = field.value.trim();
    });
    const error = $("#form-error");
    const companyField = form.elements.namedItem("company").closest(".field");
    const roleField = form.elements.namedItem("role").closest(".field");
    companyField.classList.toggle("has-error", !data.company);
    roleField.classList.toggle("has-error", !data.role);
    if (!data.company || !data.role) {
      error.textContent = "Company and role are required.";
      error.classList.remove("is-warning");
      error.hidden = false;
      return;
    }
    if (data.applied_on === "") delete data.applied_on;
    if (data.next_step_on === "") data.next_step_on = null;
    error.hidden = true;
    const saveButton = $("#modal-save");
    saveButton.disabled = true;
    try {
      let saved;
      const previous = state.editingId
        ? state.apps.find((item) => item.id === state.editingId) || null
        : null;
      if (state.editingId) {
        saved = await api("/api/applications/" + state.editingId, {
          method: "PATCH",
          body: JSON.stringify(data),
        });
        toast("Job updated");
      } else {
        saved = await api("/api/applications", { method: "POST", body: JSON.stringify(data) });
        toast(saved.phase === "to_apply" ? "Job saved to apply" : "Application added");
      }
      updateLocal(saved);
      closeModal();
      if (state.drawerId === saved.id) openDrawer(saved.id);
      if (state.tab === "overview" || state.tab === "trash") {
        setTab(saved.phase === "to_apply" ? "to_apply" : "applied");
      }
      promptRejectDelete(saved, previous);
    } catch (submitError) {
      error.textContent = submitError.message;
      error.classList.remove("is-warning");
      error.hidden = false;
    } finally {
      saveButton.disabled = false;
    }
  }

  async function extractFromLink() {
    const input = $("#extract-url");
    const url = input.value.trim();
    if (!url) {
      setPanelNote("#extract-status", "Paste a job posting link first.", "error");
      input.focus();
      return;
    }
    const button = $("#extract-btn");
    const label = button.textContent;
    button.disabled = true;
    button.textContent = "Reading…";
    setPanelNote("#extract-status", "Fetching the posting…", "ok");
    try {
      const result = await api("/api/extract", { method: "POST", body: JSON.stringify({ url: url }) });
      const form = $("#app-form");
      const fields = result.fields || {};
      Object.keys(fields).forEach((key) => {
        const field = form.elements.namedItem(key);
        if (!field) return;
        const value = fields[key];
        if (value == null || value === "") return;
        if (typeof field.value === "string" && field.value.trim()) return;
        field.value = value;
      });
      const appliedField = form.elements.namedItem("applied_on");
      if (!appliedField.value) appliedField.value = todayISO();
      const warnings = result.warnings || [];
      setModalMode("manual");
      $("#modal-content").scrollTop = 0;
      if (warnings.length) {
        const box = $("#form-error");
        box.textContent = warnings.join(" ");
        box.classList.add("is-warning");
        box.hidden = false;
      }
      toast(warnings.length ? "Details filled — review the fields" : "Details filled from the posting");
    } catch (error) {
      setPanelNote("#extract-status", error.message, "error");
    } finally {
      button.disabled = false;
      button.textContent = label;
    }
  }

  /* ---------------- confirm / toast ---------------- */

  function confirmAction(config) {
    const template = $("#confirm-template");
    const fragment = template.content.cloneNode(true);
    const backdrop = fragment.querySelector(".confirm-backdrop");
    const okButton = fragment.querySelector(".confirm-ok");
    fragment.querySelector(".confirm-title").textContent = config.title;
    fragment.querySelector(".confirm-text").textContent = config.text;
    okButton.textContent = config.okLabel || "Confirm";
    okButton.classList.toggle("btn-danger", config.danger !== false);
    let busy = false;
    const cleanup = () => {
      backdrop.remove();
      document.body.classList.remove("no-scroll");
    };
    fragment.querySelector(".confirm-cancel").addEventListener("click", cleanup);
    backdrop.addEventListener("click", (event) => {
      if (event.target === backdrop) cleanup();
    });
    okButton.addEventListener("click", async () => {
      if (busy) return;
      busy = true;
      okButton.disabled = true;
      try {
        await config.onConfirm();
        cleanup();
      } catch (error) {
        busy = false;
        okButton.disabled = false;
        toast(error.message || "Something went wrong", true);
      }
    });
    document.body.appendChild(fragment);
    document.body.classList.add("no-scroll");
    okButton.focus();
  }

  function confirmTrash(app) {
    confirmAction({
      title: "Move to trash?",
      text:
        app.company + " — " + app.role +
        " will move to the trash. You can restore it from the Trash tab; nothing is deleted permanently yet.",
      okLabel: "Move to trash",
      onConfirm: async () => {
        const result = await api("/api/applications/" + app.id, { method: "DELETE" });
        const trashed = result && result.application ? result.application : app;
        state.apps = state.apps.filter((item) => item.id !== app.id);
        state.trash = [trashed].concat(state.trash.filter((item) => item.id !== app.id));
        render();
        if (state.drawerId === app.id) closeDrawer();
        toast("Moved to trash");
      },
    });
  }

  function confirmEmptyTrash() {
    if (!state.trash.length) return;
    const count = state.trash.length;
    confirmAction({
      title: "Empty the trash?",
      text:
        count + " deleted job" + (count === 1 ? "" : "s") +
        " and all of their attached documents (resume, cover letter, files) will be removed from the database and disk." +
        " This cannot be undone.",
      okLabel: "Empty trash",
      onConfirm: async () => {
        const result = await api("/api/trash", { method: "DELETE" });
        state.trash = [];
        render();
        const removed = result && result.deleted ? result.deleted : count;
        toast("Trash emptied — " + removed + " job" + (removed === 1 ? "" : "s") + " deleted");
      },
    });
  }

  function confirmPurge(app) {
    confirmAction({
      title: "Delete permanently?",
      text:
        app.company + " — " + app.role +
        ", its notes, timeline and all attached documents (resume, cover letter, files) will be removed from the database and disk. This cannot be undone.",
      okLabel: "Delete forever",
      onConfirm: async () => {
        await api("/api/applications/" + app.id + "?permanent=1", { method: "DELETE" });
        state.trash = state.trash.filter((item) => item.id !== app.id);
        render();
        toast("Permanently deleted");
      },
    });
  }

  async function restoreJob(id) {
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

  function toast(message, isError, variant) {
    const container = $("#toasts");
    const element = document.createElement("div");
    element.className = "toast" + (isError ? " is-error" : "") + (variant ? " is-" + variant : "");
    element.textContent = message;
    container.appendChild(element);
    while (container.children.length > 3) container.firstElementChild.remove();
    window.setTimeout(() => {
      element.classList.add("is-leaving");
      window.setTimeout(() => element.remove(), 200);
    }, 2600);
  }

  /* ---------------- import / export ---------------- */

  function download(filename, content, type) {
    const blob = new Blob([content], { type: type });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  function exportJSON() {
    if (!state.apps.length) {
      toast("Nothing to export yet", true);
      return;
    }
    download("job-applications-" + todayISO() + ".json", JSON.stringify(state.apps, null, 2), "application/json");
    toast("Exported " + state.apps.length + " jobs");
  }

  function exportCSV() {
    if (!state.apps.length) {
      toast("Nothing to export yet", true);
      return;
    }
    const columns = [
      "id", "phase", "company", "role", "status", "applied_on", "work_mode", "location", "source",
      "salary", "contact_name", "contact_email", "job_url", "next_step", "next_step_on", "description", "notes", "reviewed_at",
    ];
    const cell = (value) => '"' + String(value == null ? "" : value).replace(/"/g, '""') + '"';
    const rows = [columns.join(",")];
    const ordered = state.apps.slice().sort((a, b) => (a.id > b.id ? 1 : -1));
    ordered.forEach((app) => {
      rows.push(columns.map((column) => cell(app[column])).join(","));
    });
    download("job-applications-" + todayISO() + ".csv", rows.join("\n"), "text/csv");
    toast("Exported " + state.apps.length + " jobs");
  }

  const HEADER_ALIASES = {
    company: ["company", "company_name", "employer", "organization", "organisation", "business"],
    role: ["role", "position", "job_title", "title", "job", "job_position"],
    phase: ["phase", "bucket", "workflow"],
    status: ["status", "stage", "state", "application_status"],
    applied_on: ["applied_on", "applied", "date_applied", "applied_date", "application_date", "date", "applied_at"],
    work_mode: ["work_mode", "location_type", "workplace", "workplace_type"],
    location: ["location", "city", "place", "job_location"],
    source: ["source", "channel", "job_board", "platform", "found_via"],
    salary: ["salary", "compensation", "pay", "salary_range"],
    job_url: ["job_url", "url", "link", "job_link", "posting_url", "posting", "job_posting"],
    contact_name: ["contact_name", "contact", "recruiter", "hiring_manager"],
    contact_email: ["contact_email", "email", "recruiter_email"],
    next_step: ["next_step", "next_action", "next"],
    next_step_on: ["next_step_on", "next_step_date", "follow_up", "follow_up_date", "followup_date", "reminder"],
    description: ["description", "job_description", "jd", "role_description"],
    notes: ["notes", "note", "comments", "details", "personal_notes"],
  };

  function normalizeHeader(value) {
    return String(value == null ? "" : value)
      .replace(/^\uFEFF/, "")
      .trim()
      .toLowerCase()
      .replace(/[\s-]+/g, "_")
      .replace(/[^a-z0-9_]/g, "");
  }

  function canonicalKey(header) {
    const normalized = normalizeHeader(header);
    for (const target of Object.keys(HEADER_ALIASES)) {
      if (HEADER_ALIASES[target].includes(normalized)) return target;
    }
    return normalized;
  }

  function parseCSV(text) {
    const rows = [];
    let row = [];
    let value = "";
    let inQuotes = false;
    for (let index = 0; index < text.length; index += 1) {
      const char = text[index];
      if (inQuotes) {
        if (char === '"') {
          if (text[index + 1] === '"') {
            value += '"';
            index += 1;
          } else {
            inQuotes = false;
          }
        } else {
          value += char;
        }
      } else if (char === '"') {
        inQuotes = true;
      } else if (char === "," || char === ";") {
        row.push(value);
        value = "";
      } else if (char === "\n") {
        row.push(value);
        rows.push(row);
        row = [];
        value = "";
      } else if (char !== "\r") {
        value += char;
      }
    }
    if (value !== "" || row.length) {
      row.push(value);
      rows.push(row);
    }
    return rows.filter((cells) => cells.some((cell) => cell.trim() !== ""));
  }

  function normalizeStatusValue(value) {
    const text = String(value == null ? "" : value).trim().toLowerCase();
    if (!text) return "applied";
    if (/withdraw|cancel/.test(text)) return "withdrawn";
    if (/offer|hired|accept/.test(text)) return "offer";
    if (/interview|panel|onsite/.test(text)) return "interview";
    if (/screen|phone|recruiter_call/.test(text)) return "screening";
    if (/reject|declin|denied|ghost/.test(text)) return "rejected";
    return "applied";
  }

  function normalizePhaseValue(value) {
    const text = String(value == null ? "" : value).trim().toLowerCase();
    if (!text) return "";
    if (/to.?apply|saved|wishlist|backlog|not.?applied|todo|to.?send|shortlist/.test(text)) return "to_apply";
    if (/applied|sent|submitted|done/.test(text)) return "applied";
    return "";
  }

  function normalizeWorkMode(value) {
    const text = String(value == null ? "" : value).trim().toLowerCase();
    if (/remote|telecommut|anywhere/.test(text)) return "remote";
    if (/hybrid|flex/.test(text)) return "hybrid";
    return "onsite";
  }

  function normalizeDate(value) {
    const text = String(value == null ? "" : value).trim();
    if (!text) return "";
    let match = text.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
    if (match) {
      return match[1] + "-" + match[2].padStart(2, "0") + "-" + match[3].padStart(2, "0");
    }
    match = text.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/);
    if (match) {
      const first = Number(match[1]);
      const month = first > 12 ? match[2] : match[1];
      const day = first > 12 ? match[1] : match[2];
      let year = Number(match[3]);
      if (year < 100) year += 2000;
      return year + "-" + String(month).padStart(2, "0") + "-" + String(day).padStart(2, "0");
    }
    const parsed = new Date(text);
    if (!Number.isNaN(parsed.getTime())) {
      return [
        parsed.getFullYear(),
        String(parsed.getMonth() + 1).padStart(2, "0"),
        String(parsed.getDate()).padStart(2, "0"),
      ].join("-");
    }
    return "";
  }

  function cleanImportedRow(row) {
    const cleaned = {};
    Object.keys(row).forEach((key) => {
      let value = row[key];
      if (value == null) return;
      value = String(value).trim();
      if (!value) return;
      if (key === "status") value = normalizeStatusValue(value);
      if (key === "phase") {
        value = normalizePhaseValue(value);
        if (!value) return;
      }
      if (key === "work_mode") value = normalizeWorkMode(value);
      if (key === "applied_on" || key === "next_step_on") {
        value = normalizeDate(value);
        if (!value) return;
      }
      cleaned[key] = value;
    });
    if (cleaned.phase === "to_apply") delete cleaned.applied_on;
    return cleaned;
  }

  function rowsFromCSV(text) {
    const table = parseCSV(String(text).replace(/^\uFEFF/, ""));
    if (table.length < 2) return { rows: [], skipped: 0 };
    const headers = table[0].map(canonicalKey);
    const rows = table.slice(1).map((cells) => {
      const row = {};
      headers.forEach((key, index) => {
        if (!key) return;
        row[key] = cells[index] == null ? "" : cells[index];
      });
      return cleanImportedRow(row);
    });
    const valid = rows.filter((row) => row.company && row.role);
    return { rows: valid, skipped: rows.length - valid.length };
  }

  function rowsFromJSON(text) {
    const parsed = JSON.parse(String(text).replace(/^\uFEFF/, ""));
    let list = null;
    if (Array.isArray(parsed)) list = parsed;
    else if (parsed && Array.isArray(parsed.applications)) list = parsed.applications;
    if (!list) throw new Error("Expected a JSON array of jobs");
    const rows = list.map((item) => {
      const row = {};
      Object.keys(item || {}).forEach((key) => {
        row[canonicalKey(key)] = item[key];
      });
      return cleanImportedRow(row);
    });
    const valid = rows.filter((row) => row.company && row.role);
    return { rows: valid, skipped: rows.length - valid.length };
  }

  async function importRows(rows) {
    const result = await api("/api/import", { method: "POST", body: JSON.stringify({ applications: rows }) });
    await loadApps();
    return result;
  }

  function setPanelNote(selector, message, tone) {
    const element = $(selector);
    if (!element) return;
    element.hidden = !message;
    element.textContent = message || "";
    element.classList.toggle("is-error", tone === "error");
    element.classList.toggle("is-ok", tone === "ok");
  }

  async function handleImportFile(file, options) {
    if (!file) return;
    const settings = options || {};
    const status = settings.statusSelector ? (message, tone) => setPanelNote(settings.statusSelector, message, tone) : null;
    try {
      const text = await file.text();
      const isCSV = /\.csv$/i.test(file.name) || /csv/i.test(file.type);
      const parsed = isCSV ? rowsFromCSV(text) : rowsFromJSON(text);
      if (!parsed.rows.length) {
        throw new Error("No jobs found. A CSV needs company and role columns.");
      }
      if (status) status("Importing " + parsed.rows.length + " job(s)…", "ok");
      const result = await importRows(parsed.rows);
      const skipped = parsed.skipped + result.skipped;
      const summary =
        "Imported " + result.imported + " job(s)" +
        (skipped ? ", skipped " + skipped + " row(s) missing company or role" : "") + ".";
      toast(summary);
      if (status) status(summary, "ok");
      if (settings.closeModal) closeModal();
    } catch (error) {
      const message = error.message || "Import failed";
      if (status) status(message, "error");
      else toast(message, true);
    }
  }

  /* ---------------- events ---------------- */

  function bindEvents() {
    $$(".tab").forEach((button) => {
      button.addEventListener("click", () => setTab(button.dataset.tab));
    });

    $$(".view-btn").forEach((button) => {
      button.addEventListener("click", () => {
        state.view = button.dataset.view;
        localStorage.setItem("jobpipe:view", state.view);
        renderViewSwitch();
        renderWorkspace();
      });
    });

    $("#new-btn").addEventListener("click", () => openModal(null));
    $("#modal-close").addEventListener("click", closeModal);
    $("#modal-cancel").addEventListener("click", closeModal);
    $("#modal-backdrop").addEventListener("click", (event) => {
      if (event.target === $("#modal-backdrop")) closeModal();
    });
    $("#app-form").addEventListener("submit", submitForm);
    $("#form-phase").addEventListener("change", syncPhaseFields);

    $$(".mode-btn").forEach((button) => {
      button.addEventListener("click", () => {
        setModalMode(button.dataset.mode);
        if (button.dataset.mode === "link") window.setTimeout(() => $("#extract-url").focus(), 40);
      });
    });

    $("#extract-btn").addEventListener("click", extractFromLink);
    $("#extract-url").addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        extractFromLink();
      }
    });

    $("#modal-import-file").addEventListener("change", (event) => {
      const file = event.target.files && event.target.files[0];
      handleImportFile(file, { closeModal: true, statusSelector: "#import-status" });
      event.target.value = "";
    });

    const dropzone = $("#modal-drop");
    ["dragenter", "dragover"].forEach((name) => {
      dropzone.addEventListener(name, (event) => {
        event.preventDefault();
        dropzone.classList.add("is-dragover");
      });
    });
    ["dragleave", "drop"].forEach((name) => {
      dropzone.addEventListener(name, (event) => {
        event.preventDefault();
        dropzone.classList.remove("is-dragover");
      });
    });
    dropzone.addEventListener("drop", (event) => {
      const file = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0];
      if (file) handleImportFile(file, { closeModal: true, statusSelector: "#import-status" });
    });

    document.addEventListener("click", (event) => {
      const editButton = event.target.closest('[data-action="edit"]');
      if (editButton) {
        event.stopPropagation();
        const app = state.apps.find((item) => item.id === Number(editButton.dataset.id));
        if (app) openModal(app);
        return;
      }
      const deleteButton = event.target.closest('[data-action="delete"]');
      if (deleteButton) {
        event.stopPropagation();
        const app = state.apps.find((item) => item.id === Number(deleteButton.dataset.id));
        if (app) confirmTrash(app);
        return;
      }
      const reviewedButton = event.target.closest('[data-action="mark-reviewed"]');
      if (reviewedButton) {
        event.stopPropagation();
        markReviewed(Number(reviewedButton.dataset.id));
        return;
      }
      const closePositionButton = event.target.closest('[data-action="close-position"]');
      if (closePositionButton) {
        event.stopPropagation();
        closePosition(Number(closePositionButton.dataset.id));
        return;
      }
      const restoreButton = event.target.closest('[data-action="restore"]');
      if (restoreButton) {
        event.stopPropagation();
        restoreJob(Number(restoreButton.dataset.id));
        return;
      }
      const purgeButton = event.target.closest('[data-action="purge"]');
      if (purgeButton) {
        event.stopPropagation();
        const trashed = state.trash.find((item) => item.id === Number(purgeButton.dataset.id));
        if (trashed) confirmPurge(trashed);
        return;
      }
      const markButton = event.target.closest('[data-action="mark-applied"]');
      if (markButton) {
        event.stopPropagation();
        markApplied(Number(markButton.dataset.id));
        return;
      }
      const deleteDocButton = event.target.closest("[data-doc-delete]");
      if (deleteDocButton) {
        event.stopPropagation();
        if (state.drawerId) deleteDocument(state.drawerId, Number(deleteDocButton.dataset.docDelete));
        return;
      }
      const previewDocButton = event.target.closest("[data-preview-doc]");
      if (previewDocButton) {
        event.stopPropagation();
        const doc = state.drawerDocuments.find(
          (item) => item.id === Number(previewDocButton.dataset.previewDoc)
        );
        openPreview(doc);
        return;
      }
      if (event.target.closest('[data-action="close-drawer"]')) {
        closeDrawer();
        return;
      }
      if (event.target.closest('[data-action="new"]')) {
        openModal(null);
        return;
      }
      if (event.target.closest('[data-action="open-settings"]')) {
        openSettings();
        return;
      }
      if (event.target.closest('[data-action="go-to-apply"]')) {
        setTab("to_apply");
        return;
      }
      if (event.target.closest('[data-action="clear-filters"]')) {
        clearFilters();
        return;
      }
      const followButton = event.target.closest("[data-open-app]");
      if (followButton) {
        openDrawer(Number(followButton.dataset.openApp));
        return;
      }
      const row = event.target.closest("tr[data-app-id]");
      if (row && !event.target.closest("select, button, a, input, textarea")) {
        openDrawer(Number(row.dataset.appId));
        return;
      }
      const card = event.target.closest(".app-card");
      if (card) {
        openDrawer(Number(card.dataset.appId));
      }
    });

    document.addEventListener("keydown", (event) => {
      const isTyping = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
      if (event.key === "Escape") {
        if (!$("#settings-backdrop").hidden) closeSettings();
        else if (!$("#preview-backdrop").hidden) closePreview();
        else if (!$("#modal-backdrop").hidden) closeModal();
        else if (!$(".confirm-backdrop")) {
          if (state.drawerId) closeDrawer();
        }
        return;
      }
      if (isTyping) return;
      if (event.key === "/") {
        event.preventDefault();
        if (state.tab === "overview" || state.tab === "trash") setTab("applied");
        $("#search").focus();
      } else if (event.key === "n" || event.key === "N") {
        if (event.metaKey || event.ctrlKey) return;
        event.preventDefault();
        openModal(null);
      }
    });

    $("#drawer-scrim").addEventListener("click", closeDrawer);

    $("#preview-close").addEventListener("click", closePreview);
    $("#preview-backdrop").addEventListener("click", (event) => {
      if (event.target.id === "preview-backdrop") closePreview();
    });

    $("#settings-btn").addEventListener("click", openSettings);
    $("#settings-close").addEventListener("click", closeSettings);
    $("#settings-cancel").addEventListener("click", closeSettings);
    $("#settings-form").addEventListener("submit", saveSettings);
    $("#empty-trash-btn").addEventListener("click", confirmEmptyTrash);
    $("#settings-backdrop").addEventListener("click", (event) => {
      if (event.target.id === "settings-backdrop") closeSettings();
    });

    const drawer = $("#drawer");

    const clearDropTarget = (zone) => {
      zone.classList.remove("is-dragover");
      $$(".doc-upload", zone).forEach((button) => button.classList.remove("is-dragover"));
    };

    drawer.addEventListener("dragover", (event) => {
      const zone = event.target.closest("[data-doc-drop]");
      if (!zone || !event.dataTransfer) return;
      const types = Array.from(event.dataTransfer.types || []);
      if (types.length && !types.includes("Files")) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
      zone.classList.add("is-dragover");
      const target = event.target.closest("[data-drop-kind]");
      $$(".doc-upload", zone).forEach((button) =>
        button.classList.toggle("is-dragover", button === target)
      );
    });

    drawer.addEventListener("dragleave", (event) => {
      const zone = event.target.closest("[data-doc-drop]");
      if (!zone || zone.contains(event.relatedTarget)) return;
      clearDropTarget(zone);
    });

    drawer.addEventListener("drop", (event) => {
      const zone = event.target.closest("[data-doc-drop]");
      if (!zone) return;
      event.preventDefault();
      clearDropTarget(zone);
      if (!state.drawerId) return;
      const target = event.target.closest("[data-drop-kind]");
      const files = event.dataTransfer ? Array.from(event.dataTransfer.files || []) : [];
      if (!files.length) return;
      uploadDocuments(state.drawerId, target ? target.dataset.dropKind : null, files);
    });

    drawer.addEventListener("change", (event) => {
      const select = event.target.closest("[data-drawer-status]");
      if (select) {
        patchStatus(Number(select.dataset.drawerStatus), select.value);
        return;
      }
      const upload = event.target.closest("[data-doc-kind]");
      if (upload && upload.files && upload.files.length) {
        const files = Array.from(upload.files);
        upload.value = "";
        uploadDocuments(state.drawerId, upload.dataset.docKind, files);
      }
    });

    $("#applied-table-body").addEventListener("change", (event) => {
      const select = event.target.closest("[data-inline-status]");
      if (select) patchStatus(Number(select.dataset.inlineStatus), select.value);
    });

    $("#toapply-table-body").addEventListener("change", (event) => {
      const box = event.target.closest("[data-select-id]");
      if (!box) return;
      const id = Number(box.dataset.selectId);
      if (box.checked) state.selection.add(id);
      else state.selection.delete(id);
      renderWorkspace();
    });

    $("#select-all-toapply").addEventListener("change", (event) => {
      const ids = visibleApps("to_apply").map((app) => app.id);
      if (event.target.checked) ids.forEach((id) => state.selection.add(id));
      else ids.forEach((id) => state.selection.delete(id));
      renderWorkspace();
    });

    $("#bulk-apply").addEventListener("click", bulkMarkApplied);
    $("#bulk-delete").addEventListener("click", bulkDelete);
    $("#bulk-clear").addEventListener("click", () => {
      state.selection.clear();
      renderWorkspace();
    });

    $("#applied-table-body").addEventListener("keydown", (event) => {
      if (event.target.matches("select, button")) return;
      if (event.key === "Enter" && event.target.closest("tr")) {
        openDrawer(Number(event.target.closest("tr").dataset.appId));
      }
    });

    $("#toapply-table-body").addEventListener("keydown", (event) => {
      if (event.target.matches("select, button")) return;
      if (event.key === "Enter" && event.target.closest("tr")) {
        openDrawer(Number(event.target.closest("tr").dataset.appId));
      }
    });

    $$("th.sortable").forEach((th) => {
      th.addEventListener("click", () => {
        const key = th.dataset.sort;
        const phase = state.tab === "to_apply" ? "to_apply" : "applied";
        const sort = state.sort[phase];
        if (sort.key === key) {
          sort.dir = sort.dir === "asc" ? "desc" : "asc";
        } else {
          sort.key = key;
          sort.dir = key === "applied_on" || key === "created_at" ? "desc" : "asc";
        }
        renderWorkspace();
      });
    });

    $("#search").addEventListener("input", (event) => {
      state.filters.q = event.target.value;
      renderWorkspace();
      syncFilterOptions();
    });

    ["status", "mode", "source"].forEach((key) => {
      const select = $("#filter-" + key);
      select.addEventListener("change", (event) => {
        state.filters[key] = event.target.value;
        renderWorkspace();
        syncFilterOptions();
      });
    });

    $("#clear-filters").addEventListener("click", clearFilters);

    const storedTheme = localStorage.getItem("jobpipe:theme");
    const initialTheme =
      storedTheme || (window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");
    document.documentElement.setAttribute("data-theme", initialTheme);
    $("#theme-btn").addEventListener("click", () => {
      const next = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
      document.documentElement.setAttribute("data-theme", next);
      localStorage.setItem("jobpipe:theme", next);
    });

    const menu = $("#data-menu");
    const menuButton = $("#data-menu-btn");
    menuButton.addEventListener("click", (event) => {
      event.stopPropagation();
      const willOpen = menu.hidden;
      menu.hidden = !willOpen;
      menuButton.setAttribute("aria-expanded", willOpen ? "true" : "false");
    });
    document.addEventListener("click", (event) => {
      if (!menu.hidden && !event.target.closest(".menu-wrap")) {
        menu.hidden = true;
        menuButton.setAttribute("aria-expanded", "false");
      }
    });
    $$("#data-menu [data-export]").forEach((button) => {
      button.addEventListener("click", () => {
        menu.hidden = true;
        if (button.dataset.export === "json") exportJSON();
        else exportCSV();
      });
    });
    $("#import-btn").addEventListener("click", () => {
      menu.hidden = true;
      $("#import-file").click();
    });
    $("#import-file").addEventListener("change", (event) => {
      const file = event.target.files && event.target.files[0];
      handleImportFile(file);
      event.target.value = "";
    });

    const board = $("#board");
    board.addEventListener("dragstart", (event) => {
      const card = event.target.closest(".app-card");
      if (!card) return;
      event.dataTransfer.setData("text/plain", card.dataset.appId);
      event.dataTransfer.effectAllowed = "move";
      card.classList.add("is-dragging");
    });
    board.addEventListener("dragend", (event) => {
      const card = event.target.closest(".app-card");
      if (card) card.classList.remove("is-dragging");
      $$(".board-col").forEach((column) => column.classList.remove("is-drop-target"));
    });
    board.addEventListener("dragover", (event) => {
      const column = event.target.closest(".board-col");
      if (!column) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      $$(".board-col").forEach((item) => item.classList.toggle("is-drop-target", item === column));
    });
    board.addEventListener("dragleave", (event) => {
      const column = event.target.closest(".board-col");
      if (column && !column.contains(event.relatedTarget)) column.classList.remove("is-drop-target");
    });
    board.addEventListener("drop", (event) => {
      const column = event.target.closest(".board-col");
      if (!column) return;
      event.preventDefault();
      const id = Number(event.dataTransfer.getData("text/plain"));
      const status = column.dataset.dropStatus;
      column.classList.remove("is-drop-target");
      const app = state.apps.find((item) => item.id === id);
      if (app && status && app.status !== status) patchStatus(id, status);
    });
    board.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      const card = event.target.closest(".app-card");
      if (card) openDrawer(Number(card.dataset.appId));
    });
  }

  function clearFilters() {
    state.filters = { q: "", status: "", mode: "", source: "" };
    $("#search").value = "";
    $("#filter-status").value = "";
    $("#filter-mode").value = "";
    $("#filter-source").value = "";
    render();
  }

  /* ---------------- boot ---------------- */

  function init() {
    $("#form-applied-on").value = todayISO();
    $("#form-status").innerHTML = statusSelectOptions("applied", false);
    $("#filter-status").innerHTML = statusSelectOptions("", true);
    bindEvents();
    syncPhaseFields();
    render();
    loadApps();
  }

  document.addEventListener("DOMContentLoaded", init);
})();
