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

RCL_URL = os.environ.get("RCL_TRACKING_URL", "https://eservice.rclgroup.com/CargoTracking/")
ROOT_DIR = Path.cwd()
DEFAULT_PROFILE_DIR = ROOT_DIR / ".rcl_chrome_profile"


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
    env = os.environ.get("RCL_UC_DRIVER") or os.environ.get("UC_DRIVER") or os.environ.get("CHROMEDRIVER") or os.environ.get("DRIVER_EXECUTABLE_PATH")
    if env and Path(env).exists():
        return env
    return None


def detect_chrome_major_version(chrome_binary=None):
    forced = os.environ.get("RCL_UC_VERSION_MAIN") or os.environ.get("UC_VERSION_MAIN") or os.environ.get("CHROME_VERSION_MAIN")
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
    return Path(os.environ.get("RCL_PROFILE_DIR", str(DEFAULT_PROFILE_DIR))).resolve()


def short_sleep(min_s=0.6, max_s=1.8):
    time.sleep(random.uniform(min_s, max_s))


def page_text(driver):
    try:
        return "\n".join(driver.find_element(By.TAG_NAME, "body").text.splitlines())
    except Exception:
        return ""


def compact_text(driver):
    return " ".join(page_text(driver).split())


def wait_visible(driver, locator, timeout=30):
    return WebDriverWait(driver, timeout).until(EC.visibility_of_element_located(locator))


def maybe_click(driver, by, selector, timeout=3):
    try:
        el = WebDriverWait(driver, timeout).until(EC.element_to_be_clickable((by, selector)))
        driver.execute_script("arguments[0].click();", el)
        return True
    except Exception:
        return False


def rcl_input_ready(driver):
    selectors = [
        (By.ID, "statusBkgNo"),
        (By.CSS_SELECTOR, "input#statusBkgNo"),
        (By.CSS_SELECTOR, "input[placeholder*='BL']"),
        (By.CSS_SELECTOR, "input[placeholder*='BKG']"),
        (By.CSS_SELECTOR, "input[placeholder*='CNTR']"),
    ]
    for by, sel in selectors:
        try:
            el = driver.find_element(by, sel)
            if el.is_displayed():
                return True
        except Exception:
            pass
    return False


def looks_like_verification(driver):
    # Important: RCL can leave a Cloudflare success badge visible even after the real search input appears.
    # If #statusBkgNo is visible, treat the page as ready instead of blocked.
    if rcl_input_ready(driver):
        return False

    text = compact_text(driver).lower()
    markers = [
        "xác minh bạn là con người",
        "verify you are human",
        "verify that you are human",
        "checking if the site connection is secure",
        "checking your browser",
        "cloudflare",
        "turnstile",
        "captcha",
    ]
    if any(m in text for m in markers):
        return True
    try:
        frames = driver.find_elements(By.CSS_SELECTOR, "iframe[src*='turnstile'], iframe[src*='challenge'], iframe[src*='captcha'], iframe[title*='captcha']")
        if frames:
            return True
    except Exception:
        pass
    return False


def dump_debug(driver, reason):
    if os.environ.get("RCL_DEBUG_DUMP", "").strip() != "1":
        return
    try:
        debug_dir = ROOT_DIR / "debug-rcl"
        debug_dir.mkdir(exist_ok=True)
        ts = int(time.time())
        base = debug_dir / f"rcl_{reason}_{ts}"
        (base.with_suffix(".txt")).write_text(page_text(driver), encoding="utf-8")
        (base.with_suffix(".html")).write_text(driver.page_source or "", encoding="utf-8")
        try:
            driver.save_screenshot(str(base.with_suffix(".png")))
        except Exception:
            pass
        print(f"[RCL] Debug dump saved: {base}.*", file=sys.stderr)
    except Exception as e:
        print(f"[RCL] Debug dump failed: {e}", file=sys.stderr)


def wait_for_rcl_input(driver, stage="open"):
    timeout_ms = int(os.environ.get("RCL_VERIFY_WAIT_MS", "180000"))
    end = time.time() + (timeout_ms / 1000)
    last_logged = 0

    while time.time() < end:
        if rcl_input_ready(driver):
            print(f"[RCL] Search input ready at {stage}.", file=sys.stderr)
            return True
        if looks_like_verification(driver) and time.time() - last_logged > 10:
            print("[RCL] Verification/Cloudflare page detected. Waiting for #statusBkgNo to appear...", file=sys.stderr)
            last_logged = time.time()
        time.sleep(1)

    dump_debug(driver, f"input_timeout_{stage}")
    raise RuntimeError("NEED_MANUAL_VERIFY_RCL: RCL input did not appear after verification wait")


