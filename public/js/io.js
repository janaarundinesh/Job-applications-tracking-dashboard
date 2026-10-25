/* Job Pipeline — CSV/JSON export and import.
   ES module, no build step. Open the dashboard through server.py. */

import { $, api, download, state, toast, todayISO } from "./core.js";
import { loadApps } from "./data.js";
import { closeModal } from "./dialogs.js";


export function exportJSON() {
  if (!state.apps.length) {
    toast("Nothing to export yet", true);
    return;
  }
  download("job-applications-" + todayISO() + ".json", JSON.stringify(state.apps, null, 2), "application/json");
  toast("Exported " + state.apps.length + " jobs");
}


export function exportCSV() {
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


export const HEADER_ALIASES = {
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


export function normalizeHeader(value) {
  return String(value == null ? "" : value)
    .replace(/^\uFEFF/, "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_")
    .replace(/[^a-z0-9_]/g, "");
}


export function canonicalKey(header) {
  const normalized = normalizeHeader(header);
  for (const target of Object.keys(HEADER_ALIASES)) {
    if (HEADER_ALIASES[target].includes(normalized)) return target;
  }
  return normalized;
}


export function parseCSV(text) {
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


export function normalizeStatusValue(value) {
  const text = String(value == null ? "" : value).trim().toLowerCase();
  if (!text) return "applied";
  if (/withdraw|cancel/.test(text)) return "withdrawn";
  if (/offer|hired|accept/.test(text)) return "offer";
  if (/interview|panel|onsite/.test(text)) return "interview";
  if (/screen|phone|recruiter_call/.test(text)) return "screening";
  if (/reject|declin|denied|ghost/.test(text)) return "rejected";
  return "applied";
}


export function normalizePhaseValue(value) {
  const text = String(value == null ? "" : value).trim().toLowerCase();
  if (!text) return "";
  if (/to.?apply|saved|wishlist|backlog|not.?applied|todo|to.?send|shortlist/.test(text)) return "to_apply";
  if (/applied|sent|submitted|done/.test(text)) return "applied";
  return "";
}


export function normalizeWorkMode(value) {
  const text = String(value == null ? "" : value).trim().toLowerCase();
  if (/remote|telecommut|anywhere/.test(text)) return "remote";
  if (/hybrid|flex/.test(text)) return "hybrid";
  return "onsite";
}


export function normalizeDate(value) {
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


export function cleanImportedRow(row) {
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


export function rowsFromCSV(text) {
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


export function rowsFromJSON(text) {
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


export async function importRows(rows) {
  const result = await api("/api/import", { method: "POST", body: JSON.stringify({ applications: rows }) });
  await loadApps();
  return result;
}


export function setPanelNote(selector, message, tone) {
  const element = $(selector);
  if (!element) return;
  element.hidden = !message;
  element.textContent = message || "";
  element.classList.toggle("is-error", tone === "error");
  element.classList.toggle("is-ok", tone === "ok");
}


export async function handleImportFile(file, options) {
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
