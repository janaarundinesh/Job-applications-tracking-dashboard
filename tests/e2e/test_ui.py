"""Browser tests for the dashboard.

Run them with `RUN_E2E=1 .venv/bin/python -m pytest tests/e2e -q`; without the
environment variable the suite is skipped so the pre-commit hook stays fast.
"""

import base64
import datetime
import json


def enter_profile(page):
    """The user picker is the first screen of a session; step through it."""
    page.wait_for_selector("#welcome-list [data-enter-profile]")
    page.locator("#welcome-list [data-enter-profile]").first.click()
    page.wait_for_selector("#panel-overview:not([hidden])")


def api_post(page, path, payload):
    """POST through the dashboard's own session, like the app does."""
    return page.evaluate(
        """async ({ path, payload }) => {
            const session = await (await fetch('/api/session')).json();
            const response = await fetch(path, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'X-Api-Token': session.token },
              body: JSON.stringify(payload),
            });
            return { status: response.status, body: await response.json() };
          }""",
        {"path": path, "payload": payload},
    )


def test_picker_opens_the_dashboard(page):
    page.wait_for_selector("#welcome-list [data-enter-profile]")
    assert page.locator("#welcome-list [data-enter-profile]").count() == 1
    assert page.locator("#welcome-add").count() == 1

    enter_profile(page)
    assert page.locator(".stat-grid .stat-card").count() == 6

    page.click('[data-tab="applied"]')
    page.wait_for_selector("#workspace:not([hidden])")
    assert "No applications yet" in page.locator("#applied-empty").inner_text()


def test_add_application_shows_up_in_the_table(page):
    enter_profile(page)
    page.click("#new-btn")
    page.wait_for_selector("#modal-backdrop:not([hidden])")
    page.fill('input[name="company"]', "Acme Robotics")
    page.fill('input[name="role"]', "Frontend Engineer")
    page.select_option("#form-status", "screening")
    page.click("#modal-save")
    page.wait_for_selector("#applied-table-body tr")

    row = page.locator("#applied-table-body tr").first
    assert "Acme Robotics" in row.inner_text()
    assert page.locator("#count-applied").inner_text() == "1"

    row.click()
    page.wait_for_selector("#drawer:not([hidden])")
    assert "Frontend Engineer" in page.locator("#drawer").inner_text()
    assert page.locator('#drawer [data-doc-drop]').count() >= 1
    page.click("#drawer .drawer-close")
    page.wait_for_selector("#drawer", state="hidden")


