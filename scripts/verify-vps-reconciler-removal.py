#!/usr/bin/env python3
"""Prove the host reconciler REMOVES a rotated / revoked identity.

The Worker can only stop *publishing* a secret. What actually kills a leaked
config is the VPN host rewriting its server configs from the published set, so
the claim in `cloud/worker/README.md` ("expiry/revocation/refund -> the identity
disappears from the config on the next pass") has two halves and only the second
one is falsifiable: the config that the reconciler would write must no longer
contain the old secret.

This harness runs the real reconciler (`scripts/vps-sync-vpn-users.py`) in its
`--print` mode against a sandboxed copy of the server config, feeds it a
loopback stand-in for the Worker endpoint, and diffs the result:

  1. seed the sandbox with the server config as the host holds it
     (`--from-live` uses /opt/netpulse-* when run on the VPN host; otherwise a
     skeleton is seeded through the reconciler's own builders);
  2. `--print` with that same set      -> the diff must be empty. A pass over an
     unchanged set must not churn the config, so the next diff is meaningful
     rather than a formatting artefact;
  3. `--print` with a rotated set      -> one identity rotated to a new secret,
     one revoked outright, one added, one already past `expiresAt`;
  4. assert the old secret, the revoked identity and the expired identity are
     gone from the emitted configs, and that nothing on disk was touched.

Nothing is applied and no live service is contacted except the loopback stand-in.
Exit 0 = every claim held, 1 = a claim failed, 2 = could not run.
"""

from __future__ import annotations

import argparse
import difflib
import hashlib
import http.server
import importlib.util
import json
import os
import secrets
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import uuid

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RECONCILER = os.path.join(ROOT, "scripts", "vps-sync-vpn-users.py")
TOKEN = "verify-token-not-a-credential"
DAY_MS = 24 * 60 * 60 * 1000

# Identities the seeded "before" state uses when there is no live config to copy.
SEED_USERS = ("u_1a2b3c4d5e6f", "u_9f8e7d6c5b4a")
ADDED_USER = "u_5f4e3d2c1b0a"
EXPIRED_USER = "u_deadbeefcafe"
# A retired inbound that carries a shared server secret: the reconciler must not
# know about it, and a rotation must leave it exactly as it is.
RETIRED_TAG = "ss2022"
RETIRED_CLIENT = {"password": "shared-retired-secret", "email": "ss2022-legacy"}


class Fail(Exception):
    """A claim did not hold."""


def sha256_file(path: str) -> str:
    with open(path, "rb") as fh:
        return hashlib.sha256(fh.read()).hexdigest()


def fresh_secret(protocol: str) -> str:
    """Same shapes the Worker mints: UUIDs for the Xray proxies, hex for the rest."""
    if protocol in ("xray-trojan-tls", "hysteria2"):
        return secrets.token_hex(16)
    return str(uuid.uuid4())


def user_id(username: str) -> str:
    if username.startswith("u_"):
        return "usr_" + username[2:]
    return "usr_" + hashlib.sha256(username.encode()).hexdigest()[:12]


