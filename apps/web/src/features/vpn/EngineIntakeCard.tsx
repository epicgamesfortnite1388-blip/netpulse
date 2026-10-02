import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ClipboardPaste, Cpu, Plus, TriangleAlert } from 'lucide-react';
import { useMemo, useState } from 'react';

import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { useToast } from '@/components/Toaster';
import { api } from '@/lib/api';

import { DataList, DataRow, Notice, Panel, Section } from '@/components/ui/Surface';
import { useProxyEngines } from './useVpnData';


/**
 * Engine intake — put a config you found into the engines, now.
 *
 * Two targets, because they answer different needs:
 *
 *   - Node pool: the config becomes a stored node, so the local cores (xray,
 *     sing-box, V2Ray) can test it, measure it and tunnel through it. This is
 *     what most share links should become — the app only reports what it
 *     actually measured through a core.
 *   - sing-box profile: the link is stored as a named engine profile with its
 *     own Connect button (one link at a time — a profile is a single config).
 *
 * Results are the server's own counts (added / already known / couldn't parse).
 * Nothing here invents a node, a latency or a success.
 *
 * This component is the ONE intake surface. It is mounted from two places
 * because both are legitimate entry points — the VPN Overview tab (where a user
 * looks first) and the sing-box tab (where the profile target lives) — so a
 * change to intake behaviour belongs here and reaches both tabs at once. Do not
 * fork it into the two surfaces.
 */

interface ImportResult {
  imported: number;
  duplicates: number;
  invalid: number;
  nodeIds: string[];
}

interface NodeSummary {
  id: string;
  protocol: string;
  host: string;
  port: number;
}

type Target = 'nodes' | 'profile';