def test_importing_postings_without_a_status_saves_them_to_apply(page):
    """A file of postings is a to-apply list; the analysis it carries is kept."""
    payload = json.dumps(
        [
            {
                "rank": 1,
                "company": "Airbus Defence and Space GmbH",
                "role": "Junior Simulation Software Developer C/C++",
                "location": "Manching, Bavaria, Germany",
                "source": (
                    "Airbus careers (seen via aggregator listings: speedyapply, freehire, "
                    "Glassdoor; LinkedIn/Indeed also list Airbus Manching simulation roles)"
                ),
                "estimated_match_pct": 72,
                "why_it_matches": "Junior C/C++ simulation role; thesis in C++17.",
                "important_missing_requirements": "No avionics or real-time C experience.",
            }
        ]
    ).encode("utf-8")

    enter_profile(page)
    page.click("#new-btn")
    page.wait_for_selector("#modal-backdrop:not([hidden])")
    page.click('[data-mode="file"]')
    page.set_input_files(
        "#modal-import-file",
        {"name": "jobs.json", "mimeType": "application/json", "buffer": payload},
    )
    page.wait_for_selector("#modal-backdrop", state="hidden")

    # Nothing was sent, so the job lands under To apply with its match estimate,
    # and the import takes you there rather than leaving you on the Applied tab.
    assert page.locator("#count-toapply").inner_text() == "1"
    assert page.locator("#count-applied").inner_text() == "0"
    assert page.evaluate("document.querySelector('.tab.is-active').dataset.tab") == "to_apply"
    page.wait_for_selector("#toapply-table-body tr")
    row = page.locator("#toapply-table-body tr").first
    assert "Airbus" in row.inner_text()
    assert row.locator(".match-cell").inner_text().strip() == "72%"

    row.click()
    page.wait_for_selector("#drawer:not([hidden])")
    page.wait_for_selector("#drawer .doc-list")
    detail = page.locator("#drawer").inner_text()
    assert "Resume match" in detail
    assert "72%" in detail
    notes = page.input_value("#drawer-notes")
    assert "Why it matches:\nJunior C/C++ simulation role" in notes
    assert "Important missing requirements:\nNo avionics or real-time C experience." in notes

    # The match estimate is editable from the form.
    page.click('#drawer [data-action="edit"]')
    page.wait_for_selector("#modal-backdrop:not([hidden])")
    assert page.input_value('input[name="match_pct"]') == "72"
    page.click("#modal-cancel")
    page.wait_for_selector("#modal-backdrop", state="hidden")
    page.click("#drawer .drawer-close")
    page.wait_for_selector("#drawer", state="hidden")

    # CSV files get the same treatment through their own column names.
    csv = (
        'Company,Position,Estimated Match Pct,Why It Matches\n'
        'Globex,Staff Engineer,65 %,"Remote-friendly, four-day week"\n'
    )
    page.click("#new-btn")
    page.wait_for_selector("#modal-backdrop:not([hidden])")
    page.click('[data-mode="file"]')
    page.set_input_files(
        "#modal-import-file",
        {"name": "jobs.csv", "mimeType": "text/csv", "buffer": csv.encode("utf-8")},
    )
    page.wait_for_selector("#modal-backdrop", state="hidden")
    assert page.locator("#count-toapply").inner_text() == "2"
    assert page.locator("#count-applied").inner_text() == "0"
    globex = page.locator("#toapply-table-body tr", has_text="Globex")
    assert globex.locator(".match-cell").inner_text().strip() == "65%"
    globex.click()
    page.wait_for_selector("#drawer:not([hidden])")
    page.wait_for_selector("#drawer-notes")
    assert "Why it matches:\nRemote-friendly, four-day week" in page.input_value("#drawer-notes")


def test_settings_menu_goals_and_backup(page):
    enter_profile(page)
    page.click("#settings-btn")
    page.wait_for_selector("#settings-menu")

    labels = page.locator("#settings-menu .settings-row-label").all_inner_texts()
    assert labels == ["Profile", "Lock", "Goals", "Reminders", "Backup", "Log out"]

    page.click('[data-settings-view="goals"]')
    page.fill("#settings-daily", "7")
    page.fill("#settings-weekly", "35")
    page.click("#settings-save")
    page.wait_for_selector("#toasts .toast")
    assert "Settings updated" in page.locator("#toasts").inner_text()

    # Saving closes the dialog; opening it again shows the new pace.
    page.wait_for_selector("#settings-backdrop", state="hidden")
    page.click("#settings-btn")
    page.wait_for_selector("#settings-menu")
    assert "7 a day" in page.locator("#settings-menu-goals").inner_text()

    # The backup panel has no Save button and produces a real zip download.
    page.click('[data-settings-view="backup"]')
    assert page.locator("#settings-save").is_hidden()
    with page.expect_download() as download:
        page.click("#settings-backup-download")
    assert download.value.suggested_filename.endswith(".zip")
    assert download.value.path().stat().st_size > 0
    page.wait_for_timeout(200)
    assert "Backup downloaded" in page.locator("#toasts").inner_text()

    page.click("#settings-close")
    page.wait_for_selector("#settings-backdrop", state="hidden")


def test_reminders_send_one_daily_notification(page, context):
    tomorrow = (datetime.date.today() + datetime.timedelta(days=1)).isoformat()
    created = api_post(
        page,
        "/api/applications",
        {"company": "Follow Up Ltd", "role": "Engineer", "next_step_on": tomorrow},
    )
    assert created["status"] == 201

    context.add_init_script(
        """
        window.__notes = [];
        window.Notification = class {
          static permission = 'granted';
          static requestPermission() { return Promise.resolve('granted'); }
          constructor(title, options) {
            window.__notes.push({ title, body: (options || {}).body || '' });
          }
          addEventListener() {}
          close() {}
        };
        """
    )
    page.evaluate("localStorage.setItem('jobpipe:reminders', 'on')")
    page.reload()
    page.wait_for_load_state("networkidle")
    enter_profile(page)
    page.wait_for_timeout(300)

    notes = page.evaluate("window.__notes")
    assert len(notes) == 1, notes
    assert "1 follow-up due" in notes[0]["body"]

    # A reload later the same day does not nag again.
    page.reload()
    page.wait_for_load_state("networkidle")
    page.wait_for_selector("#panel-overview:not([hidden])")
    page.wait_for_timeout(300)
    # The note list is rebuilt on every load, so an empty one plus the "already
    # reminded today" marker proves the second visit stayed quiet.
    assert page.evaluate("window.__notes") == []
    today = datetime.date.today().isoformat()
    assert page.evaluate("localStorage.getItem('jobpipe:reminded:1:' + '%s')" % today) == "1"


