#!/usr/bin/env python3
"""Update the FoxPilot AMO listing (description, icon, screenshots) via the AMO v5 API.

Auth uses the same AMO_JWT_ISSUER / AMO_JWT_SECRET secrets as the release pipeline.
Idempotent: existing screenshots are deleted and re-uploaded, so re-running is safe.
Handles AMO's write throttling (HTTP 429) with backoff. Runs in GitHub Actions.
"""
import base64, hashlib, hmac, json, os, re, sys, time
from secrets import token_hex
import requests

BASE = "https://addons.mozilla.org/api/v5"
ADDON = os.environ.get("AMO_ADDON", "foxpilot")
ISS = os.environ.get("AMO_JWT_ISSUER", "")
SEC = os.environ.get("AMO_JWT_SECRET", "")
HERE = os.path.dirname(os.path.abspath(__file__))
PACE = 4  # seconds between write calls, to stay under the throttle

if not ISS or not SEC:
    print("ERROR: AMO_JWT_ISSUER / AMO_JWT_SECRET not set in the environment.")
    sys.exit(1)
print(f"issuer present: {bool(ISS)}  secret present: {bool(SEC)}  addon: {ADDON}")

errors = []


def _b64(b: bytes) -> bytes:
    return base64.urlsafe_b64encode(b).rstrip(b"=")


def jwt_token() -> str:
    """Mint a fresh short-lived HS256 JWT (exp <= 5 min, unique jti) per AMO docs."""
    header = {"alg": "HS256", "typ": "JWT"}
    iat = int(time.time())
    payload = {"iss": ISS, "jti": token_hex(16), "iat": iat, "exp": iat + 240}
    seg = _b64(json.dumps(header, separators=(",", ":")).encode()) + b"." + \
        _b64(json.dumps(payload, separators=(",", ":")).encode())
    sig = hmac.new(SEC.encode(), seg, hashlib.sha256).digest()
    return (seg + b"." + _b64(sig)).decode()


def _wait_seconds(resp) -> int:
    ra = resp.headers.get("Retry-After")
    if ra and str(ra).isdigit():
        return int(ra)
    try:
        m = re.search(r"in (\d+) seconds", resp.json().get("detail", ""))
        if m:
            return int(m.group(1))
    except Exception:
        pass
    return 60


def req(method, url, *, json_body=None, json_ct=False, filefields=None, data=None):
    """Request with a fresh JWT each attempt; retry on 429 honoring the throttle.

    filefields: {field: (filename, abspath, content_type)} — reopened per attempt.
    """
    resp = None
    for attempt in range(8):
        headers = {"Authorization": "JWT " + jwt_token()}
        if json_ct:
            headers["Content-Type"] = "application/json"
        opened, files = [], None
        if filefields:
            files = {}
            for k, (fn, p, ct) in filefields.items():
                fh = open(p, "rb")
                opened.append(fh)
                files[k] = (fn, fh, ct)
        try:
            resp = requests.request(method, url, headers=headers, json=json_body,
                                    files=files, data=data, timeout=120)
        finally:
            for fh in opened:
                fh.close()
        if resp.status_code != 429:
            return resp
        wait = _wait_seconds(resp) + 5
        print(f"  429 throttled; sleeping {wait}s (attempt {attempt + 1})")
        time.sleep(wait)
    return resp


def path(p):
    return os.path.join(HERE, p)


addon_url = f"{BASE}/addons/addon/{ADDON}/"

# 1) Long description (JSON, localized; AMO renders Markdown) ------------------
desc = open(path("description.txt"), encoding="utf-8").read().strip()
r = req("PATCH", addon_url, json_body={"description": {"en-US": desc}, "default_locale": "en-US"}, json_ct=True)
print(f"[description] PATCH -> {r.status_code}")
if r.status_code >= 400:
    errors.append("description"); print(r.text[:1000])
time.sleep(PACE)

# 2) Add-on icon (multipart; square PNG, AMO resizes to 32/64/128) ------------
r = req("PATCH", addon_url, filefields={"icon": ("icon.png", path("icon-512.png"), "image/png")})
print(f"[icon] PATCH -> {r.status_code}")
if r.status_code >= 400:
    errors.append("icon"); print(r.text[:1000])
time.sleep(PACE)

# 3) Screenshots: delete existing, then upload in order (idempotent) ----------
det = req("GET", addon_url)
existing = det.json().get("previews", []) if det.ok else []
print(f"[previews] existing: {len(existing)}")
for p in existing:
    dr = req("DELETE", f"{addon_url}previews/{p['id']}/")
    print(f"  delete {p['id']} -> {dr.status_code}")
    time.sleep(PACE)

shots = ["hero.png", "caps.png", "flow.png"]
for i, fname in enumerate(shots):
    r = req("POST", f"{addon_url}previews/",
            filefields={"image": (fname, path(fname), "image/png")}, data={"position": i})
    print(f"[screenshot {i}] {fname} POST -> {r.status_code}")
    if r.status_code >= 400:
        errors.append(fname); print(r.text[:1000])
    time.sleep(PACE)

# 4) Verify -------------------------------------------------------------------
v = req("GET", addon_url)
if v.ok:
    d = v.json()
    icons = d.get("icons") or {}
    print("--- RESULT ---")
    print("description length:", len(((d.get("description") or {}).get("en-US") or "")))
    print("icon sizes:", list(icons.keys()))
    print("screenshots:", len(d.get("previews", [])))

if errors:
    print("FAILED steps:", errors)
    sys.exit(1)
print("AMO listing update complete.")
