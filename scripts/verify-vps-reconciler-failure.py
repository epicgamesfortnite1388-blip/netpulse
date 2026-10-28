#!/usr/bin/env python3
"""Prove the host reconciler's TEMPORARY-FAILURE and RECOVERY behaviour.

`scripts/vps-sync-vpn-users.py` documents an asymmetric failure policy:

* a failed pull (Worker down, DNS, 502) keeps the last known-good set — wiping on
  a network blip would be a self-inflicted outage;
* a malformed / half-understood payload is a hard error — nothing is applied;
* an empty but well-formed set IS applied (deny all);
* `expiresAt` is enforced on every pass, so access still ends on time while the
  Worker is unreachable.

Until now that policy was code and prose only. This harness proves it against the
real reconciler, in a sandbox, with a loopback stand-in for the Worker endpoint
that can answer 200 / 500 / garbage / nothing at all:

  1. healthy pass                     -> source: cloud, config unchanged;
  2. HTTP 500 with a cached set       -> source: state, config byte-identical;
  3. endpoint unreachable             -> source: state, config byte-identical;
  4. malformed payload (unknown protocol / illegal secret) -> treated as a failed
     pull: the malformed identity never reaches the config;
  5. an identity whose expiry passed while the Worker was down -> dropped anyway
     (expiry is enforced host-side, not by the cloud);
  6. recovery: rotated + revoked + added set -> the next pass converges, and the
     rotated-away secret and the revoked identity are gone;
  7. after that pass the CACHE holds the new set, so a later outage cannot
     resurrect the revoked identity;
  8. apply mode with an unusable xray binary -> the validation gate is
     fail-closed: exit 2, `xray config invalid; nothing applied`, no file
     written, state cache untouched;
  9. no cache and no endpoint -> exit 1, no config written, last-run records it.

Everything runs with `NETPULSE_*` paths pointed at a sandbox directory, so no
real server config is read or written except when `--live-guard` names files to
hash before and after (used on the VPN host to prove they were left alone).

Exit 0 = every claim held, 1 = a claim failed, 2 = could not run.
"""

from __future__ import annotations

import argparse
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

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
# In the repo the reconciler is a sibling in scripts/; when both files are copied
# to a host for an apply-mode run they sit next to each other.
_CANDIDATES = (
    os.path.join(HERE, "vps-sync-vpn-users.py"),
    os.path.join(ROOT, "scripts", "vps-sync-vpn-users.py"),
)
RECONCILER = next((p for p in _CANDIDATES if os.path.exists(p)), _CANDIDATES[-1])
TOKEN = "verify-token-not-a-credential"
DAY_MS = 24 * 60 * 60 * 1000
SEED_USERS = ("u_1a2b3c4d5e6f", "u_9f8e7d6c5b4a")
REVOKED_LATER = "u_9f8e7d6c5b4a"
ADDED_USER = "u_5f4e3d2c1b0a"
STALE_USER = "u_deadbeefcafe"


class Fail(Exception):
    """A claim could not be checked (harness problem, not a verdict)."""


def sha256_file(path: str) -> str:
    with open(path, "rb") as fh:
        return hashlib.sha256(fh.read()).hexdigest()


def fresh_secret(protocol: str) -> str:
    """The shapes the Worker mints: UUIDs for the Xray proxies, hex for the rest."""
    if protocol in ("xray-trojan-tls", "hysteria2"):
        return secrets.token_hex(16)
    return str(uuid.uuid4())


def user_id(username: str) -> str:
    return "usr_" + hashlib.sha256(username.encode()).hexdigest()[:12]


