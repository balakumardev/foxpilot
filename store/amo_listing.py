#!/usr/bin/env python3
"""Update the FoxPilot AMO listing (description, icon, screenshots) via the AMO v5 API.

Auth uses the same AMO_JWT_ISSUER / AMO_JWT_SECRET secrets as the release pipeline.
Idempotent: existing screenshots are deleted and re-uploaded, so re-running is safe.
Intended to run in GitHub Actions (secrets injected as env vars).
"""
import base64, hashlib, hmac, json, os, sys, time
from secrets import token_hex
import requests

BASE = "https://addons.mozilla.org/api/v5"
ADDON = os.environ.get("AMO_ADDON", "foxpilot")
ISS = os.environ.get("AMO_JWT_ISSUER", "")
SEC = os.environ.get("AMO_JWT_SECRET", "")
HERE = os.path.dirname(os.path.abspath(__file__))

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


def auth() -> dict:
    return {"Authorization": "JWT " + jwt_token()}


def path(p: str) -> str:
    return os.path.join(HERE, p)


# 1) Long description (JSON, localized; AMO renders Markdown) ------------------
desc = open(path("description.txt"), encoding="utf-8").read().strip()
r = requests.patch(
    f"{BASE}/addons/addon/{ADDON}/",
    headers={**auth(), "Content-Type": "application/json"},
    json={"description": {"en-US": desc}, "default_locale": "en-US"},
    timeout=60,
)
print(f"[description] PATCH -> {r.status_code}")
if r.status_code >= 400:
    errors.append("description")
    print(r.text[:1200])

# 2) Add-on icon (multipart; square PNG, AMO resizes to 32/64/128) ------------
with open(path("icon-512.png"), "rb") as f:
    r = requests.patch(
        f"{BASE}/addons/addon/{ADDON}/",
        headers=auth(),
        files={"icon": ("icon.png", f, "image/png")},
        timeout=120,
    )
print(f"[icon] PATCH -> {r.status_code}")
if r.status_code >= 400:
    errors.append("icon")
    print(r.text[:1200])

# 3) Screenshots: delete existing, then upload in order (idempotent) ----------
det = requests.get(f"{BASE}/addons/addon/{ADDON}/", headers=auth(), timeout=60)
existing = det.json().get("previews", []) if det.ok else []
print(f"[previews] existing: {len(existing)}")
for p in existing:
    dr = requests.delete(
        f"{BASE}/addons/addon/{ADDON}/previews/{p['id']}/", headers=auth(), timeout=60
    )
    print(f"  delete {p['id']} -> {dr.status_code}")

shots = [
    ("hero.png", "Drive Firefox from your AI assistant"),
    ("caps.png", "29 tools to automate Firefox — Automation Mode is opt-in"),
    ("flow.png", "How it works — runs locally, private by design"),
]
for i, (fname, caption) in enumerate(shots):
    with open(path(fname), "rb") as f:
        r = requests.post(
            f"{BASE}/addons/addon/{ADDON}/previews/",
            headers=auth(),
            files={"image": (fname, f, "image/png")},
            data={"position": i},
            timeout=120,
        )
    print(f"[screenshot {i}] {fname} POST -> {r.status_code}")
    if r.status_code >= 400:
        errors.append(fname)
        print(r.text[:1200])
        continue
    pid = r.json().get("id")
    cr = requests.patch(
        f"{BASE}/addons/addon/{ADDON}/previews/{pid}/",
        headers={**auth(), "Content-Type": "application/json"},
        json={"caption": {"en-US": caption}, "position": i},
        timeout=60,
    )
    print(f"  caption/position {pid} -> {cr.status_code}")

# 4) Verify -------------------------------------------------------------------
v = requests.get(f"{BASE}/addons/addon/{ADDON}/", headers=auth(), timeout=60)
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