def load_reconciler():
    """Import the reconciler as a module. It reads its paths at import time."""
    spec = importlib.util.spec_from_file_location("np_reconciler", RECONCILER)
    if spec is None or spec.loader is None:
        raise SystemExit(f"cannot load {RECONCILER}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def skeleton_xray() -> dict:
    """A stand-in for the live host config: the four per-user inbounds plus one
    retired shared-secret inbound the reconciler is not supposed to manage."""
    return {
        "log": {"loglevel": "warning"},
        "inbounds": [
            {
                "tag": "vless-reality",
                "listen": "0.0.0.0",
                "port": 443,
                "protocol": "vless",
                "settings": {"clients": [], "decryption": "none"},
                "streamSettings": {
                    "network": "tcp",
                    "security": "reality",
                    "realitySettings": {
                        "dest": "www.microsoft.com:443",
                        "serverNames": ["www.microsoft.com"],
                        "shortIds": ["674622f7"],
                        "privateKey": "REPLACED-ON-THE-LIVE-HOST",
                    },
                },
            },
            {
                "tag": "vmess-ws",
                "listen": "0.0.0.0",
                "port": 8443,
                "protocol": "vmess",
                "settings": {"clients": []},
                "streamSettings": {"network": "ws", "wsSettings": {"path": "/np-vmess"}},
            },
            {
                "tag": "vless-ws-tls",
                "listen": "0.0.0.0",
                "port": 2053,
                "protocol": "vless",
                "settings": {"clients": [], "decryption": "none"},
                "streamSettings": {"network": "ws", "security": "tls", "wsSettings": {"path": "/np-vless"}},
            },
            {
                "tag": "trojan-tls",
                "listen": "0.0.0.0",
                "port": 2087,
                "protocol": "trojan",
                "settings": {"clients": []},
                "streamSettings": {"network": "tcp", "security": "tls"},
            },
            {
                "tag": RETIRED_TAG,
                "listen": "0.0.0.0",
                "port": 8388,
                "protocol": "shadowsocks",
                "settings": {"clients": [dict(RETIRED_CLIENT)], "method": "2022-blake3-aes-128-gcm"},
            },
        ],
        "outbounds": [{"protocol": "freedom", "tag": "direct"}],
        "routing": {"rules": []},
    }


def users_from_configs(recon, xray: dict, hysteria: dict) -> list[dict]:
    """The identity set a config currently authenticates, re-expressed as a
    Worker payload entry list (`{id, protocol, username, secret, expiresAt}`)."""
    proto_by_tag = {tag: proto for proto, tag in recon.XRAY_INBOUNDS.items()}
    people: dict[str, dict[str, str]] = {}
    for inbound in xray.get("inbounds") or []:
        protocol = proto_by_tag.get(inbound.get("tag"))
        if not protocol:
            continue
        for client in (inbound.get("settings") or {}).get("clients") or []:
            secret = client.get("id") or client.get("password")
            name = client.get("email")
            if isinstance(secret, str) and secret and isinstance(name, str) and name:
                people.setdefault(name, {})[protocol] = secret
    auth = hysteria.get("auth") if isinstance(hysteria.get("auth"), dict) else {}
    if auth.get("type") == "userpass":
        for name, secret in (auth.get("userpass") or {}).items():
            people.setdefault(name, {})[recon.HYSTERIA_PROTOCOL] = secret
    return [
        {"id": user_id(name), "protocol": protocol, "username": name, "secret": secret, "expiresAt": None}
        for name, protocols in sorted(people.items())
        for protocol, secret in sorted(protocols.items())
    ]


def seed_users(recon) -> list[dict]:
    """Synthetic 'before' set: two subscribers, every per-user protocol."""
    users = []
    for name in SEED_USERS:
        for protocol in sorted(recon.XRAY_INBOUNDS) + [recon.HYSTERIA_PROTOCOL]:
            users.append(
                {
                    "id": user_id(name),
                    "protocol": protocol,
                    "username": name,
                    "secret": fresh_secret(protocol),
                    "expiresAt": None,
                }
            )
    return users


def rotate(users: list[dict], now_ms: int) -> tuple[list[dict], dict]:
    """A rotated set: the rotation the /api/v1/ops/vpn/rotate action produces
    (same account, same username, NEW secret), plus a revoked account, a new
    account and one that is already past its expiry."""
    names = sorted({u["username"] for u in users})
    rotated = names[0]
    revoked = names[-1] if len(names) > 1 else None

    out: list[dict] = []
    new_secrets: dict[str, str] = {}
    for user in users:
        if revoked is not None and user["username"] == revoked:
            continue  # entitlement gone: the identity must disappear
        if user["username"] == rotated:
            secret = fresh_secret(user["protocol"])
            new_secrets[user["protocol"]] = secret
            out.append({**user, "secret": secret, "expiresAt": now_ms + DAY_MS})
        else:
            out.append({**user, "expiresAt": now_ms + DAY_MS})

    expired_count = 0
    for protocol in sorted({u["protocol"] for u in users}):
        out.append(
            {
                "id": user_id(ADDED_USER),
                "protocol": protocol,
                "username": ADDED_USER,
                "secret": fresh_secret(protocol),
                "expiresAt": now_ms + DAY_MS,
            }
        )
        out.append(
            {
                "id": user_id(EXPIRED_USER),
                "protocol": protocol,
                "username": EXPIRED_USER,
                "secret": fresh_secret(protocol),
                "expiresAt": now_ms - 60_000,
            }
        )
        expired_count += 1

    return out, {
        "rotated": rotated,
        "revoked": revoked,
        "added": ADDED_USER,
        "expired": EXPIRED_USER,
        "expired_count": expired_count,
        "new_secrets": new_secrets,
    }


def old_secrets(users: list[dict], username: str) -> list[str]:
    return [u["secret"] for u in users if u["username"] == username]


class PayloadServer(http.server.ThreadingHTTPServer):
    """Loopback stand-in for GET /api/v1/internal/vpn-users."""

    daemon_threads = True

    def __init__(self, handler_cls, users: list[dict]):
        super().__init__(("127.0.0.1", 0), handler_cls)
        self.users = users


def make_handler(port_holder: dict):
    payload = {"users": []}
    token = TOKEN

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):  # noqa: N802 - http.server API
            if self.path.rstrip("/") != "/vpn-users":
                self.send_error(404)
                return
            if self.headers.get("Authorization") != f"Bearer {token}":
                self.send_error(401)
                return
            body = json.dumps({"ok": True, "version": "verify", "users": payload["users"]}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *args):  # silence the default access log
            return

    return Handler, payload


