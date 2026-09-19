import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Cpu, Plug, Zap } from 'lucide-react';
import { useState } from 'react';

import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { useToast } from '@/components/Toaster';
import { api } from '@/lib/api';

import type { ProxyTunnelStatus, VpnStatus } from '@netpulse/shared';

/**
 * "Use this node now" — the two ways a node can be handed to an engine.
 *
 * The distinction matters and the UI keeps it visible:
 *
 *  - Tunnel now: starts a local core (xray / sing-box / V2Ray) against this node
 *    directly, using the credential in the vault. Nothing to configure, nothing
 *    stored — it exists until it is stopped.
 *  - Add to engine: rebuilds the node's share link from the vault and stores it
 *    as a sing-box engine profile, so the node survives as a named profile with
 *    its own Connect button.
 *
 * Both are refusals-aware: when the server says why it cannot do something
 * (credential missing from the vault, protocol the core cannot dial), that
 * reason is what the user sees — no generic "failed".
 */

interface CreatedProfile {
  id: string;
  name: string;
  providerId: string;
}

export function NodeEngineActions({ nodeId, className = '' }: { nodeId: string; className?: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [profile, setProfile] = useState<CreatedProfile | null>(null);

  const tunnel = useMutation({
    mutationFn: () => api.post<{ tunnel: ProxyTunnelStatus }>('/vpn/tunnel/start', { nodeId, systemProxy: false }),
    onSuccess: (data) => {
      void qc.invalidateQueries({ queryKey: ['tunnel', 'status'] });
      const exit = data.tunnel?.exitIp ?? 'unverified';
      if (data.tunnel?.state === 'active') toast('ok', `Tunnel up through this node`, `Exit ${exit}${data.tunnel.engine ? ` via ${data.tunnel.engine}` : ''}.`);
      else toast('warn', 'Tunnel started but no exit IP was observed', 'The node answered no request through the core — treat it as unverified.');
    },
    onError: (err) => toast('error', 'Could not tunnel through this node', err instanceof Error ? err.message : undefined),
  });

  const addToEngine = useMutation({
    mutationFn: () => api.post<{ profile: CreatedProfile }>('/vpn/profiles/from-node', { nodeId }),
    onSuccess: (data) => {
      setProfile(data.profile);
      void qc.invalidateQueries({ queryKey: ['vpn', 'profiles'] });
      void qc.invalidateQueries({ queryKey: ['vpn', 'providers'] });
      toast('ok', `Added to the sing-box engine`, `Profile "${data.profile.name}" is ready to connect.`);
    },
    onError: (err) => toast('error', 'Could not add this node to an engine', err instanceof Error ? err.message : undefined),
  });

  const connect = useMutation({
    mutationFn: (profileId: string) => api.post<{ status: VpnStatus }>('/vpn/connect', { profileId }),
    onSuccess: (data) => {
      void qc.invalidateQueries({ queryKey: ['vpn'] });
      if (data.status.verification === 'verified') toast('ok', 'Connected', data.status.verificationNote ?? undefined);
      else toast('warn', 'Connected, exit unverified', data.status.verificationNote ?? undefined);
    },
    onError: (err) => toast('error', 'Connect failed', err instanceof Error ? err.message : undefined),
  });

  return (
    <div className={`flex flex-wrap items-center gap-2 ${className}`}>
      <Button
        variant="secondary"
        size="sm"
        onClick={() => tunnel.mutate()}
        loading={tunnel.isPending}
        title="Start a local core against this node right now — nothing is stored"
      >
        <Zap size={14} />
        Tunnel now
      </Button>

      {profile ? (
        <>
          <Badge tone="ok">
            <Cpu size={11} /> in sing-box
          </Badge>
          <Button
            variant="primary"
            size="sm"
            onClick={() => connect.mutate(profile.id)}
            loading={connect.isPending}
            title="Connect the profile this node just created"
          >
            <Plug size={14} />
            Connect
          </Button>
        </>
      ) : (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => addToEngine.mutate()}
          loading={addToEngine.isPending}
          title="Store this node as a sing-box engine profile with its own Connect button"
        >
          <Cpu size={14} />
          Add to engine
        </Button>
      )}
    </div>
  );
}
