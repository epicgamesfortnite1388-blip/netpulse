/** Locate the built asset whose injected app version matches the release conf. */
import fs from 'node:fs';
import path from 'node:path';

export function findBuiltVersionAsset(assetsDir, version) {
  if (!fs.existsSync(assetsDir)) return null;
  // Anchor on the injected binding. A loose search for a quoted version can be
  // fooled by React/Router's own version literals and pass a stale dist.
  const marker = `appVersion:"${version}"`;
  for (const file of fs.readdirSync(assetsDir).filter((f) => f.endsWith('.js'))) {
    const text = fs.readFileSync(path.join(assetsDir, file), 'utf8');
    if (text.includes(marker)) return file;
  }
  return null;
}
