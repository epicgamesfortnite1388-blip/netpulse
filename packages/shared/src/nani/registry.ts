/**
 * NANI — centralized API registry.
 *
 * Declares every external/internal API the application depends on, its
 * permitted routes, health-check policy, and current state. No secrets are
 * stored here: authentication is referenced by key id only, and the actual
 * credential lives in the OS credential store / settings vault.
 *
 * Pure data model — no I/O. The host (apps/api) supplies credentials and
 * performs health checks.
 */

import type { RouteCandidate, RouteFeatures, RouteKind } from './types';

export type ApiAuthType = 'none' | 'bearer' | 'api-key' | 'oauth2' | 'basic';
export type HealthCheckMethod = 'http-get' | 'http-post' | 'tcp-only' | 'tls-only' | 'custom';
export type ApiRegistryHealth = 'healthy' | 'degraded' | 'unhealthy' | 'unknown';

export interface ApiUpstreamRoute {
  id: string;
  kind: RouteKind;
  endpoint: string;
  port: number;
  tlsVerification: boolean;
  authorized: boolean;
  authorizationReason?: string;
  features?: RouteFeatures;
  lastVerifiedAt?: number;
  consecutiveFailures: number;
  circuitState: 'closed' | 'open' | 'half-open';
}

export interface ApiRateLimitPolicy {
  maxRequests: number;
  windowMs: number;
  honorsRetryAfter: boolean;
  cooldownMs: number;
}

export interface ApiRetryPolicy {
  baseMs: number;
  factor: number;
  maxMs: number;
  maxAttempts: number;
  jitter: number;
}

export interface ApiRegistryEntry {
  id: string;
  provider: string;
  endpoint: string;
  authType: ApiAuthType;
  authKeyId?: string;
  healthCheck: HealthCheckMethod;
  healthCheckPath?: string;
  expectedResponse?: string;
  timeoutMs: number;
  routes: ApiUpstreamRoute[];
  directPermitted: boolean;
  rateLimit: ApiRateLimitPolicy;
  retry: ApiRetryPolicy;
  dependsOn: string[];
  dependedBy: string[];
  health: ApiRegistryHealth;
  lastVerifiedAt?: number;
  lastFailureCategory?: string;
  consecutiveFailures: number;
  autoRecoveryPermitted: boolean;
  autoRecoveryPaused: boolean;
}

export interface ApiRegistry {
  entries: Map<string, ApiRegistryEntry>;
  defaultRoutePreference: RouteKind[];
  safety: {
    tlsVerificationMandatory: boolean;
    maxConcurrentChecks: number;
    maxConcurrentRecoveries: number;
    defaultFailureCooldownMs: number;
  };
}

export function createApiRegistry(): ApiRegistry {
  return {
    entries: new Map(),
    defaultRoutePreference: ['direct', 'upstream-proxy', 'ipv6', 'alternate-dns'],
    safety: {
      tlsVerificationMandatory: true,
      maxConcurrentChecks: 10,
      maxConcurrentRecoveries: 3,
      defaultFailureCooldownMs: 5 * 60 * 1000,
    },
  };
}

export function registerApi(
  registry: ApiRegistry,
  entry: Omit<ApiRegistryEntry, 'dependedBy'> & { dependedBy?: string[] },
): ApiRegistryEntry | undefined {
  const previous = registry.entries.get(entry.id);
  const normalized: ApiRegistryEntry = {
    ...entry,
    dependedBy: entry.dependedBy ?? [],
    consecutiveFailures: entry.consecutiveFailures ?? 0,
    autoRecoveryPermitted: entry.autoRecoveryPermitted ?? true,
    autoRecoveryPaused: entry.autoRecoveryPaused ?? false,
    health: entry.health ?? 'unknown',
  };
  registry.entries.set(entry.id, normalized);
  return previous;
}

export function unregisterApi(registry: ApiRegistry, id: string): boolean {
  return registry.entries.delete(id);
}

export function getApi(registry: ApiRegistry, id: string): ApiRegistryEntry | undefined {
  return registry.entries.get(id);
}

export function listApis(registry: ApiRegistry): ApiRegistryEntry[] {
  return Array.from(registry.entries.values());
}

export function setApiHealth(
  registry: ApiRegistry,
  id: string,
  health: ApiRegistryHealth,
  opts: { lastFailureCategory?: string; lastVerifiedAt?: number; consecutiveFailures?: number } = {},
): boolean {
  const entry = registry.entries.get(id);
  if (!entry) return false;
  entry.health = health;
  if (opts.lastFailureCategory !== undefined) entry.lastFailureCategory = opts.lastFailureCategory;
  if (opts.lastVerifiedAt !== undefined) entry.lastVerifiedAt = opts.lastVerifiedAt;
  if (opts.consecutiveFailures !== undefined) entry.consecutiveFailures = opts.consecutiveFailures;
  return true;
}

export function verifyRoute(
  registry: ApiRegistry,
  apiId: string,
  routeId: string,
  features: Partial<RouteFeatures>,
  at: number,
): boolean {
  const entry = registry.entries.get(apiId);
  if (!entry) return false;
  const route = entry.routes.find((r) => r.id === routeId);
  if (!route) return false;
  route.lastVerifiedAt = at;
  route.consecutiveFailures = 0;
  route.circuitState = 'closed';
  if (features) {
    route.features = {
      ...(route.features ?? { successPrior: 0.5, latencyMs: 0, latencyStdMs: 0, jitterMs: 0, packetLoss: 0, recoveryMs: 0, resourceCost: 0, risk: 0 }),
      ...features,
    };
  }
  return true;
}

export function failRoute(
  registry: ApiRegistry,
  apiId: string,
  routeId: string,
  at: number,
): boolean {
  const entry = registry.entries.get(apiId);
  if (!entry) return false;
  const route = entry.routes.find((r) => r.id === routeId);
  if (!route) return false;
  route.consecutiveFailures += 1;
  route.lastVerifiedAt = at;
  return true;
}

export function openCircuit(registry: ApiRegistry, apiId: string, routeId: string): boolean {
  const entry = registry.entries.get(apiId);
  if (!entry) return false;
  const route = entry.routes.find((r) => r.id === routeId);
  if (!route) return false;
  route.circuitState = 'open';
  return true;
}

export function closeCircuit(registry: ApiRegistry, apiId: string, routeId: string): boolean {
  const entry = registry.entries.get(apiId);
  if (!entry) return false;
  const route = entry.routes.find((r) => r.id === routeId);
  if (!route) return false;
  route.circuitState = 'closed';
  route.consecutiveFailures = 0;
  return true;
}

export function computeDependencyGraph(registry: ApiRegistry): void {
  for (const entry of registry.entries.values()) {
    entry.dependedBy = [];
  }
  for (const entry of registry.entries.values()) {
    for (const dep of entry.dependsOn) {
      const target = registry.entries.get(dep);
      if (target && !target.dependedBy.includes(entry.id)) {
        target.dependedBy.push(entry.id);
      }
    }
  }
}

export function authorizedRoutes(registry: ApiRegistry, apiId: string): ApiUpstreamRoute[] {
  const entry = registry.entries.get(apiId);
  if (!entry) return [];
  const order = new Map(
    registry.defaultRoutePreference.map((k, i) => [k, i]),
  );
  return [...entry.routes]
    .filter((r) => r.authorized && r.tlsVerification)
    .sort((a, b) => {
      const oa = order.get(a.kind) ?? 999;
      const ob = order.get(b.kind) ?? 999;
      return oa - ob;
    });
}

