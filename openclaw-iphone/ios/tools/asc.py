#!/usr/bin/env python3
"""Tiny App Store Connect API client (stdlib + requests + openssl) for My Claw.

Env:
  ASC_KEY_ID      e.g. F83792G38S
  ASC_ISSUER_ID   the UUID from Users and Access → Integrations → App Store Connect API
  ASC_KEY_PATH    defaults to ~/.private_keys/AuthKey_<KEY_ID>.p8

Usage:
  asc.py whoami                       # list apps visible to the key (auth check)
  asc.py get  /v1/apps?filter[bundleId]=com.8examples.openclaw
  asc.py post /v1/... '{"data": {...}}'
  asc.py patch /v1/... '{"data": {...}}'
  asc.py delete /v1/...
  asc.py upload-file <url> <path> <content-type>   # raw PUT for asset upload operations
"""
import base64
import json
import os
import subprocess
import sys
import tempfile
import time

import requests

API = "https://api.appstoreconnect.apple.com"


def b64url(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def der_to_raw(sig: bytes) -> bytes:
    """DER ECDSA signature → raw r||s (32 bytes each), as JWS ES256 wants."""
    assert sig[0] == 0x30
    i = 2
    assert sig[i] == 0x02
    rl = sig[i + 1]
    r = sig[i + 2 : i + 2 + rl]
    i = i + 2 + rl
    assert sig[i] == 0x02
    sl = sig[i + 1]
    s = sig[i + 2 : i + 2 + sl]
    return r[-32:].rjust(32, b"\0") + s[-32:].rjust(32, b"\0")


_token_cache = {"exp": 0, "jwt": ""}


def token() -> str:
    if _token_cache["exp"] - 60 > time.time():
        return _token_cache["jwt"]
    key_id = os.environ["ASC_KEY_ID"]
    issuer = os.environ["ASC_ISSUER_ID"]
    key_path = os.environ.get("ASC_KEY_PATH") or os.path.expanduser(f"~/.private_keys/AuthKey_{key_id}.p8")
    now = int(time.time())
    header = {"alg": "ES256", "kid": key_id, "typ": "JWT"}
    payload = {"iss": issuer, "iat": now, "exp": now + 15 * 60, "aud": "appstoreconnect-v1"}
    signing = b64url(json.dumps(header, separators=(",", ":")).encode()) + "." + b64url(json.dumps(payload, separators=(",", ":")).encode())
    with tempfile.NamedTemporaryFile() as f:
        f.write(signing.encode())
        f.flush()
        der = subprocess.check_output(["openssl", "dgst", "-sha256", "-sign", key_path, f.name])
    jwt = signing + "." + b64url(der_to_raw(der))
    _token_cache.update(exp=now + 15 * 60, jwt=jwt)
    return jwt


def call(method: str, path: str, body=None, params=None):
    url = path if path.startswith("http") else API + path
    r = requests.request(method, url, params=params, json=body,
                         headers={"Authorization": f"Bearer {token()}", "Content-Type": "application/json"}, timeout=60)
    if r.status_code >= 400:
        raise SystemExit(f"{method} {path} → {r.status_code}\n{r.text[:2000]}")
    return r.json() if r.text.strip() else {}


def get(path, **params):
    return call("GET", path, params=params or None)


def post(path, body):
    return call("POST", path, body)


def patch(path, body):
    return call("PATCH", path, body)


def delete(path):
    return call("DELETE", path)


def get_all(path, **params):
    """Follow `links.next` pagination."""
    out = []
    data = get(path, **params)
    out.extend(data.get("data", []))
    while data.get("links", {}).get("next"):
        data = call("GET", data["links"]["next"])
        out.extend(data.get("data", []))
    return out


def upload_file(url: str, path: str, content_type: str, headers=None):
    with open(path, "rb") as f:
        r = requests.put(url, data=f.read(), headers={"Content-Type": content_type, **(headers or {})}, timeout=300)
    if r.status_code >= 400:
        raise SystemExit(f"PUT {url} → {r.status_code}\n{r.text[:500]}")


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "whoami"
    if cmd == "whoami":
        for app in get_all("/v1/apps", **{"fields[apps]": "name,bundleId,sku,primaryLocale"}):
            a = app["attributes"]
            print(app["id"], a["bundleId"], "—", a["name"])
    elif cmd in ("get", "delete"):
        print(json.dumps(call(cmd.upper(), sys.argv[2]), indent=2))
    elif cmd in ("post", "patch"):
        print(json.dumps(call(cmd.upper(), sys.argv[2], json.loads(sys.argv[3])), indent=2))
    elif cmd == "upload-file":
        upload_file(sys.argv[2], sys.argv[3], sys.argv[4])
    else:
        raise SystemExit(__doc__)
