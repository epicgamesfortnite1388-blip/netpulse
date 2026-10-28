#!/usr/bin/env python3
"""NetPulse VPN host reconciler — makes entitlement loss actually close the tunnel.

Runs on the VPN host (206.1.96.89) from a systemd timer. It pulls the set of
identities the cloud Worker says may authenticate right now, then rewrites the
Xray inbounds and the Hysteria auth block to contain EXACTLY that set.

Before this existed, every client authenticated with one shared UUID/password,
so the cloud could only refuse to hand out a new config: a config already on a
laptop kept working after the subscription expired, was refunded, or was
revoked. Now expiry and revocation delete the identity from the server config on
the next pass (at most one minute later), and the next handshake is refused.

Failure policy — deliberately asymmetric:

* A failed pull (Worker down, DNS, 502) keeps the last known-good set. Wiping
  the configs on a network blip would be a self-inflicted outage, and the set
  already carries a hard `expiresAt` per identity, so access still ends on time
  without the Worker.
* A malformed / half-understood payload is a hard error: nothing is applied and
  the previous configs stay. The reconciler never writes a config it does not
  fully understand.
* An empty, well-formed set IS applied (deny all). That is a legitimate state:
  nobody holds an unexpired entitlement right now.

Usage:
  reconcile.py            apply (default)
  reconcile.py --print    show what would be applied, touch nothing
"""

from __future__ import annotations

import json
import os
import re
import secrets
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

SYNC_DIR = os.environ.get("NETPULSE_SYNC_DIR", "/opt/netpulse-sync")
XRAY_CONFIG = os.environ.get("NETPULSE_XRAY_CONFIG", "/opt/netpulse-xray/config.json")
XRAY_BIN = os.environ.get("NETPULSE_XRAY_BIN", "/usr/local/x-ui/bin/xray-linux-amd64")
XRAY_UNIT = os.environ.get("NETPULSE_XRAY_UNIT", "netpulse-xray")
HY_CONFIG = os.environ.get("NETPULSE_HYSTERIA_CONFIG", "/opt/netpulse-hysteria/config.yaml")
HYSTERIA_BIN = os.environ.get("NETPULSE_HYSTERIA_BIN", "/opt/netpulse-hysteria/hysteria")
HYSTERIA_UNIT = os.environ.get("NETPULSE_HYSTERIA_UNIT", "netpulse-hysteria")
DEFAULT_SYNC_URL = "https://netpulse-cloud.shuridehradin.workers.dev/api/v1/internal/vpn-users"

STATE_FILE = os.path.join(SYNC_DIR, "state.json")
SECRET_FILE = os.path.join(SYNC_DIR, "vps-sync.secret")
LAST_RUN_FILE = os.path.join(SYNC_DIR, "last-run.json")
LOG_FILE = os.path.join(SYNC_DIR, "reconcile.log")

# Protocol -> Xray inbound tag that holds its client list.
XRAY_INBOUNDS = {
    "xray-vless-reality": "vless-reality",
    "xray-vmess-ws": "vmess-ws",
    "xray-vless-ws-tls": "vless-ws-tls",
    "xray-trojan-tls": "trojan-tls",
}
HYSTERIA_PROTOCOL = "hysteria2"

USERNAME_RE = re.compile(r"^[A-Za-z0-9_.:-]{1,64}$")


def log(msg: str) -> None:
    line = f"{time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())} {msg}"
    print(line, flush=True)
    try:
        os.makedirs(SYNC_DIR, exist_ok=True)
        with open(LOG_FILE, "a", encoding="utf-8") as fh:
            fh.write(line + "\n")
    except OSError:
        # Logging must never be the reason a revocation fails.
        pass


def read_secret() -> str:
    try:
        with open(SECRET_FILE, encoding="utf-8") as fh:
            value = fh.read().strip()
    except FileNotFoundError:
        raise SystemExit(f"missing sync secret at {SECRET_FILE}")
    if not value:
        raise SystemExit(f"empty sync secret at {SECRET_FILE}")
    return value


def load_state() -> dict:
    try:
        with open(STATE_FILE, encoding="utf-8") as fh:
            data = json.load(fh)
        return data if isinstance(data, dict) else {}
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def write_atomic(path: str, content: str, mode: int = 0o600) -> None:
    directory = os.path.dirname(path)
    fd, tmp = tempfile.mkstemp(dir=directory, prefix=".np-reconcile-")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(content)
            fh.flush()
            os.fsync(fh.fileno())
        os.chmod(tmp, mode)
        os.replace(tmp, path)
    except BaseException:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise


def fetch_users(url: str, token: str) -> list[dict] | None:
    """Fresh identity set, or None when the pull itself failed."""
    # Cloudflare's edge answers 403 to the stdlib default `Python-urllib/x.y`
    # user agent (verified live), so identify the host explicitly.
    req = urllib.request.Request(
        url,
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/json",
            "User-Agent": "netpulse-vpn-host/1 (reconciler)",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as res:
            if res.status != 200:
                log(f"pull failed: HTTP {res.status}")
                return None
            payload = json.loads(res.read().decode("utf-8"))
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, OSError) as err:
        log(f"pull failed: {err}")
        return None

    if not isinstance(payload, dict) or payload.get("ok") is not True or not isinstance(payload.get("users"), list):
        log("pull failed: payload is not the expected {ok, users} shape")
        return None

    users: list[dict] = []
    for entry in payload["users"]:
        if not isinstance(entry, dict):
            log("pull rejected: user entry is not an object")
            return None
        uid, protocol = entry.get("id"), entry.get("protocol")
        username, secret = entry.get("username"), entry.get("secret")
        expires = entry.get("expiresAt")
        if not isinstance(uid, str) or not uid:
            log("pull rejected: user entry without id")
            return None
        if protocol not in XRAY_INBOUNDS and protocol != HYSTERIA_PROTOCOL:
            log(f"pull rejected: unknown protocol {protocol!r}")
            return None
        if not isinstance(username, str) or not USERNAME_RE.match(username):
            log(f"pull rejected: bad username for {protocol}")
            return None
        if not isinstance(secret, str) or not secret or len(secret) > 128 or any(c in secret for c in '"\n\r'):
            log(f"pull rejected: bad secret for {protocol}")
            return None
        if expires is not None and not isinstance(expires, int):
            log(f"pull rejected: bad expiresAt for {protocol}")
            return None
        users.append({"id": uid, "protocol": protocol, "username": username, "secret": secret, "expiresAt": expires})

    return users


def prune_expired(users: list[dict], now_ms: int) -> tuple[list[dict], int]:
    kept = [u for u in users if u.get("expiresAt") is None or u["expiresAt"] > now_ms]
    return kept, len(users) - len(kept)


def xray_client(protocol: str, username: str, secret: str) -> dict:
    if protocol == "xray-vless-reality":
        # The published client profile uses flow=xtls-rprx-vision; the server
        # entry must agree or the handshake is rejected.
        return {"id": secret, "flow": "xtls-rprx-vision", "email": username}
    if protocol == "xray-vmess-ws":
        return {"id": secret, "alterId": 0, "email": username}
    if protocol == "xray-vless-ws-tls":
        return {"id": secret, "email": username}
    return {"password": secret, "email": username}


def build_xray_config(users: list[dict]) -> dict:
    with open(XRAY_CONFIG, encoding="utf-8") as fh:
        config = json.load(fh)

    by_tag: dict[str, list[dict]] = {tag: [] for tag in XRAY_INBOUNDS.values()}
    for user in users:
        tag = XRAY_INBOUNDS.get(user["protocol"])
        if tag:
            by_tag[tag].append(xray_client(user["protocol"], user["username"], user["secret"]))

    seen_tags = set()
    for inbound in config.get("inbounds", []):
        tag = inbound.get("tag")
        if tag in by_tag:
            seen_tags.add(tag)
            inbound.setdefault("settings", {})["clients"] = sorted(
                by_tag[tag], key=lambda c: c.get("email") or ""
            )
    missing = set(by_tag) - seen_tags
    if missing:
        raise SystemExit(f"xray inbound(s) not found in {XRAY_CONFIG}: {', '.join(sorted(missing))}")
    return config


def build_hysteria_config(users: list[dict]) -> dict:
    import yaml  # pinned on the host (python3-yaml)

    with open(HY_CONFIG, encoding="utf-8") as fh:
        config = yaml.safe_load(fh) or {}

    accounts = {
        u["username"]: u["secret"] for u in sorted(users, key=lambda x: x["username"]) if u["protocol"] == HYSTERIA_PROTOCOL
    }
    if accounts:
        config["auth"] = {"type": "userpass", "userpass": accounts}
    else:
        # Hysteria rejects an empty userpass map, and a config that fails to
        # load leaves the previous (open) server running. A password nobody
        # knows keeps the service valid and authenticates no one. It must be
        # the SAME unknown password on every pass: minting a new one each run
        # would rewrite the file and restart the unit every minute, dropping
        # live sessions for no reason.
        current = config.get("auth") if isinstance(config.get("auth"), dict) else {}
        kept = current.get("password") if current.get("type") == "password" else None
        config["auth"] = {"type": "password", "password": kept or secrets.token_hex(32)}
    return config


def xray_config_is_valid(config_text: str) -> bool:
    with tempfile.NamedTemporaryFile("w", suffix=".json", dir=SYNC_DIR, delete=False) as tmp:
        tmp.write(config_text)
        path = tmp.name
    try:
        proc = subprocess.run([XRAY_BIN, "-test", "-c", path], capture_output=True, text=True, timeout=30)
        if proc.returncode != 0:
            log(f"xray rejected the generated config: {(proc.stdout + proc.stderr).strip()[:400]}")
            return False
        return True
    except (OSError, subprocess.SubprocessError) as err:
        log(f"could not validate the generated config: {err}")
        return False
    finally:
        if os.path.exists(path):
            os.unlink(path)


