import json
import os
import random
import re
import sys
import time
import subprocess
from pathlib import Path

from selenium.webdriver.common.by import By
from selenium.webdriver.common.keys import Keys
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC
import undetected_chromedriver as uc

CMA_URL = "https://www.cma-cgm.com/"
ROOT_DIR = Path.cwd()
DEFAULT_PROFILE_DIR = ROOT_DIR / ".cma_chrome_profile"


def _first_existing(paths):
    for p in paths:
        if p and Path(p).exists():
            return str(Path(p))
    return None


def resolve_chrome_executable():
    env = os.environ.get("CHROME_BINARY") or os.environ.get("BROWSER_EXECUTABLE_PATH")
    if env and Path(env).exists():
        return env
    local = os.environ.get("LOCALAPPDATA", "")
    program_files = os.environ.get("PROGRAMFILES", r"C:\Program Files")
    program_files_x86 = os.environ.get("PROGRAMFILES(X86)", r"C:\Program Files (x86)")
    candidates = [
        str(Path(local) / "Google/Chrome/Application/chrome.exe") if local else None,
        str(Path(program_files) / "Google/Chrome/Application/chrome.exe"),
        str(Path(program_files_x86) / "Google/Chrome/Application/chrome.exe"),
        "/usr/bin/google-chrome",
        "/usr/bin/google-chrome-stable",
        "/usr/bin/chromium",
        "/usr/bin/chromium-browser",
        str(ROOT_DIR / "Chrome/chrome.exe"),
        str(ROOT_DIR / "chrome.exe"),
    ]
    return _first_existing(candidates)


def resolve_driver_executable():
    # Use an explicit driver only when the user sets it.
    # Let undetected_chromedriver download the driver that matches Chrome by default.
    # This avoids accidentally picking up a stale ChromeDriver.exe from the project folder.
    env = os.environ.get("UC_DRIVER") or os.environ.get("CHROMEDRIVER") or os.environ.get("DRIVER_EXECUTABLE_PATH")
    if env and Path(env).exists():
        return env
    return None


