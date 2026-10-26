# Job Pipeline

A local dashboard for your job search: an overview of your pipeline, a separate list of jobs you still want to apply to, a sortable table and drag-and-drop board for applications you have sent, follow-up reminders, job descriptions, and resume / cover letter / document attachments.

No accounts, no build step, no dependencies. Python 3.8+ standard library only, and the frontend is plain ES modules that the browser loads directly. Data lives in SQLite on your machine.

## Run it

Double-click the launcher for your platform in the project folder: **Start Job Pipeline.command** on macOS, **Start Job Pipeline.bat** on Windows. Either one starts the server in a terminal window and opens the dashboard — or, if the server is already running, just opens the dashboard. Keep that window open while you work; closing it or pressing `Ctrl+C` stops the server.

From a terminal instead:

```bash
python3 server.py            # http://127.0.0.1:8787
python3 server.py --open     # ...and open it in your browser
```

Options:

| Flag | Default | What it does |
| --- | --- | --- |
| `--port` | `8787` | Port to listen on |
| `--host` | `127.0.0.1` | Bind address (keep it on loopback for local-only use) |
| `--db` | `data/tracker.db` | SQLite database file |
| `--open` | off | Open the dashboard in your default browser |

Stop it with `Ctrl+C`. Your data stays in `data/tracker.db` and `data/uploads/`.

