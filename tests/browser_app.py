"""Real-browser smoke test. Run: python tests/browser_app.py [--android]."""

import argparse
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import tempfile
import time
from urllib.request import urlopen

from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[1]
ADB_FALLBACK = Path.home() / "AppData/Local/Android/Sdk/platform-tools/adb.exe"


def run_adb(adb, serial, *args):
    command = [adb]
    if serial:
        command += ["-s", serial]
    result = subprocess.run(command + list(args), capture_output=True, text=True, timeout=20)
    if result.returncode:
        raise RuntimeError(f"ADB {' '.join(args)}: {result.stderr.strip() or result.stdout.strip()}")
    return result.stdout.strip()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--android", action="store_true", help="Use Android Chrome via ADB and CDP")
    parser.add_argument("--serial", help="ADB serial, if multiple devices are connected")
    parser.add_argument("--browser", choices=["edge", "chrome", "chromium"],
                        default="edge" if os.name == "nt" else "chromium")
    parser.add_argument("--artifacts", type=Path, help="Output directory (default: temporary directory)")
    args = parser.parse_args()
    artifacts = args.artifacts or Path(tempfile.mkdtemp(prefix="audioreader-browser-"))
    artifacts.mkdir(parents=True, exist_ok=True)
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    url = f"http://127.0.0.1:{port}/"
    errors = []
    checks = []
    result = "FAIL"
    adb = shutil.which("adb") or (str(ADB_FALLBACK) if ADB_FALLBACK.exists() else None)
    browser = page = server = playwright = None
    forwarded = reverse_added = False
    server_log = (artifacts / "server.log").open("w", encoding="utf-8")
    try:
        server = subprocess.Popen([sys.executable, "-m", "uvicorn", "main:app", "--host",
                                   "127.0.0.1", "--port", str(port)], cwd=ROOT,
                                  stdout=server_log, stderr=subprocess.STDOUT)
        for _ in range(100):
            if server.poll() is not None:
                raise RuntimeError("Local app exited before it became ready")
            try:
                with urlopen(url, timeout=0.5) as response:
                    if response.status == 200:
                        break
            except OSError:
                time.sleep(0.1)
        else:
            raise RuntimeError("Local app did not become ready")

        playwright = sync_playwright().start()
        if args.android:
            if not adb:
                raise RuntimeError("adb not found")
            devices = run_adb(adb, None, "devices").splitlines()[1:]
            available = [line.split()[0] for line in devices if line.endswith("\tdevice")]
            serial = args.serial or (available[0] if len(available) == 1 else None)
            if not serial or serial not in available:
                raise RuntimeError(f"Choose an authorized ADB device with --serial: {available}")
            run_adb(adb, serial, "reverse", f"tcp:{port}", f"tcp:{port}")
            reverse_added = True
            try:
                run_adb(adb, serial, "shell", "pidof", "com.android.chrome")
            except RuntimeError:
                run_adb(adb, serial, "shell", "am", "start", "-n",
                        "com.android.chrome/com.google.android.apps.chrome.Main")
                for _ in range(30):
                    try:
                        run_adb(adb, serial, "shell", "pidof", "com.android.chrome")
                        break
                    except RuntimeError:
                        time.sleep(0.2)
                else:
                    raise RuntimeError("Chrome did not start on the phone")
            cdp_port = int(run_adb(adb, serial, "forward", "tcp:0",
                                   "localabstract:chrome_devtools_remote"))
            forwarded = True
            browser = playwright.chromium.connect_over_cdp(f"http://127.0.0.1:{cdp_port}")
            page = browser.contexts[0].new_page()
        else:
            options = {"headless": True}
            if args.browser != "chromium":
                options["channel"] = "msedge" if args.browser == "edge" else "chrome"
            browser = playwright.chromium.launch(**options)
            page = browser.new_page(viewport={"width": 393, "height": 852})

        page.on("pageerror", lambda error: errors.append(f"pageerror: {error}"))
        page.on("console", lambda message: errors.append(f"console: {message.text}")
                if message.type == "error" and "Failed to load resource" not in message.text else None)
        page.on("response", lambda response: errors.append(f"HTTP {response.status}: {response.url}")
                if response.status >= 400 and not response.url.endswith("/favicon.ico") else None)
        page.on("requestfailed", lambda request: errors.append(f"requestfailed: {request.url}: {request.failure}"))
        page.goto(url, wait_until="domcontentloaded", timeout=30000)
        if args.android:
            page.bring_to_front()
        page.locator("#addContentButton").click()
        page.locator("#chooseTextImport").click()
        page.locator("#rawText").fill("Przeglądarka odczytuje próbny dokument.")
        submit = page.locator("#textImportForm button[type=submit]")
        if args.android:
            # Android CDP can misplace taps while the software keyboard changes the viewport.
            submit.evaluate("button => button.click()")
        else:
            submit.click()
        page.locator("#sentenceList").get_by_text("Przeglądarka odczytuje próbny dokument.").wait_for()
        checks.append("text import and reader view")
        assert page.locator("#rateSlider").input_value() == "0"
        page.locator("#voiceSelect").select_option("pl-PL-MarekNeural")
        assert page.locator("#rateSlider").input_value() == "0"
        page.locator("#rateSlider").evaluate("el => { el.value = '-30'; el.dispatchEvent(new Event('input', {bubbles:true})); el.dispatchEvent(new Event('change', {bubbles:true})); }")
        page.locator("#voiceSelect").select_option("pl-PL-ZofiaNeural")
        assert page.locator("#rateSlider").input_value() == "0"
        page.locator("#rateSlider").evaluate("el => { el.value = '20'; el.dispatchEvent(new Event('input', {bubbles:true})); el.dispatchEvent(new Event('change', {bubbles:true})); }")
        page.locator("#voiceSelect").select_option("pl-PL-MarekNeural")
        assert page.locator("#rateSlider").input_value() == "-30"
        assert page.locator("#rateLabel").inner_text() == "-30%"
        checks.append("independent voice rates")
        page.reload(wait_until="domcontentloaded")
        assert page.locator("#voiceSelect").input_value() == "pl-PL-MarekNeural"
        assert page.locator("#rateSlider").input_value() == "-30"
        checks.append("preferences after reload")
        page.locator("#tabHistory").click()
        page.locator("#libraryToggle").click()
        page.locator("#libraryList .library-entry button").first.click()
        page.locator("#sentenceList").get_by_text("Przeglądarka odczytuje próbny dokument.").wait_for()
        assert page.locator("#voiceSelect").input_value() == "pl-PL-MarekNeural"
        assert page.locator("#rateSlider").input_value() == "-30"
        checks.append("old library document preserves preferences")
        assert not errors, "Browser errors: " + "; ".join(errors)
        result = "PASS"
    except Exception as error:
        errors.append(f"test: {type(error).__name__}: {error}")
    finally:
        if page:
            try:
                page.screenshot(path=str(artifacts / "screen.png"), full_page=True)
            except Exception as error:
                errors.append(f"screenshot: {error}")
            page.close()
        if browser:
            browser.close()
        if playwright:
            playwright.stop()
        if args.android and adb:
            if forwarded:
                run_adb(adb, serial, "forward", "--remove", f"tcp:{cdp_port}")
            if reverse_added:
                run_adb(adb, serial, "reverse", "--remove", f"tcp:{port}")
        if server:
            server.terminate()
            try:
                server.wait(timeout=5)
            except subprocess.TimeoutExpired:
                server.kill()
        server_log.close()
        (artifacts / "result.json").write_text(json.dumps({"result": result, "device":
            "android-chrome" if args.android else args.browser, "checks": checks, "errors": errors},
            ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"{result}: browser UI smoke test; artifacts: {artifacts}")
        for error in errors:
            print(error, file=sys.stderr)
    return 0 if result == "PASS" else 1


if __name__ == "__main__":
    raise SystemExit(main())