def test_dialogs_trap_focus_and_headers_sort_by_keyboard(page):
    enter_profile(page)
    page.click("#settings-btn")
    page.wait_for_selector("#settings-menu")
    assert page.locator("main.page").get_attribute("inert") == ""
    assert page.evaluate("document.querySelector('#settings-backdrop').contains(document.activeElement)")

    for _ in range(12):
        page.keyboard.press("Tab")
    assert page.evaluate("document.querySelector('#settings-backdrop').contains(document.activeElement)")

    page.click("#settings-close")
    page.wait_for_selector("#settings-backdrop", state="hidden")
    assert page.locator("main.page").get_attribute("inert") is None
    page.wait_for_function("document.activeElement.id === 'settings-btn'")

    page.click('[data-tab="to_apply"]')
    page.wait_for_selector("#toapply-table-shell:not([hidden])")
    header = page.locator('#toapply-table-shell th[data-sort="company"]')
    assert header.get_attribute("aria-sort") == "none"
    header.focus()
    page.keyboard.press("Enter")
    assert header.get_attribute("aria-sort") == "ascending"
    page.keyboard.press("Enter")
    assert header.get_attribute("aria-sort") == "descending"


def test_pin_lock_asks_before_showing_jobs(page):
    enter_profile(page)
    result = page.evaluate(
        """async () => {
            const session = await (await fetch('/api/session')).json();
            const response = await fetch('/api/profiles/1/pin', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'X-Api-Token': session.token,
                'X-Profile-Id': '1',
              },
              body: JSON.stringify({ pin: '4321' }),
            });
            return response.status;
          }"""
    )
    assert result == 200

    page.reload()
    page.wait_for_load_state("networkidle")
    page.wait_for_selector("#welcome-list [data-enter-profile]")
    page.locator("#welcome-list [data-enter-profile]").first.click()
    page.wait_for_selector("#unlock-backdrop:not([hidden])")

    page.fill("#unlock-pin", "0000")
    page.click("#unlock-submit")
    page.wait_for_selector("#unlock-error:not([hidden])")
    assert "not correct" in page.locator("#unlock-error").inner_text()

    page.fill("#unlock-pin", "4321")
    page.click("#unlock-submit")
    page.wait_for_selector("#panel-overview:not([hidden])")
    assert page.locator(".stat-grid .stat-card").count() == 6


def test_skip_link_and_delete_confirmation(page):
    # The first Tab lands on the skip link, which is hidden until focused.
    page.keyboard.press("Tab")
    assert page.evaluate("document.activeElement.className") == "skip-link"
    page.wait_for_function(
        "document.activeElement.classList.contains('skip-link') &&"
        " document.activeElement.getBoundingClientRect().top >= 0"
    )

    enter_profile(page)
    page.click("#new-btn")
    page.fill('input[name="company"]', "Doomed Corp")
    page.fill('input[name="role"]', "Tester")
    page.click("#modal-save")
    page.wait_for_selector("#applied-table-body tr")

    page.click('#applied-table-body [data-action="delete"]')
    page.wait_for_selector(".confirm-backdrop")
    assert page.evaluate("document.querySelector('.confirm-backdrop').contains(document.activeElement)")
    assert page.locator("main.page").get_attribute("inert") == ""

    # Cancelling keeps the job and hands focus back to the row button.
    page.click(".confirm-backdrop .confirm-cancel")
    page.wait_for_selector(".confirm-backdrop", state="detached")
    assert page.locator("main.page").get_attribute("inert") is None
    assert page.locator("#applied-table-body tr").count() == 1
    page.wait_for_function("document.activeElement.dataset.action === 'delete'")