export function EngineIntakeCard() {
  const qc = useQueryClient();
  const toast = useToast();
  const enginesQuery = useProxyEngines();

  const [text, setText] = useState('');
  const [target, setTarget] = useState<Target>('nodes');
  const [result, setResult] = useState<{ target: Target; lines: string[]; nodes: NodeSummary[] } | null>(null);

  const links = useMemo(
    () =>
      text
        .split(/[\r\n\s]+/)
        .map((l) => l.trim())
        .filter((l) => l.includes('://')),
    [text],
  );

  const coresInstalled = (enginesQuery.data?.engines ?? []).filter((e) => e.available);
  const effective = enginesQuery.data?.effective ?? null;

  const importNodes = useMutation({
    mutationFn: (configs: string[]) => api.post<ImportResult>('/nodes/import', { configs }),
    onSuccess: (data, configs) => {
      void qc.invalidateQueries({ queryKey: ['nodes'] });
      const lines = [
        `${data.imported} added to the node pool`,
        `${data.duplicates} already known (kept, not duplicated)`,
        `${data.invalid} could not be parsed`,
      ];
      const nodes = data.nodeIds.map((id) => ({ id, protocol: '', host: id, port: 0 }));
      setResult({ target: 'nodes', lines, nodes });
      setText('');
      if (data.imported > 0) toast('ok', `${data.imported} node${data.imported === 1 ? '' : 's'} added`, 'Open the Node Explorer to test them.');
      else if (data.duplicates > 0) toast('warn', 'Already in the node pool', 'The app kept the stored node — nothing was added twice.');
      else if (configs.length > 0) toast('error', 'Nothing could be parsed', 'The pasted text is not a share link this app recognises.');
    },
    onError: (err) => toast('error', 'Import failed', err instanceof Error ? err.message : undefined),
  });

  const importProfile = useMutation({
    mutationFn: (link: string) =>
      api.post<{ profile: { id: string; name: string } }>('/vpn/profiles', {
        providerId: 'singbox',
        name: `Pasted link (${new Date().toLocaleDateString()})`,
        configText: link,
      }),
    onSuccess: (data) => {
      void qc.invalidateQueries({ queryKey: ['vpn', 'profiles'] });
      setResult({ target: 'profile', lines: [`Profile "${data.profile.name}" created`], nodes: [] });
      setText('');
      toast('ok', 'Profile created', 'Open the sing-box tab to connect it.');
    },
    onError: (err) => toast('error', 'Could not create the profile', err instanceof Error ? err.message : undefined),
  });

  const busy = importNodes.isPending || importProfile.isPending;

  const submit = () => {
    if (links.length === 0) return;
    if (target === 'profile') {
      if (links.length > 1) {
        toast('warn', 'One link at a time for a profile', 'A profile holds a single config — switch to the node pool for a batch.');
        return;
      }
      importProfile.mutate(links[0]!);
      return;
    }
    importNodes.mutate(links);
  };

  return (
    <Section
      variant="flat"
      title="Add a config to the engines"
      icon={<ClipboardPaste size={15} />}
      subtitle="Paste one or many share links (vless / vmess / trojan / ss / hysteria2 / tuic). They are parsed at the same boundary as a downloaded source, and nothing is invented here."
      actions={
        target === 'nodes' ? (
          <div className="hidden items-center gap-2 sm:flex">
            <Badge tone={coresInstalled.length > 0 ? 'ok' : 'warn'}>
              <Cpu size={11} /> {coresInstalled.length} core{coresInstalled.length === 1 ? '' : 's'}
            </Badge>
            {effective && <Badge tone="accent">{effective} will test</Badge>}
          </div>
        ) : null
      }
    >
      <div className="mb-3 flex flex-wrap items-center gap-1.5">
        {(
          [
            { id: 'nodes' as Target, label: 'Node pool (xray · sing-box · V2Ray)' },
            { id: 'profile' as Target, label: 'sing-box profile (connectable)' },
          ] satisfies Array<{ id: Target; label: string }>
        ).map((option) => (
          <button
            key={option.id}
            type="button"
            onClick={() => setTarget(option.id)}
            aria-pressed={target === option.id}
            className={`rounded-lg border px-3 py-1.5 text-sm transition-colors ${
              target === option.id ? 'border-accent/50 bg-accent-soft text-accent-strong' : 'border-transparent bg-surface-2/70 text-muted hover:bg-surface-2'
            }`}
          >
            {option.label}
          </button>
        ))}
      </div>

      <Panel>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={3}
          spellCheck={false}
          placeholder={'vless://…\nvmess://…\ntrojan://…'}
          className="w-full resize-y rounded-lg border border-line bg-surface px-3 py-2 font-mono text-xs text-text placeholder:text-faint"
        />
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button
            variant="primary"
            onClick={submit}
            loading={busy}
            disabled={links.length === 0 || (target === 'profile' && links.length > 1)}
          >
            <Plus size={13} />
            {target === 'nodes' ? `Add ${links.length || ''} to node pool`.replace('  ', ' ').trim() : 'Create sing-box profile'}
          </Button>
          {text.trim().length > 0 && (
            <Button variant="ghost" onClick={() => setText('')} disabled={busy}>
              Clear
            </Button>
          )}
          <span className="text-micro text-faint">
            {links.length === 0 ? 'No share link detected in the text yet' : `${links.length} share link${links.length === 1 ? '' : 's'} detected`}
          </span>
        </div>
      </Panel>

      {target === 'nodes' && coresInstalled.length === 0 && (
        <Notice tone="warn" className="mt-3" icon={<TriangleAlert size={13} />}>
          No local core is installed yet. Imported nodes are stored either way, but they cannot be tested or tunnelled through until xray, sing-box or
          V2Ray is installed from its tab.
        </Notice>
      )}

      {result && (
        <div className="mt-4">
          <DataList className="rounded-xl border border-line bg-surface px-4">
            {result.lines.map((line) => (
              <DataRow key={line} leading={<span className="h-1.5 w-1.5 rounded-full bg-muted" aria-hidden />} title={<span className="text-sm text-text">{line}</span>} />
            ))}
          </DataList>

          {result.target === 'nodes' && result.nodes.length > 0 && (
            <p className="mt-2 text-micro leading-relaxed text-faint">
              {result.nodes.length} node id{result.nodes.length === 1 ? '' : 's'} returned. Open the Node Explorer to test them, or use{' '}
              <span className="text-muted">Tunnel now</span> on a node&apos;s detail page — a node is only usable once a core has measured it.
            </p>
          )}
        </div>
      )}
    </Section>
  );
}
