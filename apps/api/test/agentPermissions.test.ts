import { describe, expect, it, vi } from 'vitest';

import { DEFAULT_SETTINGS, type AppSettings } from '@netpulse/shared';

import { AgentPermissions, AGENT_CAPABILITIES, type AgentCapability } from '../src/services/ai-agent/permissions';
import { NodeTestScheduler } from '../src/services/nodeTestScheduler';

import type { Logger } from '../src/logger';
import type { NodesService } from '../src/services/nodesService';

/**
 * The agent's permission contract.
 *
 * These tests are the enforcement's specification. If one of them is ever
 * "fixed" by letting a caller do more, the agent has gained a capability the user
 * did not grant — which is exactly what this file exists to prevent.
 */

const HOUR = 60 * 60 * 1000;

function settings(over: Partial<AppSettings['automation']['agent']> = {}): AppSettings {
  const base = structuredClone(DEFAULT_SETTINGS);
  base.automation.agent = { ...base.automation.agent, ...over };
  return base;
}

function logger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;
}

function make(opts: { agent?: Partial<AppSettings['automation']['agent']>; now?: () => number; settingsThrows?: boolean } = {}) {
  const log = logger();
  let current = settings(opts.agent);
  const permissions = new AgentPermissions({
    settings: () => {
      if (opts.settingsThrows) throw new Error('settings unreadable');
      return current;
    },
    now: opts.now ?? (() => 1_000_000),
    log,
  });
  return { permissions, log, set: (next: AppSettings) => { current = next; } };
}

describe('permanently forbidden capabilities', () => {
  const forbidden: AgentCapability[] = ['exec:shell', 'exec:elevated', 'read:credential', 'write:settings', 'install:core'];

  it.each(forbidden)('%s is denied for every origin, with a reason', (capability) => {
    const { permissions } = make();
    for (const origin of ['autonomous', 'user'] as const) {
      const decision = permissions.authorize(capability, { origin });
      expect(decision.allowed).toBe(false);
      expect(decision.code).toBe('forbidden');
      expect(decision.reason).toContain('permanently denied');
    }
  });

  it('cannot be granted by a settings file, because no code path reads settings for it', () => {
    // The strongest thing a corrupt/hostile settings blob can do is not pause the
    // agent. There is no field that maps to a forbidden capability.
    const hostile = settings() as unknown as Record<string, unknown>;
    (hostile['automation'] as Record<string, unknown>)['agent'] = {
      paused: false,
      fetchPerHour: 120,
      probesPerHour: 600,
      verifyPerHour: 120,
      allowShell: true,
      allowElevated: true,
    };
    const { permissions } = make();
    permissions.snapshot();
    expect(permissions.authorize('exec:shell', { origin: 'user' }).allowed).toBe(false);
    expect(permissions.authorize('exec:elevated', { origin: 'user' }).allowed).toBe(false);
  });
});

describe('unknown and malformed requests', () => {
  it('denies a capability it does not have', () => {
    const { permissions } = make();
    const decision = permissions.authorize('network:exfiltrate' as AgentCapability, { origin: 'user' });
    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe('unknown-capability');
  });

  it.each([0, -2, 1.5, Number.NaN])('denies a count of %s', (count) => {
    const { permissions } = make();
    const decision = permissions.authorize('network:probe-endpoint', { origin: 'autonomous', count });
    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe('invalid-request');
  });

  it('denies a batch larger than the per-call ceiling instead of silently clamping it', () => {
    const { permissions } = make({ agent: { probesPerHour: 600 } });
    const decision = permissions.authorize('network:probe-endpoint', { origin: 'autonomous', count: 51 });
    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe('invalid-request');
    expect(decision.reason).toContain('at most 50');
  });
});

describe('user-only capabilities', () => {
  it('never runs a third-party connection unattended', () => {
    const { permissions } = make();
    const unattended = permissions.authorize('connect:third-party', { origin: 'autonomous' });
    expect(unattended.allowed).toBe(false);
    expect(unattended.code).toBe('requires-user');

    const byUser = permissions.authorize('connect:third-party', { origin: 'user' });
    expect(byUser.allowed).toBe(true);
  });
});