def test_dashboard_is_installable(page):
    assert page.get_attribute('link[rel="manifest"]', "href") == "manifest.webmanifest"
    manifest = page.evaluate("async () => (await fetch('/manifest.webmanifest')).json()")
    assert manifest["display"] == "standalone"
    assert manifest["start_url"] == "/"
    assert len(manifest["icons"]) >= 2

    # The worker registers, takes over and caches the app shell.
    page.wait_for_function(
        "async () => { const r = await navigator.serviceWorker.getRegistration();"
        " return !!(r && r.active); }",
        timeout=15000,
    )
    cached = page.evaluate(
        "async () => { const c = await caches.open('jobpipe-shell-v1');"
        " return (await c.keys()).map((request) => new URL(request.url).pathname); }"
    )
    assert "/index.html" in cached
    assert "/styles.css" in cached
    assert "/js/main.js" in cached

    # The title bar of an installed window follows the theme. The toggle lives
    # in the header, so open a profile first (the picker has no top bar).
    enter_profile(page)
    before = page.get_attribute('meta[name="theme-color"]', "content")
    assert before in ("#05060b", "#e8ecf7")
    page.click("#theme-btn")
    after = page.get_attribute('meta[name="theme-color"]', "content")
    assert after != before


def test_offline_start_screen_offers_a_retry(page, context):
    page.wait_for_function(
        "async () => { const r = await navigator.serviceWorker.getRegistration();"
        " return !!(r && r.active); }",
        timeout=15000,
    )
    page.wait_for_timeout(500)

    # Opening the installed app while the server is down: the cached shell loads
    # and tells you how to start the server instead of failing silently.
    context.set_offline(True)
    page.reload()
    page.wait_for_selector("html.is-offline", state="attached", timeout=10000)
    assert page.locator("#file-guard").is_visible()
    assert page.locator("#file-guard-title").inner_text() == "Start the Job Pipeline server"

    # Once the server is back, "Check again" brings the dashboard up.
    context.set_offline(False)
    page.click("#file-guard-retry")
    page.wait_for_selector("#welcome-list [data-enter-profile]", timeout=10000)
    assert page.evaluate("document.documentElement.classList.contains('is-offline')") is False


RESUME_SOURCE = r"""\documentclass[11pt]{article}
\begin{document}

\begin{center}
{\LARGE \textbf{Test Person}}\\[3pt]
test@example.com
\end{center}

\section{Experience}
\textbf{Acme GmbH} \hfill 2024 -- 2025\\
Simulation Engineer
\begin{itemize}
\item Built a particle model in C++.
\end{itemize}

\section{Education}
\textbf{University of Wuppertal} \hfill 2022 -- 2027\\
M.Sc. Computer Simulation

\end{document}
"""

PNG_BYTES = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
)


def open_resume_tab(page):
    page.click('[data-tab="resume"]')
    page.wait_for_selector("#panel-resume:not([hidden])")