def load_reconciler():
    spec = importlib.util.spec_from_file_location("np_reconciler", RECONCILER)
    if spec is None or spec.loader is None:
        raise Fail(f"cannot load {RECONCILER}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def skeleton_xray() -> dict:
    """The host's shape: four per-user inbounds plus one retired shared-secret one."""
    return {
        "log": {"loglevel": "warning"},
        "inbounds": [
            {
                "tag": "vless-reality",
                "listen": "0.0.0.0",
                "port": 443,
                "protocol": "vless",
                "settings": {"clients": [], "decryption": "none"},
                "streamSettings": {"network": "tcp", "security": "reality"},
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
                "streamSettings": {"network": "ws", "security": "tls"},
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
                "tag": "ss2022",
                "listen": "0.0.0.0",
                "port": 8388,
                "protocol": "shadowsocks",
                "settings": {"clients": [{"password": "shared-retired-secret", "email": "ss2022-legacy"}]},
            },
        ],
        "outbounds": [{"protocol": "freedom", "tag": "direct"}],
    }


def seed_users(recon) -> list[dict]:
    return [
        {
            "id": user_id(name),
            "protocol": protocol,
            "username": name,
            "secret": fresh_secret(protocol),
            "expiresAt": None,
        }
        for name in SEED_USERS
        for protocol in sorted(recon.XRAY_INBOUNDS) + [recon.HYSTERIA_PROTOCOL]
    ]


class Server(http.server.ThreadingHTTPServer):
    daemon_threads = True


def make_server(recon):
    """Loopback stand-in with a mutable status code and payload."""
    state = {"status": 200, "users": []}

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):  # noqa: N802 - http.server API
            if self.path.rstrip("/") != "/vpn-users":
                self.send_error(404)
                return
            if self.headers.get("Authorization") != f"Bearer {TOKEN}":
                self.send_error(401)
                return
            status = state["status"]
            if status != 200:
                body = json.dumps({"ok": False, "error": "temporarily unavailable"}).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return
            body = json.dumps({"ok": True, "version": "verify", "users": state["users"]}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *args):
            return

    return Server(("127.0.0.1", 0), Handler), state


def parse_print(stdout: str) -> tuple[dict, dict, str, str]:
    """`--print` emits log lines, the summary JSON, the Xray JSON, then the YAML."""
    lines = stdout.splitlines(keepends=True)
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
            raise Fail("the run ended before the expected JSON document")
        obj, end = decoder.raw_decode(body, index)
        return obj, end

    summary, cursor = decode_at(0)
    xray, cursor = decode_at(cursor)
    return summary, xray, body[cursor:].lstrip("\n"), logs


def run(recon_env: dict, url: str, dry_run: bool) -> subprocess.CompletedProcess:
    args = [sys.executable, RECONCILER] + (["--print"] if dry_run else [])
    return subprocess.run(
        args,
        capture_output=True,
        text=True,
        timeout=180,
        env={**recon_env, "NETPULSE_SYNC_URL": url},
    )


def normalize_tail(text: str) -> str:
    return text.rstrip("\n") + "\n"