def split_print_output(text: str, stage: str) -> tuple[dict, dict, str, str]:
    """`--print` writes the log lines, the summary JSON, the Xray JSON, then YAML."""
    lines = text.splitlines(keepends=True)
    start = 0
    while start < len(lines) and not lines[start].lstrip().startswith("{"):
        start += 1
    logs = "".join(lines[:start])
    body = "".join(lines[start:])
    decoder = json.JSONDecoder()

    def decode_at(index: int) -> tuple[dict, int]:
        while index < len(body) and body[index] in " \t\r\n":
            index += 1
        if index >= len(body):
            raise Fail(f"{stage}: the output ended before the expected JSON document")
        obj, end = decoder.raw_decode(body, index)
        if not isinstance(obj, dict):
            raise Fail(f"{stage}: expected a JSON object at offset {index}")
        return obj, end

    summary, cursor = decode_at(0)
    xray, cursor = decode_at(cursor)
    return summary, xray, body[cursor:].lstrip("\n"), logs


def run_print(recon_env: dict, url: str) -> str:
    proc = subprocess.run(
        [sys.executable, RECONCILER, "--print"],
        capture_output=True,
        text=True,
        timeout=120,
        env={**recon_env, "NETPULSE_SYNC_URL": url},
    )
    if proc.returncode != 0:
        raise Fail(f"reconciler --print exited {proc.returncode}: {proc.stderr.strip()[:400]}")
    return proc.stdout


def normalize_tail(text: str) -> str:
    """`--print` ends each block with print(), so the YAML tail carries one more
    newline than the file it would be written from. Ignore only that."""
    return text.rstrip("\n") + "\n"


def unified(before: str, after: str, label: str) -> str:
    diff = list(
        difflib.unified_diff(
            before.splitlines(keepends=True),
            after.splitlines(keepends=True),
            fromfile=f"{label}.before",
            tofile=f"{label}.after",
        )
    )
    return "".join(diff)


