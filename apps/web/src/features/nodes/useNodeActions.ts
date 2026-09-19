import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useRef, useState } from 'react';

import { useToast } from '@/components/Toaster';
import { api } from '@/lib/api';
import { copyText, downloadText } from '@/lib/transfer';

import {
  exportErrorMessage,
  exportFileName,
  exportMessage,
  favoriteErrorMessage,
  favoriteMessage,
  geoErrorMessage,
  geoOutcomeMessage,
  promoteErrorMessage,
  promoteMessage,
  shareLinkClipboardFailureMessage,
  shareLinkCopiedMessage,
  shareLinkErrorMessage,
  shareLinkRefusalMessage,
  testErrorMessage,
  testMessage,
} from './nodeActionPolicy';

import type { ActionMessage, ExportEnvelope, ExportFormat, GeoRecheckOutcome, PromotedProfile, ShareLinkResult } from './nodeActionPolicy';
import type { NodeTestResult, NodeTestType } from '@netpulse/shared';

/**
 * The per-node actions a row or a detail page can run: test, geo re-check,
 * favorite, copy share link, export. One owner for both the in-flight state and
 * the outcome policy, because these actions are the same work whether they start
 * from a list row or from the node page — before this hook the explorer and the
 * detail page each carried their own copy of the fetch/decide/toast sequence and
 * their own busy flag, which is how the two drifted into different wording for
 * the same refusal.
 *
 * What stays with the caller (it is a rendering concern, not an action one):
 *   - what to re-render when a node changes (`onChanged`)
 *   - whether a started test must survive an unmount (`onTestStarted`, the
 *     detail page persists it so a long test can re-attach to its record)
 *
 * What is deliberately NOT here: engine installs (an engine concern) and tunnel
 * start/stop (`NodeEngineActions`), the latter of which owns its own state
 * because the tunnel outlives a single request.
 */

export type NodeActionKind = 'test' | 'geo' | 'favorite' | 'copy' | 'export' | 'promote';

export interface PendingNodeAction {
  nodeId: string;
  kind: NodeActionKind;
  /** Action-specific detail the UI may want: the test type, the export format. */
  detail: string | null;
}

/**
 * Terminal state of one action. `skipped` replaces the per-handler
 * `if (busy) return` guards the pages used to carry: another action was already
 * running, so nothing was attempted and nothing should be reported.
 */
export type ActionOutcome<T> = { status: 'done'; value: T } | { status: 'failed'; error: unknown } | { status: 'skipped' };

export interface NodeActionOptions<TNode> {
  /** Called after server-side node state changed, with the row when the server returned one. */
  onChanged?: (node: TNode | undefined) => void;
  /** Called when a test starts, so a caller can persist it across an unmount. */
  onTestStarted?: (started: { nodeId: string; type: NodeTestType; startedAt: number }) => void;
}