def detect_chrome_major_version(chrome_binary=None):
    forced = os.environ.get("UC_VERSION_MAIN") or os.environ.get("CHROME_VERSION_MAIN")
    if forced:
        m = re.search(r"\d+", forced)
        if m:
            return int(m.group(0))

    version_texts = []

    if chrome_binary and Path(chrome_binary).exists():
        try:
            completed = subprocess.run(
                [chrome_binary, "--version"],
                capture_output=True,
                text=True,
                timeout=8,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
            version_texts.append((completed.stdout or "") + " " + (completed.stderr or ""))
        except Exception:
            pass

    # Windows fallback: query registry. Works even when chrome.exe --version returns nothing.
    for cmd in [
        ["reg", "query", r"HKCU\Software\Google\Chrome\BLBeacon", "/v", "version"],
        ["reg", "query", r"HKLM\Software\Google\Chrome\BLBeacon", "/v", "version"],
        ["reg", "query", r"HKLM\Software\WOW6432Node\Google\Chrome\BLBeacon", "/v", "version"],
    ]:
        try:
            completed = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=8,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
            version_texts.append((completed.stdout or "") + " " + (completed.stderr or ""))
        except Exception:
            pass

    joined = "\n".join(version_texts)
    m = re.search(r"(\d{2,3})\.\d+\.\d+\.\d+", joined)
    if m:
        return int(m.group(1))
    return None


def profile_dir():
    return Path(os.environ.get("CMA_PROFILE_DIR", str(DEFAULT_PROFILE_DIR))).resolve()


def short_sleep(min_s=0.6, max_s=1.8):
    time.sleep(random.uniform(min_s, max_s))


def wait_visible(driver, locator, timeout=30):
    return WebDriverWait(driver, timeout).until(EC.visibility_of_element_located(locator))


def maybe_click(driver, by, selector, timeout=3):
    try:
        el = WebDriverWait(driver, timeout).until(EC.element_to_be_clickable((by, selector)))
        driver.execute_script("arguments[0].click();", el)
        return True
    except Exception:
        return False


def close_overlays(driver):
    # Cookie/notice banners only. Keep this conservative; do not fight security checks here.
    for by, sel in [
        (By.ID, "onetrust-accept-btn-handler"),
        (By.CSS_SELECTOR, "button[aria-label='Accept']"),
        (By.CSS_SELECTOR, "button[title='Accept']"),
        (By.XPATH, "//button[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'accept all cookies')]"),
        (By.XPATH, "//button[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'accept')]"),
        (By.CSS_SELECTOR, "button[class*='close']"),
        (By.CSS_SELECTOR, ".modal button.close"),
    ]:
        if maybe_click(driver, by, sel, timeout=2):
            short_sleep(0.4, 1.0)
    try:
        driver.find_element(By.TAG_NAME, "body").send_keys(Keys.ESCAPE)
    except Exception:
        pass


def extract_text(driver, xpath):
    try:
        el = driver.find_element(By.XPATH, xpath)
        return " ".join((el.text or "").split())
    except Exception:
        return ""


def page_text(driver):
    try:
        return " ".join(driver.find_element(By.TAG_NAME, "body").text.split())
    except Exception:
        return ""


def looks_like_verification(driver):
    text = page_text(driver).lower()
    markers = [
        "captcha",
        "verify you are human",
        "verify that you are human",
        "security check",
        "unusual traffic",
        "robot",
        "blocked",
        "access denied",
        "checking your browser",
    ]
    if any(m in text for m in markers):
        return True
    try:
        frames = driver.find_elements(By.CSS_SELECTOR, "iframe[src*='captcha'], iframe[title*='captcha'], iframe[src*='challenge']")
        if frames:
            return True
    except Exception:
        pass
    return False


def maybe_manual_verify(driver, stage):
    if not looks_like_verification(driver):
        return False
    raise RuntimeError(f"VERIFICATION_REQUIRED: CMA requested verification at {stage}. This build does not pause for manual verification or attempt to bypass security checks.")


def build_driver():
    options = uc.ChromeOptions()
    if os.environ.get("CI") or os.environ.get("SELENIUM_HEADLESS", "").lower() in {"1", "true", "yes"}:
        options.add_argument("--headless=new")
        options.add_argument("--window-size=1600,1000")
    else:
        options.add_argument("--start-maximized")
    options.add_argument("--disable-dev-shm-usage")
    options.add_argument("--no-sandbox")
    options.add_argument("--lang=en-US")

    chrome_binary = resolve_chrome_executable()
    if chrome_binary:
        options.binary_location = chrome_binary

    pdir = profile_dir()
    pdir.mkdir(parents=True, exist_ok=True)

    kwargs = {
        "options": options,
        "use_subprocess": True,
        "headless": bool(os.environ.get("CI")) or os.environ.get("SELENIUM_HEADLESS", "").lower() in {"1", "true", "yes"},
        "user_data_dir": str(pdir),
    }

    driver_path = resolve_driver_executable()
    if driver_path:
        kwargs["driver_executable_path"] = driver_path
    if chrome_binary:
        kwargs["browser_executable_path"] = chrome_binary

    if not chrome_binary:
        raise RuntimeError("Chrome executable not found. Install Google Chrome or set CHROME_BINARY.")

    chrome_major = detect_chrome_major_version(chrome_binary)
    if chrome_major:
        kwargs["version_main"] = chrome_major
        print(f"[CMA] Chrome major version detected: {chrome_major}", file=sys.stderr)
    else:
        print("[CMA] Could not detect Chrome major version. UC will choose automatically.", file=sys.stderr)

    try:
        driver = uc.Chrome(**kwargs)
    except Exception as e:
        msg = str(e)
        if "This version of ChromeDriver only supports Chrome version" in msg or "Current browser version is" in msg:
            raise RuntimeError(
                "ChromeDriver/Chrome version mismatch. Update Chrome, or set UC_VERSION_MAIN to your Chrome major version "
                "before running. Example: set UC_VERSION_MAIN=147. Original error: " + msg
            )
        raise
    driver.set_page_load_timeout(90)
    return driver


def bootstrap_profile():
    driver = build_driver()
    try:
        print(f"[CMA] Profile folder: {profile_dir()}")
        print("[CMA] First-time bootstrap mode.")
        print("[CMA] In the opened Chrome window, manually visit https://www.cma-cgm.com/")
        print("[CMA] Accept cookies / finish verification if it appears.")
        print("[CMA] When the normal CMA homepage is loaded, return here and press ENTER.")
        driver.get("about:blank")
        if sys.stdin and sys.stdin.isatty():
            input()
        else:
            raise RuntimeError("Bootstrap requires an interactive console.")
        close_overlays(driver)
        return {"status": "success", "message": f"CMA profile saved at {profile_dir()}"}
    finally:
        try:
            driver.quit()
        except Exception:
            pass


def open_home(driver):
    # Normal mode: reuse the dedicated CMA profile/cookies. Keep one domain/session stable.
    driver.get(CMA_URL)
    short_sleep(2.0, 4.0)
    maybe_manual_verify(driver, "open_home")
    close_overlays(driver)
    short_sleep(0.8, 1.8)


def focus_tracking_widget(driver):
    for by, sel in [
        (By.ID, "tracking"),
        (By.CSS_SELECTOR, "a[href='#tracking']"),
        (By.XPATH, "//*[normalize-space()='TRACKING']"),
        (By.XPATH, "//*[contains(normalize-space(),'Tracking')]"),
    ]:
        if maybe_click(driver, by, sel, timeout=4):
            short_sleep(0.8, 1.6)
            break


def enter_tracking(driver, tracking_number):
    inp = wait_visible(driver, (By.ID, "track-number"), timeout=30)
    inp.click()
    short_sleep(0.3, 0.9)
    try:
        inp.clear()
    except Exception:
        inp.send_keys(Keys.CONTROL, "a")
        inp.send_keys(Keys.BACKSPACE)

    # Slow enough to avoid hammering the UI; not a security bypass.
    for ch in tracking_number:
        inp.send_keys(ch)
        time.sleep(random.uniform(0.04, 0.14))
    short_sleep(0.8, 1.8)

    submitted = False
    for by, sel in [
        (By.XPATH, "//button[contains(., 'Shipment Tracking') or contains(., 'SHIPMENT TRACKING')]"),
        (By.XPATH, "//input[@type='submit' and contains(@value,'Shipment Tracking')]")
    ]:
        if maybe_click(driver, by, sel, timeout=4):
            submitted = True
            break
    if not submitted:
        inp.send_keys(Keys.ENTER)


def wait_result_page(driver):
    def is_ready(d):
        body = page_text(d)
        if looks_like_verification(d):
            return True
        if re.search(r"(no result|not found|no tracking|invalid)", body, flags=re.I):
            return True
        # Do not stop at "Tracking details" alone. CMA can render the title first,
        # then inject the result cards/ETA a moment later.
        return (
            re.search(r"eta\s*berth\s*at\s*pod", body, flags=re.I)
            or re.search(r"\b[A-Z]{4}\d{6,8}\b", body)
        )

    WebDriverWait(driver, 75).until(is_ready)
    maybe_manual_verify(driver, "after_submit")
    short_sleep(2.0, 4.0)


def normalize_cma_date(value: str) -> str:
    value = " ".join((value or "").split())
    value = re.sub(r"\b([A-Za-z]{3})\.(\d{2}-[A-Za-z]{3}-\d{4})", r"\1. \2", value)
    return value.strip()


def _line_text(driver):
    try:
        text = driver.find_element(By.TAG_NAME, "body").text or ""
    except Exception:
        text = ""
    lines = [" ".join(line.split()) for line in text.splitlines()]
    return [line for line in lines if line]


def _parse_eta_from_text(text: str) -> str:
    patterns = [
        r"ETA\s*Berth\s*at\s*POD\s*([A-Za-z]{3}\.?\s*\d{2}-[A-Za-z]{3}-\d{4}\s+\d{1,2}:\d{2}\s*[AP]M)",
        r"ETA\s*Berth\s*at\s*POD\s*([A-Za-z]{3}\.?\s*\d{2}-[A-Za-z]{3}-\d{4})(?:\s+[^A-Za-z0-9]{0,3})?\s*(\d{1,2}:\d{2}\s*[AP]M)",
    ]
    for pat in patterns:
        m = re.search(pat, text, flags=re.I)
        if m:
            if len(m.groups()) >= 2 and m.group(2):
                return normalize_cma_date(f"{m.group(1)} {m.group(2)}")
            return normalize_cma_date(m.group(1))
    return ""


def _parse_pod_from_lines(lines):
    # CMA card line usually looks like:
    # FREETOWN Wed. 18-MAR-2026 11:41 AM
    day_re = r"(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\.?,?"
    date_re = r"\d{1,2}-[A-Za-z]{3}-\d{4}"

    for line in lines:
        m = re.match(rf"^([A-Z][A-Z .,'()/-]{{2,80}}?)\s+{day_re}\s+{date_re}\b", line, flags=re.I)
        if m:
            pod = m.group(1).strip(" -•")
            if not re.search(r"tracking|booking|search|details|eta|container", pod, flags=re.I):
                return pod.upper()

    joined = " ".join(lines)
    m = re.search(rf"\b([A-Z][A-Z .,'()/-]{{2,80}}?)\s+{day_re}\s+{date_re}\s+\d{{1,2}}:\d{{2}}\s*[AP]M\s+ETA\s*Berth\s*at\s*POD", joined, flags=re.I)
    if m:
        pod = m.group(1).strip(" -•")
        pod = re.sub(r"^.*?\b(?:EMPTY IN DEPOT|GATE OUT|DISCHARGED|LOADED|SAILED|ARRIVED|DELIVERED)\b\s*", "", pod, flags=re.I)
        if len(pod.split()) > 5:
            pod = pod.split()[-1]
        return pod.upper()

    return ""


def parse_result(driver):
    lines = _line_text(driver)
    text = " ".join(lines)

    if os.environ.get("CMA_DEBUG_DUMP", "").strip() == "1":
        debug_dir = ROOT_DIR / "debug-cma"
        debug_dir.mkdir(exist_ok=True)
        ts = int(time.time())
        (debug_dir / f"cma_body_{ts}.txt").write_text("\n".join(lines), encoding="utf-8")
        (debug_dir / f"cma_page_{ts}.html").write_text(driver.page_source or "", encoding="utf-8")

    eta = _parse_eta_from_text(text)
    pod = _parse_pod_from_lines(lines)

    if not eta:
        try:
            eta_label = driver.find_element(By.XPATH, "//*[contains(translate(normalize-space(.), 'abcdefghijklmnopqrstuvwxyz', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'), 'ETA BERTH AT POD')]")
            parent_text = " ".join((eta_label.find_element(By.XPATH, "./ancestor::*[self::div or self::section][1]").text or "").split())
            eta = _parse_eta_from_text(parent_text)
        except Exception:
            pass

    if not pod:
        pod = _parse_pod_from_lines([text])

    no_result = re.search(r"(no result|not found|no tracking|invalid)", text, flags=re.I)
    return pod, eta, bool(no_result)

def run(tracking_number: str):
    driver = build_driver()
    try:
        open_home(driver)
        focus_tracking_widget(driver)
        enter_tracking(driver, tracking_number)
        wait_result_page(driver)
        pod, eta, no_result = parse_result(driver)

        if pod or eta:
            status = "success"
            error = ""
        elif no_result:
            status = "not_found"
            error = "CMA result not found"
        else:
            status = "error"
            error = "CMA result not found"

        return {
            "status": status,
            "carrier": "CMA",
            "trackingNumber": tracking_number,
            "pod": pod,
            "eta": eta,
            "error": error,
        }
    except Exception as e:
        message = str(e)
        status = "verification_required" if "VERIFICATION_REQUIRED" in message else "error"
        return {
            "status": status,
            "carrier": "CMA",
            "trackingNumber": tracking_number,
            "pod": "",
            "eta": "",
            "error": message,
        }
    finally:
        try:
            driver.quit()
        except Exception:
            pass


if __name__ == "__main__":
    if "--bootstrap" in sys.argv:
        print(json.dumps(bootstrap_profile(), ensure_ascii=False))
        raise SystemExit(0)

    tn = ""
    for arg in sys.argv[1:]:
        if not arg.startswith("--"):
            tn = arg
            break
    if not tn:
        tn = "TRHU3285204"
    print(json.dumps(run(tn), ensure_ascii=False))
