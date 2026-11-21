import { describe, expect, it } from 'vitest';

import { resolveAiRole } from '../src/index';

/**
 * SEC-DD-001 regression. `/api/v1/ai/ask` and `/ai/stream` proxy to an ADMIN
 * upstream that trusts the role this Worker asserts. Before the fix the role
 * came from the request body and defaulted to `admin`, so any authenticated
 * user could ask the Copilot to act as an administrator. The role must be
 * derived from the verified session's D1 row; this pins that derivation
 * independently of the fetch handler.
 */
describe('AI role derivation (privilege boundary)', () => {
  it('downgrades a non-admin who asks for a privileged role', () => {
    expect(resolveAiRole('admin', 'user')).toBe('support');
    expect(resolveAiRole('developer', 'user')).toBe('support');
    expect(resolveAiRole('admin', null)).toBe('support');
    expect(resolveAiRole('admin', undefined)).toBe('support');
  });

  it('defaults a non-admin to support, never admin', () => {
    expect(resolveAiRole(undefined, 'user')).toBe('support');
    expect(resolveAiRole('nonsense', 'user')).toBe('support');
    expect(resolveAiRole(null, 'user')).toBe('support');
  });

  it('lets a verified admin keep the privileged roles they requested', () => {
    expect(resolveAiRole('admin', 'admin')).toBe('admin');
    expect(resolveAiRole('developer', 'admin')).toBe('developer');
    expect(resolveAiRole(undefined, 'admin')).toBe('admin');
  });

  it('keeps the non-privileged roles usable for everyone', () => {
    expect(resolveAiRole('support', 'user')).toBe('support');
    expect(resolveAiRole('diagnostics', 'user')).toBe('diagnostics');
    expect(resolveAiRole('support', 'admin')).toBe('support');
  });
});