def rewrite(path: str, text: str, backup_dir: str) -> bool:
    """Replace `path` when the content differs. Returns True when written."""
    try:
        with open(path, encoding="utf-8") as fh:
            if fh.read() == text:
                return False
    except FileNotFoundError:
        pass
    os.makedirs(backup_dir, exist_ok=True)
    if os.path.exists(path):
        shutil.copy2(path, os.path.join(backup_dir, os.path.basename(path)))
    write_atomic(path, text)
    return True


def restart(unit: str) -> bool:
    proc = subprocess.run(["systemctl", "restart", unit], capture_output=True, text=True, timeout=60)
    if proc.returncode != 0:
        log(f"restart {unit} failed: {(proc.stderr or proc.stdout).strip()[:300]}")
        return False
    time.sleep(1)
    active = subprocess.run(["systemctl", "is-active", unit], capture_output=True, text=True)
    if active.stdout.strip() != "active":
        log(f"{unit} is not active after restart ({active.stdout.strip()})")
        return False
    return True


def main() -> int:
    dry_run = "--print" in sys.argv[1:]
    os.makedirs(SYNC_DIR, exist_ok=True)
    now_ms = int(time.time() * 1000)

    previous = load_state()
    users: list[dict] = previous.get("users") or []
    source = "state"
    pruned_from_state = 0

    token = read_secret()
    url = os.environ.get("NETPULSE_SYNC_URL", DEFAULT_SYNC_URL)
    fresh = fetch_users(url, token)
    if fresh is not None:
        users = fresh
        source = "cloud"
    elif not previous.get("users"):
        # Nothing to enforce with: no fresh answer and no last known-good set.
        # Writing the empty set here would take the server down for everyone
        # because of one unreachable request.
        log("pull failed and no previous state exists; leaving server config untouched")
        write_atomic(LAST_RUN_FILE, json.dumps({"at": now_ms, "error": "no state, pull failed", "dryRun": dry_run}, indent=1))
        return 1

    users, pruned = prune_expired(users, now_ms)
    if pruned:
        log(f"pruned {pruned} identit{'y' if pruned == 1 else 'ies'} past their expiry")

    summary: dict = {
        "at": now_ms,
        "source": source,
        "users": len(users),
        "byProtocol": {},
        "dryRun": dry_run,
    }
    for user in users:
        summary["byProtocol"][user["protocol"]] = summary["byProtocol"].get(user["protocol"], 0) + 1

    xray_config = build_xray_config(users)
    xray_text = json.dumps(xray_config, indent=1) + "\n"
    hysteria_config = build_hysteria_config(users)
    import yaml

    hysteria_text = yaml.safe_dump(hysteria_config, sort_keys=False, default_flow_style=False)

    if dry_run:
        print(json.dumps(summary, indent=1))
        print(xray_text)
        print(hysteria_text)
        return 0

    if not xray_config_is_valid(xray_text):
        summary["error"] = "xray config invalid; nothing applied"
        write_atomic(LAST_RUN_FILE, json.dumps(summary, indent=1))
        log("aborting: xray config invalid, previous server config left in place")
        return 2

    # Cache the set only once it has passed validation, i.e. only when it is
    # actually about to be applied. Writing it earlier made a *rejected* config
    # the "last known-good" state, so a Worker outage right after would have the
    # host fall back to a set the server never received.
    if fresh is not None and not dry_run:
        write_atomic(STATE_FILE, json.dumps({"users": users, "fetchedAt": now_ms}, indent=1, sort_keys=True))

    backup_dir = os.path.join(SYNC_DIR, "backup")
    xray_changed = rewrite(XRAY_CONFIG, xray_text, backup_dir)
    hysteria_changed = rewrite(HY_CONFIG, hysteria_text, backup_dir)

    summary["xrayChanged"] = xray_changed
    summary["hysteriaChanged"] = hysteria_changed

    if xray_changed and not restart(XRAY_UNIT):
        summary["error"] = f"{XRAY_UNIT} failed to restart"
    if hysteria_changed and not restart(HYSTERIA_UNIT):
        summary["error"] = f"{HYSTERIA_UNIT} failed to restart"

    write_atomic(LAST_RUN_FILE, json.dumps(summary, indent=1, sort_keys=True))
    log(
        "applied"
        f" source={source} users={len(users)} pruned={pruned}"
        f" xray={'changed' if xray_changed else 'same'} hysteria={'changed' if hysteria_changed else 'same'}"
        + (f" error={summary['error']}" if summary.get("error") else "")
    )
    return 0 if "error" not in summary else 3


if __name__ == "__main__":
    sys.exit(main())
