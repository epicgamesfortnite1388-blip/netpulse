#!/usr/bin/env node
/**
 * Regression guard for release-gate honesty (DD-001..DD-005, DD-002 CI).
 *
 * These gates are orchestration scripts rather than importable functions, so
 * their contract is pinned at the source level: reverting any of the
 * warn-only / omitted steps below makes this suite fail. It deliberately does
 * NOT run a release, sign anything, or touch a live feed.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const desktopPackage = read('scripts/desktop-package.mjs');
const prepare = read('scripts/prepare-desktop.mjs');
const auditCi = read('scripts/audit-ci.sh');
const release = read('scripts/release.mjs');
const ci = read('.github/workflows/ci.yml');

let checks = 0;
const check = (condition, label) => {
  assert.ok(condition, label);
  checks += 1;
};

// DD-001 — the release chain must require the updater feed, not merely
// tolerate its absence (--optional + no env var = successful release with no
// .sig / latest.json).
check(
  /name:\s*'release:feed',[\s\S]*?NETPULSE_REQUIRE_UPDATER_FEED:\s*'1'/.test(desktopPackage),
  'desktop-package: release:feed must set NETPULSE_REQUIRE_UPDATER_FEED=1',
);

// DD-003 — a failed portable-runtime bundle must stop `desktop:prepare`;
// the system-node fallback is an explicit, visible opt-in only.
check(
  /res\.status !== 0[\s\S]*?NETPULSE_ALLOW_SYSTEM_NODE_FALLBACK[\s\S]*?process\.exit\(res\.status \?\? 1\)/.test(prepare),
  'prepare-desktop: runtime bundling failure must exit non-zero by default',
);
check(
  !prepare.includes('supervisor falls back to system node.'),
  'prepare-desktop: no silent fallback message',
);

// DD-004 — ts-prune exits 0 while reporting unused exports, so printing PASS
// was false-green. It cannot be a hard gate on this monorepo (cross-workspace
// re-exports make every invocation red), so it must be labeled ADVISORY and
// never counted as a passing gate.
const pruneGates = auditCi.match(/run_advisory "ts-prune [^\n]*ts-prune --project/g) ?? [];
check(pruneGates.length === 3, `audit-ci: all three ts-prune checks must be advisory (got ${pruneGates.length})`);
check(!/run "ts-prune/.test(auditCi), 'audit-ci: ts-prune must not be reported as a PASS gate');

// DD-005 — neither a Cargo layout drift nor an unstampable feed endpoint may
// be downgraded to a warning during a release.
check(
  release.includes('could not stamp Cargo.toml version'),
  'release: Cargo version stamping failure must be an error',
);
check(
  /updater endpoint NOT stamped[\s\S]{0,300}process\.exit\(1\)/.test(release),
  'release: updater endpoint stamping failure must exit non-zero',
);

// DD-002 — release-readiness suites must be enforced by CI, not only by a
// human remembering to run desktop:package locally.
for (const gate of ['test:signing', 'test:release', 'test:pipeline']) {
  check(ci.includes(`run: npm run ${gate}`), `ci.yml: gates job must run ${gate}`);
}

console.log(`build-gate-honesty: ${checks} assertions passed`);
