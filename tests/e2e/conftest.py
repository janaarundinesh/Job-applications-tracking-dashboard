"""Fixtures for the browser tests.

These drive the real dashboard in Chromium against a throwaway server and
database, so a broken module import or a broken click path fails the suite
instead of only showing up by hand.

They are skipped unless RUN_E2E=1, which keeps the pre-commit hook fast and lets
CI (which installs Playwright) run them in a separate job.
"""

import os
import sys
import threading
from http.server import ThreadingHTTPServer
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import server  # noqa: E402  (needs the path tweak above)

RUN_E2E = os.environ.get("RUN_E2E") == "1"


def pytest_collection_modifyitems(config, items):
    """Plain `pytest` (and the pre-commit hook) skips the browser tests."""
    if RUN_E2E:
        return
    skip = pytest.mark.skip(reason="set RUN_E2E=1 to run the browser tests")
    for item in items:
        if str(item.nodeid).startswith("tests/e2e"):
            item.add_marker(skip)


@pytest.fixture(scope="session")
def playwright_tools():
    if not RUN_E2E:
        pytest.skip("set RUN_E2E=1 to run the browser tests")
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        pytest.skip("playwright is not installed (pip install playwright)")
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch()
        try:
            yield browser
        finally:
            browser.close()


@pytest.fixture()
def server_url(tmp_path, monkeypatch):
    db_path = tmp_path / "tracker.db"
    server.init_db(str(db_path))
    monkeypatch.setattr(server.Handler, "db_path", str(db_path))
    monkeypatch.setattr(server.Handler, "log_message", lambda *args, **kwargs: None)
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    try:
        yield "http://127.0.0.1:%d" % httpd.server_address[1]
    finally:
        httpd.shutdown()
        httpd.server_close()
        thread.join(timeout=5)


@pytest.fixture()
def context(playwright_tools, server_url):
    browser_context = playwright_tools.new_context(viewport={"width": 1280, "height": 900})
    browser_context.grant_permissions(["notifications"], origin=server_url)
    try:
        yield browser_context
    finally:
        browser_context.close()


@pytest.fixture()
def page_errors():
    return []


@pytest.fixture()
def page(context, server_url, page_errors):
    tab = context.new_page()
    tab.on("pageerror", lambda error: page_errors.append(str(error)))
    tab.goto(server_url + "/")
    tab.wait_for_load_state("networkidle")
    try:
        yield tab
    finally:
        tab.close()
        assert page_errors == [], "the page raised: %s" % page_errors