describe('pause', () => {
  it('stops unattended network work but leaves manual verification working', () => {
    const { permissions } = make({ agent: { paused: true } });
    const probe = permissions.authorize('network:probe-endpoint', { origin: 'autonomous', count: 4 });
    expect(probe.allowed).toBe(false);
    expect(probe.code).toBe('paused');

    const fetch = permissions.authorize('network:fetch-source', { origin: 'autonomous', count: 1 });
    expect(fetch.allowed).toBe(false);

    // A pause is not a lockout: the user can still ask for a connection test.
    const verify = permissions.authorize('network:verify-traffic', { origin: 'user', count: 2 });
    expect(verify.allowed).toBe(true);
  });

  it('treats unreadable settings as paused, not as unlimited', () => {
    const { permissions } = make({ settingsThrows: true });
    const decision = permissions.authorize('network:probe-endpoint', { origin: 'autonomous', count: 1 });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain('could not be read');
  });
});

describe('hourly budgets', () => {
  it('enforces the allowance, refuses without spending, and reports what is left', () => {
    const { permissions } = make({ agent: { probesPerHour: 5 } });

    const first = permissions.authorize('network:probe-endpoint', { origin: 'autonomous', count: 3 });
    expect(first.allowed).toBe(true);
    expect(first.remaining).toBe(2);

    const over = permissions.authorize('network:probe-endpoint', { origin: 'autonomous', count: 3 });
    expect(over.allowed).toBe(false);
    expect(over.code).toBe('budget-exhausted');
    expect(over.remaining).toBe(2);

    // The refusal must not have consumed anything: exactly 2 are still available.
    const fits = permissions.authorize('network:probe-endpoint', { origin: 'autonomous', count: 2 });
    expect(fits.allowed).toBe(true);
    expect(fits.remaining).toBe(0);

    const none = permissions.authorize('network:probe-endpoint', { origin: 'autonomous', count: 1 });
    expect(none.allowed).toBe(false);
    expect(none.remaining).toBe(0);
    expect(none.retryAfterMs).toBeGreaterThan(0);
  });

  it('keeps separate allowances per capability', () => {
    const { permissions } = make({ agent: { probesPerHour: 1, fetchPerHour: 2 } });
    expect(permissions.authorize('network:probe-endpoint', { origin: 'autonomous', count: 1 }).allowed).toBe(true);
    expect(permissions.authorize('network:probe-endpoint', { origin: 'autonomous', count: 1 }).allowed).toBe(false);
    expect(permissions.authorize('network:fetch-source', { origin: 'autonomous', count: 1 }).allowed).toBe(true);
  });

  it('resets on the next hour boundary', () => {
    let now = 1_000_000;
    const { permissions } = make({ agent: { probesPerHour: 2 }, now: () => now });
    expect(permissions.authorize('network:probe-endpoint', { origin: 'autonomous', count: 2 }).allowed).toBe(true);
    expect(permissions.authorize('network:probe-endpoint', { origin: 'autonomous', count: 1 }).allowed).toBe(false);
    now += HOUR + 1;
    expect(permissions.authorize('network:probe-endpoint', { origin: 'autonomous', count: 2 }).allowed).toBe(true);
  });

  it('gives back reserved-but-unused allowance, without ever creating any', () => {
    const { permissions } = make({ agent: { verifyPerHour: 20 } });

    const gate = permissions.authorize('network:verify-traffic', { origin: 'user', count: 10 });
    expect(gate.allowed).toBe(true);
    expect(gate.remaining).toBe(10);

    // The pool dialled 2 of the 10 reserved; the other 8 were never spent.
    expect(permissions.release('network:verify-traffic', 8)).toBe(8);
    expect(permissions.snapshot().capabilities.find((c) => c.id === 'network:verify-traffic')?.usedThisHour).toBe(2);
    // 18 are live again: one more 10-candidate request fits (per-call cap is 10).
    const again = permissions.authorize('network:verify-traffic', { origin: 'user', count: 10 });
    expect(again.allowed).toBe(true);
    expect(again.remaining).toBe(8);

    // A release can only give back what this hour consumed (12 total), never more.
    expect(permissions.release('network:verify-traffic', 100)).toBe(12);
    expect(permissions.authorize('network:verify-traffic', { origin: 'user', count: 1 }).allowed).toBe(true);
  });

  it('ignores a release for a capability that has no budget', () => {
    const { permissions } = make({});
    expect(permissions.release('read:local-state', 5)).toBe(0);
    expect(permissions.release('exec:shell', 1)).toBe(0);
  });

  it('re-clamps a stored budget that bypassed validation', () => {
    const { permissions } = make({ agent: { probesPerHour: 99_999 } });
    // The schema caps at 600; a loader that skipped it must not yield infinity.
    expect(permissions.snapshot().capabilities.find((c) => c.id === 'network:probe-endpoint')?.limitPerHour).toBe(600);
  });
});

