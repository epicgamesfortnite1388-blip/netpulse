/**
 * TelegramIntegrationCard — the desktop UI for the NetPulse <-> Abystral
 * (Telegram commerce) integration.
 *
 * The bot owns purchases/payments/entitlements; this app only MIRRORS them
 * for the linked account. Linking is bot-verified: the worker asks the bot
 * (over the signed service channel) for a one-time code, the USER opens the
 * bot's deep link, Telegram authenticates them there, and the code is
 * confirmed back through the worker. This client never supplies a Telegram
 * identity — it cannot, by construction.
 *
 * Subscription data shown here is the safe entitlement model only (plan,
 * status, expiry, traffic). VPN configs and server credentials are delivered
 * by the bot's own channels and never transit this API.
 */

import { useCallback, useEffect, useState } from 'react';
import { Send, RefreshCw, Trash2 } from 'lucide-react';

import { Button } from '@/components/ui/Button';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { useToast } from '@/components/Toaster';
import { CloudError, cloudApi, type NetpulseSubscription } from '@/lib/cloud/client';
import { useCloudSession } from '@/lib/cloud/useCloudSession';

interface LinkStatus {
  connected: boolean;
  telegramUserId: number | null;
  linkedAt: number | null;
  lastSyncedAt: number | null;
  lastSyncStatus: string | null;
}

const IDLE_STATUS: LinkStatus = { connected: false, telegramUserId: null, linkedAt: null, lastSyncedAt: null, lastSyncStatus: null };