def test_resume_editor_renders_the_source_and_keeps_files(page):
    enter_profile(page)
    open_resume_tab(page)

    # The empty state offers the template built from the profile.
    assert "No resume open" in page.locator("#resume-empty").inner_text()
    page.click('#resume-empty [data-resume-action="new"]')
    page.wait_for_selector("#resume-source:not([hidden])")
    page.wait_for_selector(".resume-page .tex-section")
    assert page.input_value("#resume-name") == "resume-1.tex"
    assert page.locator(".resume-tabs .resume-tab").count() == 1
    assert page.locator(".resume-rail .resume-file").count() == 1

    page.fill("#resume-source", RESUME_SOURCE)
    page.wait_for_function(
        """() => {
          const sections = Array.from(document.querySelectorAll('.resume-page .tex-section'));
          return sections.length === 2 && sections[0].textContent === 'Experience';
        }"""
    )
    page.wait_for_function("() => /^Saved \\d/.test(document.querySelector('#resume-status').textContent)")

    # The commands the resume actually uses are rendered, not printed.
    assert page.locator(".resume-page .tex-size-xlarge strong").inner_text() == "Test Person"
    assert page.locator(".resume-page .tex-line.is-split .tex-right").first.inner_text() == "2024 – 2025"
    assert "Built a particle model in C++." in page.locator(".resume-page ul li").first.inner_text()
    assert page.locator("#resume-issues").is_hidden()

    # A support file: uploaded, listed, and usable by \includegraphics.
    page.set_input_files(
        "#resume-file-input",
        {"name": "profile.png", "mimeType": "image/png", "buffer": PNG_BYTES},
    )
    page.wait_for_selector(".resume-asset-name")
    assert "profile.png" in page.locator(".resume-assets").inner_text()

    page.fill(
        "#resume-source",
        RESUME_SOURCE.replace(
            "test@example.com",
            "test@example.com\n\\includegraphics[width=3cm]{profile.png}",
        ),
    )
    page.wait_for_function(
        "() => { const img = document.querySelector('.resume-page .tex-img'); return Boolean(img && img.complete && img.naturalWidth > 0); }"
    )
    assert page.evaluate("document.querySelector('.resume-page .tex-img').getAttribute('src')").endswith(
        "/files/1"
    )

    # Both the source and the file survive a reload.
    page.reload()
    page.wait_for_function(
        "() => !document.querySelector('#welcome').hidden || !document.querySelector('#panel-overview').hidden"
    )
    if page.locator("#welcome-list [data-enter-profile]").is_visible():
        enter_profile(page)
    open_resume_tab(page)
    page.wait_for_selector(".resume-asset-name")
    assert "Built a particle model" in page.input_value("#resume-source")
    assert page.locator(".resume-asset-name").first.inner_text().strip() == "profile.png"


def test_a_job_gets_a_tailored_resume(page):
    created = api_post(
        page,
        "/api/applications",
        {"company": "Airbus", "role": "Frontend Engineer", "phase": "to_apply"},
    )
    assert created["status"] == 201
    page.reload()
    page.wait_for_function(
        "() => !document.querySelector('#welcome').hidden || !document.querySelector('#welcome-list [data-enter-profile]')"
    )
    if page.locator("#welcome-list [data-enter-profile]").is_visible():
        enter_profile(page)
    page.click('[data-tab="to_apply"]')
    page.wait_for_selector("#toapply-table-body tr")
    page.locator("#toapply-table-body tr").first.click()
    page.wait_for_selector("#drawer:not([hidden])")

    page.click('#drawer [data-action="open-resume"]')
    page.wait_for_selector("#panel-resume:not([hidden])")
    page.wait_for_function(
        "() => document.querySelector('#resume-name').value === 'airbus.tex'"
    )
    page.wait_for_selector("#drawer", state="hidden")
    assert "Airbus — Frontend Engineer" in page.locator("#resume-preview-title").inner_text()
    groups = [name.lower() for name in page.locator(".resume-rail-group h3").all_inner_texts()]
    assert "tailored for jobs" in groups
    # The tailored copy is a tab of its own next to the master it came from.
    assert page.locator(".resume-tabs .resume-tab").count() >= 1
    assert page.locator(".resume-page .tex-section").count() >= 3


