import { describe, expect, it } from 'vitest';

import { maskSourceUrl } from '../src/util/redact';

/**
 * `maskSourceUrl` is the server-side half of "no user can read or copy the raw
 * config". A subscription URL is a credential, so the mask must keep the part
 * that identifies a provider and drop the part that fetches one.
 */
describe('maskSourceUrl', () => {
  it('keeps the provider domain so the user can still recognise the source', () => {
    expect(maskSourceUrl('https://sub.example.com/aVeryLongToken123')).toContain('example.com');
  });

  it('drops the path, the query and the fragment', () => {
    const masked = maskSourceUrl('https://example.com/sub/some/long/path?token=supersecret#frag');
    expect(masked).not.toContain('some/long/path');
    expect(masked).not.toContain('supersecret');
    expect(masked).not.toContain('frag');
  });

  it('collapses the subdomain, because panels put the token there', () => {
    // https://<token>.my-panel.com/… — a leftmost label is frequently the
    // secret, so leaving it visible would hand the credential back.
    const masked = maskSourceUrl('https://k7f2ab9cd.my-panel.example/sub');
    expect(masked).not.toContain('k7f2ab9cd');
    expect(masked).toContain('my-panel.example');
  });

  it('never leaks userinfo', () => {
    const masked = maskSourceUrl('https://admin:hunter2@example.com/sub');
    expect(masked).not.toContain('admin');
    expect(masked).not.toContain('hunter2');
  });

  it('shows an IP host in full — it is the only handle on a self-hosted source', () => {
    expect(maskSourceUrl('http://127.0.0.1:8080/admin')).toContain('127.0.0.1:8080');
  });

  it('fingersprints stably, so the same URL always looks the same', () => {
    const a = maskSourceUrl('https://example.com/sub/one');
    const b = maskSourceUrl('https://example.com/sub/one');
    expect(a).toBe(b);
  });

  it('distinguishes two different URLs on the same host', () => {
    const a = maskSourceUrl('https://example.com/sub/one');
    const b = maskSourceUrl('https://example.com/sub/two');
    expect(a).not.toBe(b);
  });

  it('parses a scheme-less URL instead of falling back to an opaque blob', () => {
    expect(maskSourceUrl('example.com/sub/token')).toContain('example.com');
  });

  it('emits no base64 blob, which a masked value must never look like', () => {
    const masked = maskSourceUrl('https://sub.example.com/eyJhbGciOiJIUzI1NiJ9.payloadpart.signaturepart');
    expect(masked).not.toMatch(/[A-Za-z0-9+/]{40,}={0,2}/);
  });

  it('discloses nothing for an unparseable entry', () => {
    expect(maskSourceUrl('::::not a url::::')).toMatch(/^•••••• · [0-9a-f]{8}$/);
  });

  it('is empty for an empty entry rather than rendering a dangling separator', () => {
    expect(maskSourceUrl('')).toBe('');
    expect(maskSourceUrl('   ')).toBe('');
  });
});