export function TelegramIntegrationCard() {
  const { session } = useCloudSession();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<LinkStatus>(IDLE_STATUS);
  const [pendingCode, setPendingCode] = useState('');
  const [confirmCode, setConfirmCode] = useState('');
  const [subs, setSubs] = useState<NetpulseSubscription[] | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [lastSyncAt, setLastSyncAt] = useState<number | null>(null);

  const load = useCallback(async () => {
    if (!session) return;
    try {
      const link = await cloudApi.netpulse.status();
      setStatus({
        connected: link.connected,
        telegramUserId: link.telegram_user_id,
        linkedAt: link.linked_at,
        lastSyncedAt: link.last_synced_at,
        lastSyncStatus: link.last_sync_status,
      });
      if (link.connected) {
        const listed = await cloudApi.netpulse.subscriptions();
        setSubs(listed.subscriptions);
        const sync = await cloudApi.netpulse.syncStatus();
        setLastSyncAt(sync.lastSyncAt);
        setSyncError(sync.error);
      } else {
        setSubs(null);
      }
    } catch (err) {
      if (!(err instanceof CloudError && err.code === 'network_error')) {
        setStatus(IDLE_STATUS);
      }
      // Offline: leave the last-known UI state in place (the app works offline).
    }
  }, [session]);

  useEffect(() => {
    void load();
  }, [load]);

  // Reasonable background convergence: refresh the mirror every 15 minutes
  // while linked. Push events from the bot are the primary path; this only
  // repairs gaps when the app sat idle through them. No aggressive polling.
  useEffect(() => {
    if (!status.connected) return;
    const timer = window.setInterval(() => {
      void cloudApi.netpulse
        .sync()
        .then((res) => {
          setSubs(res.subscriptions);
          setLastSyncAt(Date.now());
          setSyncError(null);
        })
        .catch(() => {
          setSyncError('background_sync_failed');
        });
    }, 15 * 60_000);
    return () => window.clearInterval(timer);
  }, [status.connected]);

  const startLinking = async () => {
    setBusy(true);
    try {
      const res = await cloudApi.netpulse.link();
      setPendingCode(res.token);
      window.open(res.deepLink, '_blank');
      toast('ok', 'Telegram opened - confirm there, or paste the code below');
    } catch (err) {
      toast('error', err instanceof CloudError ? err.message : 'Could not start linking');
    } finally {
      setBusy(false);
    }
  };

  const confirmLink = async () => {
    if (!confirmCode.trim()) return;
    setBusy(true);
    try {
      await cloudApi.netpulse.confirm(confirmCode.trim());
      setConfirmCode('');
      setPendingCode('');
      toast('ok', 'Telegram linked');
      await load();
    } catch (err) {
      toast('error', err instanceof CloudError ? err.message : 'Link code invalid or expired');
    } finally {
      setBusy(false);
    }
  };

  const unlink = async () => {
    setBusy(true);
    try {
      await cloudApi.netpulse.unlink();
      toast('ok', 'Telegram unlinked');
      setStatus(IDLE_STATUS);
      setSubs(null);
      setPendingCode('');
    } catch (err) {
      toast('error', err instanceof CloudError ? err.message : 'Could not unlink');
    } finally {
      setBusy(false);
    }
  };

  const sync = async () => {
    setSyncing(true);
    try {
      const res = await cloudApi.netpulse.sync();
      setSubs(res.subscriptions);
      setLastSyncAt(Date.now());
      setSyncError(null);
    } catch (err) {
      setSyncError(err instanceof CloudError ? err.code : 'sync_failed');
    } finally {
      setSyncing(false);
    }
  };

  return (
    <Card fold={{ id: 'telegram-integration', defaultOpen: false, summary: status.connected ? 'linked' : 'not linked' }}>
      <CardHeader title="Telegram" icon={<Send size={16} />} />
      <CardBody>
        {status.connected ? (
          <div className="flex flex-col gap-3 text-sm">
            <div className="flex items-center gap-2">
              <span className="font-medium">
                Telegram linked{status.telegramUserId != null ? ` - ID ${status.telegramUserId}` : ''}
                {status.linkedAt && (
                  <span className="text-xs text-muted"> - since {new Date(status.linkedAt).toLocaleDateString()}</span>
                )}
              </span>
              <Button variant="ghost" onClick={unlink} disabled={busy} className="flex-1">
                <Trash2 size={14} /> Unlink
              </Button>
            </div>
            {subs && subs.length > 0 && (
              <div className="space-y-2">
                {subs.map((s) => (
                  <div key={s.id} className="rounded border border-line p-3">
                    <p className="font-medium">{s.plan}</p>
                    <p className="text-muted text-sm">Status: {s.status}</p>
                    <p className="text-muted text-sm">
                      Expires: {s.expiration_time ? new Date(s.expiration_time).toLocaleDateString() : 'never'}
                    </p>
                    <p className="text-muted text-sm">
                      Traffic: {s.used_gb.toFixed(2)} / {s.total_gb.toFixed(0)} GB
                    </p>
                  </div>
                ))}
              </div>
            )}
            {subs && subs.length === 0 && <p className="text-muted">No subscriptions mirror yet.</p>}
            <div>
              <Button onClick={sync} disabled={syncing}>
                <RefreshCw size={14} /> {syncing ? 'Syncing...' : 'Refresh Subscriptions'}
              </Button>
              {(lastSyncAt || syncError) && (
                <p className="mt-1 text-xs text-muted">
                  {syncError ? `Last sync failed (${syncError})` : lastSyncAt ? `Last synced ${new Date(lastSyncAt).toLocaleString()}` : ''}
                </p>
              )}
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-2 text-sm">
            {!session ? (
              <p className="text-muted">Log in to your account to link Telegram.</p>
            ) : (
              <>
                <div>
                  <Button onClick={startLinking} disabled={busy}>
                    <Send size={14} /> Link Telegram
                  </Button>
                </div>
                {pendingCode && (
                  <div className="flex items-center gap-2">
                    <input
                      value={confirmCode}
                      onChange={(e) => setConfirmCode(e.target.value)}
                      placeholder="Paste the code from the bot"
                      className="flex-1 rounded border border-line bg-transparent px-2 py-1 text-sm"
                    />
                    <Button onClick={confirmLink} disabled={!confirmCode.trim() || busy}>
                      Confirm
                    </Button>
                  </div>
                )}
              </>
            )}
          </div>
        )}
        <p className="mt-3 text-xs text-muted">
          Purchases and renewals are managed on Telegram. Subscription sync requires cloud connectivity.
        </p>
      </CardBody>
    </Card>
  );
}