def close_overlays(driver):
    for by, sel in [
        (By.XPATH, "//button[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'accept') or contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'agree')]"),
        (By.CSS_SELECTOR, "button[aria-label='Close']"),
        (By.CSS_SELECTOR, "button.close"),
        (By.CSS_SELECTOR, ".modal button.close"),
    ]:
        if maybe_click(driver, by, sel, timeout=1):
            short_sleep(0.3, 0.7)
    try:
        driver.find_element(By.TAG_NAME, "body").send_keys(Keys.ESCAPE)
    except Exception:
        pass


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
        print(f"[RCL] Chrome major version detected: {chrome_major}", file=sys.stderr)
    else:
        print("[RCL] Could not detect Chrome major version. UC will choose automatically.", file=sys.stderr)

    try:
        driver = uc.Chrome(**kwargs)
    except Exception as e:
        msg = str(e)
        if "This version of ChromeDriver only supports Chrome version" in msg or "Current browser version is" in msg:
            raise RuntimeError(
                "ChromeDriver/Chrome version mismatch. Update Chrome, or set UC_VERSION_MAIN to your Chrome major version. "
                "Example: set UC_VERSION_MAIN=147. Original error: " + msg
            )
        raise
    driver.set_page_load_timeout(int(os.environ.get("RCL_PAGELOAD_TIMEOUT", "90")))
    return driver


def open_home(driver):
    print(f"[RCL] Opening {RCL_URL}", file=sys.stderr)
    driver.get(RCL_URL)
    short_sleep(2.0, 4.0)
    wait_for_rcl_input(driver, "open_home")
    close_overlays(driver)
    short_sleep(0.5, 1.2)


def enter_tracking(driver, tracking_number):
    inp = wait_visible(driver, (By.ID, "statusBkgNo"), timeout=30)
    inp.click()
    short_sleep(0.2, 0.7)
    try:
        inp.clear()
    except Exception:
        inp.send_keys(Keys.CONTROL, "a")
        inp.send_keys(Keys.BACKSPACE)

    for ch in tracking_number:
        inp.send_keys(ch)
        time.sleep(random.uniform(0.035, 0.11))
    short_sleep(0.5, 1.2)

    clicked = False
    for by, sel in [
        (By.ID, "submitBlNo"),
        (By.CSS_SELECTOR, "button#submitBlNo"),
        (By.CSS_SELECTOR, "button[onclick*='fillCargoTrackingList']"),
        (By.XPATH, "//button[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'search')]"),
    ]:
        if maybe_click(driver, by, sel, timeout=4):
            clicked = True
            break
    if not clicked:
        inp.send_keys(Keys.ENTER)


def wait_result_page(driver, tracking_number):
    def ready(d):
        if rcl_input_ready(d) and not compact_text(d).strip():
            return False
        if looks_like_verification(d):
            return True
        text = compact_text(d)
        return (
            tracking_number.upper() in text.upper()
            or re.search(r"\b(POD|ETA|POL|ETD)\s*:?", text, re.I)
            or re.search(r"(no result|not found|no data|no information|no bl number|invalid)", text, re.I)
        )

    WebDriverWait(driver, int(os.environ.get("RCL_RESULT_TIMEOUT", "90"))).until(ready)
    if looks_like_verification(driver):
        wait_for_rcl_input(driver, "after_search")
    short_sleep(2.0, 4.0)


def _lines(driver):
    text = page_text(driver)
    return [" ".join(line.split()) for line in text.splitlines() if " ".join(line.split())]


def clean(value):
    return re.sub(r"\s+", " ", str(value or "").replace("\u00a0", " ")).strip()


def cleanup_pod(value):
    v = clean(value)
    v = re.sub(r"^(POD|ETA|ETD|POL)\s*:?\s*", "", v, flags=re.I)
    v = re.sub(r"\s+(ETA|ETD|POL|No BL Number|Container Number|All cargo|Sorry).*$", "", v, flags=re.I)
    return clean(v).upper()


def cleanup_eta(value):
    v = clean(value)
    v = re.sub(r"^(ETA|POD|ETD|POL)\s*:?\s*", "", v, flags=re.I)
    v = re.sub(r"\s+(No BL Number|Container Number|All cargo|Sorry).*$", "", v, flags=re.I)
    return clean(v)


def get_label_value_from_lines(lines, label):
    pat = re.compile(rf"^{re.escape(label)}\s*:?\s*(.*)$", re.I)
    for i, line in enumerate(lines):
        m = pat.search(line)
        if not m:
            continue
        inline = clean(m.group(1))
        if inline:
            return inline
        for j in range(i + 1, min(len(lines), i + 4)):
            if re.match(r"^(POL|POD|ETD|ETA)\s*:?$", lines[j], flags=re.I):
                continue
            return lines[j]
    return ""


