"""Browser tests for the dashboard.

Run them with `RUN_E2E=1 .venv/bin/python -m pytest tests/e2e -q`; without the
environment variable the suite is skipped so the pre-commit hook stays fast.
"""

import datetime


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
