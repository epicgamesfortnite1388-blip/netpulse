import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app';

/**
 * Desktop launch-secret gate (follow-up to security finding H1).
 *
 * In desktop mode (NETPULSE_DESKTOP=1) the Tauri shell injects a per-launch
 * ephemeral secret into the webview (typed IPC) and this process (stdin).
 * Cookies are removed from the trust chain entirely:
 *   - POST /auth/session without the launch secret → refused, no cookie minted
 *   - POST /auth/session with the launch secret → allowed (the desktop UI may
 *     still opt into a cookie, but nothing in the browser can obtain one)
 *   - requireAuth ignores cookies; only the Bearer launch secret authenticates
 *
 * The attack this closes: any page running in any browser on the machine used
 * to be able to POST /auth/session from loopback and walk away with a cookie
 * that satisfied every mutating route. Now no credential a browser can request
 * exists at all.
 */
describe('desktop launch-secret gate', () => {
  let app: Awaited<ReturnType<typeof buildApp>>['app'];
  let token: string;
  let prevDesktop: string | undefined;

  beforeAll(async () => {
    prevDesktop = process.env['NETPULSE_DESKTOP'];
    process.env['NETPULSE_DESKTOP'] = '1';
    ({ app, daemonToken: token } = await buildApp({ configOverrides: { dataDir: 'C:/tmp/np-launchsecret-test' } }));
  });

  afterAll(async () => {
    if (prevDesktop === undefined) delete process.env['NETPULSE_DESKTOP'];
    else process.env['NETPULSE_DESKTOP'] = prevDesktop;
  });

  it('refuses session issuance without the launch secret — no cookie is minted', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/session',
      remoteAddress: '127.0.0.1',
      headers: { origin: 'http://tauri.localhost' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: { code: 'launch_secret_required' } });
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('refuses session issuance even from a browser-looking cross-site request withSecFetch', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/session',
      remoteAddress: '127.0.0.1',
      headers: { 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('issues a session WITH the launch secret (the shell-injected credential)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/session',
      remoteAddress: '127.0.0.1',
      headers: { origin: 'http://tauri.localhost', authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true });
  });

  it('requireAuth ignores cookies entirely — only the Bearer launch secret authenticates', async () => {
    // Mint a cookie first (legitimately, with the secret).
    const mint = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/session',
      remoteAddress: '127.0.0.1',
      headers: { origin: 'http://tauri.localhost', authorization: `Bearer ${token}` },
    });
    const setCookie = mint.headers['set-cookie'];
    const cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie ?? '').split(';')[0] ?? '';
    expect(cookie).toContain('netpulse_session=');

    // The same cookie WITHOUT the bearer must NOT authenticate a mutating call.
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/settings',
      remoteAddress: '127.0.0.1',
      headers: { origin: 'http://tauri.localhost', cookie },
    });
    expect(res.statusCode).toBe(401);

    // And with the bearer it does.
    const ok = await app.inject({
      method: 'GET',
      url: '/api/v1/meta',
      remoteAddress: '127.0.0.1',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(ok.statusCode).toBe(200);
  });
});