def parse_result_text(text, tracking_number):
    lines = [clean(x) for x in text.splitlines() if clean(x)]
    raw = clean(text)

    pod = get_label_value_from_lines(lines, "POD")
    eta = get_label_value_from_lines(lines, "ETA")

    if not pod:
        m = re.search(r"\bPOD\s*:??\s*([A-Z][A-Z .,'/-]{2,}?)(?=\s+ETA\b|\s+No BL\b|\s+Container\b|\s+All cargo\b|$)", raw, flags=re.I)
        if m:
            pod = m.group(1)
    if not eta:
        m = re.search(r"\bETA\s*:??\s*([A-Za-z]{3,9}\.?\s*\d{1,2}[\-/\s][A-Za-z]{3,9}[\-/\s]\d{2,4}(?:\s+\d{1,2}:\d{2}(?:\s*[AP]M)?)?|\d{1,2}[\-/]\d{1,2}[\-/]\d{2,4}(?:\s+\d{1,2}:\d{2})?)", raw, flags=re.I)
        if m:
            eta = m.group(1)

    return cleanup_pod(pod), cleanup_eta(eta)



def parse_result_dom_direct(driver):
    """Read RCL result fields from stable DOM ids: label#pod and label#eta."""
    try:
        data = driver.execute_script(r"""
            const clean = v => String(v || '').replace(/\s+/g, ' ').trim();
            const pick = selectors => {
              for (const sel of selectors) {
                const el = document.querySelector(sel);
                const txt = clean(el && (el.value || el.textContent));
                if (txt) return txt;
              }
              return '';
            };
            return {
              pod: pick(['label#pod', '#pod', '[id="pod"]']),
              eta: pick(['label#eta', '#eta', '[id="eta"]'])
            };
        """)
        return cleanup_pod((data or {}).get("pod", "")), cleanup_eta((data or {}).get("eta", ""))
    except Exception:
        return "", ""


def parse_result(driver, tracking_number):
    lines = _lines(driver)
    text = "\n".join(lines)

    if os.environ.get("RCL_DEBUG_DUMP", "").strip() == "1":
        dump_debug(driver, "result")

    # RCL current layout exposes direct IDs for the needed fields.
    pod, eta = parse_result_dom_direct(driver)

    # Text fallback for older layout / selector changes.
    if not pod or not eta:
        text_pod, text_eta = parse_result_text(text, tracking_number)
        if not pod:
            pod = text_pod
        if not eta:
            eta = text_eta

    # Generic DOM fallback: read elements around labels.
    if not pod or not eta:
        try:
            data = driver.execute_script(r"""
                const clean = v => String(v || '').replace(/\s+/g, ' ').trim();
                const result = {pod: '', eta: ''};
                const els = Array.from(document.querySelectorAll('body *'));
                function nextUseful(el) {
                  const own = clean(el.textContent);
                  const inline = own.replace(/^(POD|ETA)\s*:?\s*/i, '').trim();
                  if (inline && inline !== own) return inline;
                  let cur = el;
                  for (let depth = 0; depth < 4 && cur; depth++) {
                    let sib = cur.nextElementSibling;
                    while (sib) {
                      const txt = clean(sib.textContent || sib.value);
                      if (txt && !/^(POL|POD|ETD|ETA)\s*:?$/i.test(txt)) return txt;
                      sib = sib.nextElementSibling;
                    }
                    cur = cur.parentElement;
                  }
                  return '';
                }
                for (const el of els) {
                  const txt = clean(el.textContent);
                  if (!result.pod && /^POD\s*:?/i.test(txt)) result.pod = nextUseful(el);
                  if (!result.eta && /^ETA\s*:?/i.test(txt)) result.eta = nextUseful(el);
                }
                return result;
            """)
            if not pod:
                pod = cleanup_pod((data or {}).get("pod", ""))
            if not eta:
                eta = cleanup_eta((data or {}).get("eta", ""))
        except Exception:
            pass

    no_result = bool(re.search(r"(no result|not found|no data|no information|no bl number|invalid)", text, flags=re.I))
    return pod, eta, no_result


def run(tracking_number: str):
    driver = build_driver()
    try:
        open_home(driver)
        enter_tracking(driver, tracking_number)
        wait_result_page(driver, tracking_number)
        pod, eta, no_result = parse_result(driver, tracking_number)

        if pod or eta:
            status = "success"
            error = ""
        elif no_result:
            status = "not_found"
            error = "RCL result not found"
        else:
            status = "error"
            error = "RCL result loaded but POD/ETA could not be extracted"
            dump_debug(driver, "parse_failed")

        return {
            "status": status,
            "carrier": "RCL",
            "trackingNumber": tracking_number,
            "pod": pod,
            "eta": eta,
            "error": error,
        }
    except Exception as e:
        message = str(e)
        status = "verification_required" if "NEED_MANUAL_VERIFY_RCL" in message else "error"
        return {
            "status": status,
            "carrier": "RCL",
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
    tn = ""
    for arg in sys.argv[1:]:
        if not arg.startswith("--"):
            tn = arg
            break
    if not tn:
        tn = "RCLU1234567"
    print(json.dumps(run(tn), ensure_ascii=False))