describe('inspection', () => {
  it('records denials for inspection and logs them', () => {
    const { permissions, log } = make({ agent: { paused: true } });
    permissions.authorize('network:probe-endpoint', { origin: 'autonomous', count: 1 });
    const snapshot = permissions.snapshot();
    expect(snapshot.recent).toHaveLength(1);
    expect(snapshot.recent[0]!.code).toBe('paused');
    expect(snapshot.note).toContain('paused');
    expect(log.warn).toHaveBeenCalled();
  });

  it('lists every capability with its grant state and the forbidden count', () => {
    const { permissions } = make();
    const snapshot = permissions.snapshot();
    expect(snapshot.capabilities).toHaveLength(AGENT_CAPABILITIES.length);
    expect(snapshot.capabilities.find((c) => c.id === 'connect:third-party')?.granted).toBe('user-only');
    expect(snapshot.capabilities.find((c) => c.id === 'exec:shell')?.granted).toBe('forbidden');
    expect(snapshot.capabilities.find((c) => c.id === 'read:local-state')?.granted).toBe('always');
    expect(snapshot.capabilities.find((c) => c.id === 'network:probe-endpoint')?.granted).toBe('granted');
    expect(snapshot.note).toContain('5 capabilities are permanently denied');
  });

  it('does not spend allowance or write audit entries when previewing with can()', () => {
    const { permissions } = make({ agent: { probesPerHour: 3 } });
    expect(permissions.can('network:probe-endpoint', 'autonomous').allowed).toBe(true);
    expect(permissions.can('network:probe-endpoint', 'autonomous').allowed).toBe(true);
    const snapshot = permissions.snapshot();
    expect(snapshot.capabilities.find((c) => c.id === 'network:probe-endpoint')?.usedThisHour).toBe(0);
    expect(snapshot.recent).toHaveLength(0);
  });

  it('reports the real defaults from the shipped settings', () => {
    const { permissions } = make();
    const snapshot = permissions.snapshot();
    expect(snapshot.paused).toBe(false);
    expect(snapshot.capabilities.find((c) => c.id === 'network:probe-endpoint')?.limitPerHour).toBe(
      DEFAULT_SETTINGS.automation.agent.probesPerHour,
    );
    expect(snapshot.note).toContain('probes');
  });
});

describe('enforcement in the autonomous tester', () => {
  function scheduler(permissions: AgentPermissions, probe: ReturnType<typeof vi.fn>) {
    const nodes = {
      pickNodesForAutoTest: vi.fn(({ bucket }: { bucket: string }) =>
        bucket === 'never-validated' ? [{ id: 'node:a' }, { id: 'node:b' }] : [],
      ),
      testNode: probe,
      retireStaleNodes: vi.fn(() => 0),
    } as unknown as NodesService;

    return new NodeTestScheduler({
      nodes,
      settings: { get: () => settings() },
      log: logger(),
      permissions,
    });
  }

  it('does not dial a single endpoint when the policy refuses the batch', async () => {
    const probe = vi.fn(async () => ({ status: 'done' }));
    const { permissions } = make({ agent: { paused: true } });
    const result = await scheduler(permissions, probe).tick();

    expect(result.denied).toContain('paused');
    expect(result.tested).toBe(0);
    expect(probe).not.toHaveBeenCalled();
  });

  it('dials the batch when the policy allows it, and reports no denial', async () => {
    const probe = vi.fn(async () => ({ status: 'done' }));
    const { permissions } = make();
    const result = await scheduler(permissions, probe).tick();

    expect(result.denied).toBeNull();
    expect(probe).toHaveBeenCalledTimes(2);
    expect(permissions.snapshot().capabilities.find((c) => c.id === 'network:probe-endpoint')?.usedThisHour).toBe(2);
  });

  it('refuses a batch that exceeds the remaining allowance instead of shrinking it silently', async () => {
    const probe = vi.fn(async () => ({ status: 'done' }));
    const { permissions } = make({ agent: { probesPerHour: 1 } });
    const result = await scheduler(permissions, probe).tick();

    expect(result.denied).toContain('budget-exhausted');
    expect(probe).not.toHaveBeenCalled();
  });
});