def check(condition: bool, message: str, results: list) -> None:
    results.append((bool(condition), message))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--workdir", help="sandbox directory (default: a temp dir)")
    parser.add_argument("--keep", action="store_true", help="keep the sandbox after the run")
    parser.add_argument(
        "--apply",
        action="store_true",
        help="also exercise apply mode in the sandbox (needs a runnable xray binary for the happy path)",
    )
    parser.add_argument("--live-guard", nargs="*", default=[], help="files that must be unchanged afterwards (host safety)")
    parser.add_argument(
        "--seed-xray",
        help="copy this config into the sandbox as the starting point (run on the VPN host: the real inbound "
        "structure, so the xray validation gate is exercised for real)",
    )
    parser.add_argument("--seed-hysteria", help="same, for the hysteria config")
    args = parser.parse_args()

    try:
        import yaml  # noqa: F401 - the hysteria half needs it
    except ImportError:
        print("pyyaml is required (pip install pyyaml, or apt install python3-yaml)")
        return 2

    workdir = args.workdir or tempfile.mkdtemp(prefix="np-reconcile-failure-")
    os.makedirs(workdir, exist_ok=True)
    sync_dir = os.path.join(workdir, "sync")
    xray_path = os.path.join(workdir, "xray-config.json")
    hysteria_path = os.path.join(workdir, "hysteria-config.yaml")
    os.makedirs(sync_dir, exist_ok=True)
    with open(os.path.join(sync_dir, "vps-sync.secret"), "w", encoding="utf-8") as fh:
        fh.write(TOKEN + "\n")

    recon_env = {
        **os.environ,
        "NETPULSE_SYNC_DIR": sync_dir,
        "NETPULSE_XRAY_CONFIG": xray_path,
        "NETPULSE_HYSTERIA_CONFIG": hysteria_path,
        # Restarting a live unit is not this harness's business: apply-mode runs
        # deliberately name units that do not exist, so the file/state checks stay
        # honest and no running service is bounced.
        "NETPULSE_XRAY_UNIT": os.environ.get("NP_PROOF_XRAY_UNIT", "np-proof-noop-xray"),
        "NETPULSE_HYSTERIA_UNIT": os.environ.get("NP_PROOF_HYSTERIA_UNIT", "np-proof-noop-hysteria"),
    }
    os.environ.update({k: v for k, v in recon_env.items() if k.startswith("NETPULSE_")})
    recon = load_reconciler()

    guard_hashes = {p: sha256_file(p) for p in args.live_guard if os.path.exists(p)}

    results: list[tuple[bool, str]] = []
    notes: list[str] = []

    base_users = seed_users(recon)
    if args.seed_xray and args.seed_hysteria:
        shutil.copy2(args.seed_xray, xray_path)
        shutil.copy2(args.seed_hysteria, hysteria_path)
        notes.append("sandbox seeded from the real configs: real inbound structure, synthetic identities")
    else:
        with open(xray_path, "w", encoding="utf-8", newline="") as fh:
            json.dump(skeleton_xray(), fh, indent=1)
        with open(hysteria_path, "w", encoding="utf-8", newline="") as fh:
            fh.write(yaml.safe_dump({"listen": ":8443", "auth": {"type": "password", "password": "unknown"}}, sort_keys=False))
    # Write exactly what the reconciler would write, so "unchanged" is a
    # behavioural claim, not a formatting one. Build first, write second: the
    # builders read these same files.
    xray_text = json.dumps(recon.build_xray_config(base_users), indent=1) + "\n"
    hysteria_text = yaml.safe_dump(recon.build_hysteria_config(base_users), sort_keys=False, default_flow_style=False)
    with open(xray_path, "w", encoding="utf-8", newline="") as fh:
        fh.write(xray_text)
    with open(hysteria_path, "w", encoding="utf-8", newline="") as fh:
        fh.write(hysteria_text)

    with open(xray_path, encoding="utf-8") as fh:
        xray_reference = fh.read()
    with open(hysteria_path, encoding="utf-8") as fh:
        hysteria_reference = fh.read()
    reference_hashes = (sha256_file(xray_path), sha256_file(hysteria_path))

    server, state = make_server(recon)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    url = f"http://127.0.0.1:{server.server_port}/vpn-users"
    logs_seen: dict[str, str] = {}

    try:
        # ---- 1. healthy pass: source cloud, nothing churns ---------------------
        state["status"], state["users"] = 200, base_users
        proc = run(recon_env, url, dry_run=True)
        if proc.returncode != 0:
            raise Fail(f"healthy --print exited {proc.returncode}: {proc.stderr.strip()[:300]}")
        summary, xray_out, _hy, logs = parse_print(proc.stdout)
        logs_seen["healthy"] = logs
        check(summary.get("source") == "cloud", "healthy pass: the set came from the endpoint (source: cloud)", results)
        check(
            json.dumps(xray_out, indent=1) + "\n" == xray_reference,
            "healthy pass: an identical published set rewrites nothing (byte-identical config)",
            results,
        )

        # `--print` deliberately never writes the cache (that happens in apply
        # mode), so seed what a previous applied pass would have left behind.
        with open(os.path.join(sync_dir, "state.json"), "w", encoding="utf-8") as fh:
            json.dump({"users": base_users, "fetchedAt": int(time.time() * 1000)}, fh)
        notes.append("cache seeded as an applied pass would leave it (--print never writes state.json)")

        # ---- 2. HTTP 500 with a cache: last known-good survives ---------------
        state["status"] = 500
        proc = run(recon_env, url, dry_run=True)
        if proc.returncode != 0:
            raise Fail(f"500 --print exited {proc.returncode}: {proc.stderr.strip()[:300]}")
        summary, xray_out, _hy, logs = parse_print(proc.stdout)
        logs_seen["http500"] = logs
        check(summary.get("source") == "state", "HTTP 500: the reconciler fell back to its last known-good set (source: state)", results)
        check(
            json.dumps(xray_out, indent=1) + "\n" == xray_reference,
            "HTTP 500: the emitted config is byte-identical to the last known-good one (no wipe)",
            results,
        )
        check("pull failed" in logs and "500" in logs, "HTTP 500: the failure is logged, not swallowed", results)

        # ---- 3. endpoint unreachable -----------------------------------------
        dead_url = url.replace(str(server.server_port), str(server.server_port + 1))
        proc = run(recon_env, dead_url, dry_run=True)
        if proc.returncode != 0:
            raise Fail(f"unreachable --print exited {proc.returncode}: {proc.stderr.strip()[:300]}")
        summary, xray_out, _hy, logs = parse_print(proc.stdout)
        logs_seen["refused"] = logs
        check(summary.get("source") == "state", "endpoint unreachable: still source: state (no fail-open, no fail-wipe)", results)
        check(
            json.dumps(xray_out, indent=1) + "\n" == xray_reference,
            "endpoint unreachable: emitted config unchanged",
            results,
        )

        # ---- 4. malformed payload: never applied ------------------------------
        state["status"] = 200
        state["users"] = base_users + [
            {"id": "usr_bad", "protocol": "wireguard", "username": "u_bad", "secret": "x", "expiresAt": None}
        ]
        proc = run(recon_env, url, dry_run=True)
        if proc.returncode != 0:
            raise Fail(f"malformed --print exited {proc.returncode}: {proc.stderr.strip()[:300]}")
        summary, xray_out, _hy, logs = parse_print(proc.stdout)
        emitted = json.dumps(xray_out, indent=1)
        check(summary.get("source") == "state", "unknown protocol in the payload: treated as a failed pull", results)
        check("pull rejected: unknown protocol" in logs, "unknown protocol: the rejection says why", results)
        check("u_bad" not in emitted, "unknown protocol: the malformed identity never reaches the config", results)

        state["users"] = base_users + [
            {"id": "usr_bad2", "protocol": "hysteria2", "username": "u_bad2", "secret": 'has"quote', "expiresAt": None}
        ]
        proc = run(recon_env, url, dry_run=True)
        if proc.returncode != 0:
            raise Fail(f"bad-secret --print exited {proc.returncode}: {proc.stderr.strip()[:300]}")
        summary, xray_out, _hy, logs = parse_print(proc.stdout)
        check("u_bad2" not in json.dumps(xray_out, indent=1), "illegal secret: the entry is rejected, nothing is written", results)

        # ---- 5. expiry is enforced while the Worker is down -------------------
        state["users"] = base_users + [
            {
                "id": user_id(STALE_USER),
                "protocol": "hysteria2",
                "username": STALE_USER,
                "secret": fresh_secret("hysteria2"),
                "expiresAt": int(time.time() * 1000) - 60_000,
            }
        ]
        proc = run(recon_env, url, dry_run=True)
        if proc.returncode != 0:
            raise Fail(f"stale --print exited {proc.returncode}: {proc.stderr.strip()[:300]}")
        _summary, xray_out, hysteria_out, _logs = parse_print(proc.stdout)
        check("u_deadbeefcafe" not in json.dumps(xray_out, indent=1) + normalize_tail(hysteria_out), "an already-expired identity never reaches the config", results)

        # cache that expired set, then take the endpoint away: the host must drop
        # it locally on the next pass, without the Worker's help.
        apply_env = dict(recon_env)
        with open(os.path.join(sync_dir, "state.json"), "w", encoding="utf-8") as fh:
            json.dump(
                {
                    "users": base_users
                    + [
                        {
                            "id": user_id(STALE_USER),
                            "protocol": "hysteria2",
                            "username": STALE_USER,
                            "secret": fresh_secret("hysteria2"),
                            "expiresAt": int(time.time() * 1000) - 60_000,
                        }
                    ],
                    "fetchedAt": int(time.time() * 1000),
                },
                fh,
            )
        proc = run(apply_env, dead_url, dry_run=True)
        if proc.returncode != 0:
            raise Fail(f"outage-with-stale-cache --print exited {proc.returncode}: {proc.stderr.strip()[:300]}")
        summary, xray_out, hysteria_out, logs = parse_print(proc.stdout)
        check(summary.get("source") == "state", "outage with a cached set: source: state", results)
        check(
            STALE_USER not in json.dumps(xray_out, indent=1) + normalize_tail(hysteria_out),
            "outage: an identity whose expiry passed is still pruned locally - access ends on time without the Worker",
            results,
        )
        check(
            json.dumps(xray_out, indent=1) + "\n" == xray_reference,
            "outage: the still-valid identities are untouched (only the expired one went)",
            results,
        )

        # ---- 6. recovery: the next good pass converges ------------------------
        rotated = SEED_USERS[0]
        new_secrets = {}
        recovered: list[dict] = []
        for user in base_users:
            if user["username"] == REVOKED_LATER:
                continue
            if user["username"] == rotated:
                secret = fresh_secret(user["protocol"])
                new_secrets[user["protocol"]] = secret
                recovered.append({**user, "secret": secret, "expiresAt": int(time.time() * 1000) + DAY_MS})
            else:
                recovered.append({**user, "expiresAt": int(time.time() * 1000) + DAY_MS})
        for protocol in sorted(recon.XRAY_INBOUNDS) + [recon.HYSTERIA_PROTOCOL]:
            recovered.append(
                {
                    "id": user_id(ADDED_USER),
                    "protocol": protocol,
                    "username": ADDED_USER,
                    "secret": fresh_secret(protocol),
                    "expiresAt": int(time.time() * 1000) + DAY_MS,
                }
            )
        state["status"], state["users"] = 200, recovered
        proc = run(apply_env, url, dry_run=True)
        if proc.returncode != 0:
            raise Fail(f"recovery --print exited {proc.returncode}: {proc.stderr.strip()[:300]}")
        summary, xray_out, hysteria_out, logs = parse_print(proc.stdout)
        emitted = json.dumps(xray_out, indent=1) + normalize_tail(hysteria_out)
        check(summary.get("source") == "cloud", "recovery: the fresh set is pulled again (source: cloud)", results)
        for protocol, secret in sorted(new_secrets.items()):
            check(secret in emitted, f"recovery: the rotated identity now carries the new {protocol} secret", results)
        old_secret = next(u["secret"] for u in base_users if u["username"] == rotated and u["protocol"] == sorted(new_secrets)[0])
        check(old_secret not in emitted, "recovery: the rotated-away secret is gone from the config", results)
        check(REVOKED_LATER not in emitted, "recovery: the revoked identity is gone from the config", results)
        check(ADDED_USER in emitted, "recovery: the newly entitled identity is written", results)
        check(
            SEED_USERS[0] in emitted and STALE_USER not in emitted,
            "recovery: the surviving (rotated) subscriber is kept and the expired identity stays out",
            results,
        )

        # ---- 7. the cache advanced: a later outage cannot resurrect anyone ----
        with open(os.path.join(sync_dir, "state.json"), "w", encoding="utf-8") as fh:
            json.dump({"users": recovered, "fetchedAt": int(time.time() * 1000)}, fh)
        proc = run(apply_env, dead_url, dry_run=True)
        if proc.returncode != 0:
            raise Fail(f"post-recovery outage --print exited {proc.returncode}: {proc.stderr.strip()[:300]}")
        _summary, xray_out, hysteria_out, logs = parse_print(proc.stdout)
        emitted = json.dumps(xray_out, indent=1) + normalize_tail(hysteria_out)
        check(REVOKED_LATER not in emitted, "post-recovery outage: the revoked identity is NOT resurrected from cache", results)
        for protocol, secret in sorted(new_secrets.items()):
            check(secret in emitted, f"post-recovery outage: the new {protocol} secret stays in place", results)

        # ---- 8. fail-closed validation gate (apply mode, no writes) ----------
        apply_env_gate = dict(apply_env)
        apply_env_gate["NETPULSE_XRAY_BIN"] = os.path.join(workdir, "no-such-xray-binary")
        before = (sha256_file(xray_path), sha256_file(hysteria_path))
        state_before = sha256_file(os.path.join(sync_dir, "state.json"))
        proc = run(apply_env_gate, url, dry_run=False)
        check(proc.returncode == 2, f"apply with an unusable xray binary exits 2 (got {proc.returncode})", results)
        last_run = json.load(open(os.path.join(sync_dir, "last-run.json"), encoding="utf-8"))
        check(
            last_run.get("error") == "xray config invalid; nothing applied",
            "apply: the validation gate refuses to write an unvalidated config",
            results,
        )
        check(
            (sha256_file(xray_path), sha256_file(hysteria_path)) == before and sha256_file(os.path.join(sync_dir, "state.json")) == state_before,
            "apply: the refusal wrote neither config nor state cache (fail-closed)",
            results,
        )

        # ---- 9. real apply in the sandbox (opt-in) ---------------------------
        if args.apply:
            apply_env_ok = dict(apply_env)
            proc = run(apply_env_ok, url, dry_run=False)
            applied = json.load(open(os.path.join(sync_dir, "last-run.json"), encoding="utf-8"))
            check(applied.get("source") == "cloud", "apply: the pass recorded source: cloud", results)
            check(applied.get("xrayChanged") is True, "apply: the new set was written to the sandbox xray config", results)
            with open(xray_path, encoding="utf-8") as fh:
                on_disk = fh.read()
            check(REVOKED_LATER not in on_disk, "apply: the file on disk no longer authenticates the revoked identity", results)
            check(ADDED_USER in on_disk, "apply: the file on disk authenticates the newly entitled identity", results)
            state_now = json.load(open(os.path.join(sync_dir, "state.json"), encoding="utf-8"))
            check(
                {u["username"] for u in state_now.get("users", [])} == {u["username"] for u in recovered},
                "apply: the state cache now holds the fresh set (so a later outage cannot undo the removal)",
                results,
            )
            notes.append(f"apply run exit={proc.returncode}; unit restarts deliberately target nonexistent units")
        else:
            notes.append("apply-mode happy path not exercised (pass --apply on a host with a real xray binary)")
    finally:
        server.shutdown()
        server.server_close()

    # ---- 10. no cache and no endpoint: refuse to guess ------------------------
    bare = os.path.join(workdir, "bare")
    os.makedirs(bare, exist_ok=True)
    bare_sync = os.path.join(bare, "sync")
    os.makedirs(bare_sync, exist_ok=True)
    with open(os.path.join(bare_sync, "vps-sync.secret"), "w", encoding="utf-8") as fh:
        fh.write(TOKEN + "\n")
    bare_xray = os.path.join(bare, "xray.json")
    with open(bare_xray, "w", encoding="utf-8") as fh:
        json.dump(skeleton_xray(), fh, indent=1)
    bare_hash = sha256_file(bare_xray)
    bare_env = {
        **os.environ,
        "NETPULSE_SYNC_DIR": bare_sync,
        "NETPULSE_XRAY_CONFIG": bare_xray,
        "NETPULSE_HYSTERIA_CONFIG": os.path.join(bare, "hysteria.yaml"),
    }
    proc = run(bare_env, dead_url, dry_run=False)
    check(proc.returncode == 1, f"no cache + no endpoint exits 1 (got {proc.returncode})", results)
    check("{" not in proc.stdout.split("=== ")[0][:2000], "no cache: no config is emitted at all", results)
    check(sha256_file(bare_xray) == bare_hash, "no cache: the existing server config is left exactly as it was", results)
    bare_last = json.load(open(os.path.join(bare_sync, "last-run.json"), encoding="utf-8"))
    check(bare_last.get("error") == "no state, pull failed", "no cache: last-run records why nothing was done", results)
    check(
        not os.path.exists(os.path.join(bare_sync, "state.json")),
        "no cache: no empty set is cached either (a later Worker outage still cannot wipe anyone)",
        results,
    )

    # ---- 11. the sandbox never wrote the real configs ------------------------
    check(
        (sha256_file(xray_path), sha256_file(hysteria_path)) == reference_hashes or args.apply,
        "--print passes never modified the sandbox configs (and the live ones are hash-guarded)",
        results,
    )
    for path, digest in guard_hashes.items():
        check(sha256_file(path) == digest, f"live guard: {path} is byte-identical after the run", results)

    print(f"workdir: {workdir}")
    for note in notes:
        print(f"note: {note}")
    print(f"seeded identities: {len(SEED_USERS)} accounts × {len(recon.XRAY_INBOUNDS) + 1} protocols")
    print(f"pull-failure log lines: {logs_seen.get('http500', '').strip() or '(none)'}")

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