def test_jobs_sort_and_filter_by_resume_match(page):
    for company, pct in (
        ("Below Forty Co", 25),
        ("Forty Band Co", 45),
        ("Sixty Band Co", 65),
        ("High Match Co", 88),
        ("Unscored Co", None),
    ):
        payload = {"company": company, "role": "Engineer", "phase": "to_apply"}
        if pct is not None:
            payload["match_pct"] = pct
        assert api_post(page, "/api/applications", payload)["status"] == 201

    page.reload()
    page.wait_for_function(
        "() => !document.querySelector('#welcome').hidden || !document.querySelector('#panel-overview').hidden"
    )
    if page.locator("#welcome-list [data-enter-profile]").is_visible():
        enter_profile(page)
    page.click('[data-tab="to_apply"]')
    page.wait_for_selector("#toapply-table-body tr")

    def companies():
        return [name.strip() for name in page.locator("#toapply-table-body tr .company-name").all_inner_texts()]

    header = page.locator('#toapply-table-shell th[data-sort="match_pct"]')
    assert header.count() == 1
    assert header.inner_text().strip().lower() == "match"

    # Highest match first, and a job with no estimate never pretends to be low.
    header.click()
    assert header.get_attribute("aria-sort") == "descending"
    assert companies() == [
        "High Match Co",
        "Sixty Band Co",
        "Forty Band Co",
        "Below Forty Co",
        "Unscored Co",
    ]
    assert [
        value.strip() for value in page.locator("#toapply-table-body .match-cell").all_inner_texts()
    ] == ["88%", "65%", "45%", "25%", "—"]

    header.click()
    assert header.get_attribute("aria-sort") == "ascending"
    assert companies()[-1] == "Unscored Co"
    assert companies()[0] == "Below Forty Co"

    # The match column replaced the chip beside the company name.
    assert "88%" not in page.locator("#toapply-table-body tr .company-name").last.inner_text()

    page.select_option("#filter-match", "80")
    assert companies() == ["High Match Co"]
    page.select_option("#filter-match", "60")
    assert companies() == ["Sixty Band Co"]
    page.select_option("#filter-match", "40")
    assert companies() == ["Forty Band Co"]
    page.select_option("#filter-match", "under40")
    assert companies() == ["Below Forty Co"]
    page.select_option("#filter-match", "none")
    assert companies() == ["Unscored Co"]

    # The extra column still fits the table at this width.
    assert page.evaluate(
        """() => {
          const shell = document.querySelector('#toapply-table-shell');
          return shell.scrollWidth <= shell.clientWidth + 1;
        }"""
    )

    # The filter is shared with the Applied table, which has the same column.
    assert page.locator('#applied-table-shell th[data-sort="match_pct"]').count() == 1
    assert page.locator("#clear-filters").is_visible()
    page.click("#clear-filters")
    assert page.locator("#filter-match").input_value() == ""
    assert len(companies()) == 5
    assert page.locator("#clear-filters").is_hidden()


def test_applied_list_selects_all_and_bulk_deletes(page):
    for company in ("Alpha Co", "Beta Co", "Gamma Co"):
        assert api_post(page, "/api/applications", {"company": company, "role": "Engineer"})["status"] == 201

    page.reload()
    page.wait_for_function(
        "() => !document.querySelector('#welcome').hidden || !document.querySelector('#panel-overview').hidden"
    )
    if page.locator("#welcome-list [data-enter-profile]").is_visible():
        enter_profile(page)

    # Saved jobs come before the applications you have already sent.
    labels = [label.strip() for label in page.locator("#main-tabs .tab").all_inner_texts()]
    assert labels[0].startswith("Overview")
    assert labels[1].startswith("To apply")
    assert labels[2].startswith("Applied")
    assert labels[3] == "Resume"
    assert labels[4].startswith("Trash")

    page.click('[data-tab="applied"]')
    page.wait_for_selector("#applied-table-body tr")
    assert page.locator("#applied-table-body tr").count() == 3
    # The select column fits beside the rest of the table at this width.
    assert page.evaluate(
        """() => {
          const shell = document.querySelector('#applied-table-shell');
          return shell.scrollWidth <= shell.clientWidth + 1;
        }"""
    )

    header = page.locator("#select-all-applied")
    assert header.is_visible()
    header.check()
    assert page.locator("#bulk-count").inner_text() == "3 selected"
    assert page.locator("#bulk-bar").is_visible()
    # Nothing here still needs sending, so there is nothing to mark as applied.
    assert page.locator("#bulk-apply").is_hidden()

    page.locator("#applied-table-body [data-select-id]").first.uncheck()
    assert page.locator("#bulk-count").inner_text() == "2 selected"
    assert page.locator("#select-all-applied").evaluate("(box) => box.indeterminate") is True

    page.click("#bulk-delete")
    page.wait_for_selector(".confirm-backdrop")
    assert page.locator(".confirm-backdrop .confirm-title").inner_text() == "Move 2 jobs to trash?"
    page.click(".confirm-backdrop .confirm-ok")
    page.wait_for_selector(".confirm-backdrop", state="detached")

    assert page.locator("#count-applied").inner_text() == "1"
    assert page.locator("#count-trash").inner_text() == "2"
    assert page.locator("#bulk-bar").is_hidden()

    page.click('[data-tab="applied"]')
    page.wait_for_selector("#applied-table-body tr")
    assert page.locator("#applied-table-body tr").count() == 1
    assert page.locator("#select-all-applied").is_checked() is False

    # The saved list still selects and marks, with its own header checkbox.
    page.click('[data-tab="to_apply"]')
    page.wait_for_selector("#toapply-empty:not([hidden])")
    assert page.locator("#select-all-applied").is_checked() is False


