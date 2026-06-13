#!/usr/bin/env python3
"""Update an AMO listing (description, icon, screenshots) via the AMO v5 API.

Env: AMO_JWT_ISSUER, AMO_JWT_SECRET (account-level key), AMO_ADDON (slug),
     optional AMO_DIR (asset dir, default = this script's dir),
     optional AMO_SHOTS (comma-separated screenshot filenames),
     optional VERIFY_ONLY (read current state and exit).

Throttle-safe: verifies first, fails fast if writes are throttled, caps backoff,
and uploads new screenshots BEFORE deleting old ones (no empty gap). Idempotent.
"""
import base64, hashlib, hmac, json, os, re, sys, time
from secrets import token_hex
import requests

try:
    sys.stdout.reconfigure(line_buffering=True)  # live logs in CI
except Exception:
    pass

BASE = "https://addons.mozilla.org/api/v5"
ADDON = os.environ.get("AMO_ADDON", "foxpilot")
ISS = os.environ.get("AMO_JWT_ISSUER", "")
SEC = os.environ.get("AMO_JWT_SECRET", "")
HERE = os.environ.get("AMO_DIR") or os.path.dirname(os.path.abspath(__file__))
SHOTS = [s.strip() for s in os.environ.get("AMO_SHOTS", "hero.png,caps.png,flow.png").split(",") if s.strip()]
VERIFY_ONLY = bool(os.environ.get("VERIFY_ONLY"))
PACE = 10           # seconds between write calls
MAX_RETRIES = 2     # retries per call on 429
WAIT_CAP = 70       # cap each backoff sleep (never honor huge server waits)

if not ISS or not SEC:
    print("ERROR: AMO_JWT_ISSUER / AMO_JWT_SECRET not set."); sys.exit(1)
print(f"addon={ADDON} dir={HERE} shots={SHOTS} verify_only={VERIFY_ONLY}")
errors = []
addon_url = f"{BASE}/addons/addon/{ADDON}/"


def _b64(b):
    return base64.urlsafe_b64encode(b).rstrip(b"=")


def jwt_token():
    h = {"alg": "HS256", "typ": "JWT"}
    iat = int(time.time())
    p = {"iss": ISS, "jti": token_hex(16), "iat": iat, "exp": iat + 240}
    seg = _b64(json.dumps(h, separators=(",", ":")).encode()) + b"." + _b64(json.dumps(p, separators=(",", ":")).encode())
    return (seg + b"." + _b64(hmac.new(SEC.encode(), seg, hashlib.sha256).digest())).decode()


def _wait(resp):
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


def req(method, url, *, json_body=None, json_ct=False, filefields=None, data=None, label=""):
    resp = None
    for attempt in range(MAX_RETRIES + 1):
        headers = {"Authorization": "JWT " + jwt_token()}
        if json_ct:
            headers["Content-Type"] = "application/json"
        opened, files = [], None
        if filefields:
            files = {}
            for k, (fn, p, ct) in filefields.items():
                fh = open(p, "rb"); opened.append(fh); files[k] = (fn, fh, ct)
        try:
            resp = requests.request(method, url, headers=headers, json=json_body, files=files, data=data, timeout=90)
        finally:
            for fh in opened:
                fh.close()
        if resp.status_code != 429:
            return resp
        if attempt < MAX_RETRIES:
            w = min(_wait(resp), WAIT_CAP)
            print(f"  429 {label}; waiting {w}s (retry {attempt + 1}/{MAX_RETRIES})")
            time.sleep(w)
        else:
            print(f"  429 {label}; gave up after {MAX_RETRIES} retries (server ~{_wait(resp)}s)")
    return resp


def asset(p):
    return os.path.join(HERE, p)


def verify(tag):
    v = req("GET", addon_url, label="verify")
    if not v.ok:
        print(f"[{tag}] verify GET -> {v.status_code} {v.text[:200]}"); return {}
    d = v.json()
    print(f"[{tag}] desc_len={len(((d.get('description') or {}).get('en-US')) or '')} "
          f"icon={list((d.get('icons') or {}).keys())} screenshots={len(d.get('previews', []))}")
    return d


state0 = verify("initial")
if VERIFY_ONLY:
    sys.exit(0)

desc = open(asset("description.txt"), encoding="utf-8").read().strip()
r = req("PATCH", addon_url, json_body={"description": {"en-US": desc}, "default_locale": "en-US"}, json_ct=True, label="description")
print(f"[description] -> {r.status_code}")
if r.status_code == 429:
    print("WRITES THROTTLED on first call — quota likely exhausted. Re-run later."); sys.exit(2)
if r.status_code >= 400:
    errors.append("description"); print(r.text[:600])
time.sleep(PACE)

r = req("PATCH", addon_url, filefields={"icon": ("icon.png", asset("icon-512.png"), "image/png")}, label="icon")
print(f"[icon] -> {r.status_code}")
if r.status_code >= 400:
    errors.append("icon"); print(r.text[:600])
time.sleep(PACE)

# Screenshots: upload NEW first, then delete OLD (no empty gap).
old_ids = [p["id"] for p in state0.get("previews", [])]
new_ids = []
for i, fname in enumerate(SHOTS):
    r = req("POST", f"{addon_url}previews/", filefields={"image": (fname, asset(fname), "image/png")}, data={"position": i}, label=f"upload {fname}")
    print(f"[screenshot {i}] {fname} -> {r.status_code}")
    if r.ok:
        new_ids.append(r.json().get("id"))
    else:
        errors.append(fname); print(r.text[:400])
    time.sleep(PACE)

if new_ids:
    for pid in old_ids:
        dr = req("DELETE", f"{addon_url}previews/{pid}/", label=f"delete {pid}")
        print(f"  delete old {pid} -> {dr.status_code}")
        time.sleep(PACE)
else:
    print(f"no new screenshots uploaded; keeping existing {old_ids}")

verify("final")
if errors:
    print("INCOMPLETE steps:", errors); sys.exit(1)
print("AMO listing update complete.")
