"""Check 13: GUI smoke test via Playwright headless."""
from . import CheckResult, VerifyContext

def run(ctx: VerifyContext) -> CheckResult:
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        # A check that cannot run must not report PASS: an unverified GUI is
        # exactly what this check exists to catch.
        return CheckResult("gui", False,
                           "playwright not installed on runner — install it "
                           "(pip install playwright && playwright install chromium) "
                           "or explicitly remove the gui check from the run")

    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            page = browser.new_page()
            page.goto(ctx.gui_url, timeout=15000)
            # Check login page loads
            if page.title():
                page.screenshot(path="/tmp/gui-check.png")
                browser.close()
                return CheckResult("gui", True, f"GUI loaded: {page.title()}")
            browser.close()
            return CheckResult("gui", False, "GUI returned empty page")
    except Exception as e:
        return CheckResult("gui", False, f"Playwright error: {e}")