def test_applied_bulk_bar_moves_several_jobs_to_a_stage(page):
    for company in ("Alpha Co", "Beta Co", "Gamma Co"):
        assert api_post(page, "/api/applications", {"company": company, "role": "Engineer"})["status"] == 201

    page.reload()
    page.wait_for_function(
        "() => !document.querySelector('#welcome').hidden || !document.querySelector('#panel-overview').hidden"
    )
    if page.locator("#welcome-list [data-enter-profile]").is_visible():
        enter_profile(page)
    page.click('[data-tab="applied"]')
    page.wait_for_selector("#applied-table-body tr")

    # Saved jobs have nothing to move: the stage controls belong to applied ones.
    page.click('[data-tab="to_apply"]')
    page.wait_for_selector("#toapply-empty:not([hidden])")
    page.click('[data-tab="applied"]')
    page.wait_for_selector("#applied-table-body tr")
    assert page.locator("#bulk-status").is_hidden()

    page.check("#select-all-applied")
    assert page.locator("#bulk-status").is_visible()
    assert page.locator("#bulk-stage-apply").is_visible()
    assert page.locator("#bulk-stage-apply").is_disabled()
    assert page.locator("#bulk-apply").is_hidden()

    page.select_option("#bulk-status", "interview")
    assert page.locator("#bulk-stage-apply").is_enabled()
    page.click("#bulk-stage-apply")
    page.wait_for_selector("#bulk-bar", state="hidden")

    def stages():
        return page.evaluate(
            "() => Array.from(document.querySelectorAll('#applied-table-body .stage-select')).map((s) => s.value)"
        )

    assert stages() == ["interview", "interview", "interview"]

    # A wrong stage move is reversible while the toast is still up.
    undo = page.locator("#toasts .toast-action")
    assert undo.count() == 1
    assert undo.inner_text() == "Undo"
    undo.click()
    page.wait_for_function(
        "() => document.querySelectorAll('#applied-table-body .stage-select[data-status=\"applied\"]').length === 3"
    )
    assert stages() == ["applied", "applied", "applied"]
    assert "Undone" in page.locator("#toasts").inner_text()

    page.check("#select-all-applied")
    page.select_option("#bulk-status", "interview")
    page.click("#bulk-stage-apply")
    page.wait_for_selector("#bulk-bar", state="hidden")
    # The stage filter and the overview funnel follow the move.
    page.select_option("#filter-status", "interview")
    assert page.locator("#applied-table-body tr").count() == 3
    assert page.inner_text('#funnel .funnel-row[data-status="interview"] .funnel-count') == "3"

    # The stage select resets, so a second selection starts from "Change stage…".
    page.select_option("#filter-status", "")
    page.check("#select-all-applied")
    assert page.input_value("#bulk-status") == ""
    assert page.locator("#bulk-stage-apply").is_disabled()


def test_marking_saved_jobs_applied_can_be_undone(page):
    for company in ("Alpha Co", "Beta Co"):
        assert (
            api_post(
                page,
                "/api/applications",
                {"company": company, "role": "Engineer", "phase": "to_apply"},
            )["status"]
            == 201
        )

    page.reload()
    page.wait_for_function(
        "() => !document.querySelector('#welcome').hidden || !document.querySelector('#panel-overview').hidden"
    )
    if page.locator("#welcome-list [data-enter-profile]").is_visible():
        enter_profile(page)
    page.click('[data-tab="to_apply"]')
    page.wait_for_selector("#toapply-table-body tr")

    page.check("#select-all-toapply")
    page.click("#bulk-apply")
    page.wait_for_function("() => document.querySelector('#count-applied').textContent === '2'")
    assert page.locator("#count-toapply").inner_text() == "0"

    undo = page.locator("#toasts .toast-action")
    assert undo.inner_text() == "Undo"
    undo.click()
    page.wait_for_function("() => document.querySelector('#count-toapply').textContent === '2'")
    assert page.locator("#count-applied").inner_text() == "0"
    page.wait_for_selector("#toapply-table-body tr")
    assert page.locator("#toapply-table-body tr").count() == 2
    assert page.input_value("#filter-status") == ""
    # The undoing is itself reported, and the undo offer is gone with the toast.
    assert "Undone" in page.locator("#toasts").inner_text()