Install the dashboard as an app if you like: see [Install it as an app](#install-it-as-an-app).

Opening `public/index.html` from Finder works too: if the server is already running, the page forwards to it, and if it is not you get a short start screen with the command to run, a **Check again** button and a link to the dashboard. Either way the server must stay running for saves to land, so keep that Terminal window open. If an action reports that it cannot reach the server, start it again; a single failed request is retried once automatically, so a stale connection (after the machine sleeps, for example) does not interrupt a save.

## Install it as an app

The dashboard ships a [web app manifest](public/manifest.webmanifest) and a [service worker](public/sw.js), so it can run in its own window without browser tabs.

- **Chrome, Edge, Brave** — open the dashboard, then use the install icon in the address bar (or ⋮ → *Cast, save and share* → *Install page as app*).
- **Safari on macOS 14+** — **File → Add to Dock**. On iPhone or iPad, **Share → Add to Home Screen**.
- Anything else that supports installing web apps will offer it too; the app is served from `http://127.0.0.1:8787`, so it only works while that server runs.

The service worker caches the shell — `index.html`, `styles.css`, the ES modules and the icons — so an installed window still opens when the server is stopped, and shows the *Start the Job Pipeline server* screen with the command and a **Check again** button. Job data, settings and documents are **never** cached: every API call goes straight to the server, so you cannot be shown a stale list of applications. While the server is running a reload always fetches the current files, so upgrades take effect immediately.

## The three tabs

- **Overview** — total applications, active, interviews, offers, response rate, saved jobs, the stage funnel, applications per week (last 8 weeks) and follow-ups due in the next 7 days.
- **Applied** — everything you have actually sent. Table view (search, filter, sort, inline stage changes) and board view (drag cards between Applied → Screening → Interview → Offer, plus Rejected/Withdrawn).
- **To apply** — jobs you have saved but not sent yet. Also a table, with a one-click **Mark as applied** action on every row (or in the detail drawer). Saved jobs are excluded from pipeline stats, follow-up reminders and the board until you send them.
- **Bulk actions** — tick the checkbox on several saved jobs (or the header checkbox to select everything currently shown) and a bar appears with **Mark as applied**, **Delete** and **Clear**. Marking several as applied sends them to the Applied tab with today's date; Delete asks once, then moves them all to Trash, where they can still be restored. The selection clears when you change tabs.
- **Trash** — deleted jobs wait here. Restore one, or delete it permanently when you are sure.

Click any row or card to open the detail drawer: stage, dates, salary, source, contact, job description, documents, personal notes, and the full stage timeline.

## Profiles

The app keeps separate profiles — for example one for your own search and one for freelance work. Each profile has its own jobs, trash, documents and goals; nothing is shared between them.

**The picker comes first.** Opening the dashboard in a new browser session shows a user screen with one round avatar per profile, its job count and a lock badge when it is PIN protected. Click an avatar to open that profile; the plus circle beside them adds someone new. Reloading the same tab goes straight back into the profile you were using — the picker returns in a new tab or after closing the browser. **Log out** in Settings drops the session (and the unlock token) and returns to the picker.

- The **profile button** in the header (your initials and the profile name) opens the same list as a dialog, with the active profile tagged **Current**, and **New profile** there creates another user.
- **Clicking a profile** switches to it: the dashboard reloads with that profile's jobs and goals.
- **Deleting a profile** happens only inside that profile: **Settings → Delete this profile…**, then a confirmation spelling out how many jobs and files go with it. A profile can never be deleted from someone else's dashboard; the API refuses it too. After deleting, the app returns to the user screen and keeps at least one profile.

Contact details are edited in **Settings** and apply to the profile you are on.

## PIN lock

Any profile can be locked with a 4–8 digit PIN. It is set, changed or removed in **Settings → Lock**; changing or removing it asks for the current PIN.

- A locked profile shows a padlock in the picker and asks for the PIN before its jobs are opened. Pressing the profile asks for the PIN, a wrong one says so and lets you try again.
- The lock is enforced by the local server, not just the screen: jobs, documents, goals and trash of a locked profile answer `423 Locked` until a valid unlock token is supplied. The token lives in memory on the server and in that browser tab only; it lasts 12 hours, a page reload keeps it, and restarting the server or closing the tab asks for the PIN again.
- **Lock now** in the profile dialog (the open-padlock icon on the active profile) drops the token and returns to the user screen immediately.
- The PIN is stored as a salted PBKDF2-SHA256 hash, never in plain text. It protects the dashboard and its API, not the database file itself: anyone who can read `data/tracker.db` can still read the jobs without the PIN.

## Deleting and the trash

Every job can be deleted from its table row, board card or detail drawer. Each delete asks for confirmation first. Deleting does **not** remove anything permanently — the job moves to the **Trash** tab with its timeline and files intact.

From Trash you can:

- **Restore** a job, which puts it back in Applied or To apply exactly as it was.
- **Delete forever**, which asks for a second confirmation and then removes the job's database row, its status history, all document records and every attached file from `data/uploads/`.
- **Empty trash**, a button on the Trash tab that permanently clears the whole bin — every job, its notes, timeline and attached files — after one confirmation. It is disabled while the trash is empty.

There is no automatic emptying otherwise: jobs stay in the trash until you restore or purge them.

## Adding jobs

Click **Add job** (or press `N`). There are three ways in:

1. **Manual** — fill in the form yourself, choosing **Applied** or **Saved — not applied yet** under Status.
2. **From link** — paste a job posting URL and press **Fetch details**. The server reads the page's `schema.org JobPosting` JSON-LD (used by Greenhouse, Lever, Workable, many company career sites) and falls back to OpenGraph metadata. It fills company, role, location, work mode, salary, source, the job description, and the posting URL for you to review. Some sites (LinkedIn, many Workday boards) block automated requests or render postings with JavaScript — you'll get a clear error and can switch to manual entry. Nothing is saved without your confirmation. Only public `http(s)` addresses are fetched; private/loopback addresses are refused.
3. **Import file** — drop or choose a `.csv` or `.json` file. Rows are appended; existing jobs are kept. Also available from **Export ▾ → Import CSV or JSON**.

### CSV format

Header names are matched loosely (`position`/`title` → role, `date applied` → applied_on, `company name` → company, `job description` → description, and so on). Only `company` and `role` are required.

```csv
Company,Role,Phase,Status,Applied On,Location,Work Mode,Source,Salary,Job URL,Next Step,Next Step Date,Contact,Email,Description,Notes
"Acme, Inc.",Senior Frontend Engineer,Applied,Applied,2026-10-20,Berlin,Hybrid,Referral,€90–110k,https://acme.com/jobs/1,Send follow-up,2026-10-27,Marta Klein,marta@acme.com,"Own our design system","Referred by Priya"
"Globex",Staff Engineer,To apply,,2026-10-24,Remote,Remote,Company site,€120k,https://globex.com/jobs/2,Tailor resume,2026-10-26,,,,"Met at a meetup"
```

`Phase` accepts `Applied` or `To apply` (also saved / wishlist / backlog / not applied). Status values are normalized (`phone screen` → screening, `offer` → offer, `rejected`/`declined` → rejected, and so on), as are work modes and dates (`YYYY-MM-DD`, `MM/DD/YYYY`, `DD/MM/YYYY` when the first number is over 12). JSON accepts either an array of objects or `{ "applications": [...] }` with the same field aliases.

## Documents

Open a job and use the **Documents** section to attach a **resume**, **cover letter**, or any **other** file. You can also drag files straight onto the section: drop one on the **Resume**, **Cover letter** or **Other** button to file it as that type, or drop anywhere in the box to attach several at once — the type is then guessed from the file name (`resume`, `cv`, `cover letter`, otherwise Other). Files are stored under `data/uploads/<job id>/` and listed with their type, size and date. Limit is 10 MB per file; anything larger is skipped with a message. Deleting a job also deletes its files.

Click a document name to preview it without leaving the dashboard: PDFs render in the browser's viewer inside the preview panel, images display inline, and plain text, CSV and Markdown files are shown as text. The panel also offers **Download** and **Open in tab**, and closes with `Esc`, the close button, or a click outside it. Word documents and other formats browsers cannot render show a short notice with a download link instead. Files are served with a safe content type and never as executable HTML.

## Using the dashboard

- **Search / filters** — search company, role, location, source, description and notes; filter by stage, location type and source. The same filters apply to whichever tab you are on (stage only matters for Applied).
- **Settings** — the gear in the header opens a menu for the current profile: **Profile** (name, headline, email, phone, location, links, and *Delete this profile…*), **Lock** (the PIN), **Goals** (daily and weekly), **Reminders** (the daily notification), **Backup** (a zip of the database and documents) and **Log out**. Each option opens its own panel with a back arrow, and `Esc` returns to the menu before closing. *Save changes* stores the details and goals together; the PIN, reminder and backup actions are buttons inside their own panels.
- **Sorting** — click a table header, or focus it and press `Enter`. The sorted column reports `aria-sort` to screen readers.
- **Follow-ups** — any Applied job with a next-step date in the next 7 days appears on the Overview. Every due label — "Due tomorrow", "Due in 3d", "Overdue by 2d" — is shown in red, with overdue ones in a heavier weight and a stronger tint. The same red labels appear under the next step in the Applied table and in the detail drawer.
- **Goals and streak** — the Overview has an **Application goals** panel with a ring for each target: daily and weekly (default 3 a day, 10 a week). Each ring shows applications sent against the target and turns green once it is met, and crossing a target while you use the app sets off a short confetti burst with a "Daily/Weekly goal complete" toast (confetti is skipped if your system asks for reduced motion; the toast still appears). Set the numbers in **Settings** — the gear in the header, or **Set goals** in the panel — and they are stored for the current profile in the database. A day counts once you have at least one application with that applied date; the week runs Monday to Sunday.
- **Streak** — the next panel counts consecutive days with at least one application. It keeps counting from yesterday until you send something today, so a streak is only broken once a full day passes with nothing sent. The last seven days are shown as dots and the longest run ever is listed as your best. The flame is drawn in flame orange with a warm halo and flickers gently all the time, burning brighter and a little faster once a streak is alive; both animations stop when your system asks for reduced motion.
- **Rejecting a job** — moving any application to the Rejected stage (from the table, the board, the detail drawer or the edit form) immediately asks whether to delete it. **Delete job and files** removes the application, its notes, timeline and every attached resume, cover letter and other document from the database and disk; **Cancel** keeps it in the Applied tab as rejected. Marking a posting "No longer open" from the review panel does not ask, since that is already a confirmation step.
- **Needs review** — once an application reaches 30 days in an active stage (Applied, Screening, Interview), it is automatically flagged: a **Review** badge appears in the table and on its board card, and it is listed in the **Needs review** panel on the Overview. Open it and choose **Still open** to record the check, or **No longer open** to close it as rejected. A reviewed job becomes due again after another 30 days, so long-running processes get checked monthly. Rejected, withdrawn and offered jobs, and jobs in To apply, are never flagged.
- **Export** — every job as JSON or CSV, including phase, description and notes.
- **Reminders** — **Settings → Reminders → Turn on notifications** asks the browser for permission once. After that, at most one notification per profile per day summarises what is due ("2 follow-ups due · 1 job to review") when you open the dashboard; it never fires twice for the same day, and nothing leaves your machine. Where a page is not allowed to raise a notification (installed windows and mobile browsers), the service worker posts it instead and clicking it brings the dashboard forward.
- Keyboard: `N` new job, `/` search, `Esc` close dialog/drawer, `Enter` opens the focused row, `Tab`/`Shift+Tab` stay inside an open dialog, arrow keys move between tabs.
- Screen readers: dialogs are labelled, the page behind an open dialog is `inert`, focus returns to the button that opened it, and toasts are announced politely.
- Theme follows your system preference; the header toggle overrides it and remembers your choice.

## Look and feel

The interface uses an Apple-style glass treatment: translucent frosted panels over a slowly drifting colour backdrop, a specular highlight along the top edge of each surface, soft layered shadows and rounded 20–26 px corners. Sheets, the detail drawer and dialogs are more opaque than the panels behind them, so text stays comfortable while the glass still reads as glass.

Cards respond to the pointer: stat cards and panels lift two pixels while a soft light glint fades in behind their content, goal rings glow, board cards raise with an accent rim, document rows lift, and table rows and follow-up items gain a slim accent edge. The effects only run on devices with a real pointer and are reduced to colour changes when the system asks for reduced motion.

Both themes are glass: the header toggle switches between dark smoked glass and light frosted glass. Everything is driven by custom properties at the top of `styles.css` if you want to retune it:

- `--surface`, `--surface-raised`, `--surface-soft` — translucent panel tints; `--surface-solid` is the opaque base the drawer, dialogs and preview sheet mix with.
- `--glass-edge`, `--glass-edge-soft`, `--glass-sheen` — the inner highlight and top-light gradient that make a surface look like glass.
- `--glass-blur`, `--glass-sat` — the frosted blur and colour boost; the header, menus, board columns, drawer and dialogs blur harder than plain panels.
- `--glow-1` … `--glow-4` — the colour orbs drifting behind everything.
- `--scrim` — the dimmed, blurred layer behind the drawer and dialogs.
- `--shadow-sm`, `--shadow-md`, `--shadow-lg` — the three shadow depths.

The backdrop drift and the goal confetti respect `prefers-reduced-motion`, and browsers without `backdrop-filter` still get readable translucent tints instead of flat colour.

## Data and backups

- Everything lives in `data/tracker.db` (SQLite, WAL mode); attachments in `data/uploads/`.
- **Automatic snapshots** — the first time the server starts each day it copies the database to `data/backups/tracker-YYYY-MM-DD.db` (SQLite's own backup, so it is consistent even while the app is open) and keeps the newest 14 copies. A day with no backup yet is added on the next start.
- **Download a backup** — **Settings → Backup → Download backup (.zip)** saves `tracker.db` together with every uploaded document in one zip, ready to keep somewhere else. The zip is built from a fresh snapshot, so it is safe to download while you work.
- Trashed jobs still occupy their row and files until permanently deleted.
- You can also copy `data/` by hand, or use **Export → Export as JSON** for a readable copy of the jobs.
- PINs are stored hashed, but the database file is not encrypted; the PIN lock guards the dashboard, not `data/tracker.db` on disk.
- Unlock tokens live in the server's memory, so restarting the server locks every PIN-protected profile again.

## Local-only API

The address and the data are yours, so the server refuses to be driven by anything else on the machine:

- **Host check** — every API call must carry a loopback `Host` header (`127.0.0.1`, `localhost`, `::1`, or the address given to `--host`). This stops a DNS-rebinding page from pretending to be the dashboard.
- **Same-origin writes** — creating, changing and deleting require an `Origin` (or `Referer`) from the same server and port. A page on another site cannot post to your tracker.
- **Session token** — `GET /api/session` hands out a random token for this run of the server. Every API call except the health probe and document downloads must send it as `X-Api-Token`; only the dashboard's own origin can read the response. Reloading picks up a fresh token automatically.
- `GET /api/health` stays open so the start screen can check whether the server is running.

If you script the API, fetch the token first and send it with your requests (see the example below).

## Tests

Two suites run against the real HTTP server with a throwaway SQLite database in a temp directory, so neither touches `data/`.

```bash
python3 -m pip install -r requirements-dev.txt
python3 -m pytest -q                    # API suite
RUN_E2E=1 python3 -m pytest tests/e2e   # browser suite (needs Playwright)
```

The **API suite** covers creating and validating jobs, stage changes and their timeline events, review marks, the trash flow (soft delete, restore, permanent delete, empty trash), document upload/download/inline preview with byte ranges and content-type safety, goal settings, JSON import, profiles — creating and updating them, keeping jobs, trash, documents and goals isolated per profile, deleting a profile only from inside itself, the PIN lock (hashing, wrong PINs, unlock tokens, locking again, refusing locked data without a token) — and the local-only guards (foreign `Origin`, missing token, foreign `Host`), plus the daily backup snapshot, its pruning and the backup zip.

The **browser suite** drives Chromium with Playwright: it opens the user picker, adds an application and opens its drawer, walks the Settings menu, saves goals, downloads a real backup zip, checks that a due follow-up produces exactly one notification a day, verifies the dialog focus trap and keyboard sorting, unlocks a PIN-protected profile, and confirms the app is installable (manifest, registered service worker, cached shell, themed title bar) and that opening it offline shows the start screen with a working **Check again**.

```bash
python3 -m playwright install chromium   # once, after installing requirements-dev
```

The browser suite is skipped unless `RUN_E2E=1`, so the pre-commit hook stays fast. GitHub Actions runs the API suite and, in a second job, the browser suite on every push to `main` and on pull requests via [.github/workflows/tests.yml](.github/workflows/tests.yml).

### Pre-commit hook

A hook runs the same suite before every commit and aborts the commit if anything fails. Enable it once per clone:

```bash
git config core.hooksPath .githooks
```

The hook uses `$JOBPIPE_PYTHON` if set, otherwise `.venv/bin/python`, `venv/bin/python`, then `python3`. Create the virtualenv so it has pytest:

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements-dev.txt
```

If the interpreter it finds has no pytest, the hook says so and lets the commit through rather than blocking on a missing tool; CI still runs the suite. Skip a single commit with `git commit --no-verify`.

## Files

```
Start Job Pipeline.command  macOS double-click launcher (starts the server, opens the dashboard)
Start Job Pipeline.bat      Windows double-click launcher (same thing)
server.py        HTTP server, JSON API, validation, SQLite schema, document storage
extract.py       Job posting extraction (JSON-LD + OpenGraph, stdlib only)
public/          Dashboard UI: index.html, styles.css, sw.js, manifest.webmanifest, icons
                 and js/ ES modules (no build step)
  public/js/     main.js (events and boot), core.js (state, dates, API client), data.js
                 (loading and mutations), overview.js, workspace.js, drawer.js, dialogs.js,
                 profiles.js (picker, PIN, settings), io.js (import/export), a11y.js (dialog
                 focus), reminders.js (daily notification), pwa.js (service worker and
                 offline start screen)
tests/           pytest suite exercising the API end to end
  tests/e2e/     Playwright suite driving the dashboard in Chromium
data/            Created on first run: tracker.db, uploads/ and backups/
.githooks/       pre-commit hook that runs the suite
.github/         CI workflows that run both suites
AGENTS.md        Working conventions for automated assistants
requirements-dev.txt  pytest and Playwright, only needed for running the tests
```

## API (if you want to script it)

```
GET    /api/applications                      list all jobs
GET    /api/applications/<id>                 one job + status events + documents
POST   /api/applications                      create
PATCH  /api/applications/<id>                 partial update (phase, status, description, …);
                                              { "mark_reviewed": true } records a review
DELETE /api/applications/<id>                 move job to trash (soft delete)
DELETE /api/applications/<id>?permanent=1     permanently delete a trashed job + files
POST   /api/applications/<id>/restore         restore a trashed job
GET    /api/applications?trash=1              list trashed jobs
DELETE /api/trash                             permanently delete every trashed job and its files
POST   /api/applications/<id>/documents       upload { filename, kind, content_type, data (base64) }
GET    /api/applications/<id>/documents/<doc> download a document
GET    /api/applications/<id>/documents/<doc>?inline=1  preview a PDF, image or text file inline
DELETE /api/applications/<id>/documents/<doc> remove a document
GET    /api/settings                           daily and weekly application goals
PATCH  /api/settings                           update goals, e.g. { "daily_goal": 5, "weekly_goal": 20 }
GET    /api/profiles                           every profile with its job counts and locked flag
POST   /api/profiles                           create a profile, { "name": "Freelance", … }
GET    /api/profiles/<id>                      one profile
PATCH  /api/profiles/<id>                      update name, headline, email, phone, location, links
DELETE /api/profiles/<id>                      remove the profile with its jobs, files and goals;
                                              only from inside that profile (X-Profile-Id must match)
POST   /api/profiles/<id>/pin                  { "pin": "1234" } sets or changes it (needs current_pin
                                              once set); { "remove": true, "current_pin": "…" } clears it
POST   /api/profiles/<id>/unlock               { "pin": "1234" } → { "token": "…" }
POST   /api/profiles/<id>/lock                 revoke every unlock token for the profile
POST   /api/import                            { "applications": [ … ] }
POST   /api/extract                           { "url": "https://…" }
GET    /api/session                           { "token": "…" } for this run of the server
GET    /api/backup                            a zip of the database and every document
GET    /api/health                            open, no token needed
```

Every endpoint except `GET /api/profiles`, `/api/session`, `/api/backup` and `/api/health` works on one profile. Send `X-Profile-Id: <id>` to pick it; without the header the first profile is used, which is what the dashboard does before it has loaded the profile list. For a PIN-protected profile also send `X-Profile-Token` with the token from `/unlock`, otherwise the data endpoints answer `423`.

Send `X-Api-Token` from `/api/session` on every call, and an `Origin` matching the server on writes (see [Local-only API](#local-only-api)):

```bash
BASE=http://127.0.0.1:8787
TOKEN=$(curl -s $BASE/api/session | python3 -c 'import json,sys; print(json.load(sys.stdin)["token"])')

curl -X POST $BASE/api/applications \
  -H "X-Api-Token: $TOKEN" \
  -H "Origin: $BASE" \
  -H 'Content-Type: application/json' \
  -d '{"company":"Acme","role":"Frontend Engineer","phase":"applied","status":"applied"}'
```
