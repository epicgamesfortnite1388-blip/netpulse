#!/usr/bin/env node
/** Regression tests for the built-version gate in desktop:verify. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { findBuiltVersionAsset } from './lib/webDistVersion.mjs';

let checks = 0;
let failed = 0;

function check(name, ok, detail = '') {
  checks += 1;
  if (ok) console.log(`  ok   ${name}`);
  else {
    failed += 1;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'np-web-version-'));
try {
  fs.writeFileSync(path.join(tmp, 'react.js'), 'ze.version="19.2.8";');
  check(
    'an unrelated framework version does not satisfy the gate',
    findBuiltVersionAsset(tmp, '19.2.8') === null,
  );

  fs.writeFileSync(path.join(tmp, 'app.js'), 'const x={appVersion:"3.2.0"};');
  check(
    'the injected appVersion binding satisfies the gate',
    findBuiltVersionAsset(tmp, '3.2.0') === 'app.js',
  );
  check(
    'a different conf version does not match the same stale dist',
    findBuiltVersionAsset(tmp, '3.2.1') === null,
  );
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`desktop-pipeline-version: ${checks - failed}/${checks} checks passed`);
process.exitCode = failed === 0 ? 0 : 1;