def check(condition: bool, message: str, results: list[tuple[bool, str]]) -> None:
    results.append((bool(condition), message))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--from-live", action="store_true", help="copy the host's configs (run on the VPN host)")
    parser.add_argument("--live-xray", default="/opt/netpulse-xray/config.json")
    parser.add_argument("--live-hysteria", default="/opt/netpulse-hysteria/config.yaml")
    parser.add_argument("--workdir", help="sandbox directory (default: a temp dir, removed afterwards)")
    parser.add_argument("--keep", action="store_true", help="keep the sandbox after the run")
    args = parser.parse_args()

    try:
        import yaml  # noqa: F401 - the hysteria half of the reconciler needs it
    except ImportError:
        print("pyyaml is required to verify the hysteria half (pip install pyyaml, or apt install python3-yaml)")
        return 2

    workdir = args.workdir or tempfile.mkdtemp(prefix="np-reconcile-verify-")
    os.makedirs(workdir, exist_ok=True)
    sync_dir = os.path.join(workdir, "sync")
    xray_path = os.path.join(workdir, "xray-config.json")
    hysteria_path = os.path.join(workdir, "hysteria-config.yaml")
    os.makedirs(sync_dir, exist_ok=True)

    with open(os.path.join(sync_dir, "vps-sync.secret"), "w", encoding="utf-8") as fh:
        fh.write(TOKEN + "\n")

    # The reconciler resolves its paths from the environment at import time.
    recon_env = {
        **os.environ,
        "NETPULSE_SYNC_DIR": sync_dir,
        "NETPULSE_XRAY_CONFIG": xray_path,
        "NETPULSE_HYSTERIA_CONFIG": hysteria_path,
    }
    os.environ.update({k: v for k, v in recon_env.items() if k.startswith("NETPULSE_")})
    recon = load_reconciler()

    results: list[tuple[bool, str]] = []
    notes: list[str] = []

    # ---- 1. the "before" state, as the host holds it -------------------------
    base_users: list[dict] = []
    seeded = False
    if args.from_live:
        if os.path.exists(args.live_xray) and os.path.exists(args.live_hysteria):
            shutil.copy2(args.live_xray, xray_path)
            shutil.copy2(args.live_hysteria, hysteria_path)
            with open(xray_path, encoding="utf-8") as fh:
                live_xray = json.load(fh)
            with open(hysteria_path, encoding="utf-8") as fh:
                live_hysteria = yaml.safe_load(fh) or {}
            base_users = users_from_configs(recon, live_xray, live_hysteria)
            notes.append(
                f"copied the live configs from the host: {len({u['username'] for u in base_users})} identit"
                f"{'y' if len({u['username'] for u in base_users}) == 1 else 'ies'} currently published"
            )
        else:
            print(f"--from-live given but {args.live_xray} / {args.live_hysteria} are missing")
            return 2

    if not base_users:
        if args.from_live:
            notes.append(
                "the live config currently authenticates nobody (deny-all), so the 'before' state is seeded "
                "through the reconciler's own builders instead"
            )
        base_users = seed_users(recon)
        xray_base = skeleton_xray()
        with open(xray_path, "w", encoding="utf-8") as fh:
            json.dump(xray_base, fh, indent=1)
            fh.write("\n")
        with open(hysteria_path, "w", encoding="utf-8", newline="") as fh:
            fh.write(yaml.safe_dump({"listen": ":8443", "auth": {"type": "password", "password": "unknown"}}, sort_keys=False))
        seeded = True

    if seeded:
        # Write the seeded state exactly as the reconciler would, so the
        # "unchanged set -> empty diff" check is about behaviour, not formatting.
        xray_text = json.dumps(recon.build_xray_config(base_users), indent=1) + "\n"
        with open(xray_path, "w", encoding="utf-8", newline="") as fh:
            fh.write(xray_text)
        hysteria_text = yaml.safe_dump(recon.build_hysteria_config(base_users), sort_keys=False, default_flow_style=False)
        with open(hysteria_path, "w", encoding="utf-8", newline="") as fh:
            fh.write(hysteria_text)

    with open(xray_path, encoding="utf-8") as fh:
        xray_before = fh.read()
    with open(hysteria_path, encoding="utf-8") as fh:
        hysteria_before = fh.read()
    before_hashes = (sha256_file(xray_path), sha256_file(hysteria_path))

    handler_cls, payload = make_handler({})
    server = PayloadServer(handler_cls, base_users)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    url = f"http://127.0.0.1:{server.server_port}/vpn-users"

    try:
        # ---- 2. same set again: no churn ------------------------------------
        payload["users"] = base_users
        summary_a, xray_a, hysteria_a, logs_a = split_print_output(run_print(recon_env, url), "run/unchanged")
        diff_a_xray = unified(xray_before, json.dumps(xray_a, indent=1) + "\n", "xray")
        diff_a_hysteria = unified(hysteria_before, normalize_tail(hysteria_a), "hysteria")
        check(
            not diff_a_xray and not diff_a_hysteria,
            "an unchanged published set produces byte-identical configs (the later diff is not formatting noise)",
            results,
        )
        check(summary_a.get("source") == "cloud", "the reconciler pulled the set from the endpoint (source: cloud)", results)
        check(summary_a.get("dryRun") is True, "the run was a dry run (dryRun: true)", results)

        # ---- 3. rotated set: removal ---------------------------------------
        rotated_users, expect = rotate(base_users, int(time.time() * 1000))
        payload["users"] = rotated_users
        summary_b, xray_b, hysteria_b, logs_b = split_print_output(run_print(recon_env, url), "run/rotated")
        hysteria_b = normalize_tail(hysteria_b)
        emitted = json.dumps(xray_b, indent=1) + "\n" + hysteria_b

        for secret in old_secrets(base_users, expect["rotated"]):
            check(secret not in emitted, f"rotated identity: old secret {secret[:8]}... no longer appears in the config", results)
        for protocol, secret in sorted(expect["new_secrets"].items()):
            check(secret in emitted, f"rotated identity: {protocol} now carries the new secret", results)

        revoked = expect["revoked"]
        check(revoked is not None and revoked not in emitted, f"revoked identity {revoked} removed from both configs", results)
        check(expect["expired"] not in emitted, f"identity past expiresAt ({expect['expired']}) never reaches the config", results)
        check(expect["added"] in emitted, f"newly entitled identity {expect['added']} is written into the config", results)
        check(
            summary_b.get("users") == len(rotated_users) - expect["expired_count"],
            f"the summary reports {summary_b.get('users')} kept identities, after pruning the {expect['expired_count']} expired ones",
            results,
        )

        # every per-user inbound really carries exactly the kept set
        tag_by_proto = {proto: tag for proto, tag in recon.XRAY_INBOUNDS.items()}
        emitted_clients = {
            inbound.get("tag"): len((inbound.get("settings") or {}).get("clients") or [])
            for inbound in xray_b.get("inbounds") or []
            if inbound.get("tag") in tag_by_proto.values()
        }
        expected_per_tag = {}
        kept = [u for u in rotated_users if not u.get("expiresAt") or u["expiresAt"] > time.time() * 1000]
        for user in kept:
            tag = tag_by_proto.get(user["protocol"])
            if tag:
                expected_per_tag[tag] = expected_per_tag.get(tag, 0) + 1
        check(emitted_clients == expected_per_tag, f"clients arrays are replaced, not merged: {emitted_clients}", results)

        retired = next((i for i in xray_b.get("inbounds") or [] if i.get("tag") == RETIRED_TAG), None)
        check(
            retired is not None and retired.get("settings", {}).get("clients") == [RETIRED_CLIENT],
            f"the retired shared-secret inbound ({RETIRED_TAG}) is left untouched",
            results,
        )

        # ---- 4. --print touched nothing ------------------------------------
        check(
            (sha256_file(xray_path), sha256_file(hysteria_path)) == before_hashes,
            "both config files are unchanged on disk (the diff is what would be applied)",
            results,
        )

        diff_b_xray = unified(xray_before, json.dumps(xray_b, indent=1) + "\n", "xray")
        diff_b_hysteria = unified(hysteria_before, hysteria_b, "hysteria")
    finally:
        server.shutdown()
        server.server_close()

    print(f"workdir: {workdir}")
    for note in notes:
        print(f"note: {note}")
    print(f"reconciler log lines, unchanged set: {logs_a.strip() or '(none)'}")
    print(f"reconciler log lines, rotated set:   {logs_b.strip() or '(none)'}")
    print(f"seeded before-state identities: {len({u['username'] for u in base_users})}")
    print(f"rotated: {expect['rotated']}  revoked: {expect['revoked']}  added: {expect['added']}  expired: {expect['expired']}")

    print("\n=== diff: xray config (current on-disk -> what the reconciler would write) ===")
    print(diff_b_xray or "(no changes)")
    print("=== diff: hysteria config ===")
    print(diff_b_hysteria or "(no changes)")

    print("\n=== checks ===")
    failed = 0
    for ok, message in results:
        print(f"[{'PASS' if ok else 'FAIL'}] {message}")
        failed += 0 if ok else 1
    print(f"\n{len(results) - failed}/{len(results)} checks passed")

    if not args.keep and not args.workdir:
        shutil.rmtree(workdir, ignore_errors=True)
    return 1 if failed else 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Fail as err:
        print(f"could not complete the verification: {err}")
        sys.exit(2)
