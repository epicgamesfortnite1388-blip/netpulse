/**
 * Centralized DNS resolution with tunnel enforcement.
 *
 * When a tunnel is active and requires the client to resolve
 * names (because the SOCKS server refuses hostname-form CONNECT), ALL DNS
 * lookups must go through the tunnel to avoid leaks. This module provides a
 * single chokepoint for name resolution with explicit policy per connection
 * state.
 */
import type dns from 'node:dns';
import dnsPromises from 'node:dns/promises';

import { resolveThroughTunnel } from '../vpn/aetherProvider';

export type TunnelDnsPolicy =
  | { mode: 'direct' } // only when explicitly allowed and no tunnel requires tunnelling DNS
  | { mode: 'tunnel'; port: number; resolvers?: string[]; forceAll?: boolean } // must resolve through tunnel
  | { mode: 'block' }; // tunnel unavailable and policy requires tunnel

export interface TunnelDnsResolver {
  getPolicy(): TunnelDnsPolicy;
  setPolicy(policy: TunnelDnsPolicy): void;
  forceTunnelDns(port?: number): void;
  allowDirectDns(): void;
  resolve4(hostname: string): Promise<string[]>;
  resolve6(hostname: string): Promise<string[]>;
  resolve(hostname: string, family?: number): Promise<string[]>;
  lookup(hostname: string, options?: dns.LookupOptions): Promise<dns.LookupAddress | dns.LookupAddress[]>;
}

class DefaultTunnelDnsResolver implements TunnelDnsResolver {
  private policy: TunnelDnsPolicy = { mode: 'direct' };
  private forceTunnel = false;
  private tunnelPort: number | null = null;

  getPolicy(): TunnelDnsPolicy {
    if (this.forceTunnel && this.tunnelPort) {
      return { mode: 'tunnel', port: this.tunnelPort, forceAll: true };
    }
    return this.policy;
  }

  setPolicy(policy: TunnelDnsPolicy): void {
    this.policy = policy;
    if (policy.mode === 'tunnel') {
      this.forceTunnel = true;
      this.tunnelPort = policy.port;
    } else {
      // The explicit policy is authoritative. Leaving a previous
      // forceTunnelDns() override in place made setPolicy({ mode: 'block' })
      // silently resolve as 'tunnel' — fail-open on a state that must be
      // fail-closed.
      this.forceTunnel = false;
      this.tunnelPort = null;
    }
  }

  forceTunnelDns(port = 1819): void {
    this.forceTunnel = true;
    this.tunnelPort = port;
    this.policy = { mode: 'tunnel', port, forceAll: true };
  }

  allowDirectDns(): void {
    this.forceTunnel = false;
    this.tunnelPort = null;
    this.policy = { mode: 'direct' };
  }

  private async resolveThroughTunnelIfNeeded(hostname: string, family: 4 | 6): Promise<string[]> {
    if (this.policy.mode === 'tunnel') {
      // Aether's tunnel refuses hostname CONNECT; resolve over DNS-over-TCP through the tunnel
      try {
        const res = await resolveThroughTunnel(this.policy.port, hostname, '1.1.1.1', 5_000);
        if (!res || !res.addresses) throw new Error('no addresses');
        const ips = res.addresses;
        // Filter by family if needed. An empty filtered set is an ERROR, never
        // an empty array: lookup({ family: 4 }) would otherwise build
        // { address: undefined } and hand an invalid address to the caller.
        const filtered = family === 4
          ? ips.filter((ip: string) => !ip.includes(':'))
          : ips.filter((ip: string) => ip.includes(':'));
        if (filtered.length === 0) {
          throw new Error('tunnel DNS returned no IPv' + family + ' addresses for ' + hostname);
        }
        return filtered;
      } catch (err) {
        throw new Error(`tunnel DNS resolution failed for ${hostname}: ${err instanceof Error ? err.message : String(err)}`);
      }
    } else if (this.policy.mode === 'block') {
      throw new Error(`DNS resolution blocked: tunnel required but unavailable (hostname=${hostname})`);
    } else {
      // direct mode - use system resolver
      if (family === 4) {
        const res = await dnsPromises.resolve4(hostname);
        return res;
      } else if (family === 6) {
        const res = await dnsPromises.resolve6(hostname);
        return res;
      }
      const res = await dnsPromises.resolve(hostname);
      return res;
    }
  }

  async resolve4(hostname: string): Promise<string[]> {
    return this.resolveThroughTunnelIfNeeded(hostname, 4);
  }

  async resolve6(hostname: string): Promise<string[]> {
    return this.resolveThroughTunnelIfNeeded(hostname, 6);
  }

  async resolve(hostname: string, family?: number): Promise<string[]> {
    if (family === 4 || family === 6) {
      return this.resolveThroughTunnelIfNeeded(hostname, family);
    }
    // Try to get both
    if (this.policy.mode === 'tunnel') {
      try {
        const res = await resolveThroughTunnel(this.policy.port, hostname, '1.1.1.1', 5_000);
        if (!res || !res.addresses) throw new Error('no addresses');
        return res.addresses;
      } catch (err) {
        throw new Error(`tunnel DNS resolution failed for ${hostname}: ${err instanceof Error ? err.message : String(err)}`);
      }
    } else if (this.policy.mode === 'block') {
      throw new Error(`DNS resolution blocked: tunnel required but unavailable (hostname=${hostname})`);
    } else {
      const res = await dnsPromises.resolve(hostname);
      return res;
    }
  }

  async lookup(hostname: string, options?: dns.LookupOptions): Promise<dns.LookupAddress | dns.LookupAddress[]> {
    const family = typeof options?.family === 'number' ? options.family : 0;
    const all = options?.all === true;

    if (family === 4) {
      const addrs = await this.resolve4(hostname);
      if (all) return addrs.map((address) => ({ address, family: 4 }));
      return { address: addrs[0]!, family: 4 };
    } else if (family === 6) {
      const addrs = await this.resolve6(hostname);
      if (all) return addrs.map((address) => ({ address, family: 6 }));
      return { address: addrs[0]!, family: 6 };
    } else {
      // family 0 or unspecified - try to get addresses
      if (this.policy.mode === 'tunnel') {
        try {
          const res = await resolveThroughTunnel(this.policy.port, hostname, '1.1.1.1', 5_000);
          if (!res || !res.addresses) throw new Error('no addresses');
          const ips = res.addresses;
          if (all) {
            return ips.map((address: string) => ({ address, family: address.includes(':') ? 6 : 4 }));
          }
          return { address: ips[0]!, family: ips[0]!.includes(':') ? 6 : 4 };
        } catch (err) {
          throw new Error(`tunnel DNS resolution failed for ${hostname}: ${err instanceof Error ? err.message : String(err)}`);
        }
      } else if (this.policy.mode === 'block') {
        throw new Error(`DNS resolution blocked: tunnel required but unavailable (hostname=${hostname})`);
      } else {
        if (all) {
          return dnsPromises.lookup(hostname, { all: true });
        }
        return dnsPromises.lookup(hostname);
      }
    }
  }
}

export const tunnelDns = new DefaultTunnelDnsResolver();