export function useNodeActions<TNode = unknown>(options: NodeActionOptions<TNode> = {}) {
  const toast = useToast();
  const qc = useQueryClient();
  const [pending, setPending] = useState<PendingNodeAction | null>(null);
  const inFlight = useRef(false);

  // Kept in a ref as well as state: the guard must see the current value even
  // when two handlers run before React re-renders.
  const run = useCallback(
    async <T>(nodeId: string, kind: NodeActionKind, detail: string | null, task: () => Promise<T>): Promise<ActionOutcome<T>> => {
      if (inFlight.current) return { status: 'skipped' };
      inFlight.current = true;
      setPending({ nodeId, kind, detail });
      try {
        return { status: 'done', value: await task() };
      } catch (error) {
        return { status: 'failed', error };
      } finally {
        inFlight.current = false;
        setPending(null);
      }
    },
    [],
  );

  const say = useCallback((message: ActionMessage) => toast(message.tone, message.title, message.body), [toast]);

  /** Rows and detail both render server measurements, so a stored test result invalidates the list. */
  const invalidateNodes = useCallback(() => {
    void qc.invalidateQueries({ queryKey: ['nodes'] });
  }, [qc]);

  const test = useCallback(
    async (nodeId: string, type: NodeTestType = 'tcp') => {
      options.onTestStarted?.({ nodeId, type, startedAt: Date.now() });
      const outcome = await run(nodeId, 'test', type, () => api.post<NodeTestResult>(`/nodes/${nodeId}/test`, { type }));
      if (outcome.status === 'done') {
        // The message comes from the STORED record the POST returns, so a run
        // the backend recorded as failed reports its reason instead of the
        // failed attempt's duration.
        say(testMessage(outcome.value));
        invalidateNodes();
        options.onChanged?.(undefined);
      } else if (outcome.status === 'failed') {
        say(testErrorMessage(type, outcome.error));
      }
      return outcome;
    },
    [invalidateNodes, options, run, say],
  );

  const recheckGeo = useCallback(
    async (nodeId: string) => {
      const outcome = await run(nodeId, 'geo', null, () =>
        api.post<{ result: GeoRecheckOutcome; node: TNode | null }>(`/nodes/${nodeId}/geo-recheck`, {}),
      );
      if (outcome.status === 'done') {
        say(geoOutcomeMessage(outcome.value.result));
        invalidateNodes();
        options.onChanged?.(outcome.value.node ?? undefined);
      } else if (outcome.status === 'failed') {
        say(geoErrorMessage(outcome.error));
      }
      return outcome;
    },
    [invalidateNodes, options, run, say],
  );

  const toggleFavorite = useCallback(
    async (node: { id: string; favorite: boolean }) => {
      const next = !node.favorite;
      const outcome = await run(node.id, 'favorite', null, () => api.post(`/nodes/${node.id}/favorite`, { favorite: next }));
      if (outcome.status === 'done') {
        say(favoriteMessage(next));
        invalidateNodes();
        options.onChanged?.(undefined);
      } else if (outcome.status === 'failed') {
        say(favoriteErrorMessage(outcome.error));
      }
      return outcome;
    },
    [invalidateNodes, options, run, say],
  );

  /**
   * Rebuild the node's share link server-side and hand it to the clipboard.
   * The only honest outcomes are "copied" and "here is why it cannot be
   * rebuilt" — a link that never reached the clipboard must not read as success.
   */
  const copyShareLink = useCallback(
    async (nodeId: string) => {
      const outcome = await run(nodeId, 'copy', null, () => api.get<ShareLinkResult>(`/nodes/${nodeId}/link`));
      if (outcome.status === 'done') {
        const res = outcome.value;
        if (!res.ok || !res.link) {
          say(shareLinkRefusalMessage(res));
          return outcome;
        }
        const copied = await copyText(res.link);
        say(copied ? shareLinkCopiedMessage(res) : shareLinkClipboardFailureMessage());
      } else if (outcome.status === 'failed') {
        say(shareLinkErrorMessage(outcome.error));
      }
      return outcome;
    },
    [run, say],
  );

  /**
   * Turn a stored node into an engine profile (the node survives as a named
   * profile with its own Connect button). Available from the row as well as the
   * detail page, so a likely node can be promoted while scanning the list.
   */
  const promote = useCallback(
    async (nodeId: string) => {
      const outcome = await run(nodeId, 'promote', null, () =>
        api.post<{ profile: PromotedProfile }>('/vpn/profiles/from-node', { nodeId }),
      );
      if (outcome.status === 'done') {
        say(promoteMessage(outcome.value.profile));
        void qc.invalidateQueries({ queryKey: ['vpn'] });
      } else if (outcome.status === 'failed') {
        say(promoteErrorMessage(outcome.error));
      }
      return outcome;
    },
    [qc, run, say],
  );

  const downloadExport = useCallback(
    async (nodeIds: string[], format: ExportFormat, prefix: string, scope: string) => {
      const outcome = await run(nodeIds[0] ?? '', 'export', format, async () => {
        const res = await api.get<ExportEnvelope>(`/nodes/export?nodeIds=${encodeURIComponent(nodeIds.join(','))}&format=${format}`);
        downloadText(exportFileName(prefix, format), res.data);
        return res;
      });
      if (outcome.status === 'done') say(exportMessage(format, scope));
      else if (outcome.status === 'failed') say(exportErrorMessage(outcome.error));
      return outcome;
    },
    [run, say],
  );

  /** Is `nodeId` currently running an action (optionally of a given kind)? */
  const busy = useCallback(
    (nodeId: string, kind?: NodeActionKind) => pending?.nodeId === nodeId && (kind === undefined || pending.kind === kind),
    [pending],
  );

  /** Is any node running this kind of action? For actions that cover many nodes at once. */
  const busyKind = useCallback((kind: NodeActionKind) => pending?.kind === kind, [pending]);

  return { pending, busy, busyKind, anyBusy: pending !== null, test, recheckGeo, toggleFavorite, copyShareLink, promote, downloadExport };
}
