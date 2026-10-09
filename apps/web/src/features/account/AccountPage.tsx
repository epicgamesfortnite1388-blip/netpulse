/**
 * AccountPage — the welcome gate (logged out) and the account dashboard
 * (logged in), one route: /account.
 *
 * Logged out: sign in / create account / continue offline — exactly the
 * mission's startup flow. "Continue offline" just navigates away; every
 * cloud-aware surface treats a null session as "local-only", never as an
 * error, so the VPN keeps working without an account.
 *
 * Logged in: profile, security (password change), sessions/devices with
 * revocation, and the sync panel (status, sync now, offline queue count,
 * honest last-sync state).
 */

import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { CloudOff, Copy, Download, LogOut, RefreshCw, ShieldCheck, Trash2, UserRound } from 'lucide-react';

import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Field } from '@/components/ui/Field';
import { useToast } from '@/components/Toaster';
import { CloudError, cloudApi, CLOUD_TIMEOUT } from '@/lib/cloud/client';
import { TelegramIntegrationCard } from './TelegramIntegrationCard';
import { pendingCount, lastSyncError, restoreProfileFromVault, syncNow } from '@/lib/cloud/syncEngine';
import { useSessionStore } from '@/lib/cloud/sessionStore';
import { useCloudSession } from '@/lib/cloud/useCloudSession';
import type { CloudDevice, CloudSession } from '@/lib/cloud/types';

function fmtTime(ts: number | null): string {
  if (!ts) return 'not yet';
  return new Date(ts).toLocaleString();
}

/* ------------------------------ logged out ------------------------------- */

function WelcomeGate() {
  const navigate = useNavigate();
  const { login, register, busy } = useCloudSession();
  const toast = useToast();
  const [mode, setMode] = useState<'signin' | 'register'>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  /**
   * How many times this form has been submitted. The first press answers fast
   * and names the cause; a press after that is the user choosing to wait, so
   * it gets the longer window a slow-but-working tunnel needs. Nothing is
   * retried automatically — the wait is theirs to spend.
   */
  const [attempts, setAttempts] = useState(0);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (mode === 'register' && password !== confirm) {
      setError('Passwords do not match');
      return;
    }
    const timeoutMs = attempts === 0 ? CLOUD_TIMEOUT.interactive : CLOUD_TIMEOUT.patient;
    setAttempts((n) => n + 1);
    try {
      if (mode === 'signin') await login(email.trim(), password, timeoutMs);
      else await register(email.trim(), password, timeoutMs);
      toast('ok', mode === 'signin' ? 'Signed in' : 'Account created');
    } catch (err) {
      // Never "check your connection": by far the most common cause is that the
      // cloud is filtered on this network and a tunnel/proxy would fix it, and
      // the client already knows which. Showing a code or a generic sentence
      // sent people to debug the connection that was working fine.
      setError(
        err instanceof CloudError
          ? err.message
          : err instanceof Error && err.message
            ? err.message
            : 'Could not reach the cloud service. If this network blocks it, turn on your VPN or tunnel and try again.',
      );
    }
  };

  return (
    <div className="mx-auto flex min-h-[60vh] w-full max-w-md flex-col justify-center gap-4 p-6">
      <div className="text-center">
        <h1 className="text-2xl font-semibold tracking-tight">
          {mode === 'signin' ? 'Welcome back' : 'Create your account'}
        </h1>
        <p className="mt-1 text-sm text-muted">
          {mode === 'signin'
            ? 'Sign in to sync settings and favorites across devices.'
            : 'One account syncs your settings, favorites and profiles.'}
        </p>
      </div>

      <Card>
        <CardBody>
          <form className="flex flex-col gap-3" onSubmit={submit}>
            <Field label="Email">
              <input
                type="email"
                required
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                className="w-full rounded-md border border-line bg-surface-2 px-3 py-2 text-sm outline-none focus:border-accent/80"
              />
            </Field>
            <Field label="Password" hint={mode === 'register' ? 'At least 10 characters with upper case, lower case and a digit' : undefined}>
              <input
                type="password"
                required
                minLength={mode === 'register' ? 10 : 1}
                autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full rounded-md border border-line bg-surface-2 px-3 py-2 text-sm outline-none focus:border-accent/80"
              />
            </Field>
            {mode === 'register' && (
              <Field label="Confirm password">
                <input
                  type="password"
                  required
                  autoComplete="new-password"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  className="w-full rounded-md border border-line bg-surface-2 px-3 py-2 text-sm outline-none focus:border-accent/80"
                />
              </Field>
            )}
            {error && <p className="text-sm text-red-400">{error}</p>}
            <Button type="submit" disabled={busy}>
              {busy ? 'Working…' : mode === 'signin' ? 'Sign in' : 'Create account'}
            </Button>
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setMode(mode === 'signin' ? 'register' : 'signin');
                // The banner describes one attempt at one mode. Carrying it
                // across the toggle showed "The cloud did not answer in time"
                // on a registration form that had never been submitted.
                setError(null);
              }}
            >
              {mode === 'signin' ? 'Need an account? Create one' : 'Already have an account? Sign in'}
            </Button>
          </form>
        </CardBody>
      </Card>

      <Button variant="ghost" onClick={() => navigate('/')}>
        <CloudOff size={15} /> Continue offline
      </Button>
      <p className="text-center text-xs text-muted">
        An account is optional. Diagnostics, nodes and the VPN work fully without one.
      </p>
    </div>
  );
}

/* ------------------------------- logged in -------------------------------- */

function SessionRow({ session, onRevoke }: { session: CloudSession; onRevoke: (id: string) => void }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-line py-2 last:border-b-0">
      <div className="min-w-0">
        <p className="truncate text-sm">
          {session.deviceName ?? 'Unknown device'}
          {session.current && (
            <span className="ml-2">
              <Badge tone="ok">this device</Badge>
            </span>
          )}
        </p>
        <p className="text-xs text-muted">
          {[session.os, session.appVersion].filter(Boolean).join(' · ') || 'details unavailable'} — last active {fmtTime(session.lastSeenAt)}
        </p>
      </div>
      {!session.current && (
        <Button variant="ghost" onClick={() => onRevoke(session.id)}>
          <Trash2 size={14} /> Revoke
        </Button>
      )}
    </div>
  );
}

/* ----------------------- encrypted profile backup ------------------------ */

interface VaultRow {
  profileId: string;
  ciphertext: string;
  updatedAt: number;
}

function EncryptedBackupCard() {
  const session = useSessionStore((s) => s.session);
  const toast = useToast();
  const [rows, setRows] = useState<VaultRow[] | null>(null);
  const [names, setNames] = useState<Record<string, string>>({});
  const [restoring, setRestoring] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [v, p] = await Promise.all([cloudApi.vaults(), cloudApi.profiles()]);
      setRows(v.vaults);
      const map: Record<string, string> = {};
      for (const prof of p.profiles) map[prof.id] = prof.name;
      setNames(map);
    } catch {
      setRows(null);
    }
  }, []);

  useEffect(() => {
    // No key is required to read this list: it is names and timestamps from
    // the cloud, and the app seals a backup itself. It used to be gated on a
    // browser-derived key that the sync path stopped consulting when the whole
    // seal/restore moved server-side — see the note in the card body.
    if (session) void load();
  }, [session, load]);

  if (!session) return null;

  const restore = async (profileId: string) => {
    setRestoring(profileId);
    try {
      const r = await restoreProfileFromVault(profileId);
      if (r.ok) toast('ok', `Restored "${r.name}"`, 'Imported locally; the cloud backup moved to its new id.');
      else if (r.error === 'decrypt_failed')
        toast(
          'error',
          'Restore failed',
          'The backup could not be opened — it is damaged, or it was written by an older version of this app that sealed it differently.',
        );
      else toast('error', 'Restore failed', r.error);
    } finally {
      setRestoring(null);
    }
  };

  const summary = rows === null ? 'backups not loaded' : `${rows.length} backup(s)`;

  return (
    <Card fold={{ id: 'account-e2e', defaultOpen: false, summary }}>
      <CardHeader title="Profile backup" icon={<ShieldCheck size={16} />} />
      <CardBody>
        <div className="flex flex-col gap-2 text-sm">
          <p>
            Full configs — including credentials — are sealed before upload with a key this app keeps <em>on your own machine</em>, next to the
            data it protects. The cloud only ever receives ciphertext, so whoever runs that service — or anyone who steals its database — cannot
            read what is in it.
          </p>
          <p className="text-xs text-muted">
            <span className="font-medium text-text">What this does not protect against:</span> someone who can read this app&apos;s data
            directory. The key sits beside the ciphertext, so anyone with access to this machine can open the backups too. This is a change from
            earlier versions, where the browser derived a key and the cloud copy was unreadable even from here — that version could not restore a
            config without decrypting it into the page first. Sealing now happens in the app instead, which is what lets restore import a config
            without anyone seeing it, and the price is that <span className="font-medium text-text">sync is no longer end-to-end encrypted against your own
            machine</span>.
          </p>
          <p className="text-xs text-muted">
            <strong>Where the unlock step went:</strong> it is gone, not merely switched off. Sealing and restoring happen inside the app now, so there
            is no in-browser key to enter — the old unlock field and button were removed along with the design they belonged to, and nothing on this
            card asks for a key because nothing here needs one.
          </p>
          {rows === null && <p className="text-xs text-muted">Backups load on the next sync.</p>}
          {rows?.length === 0 && <p className="text-xs text-muted">No backups yet — run “Sync now”.</p>}
          {rows !== null && rows.length > 0 && (
            <ul className="flex flex-col gap-1">
              {rows.map((r) => (
                <li key={r.profileId} className="flex items-center justify-between gap-2 rounded border border-line px-2 py-1.5">
                  <span className="truncate">
                    {names[r.profileId] ?? r.profileId} <span className="text-xs text-muted">· {fmtTime(r.updatedAt)}</span>
                  </span>
                  <Button variant="ghost" onClick={() => void restore(r.profileId)} disabled={restoring === r.profileId}>
                    <Download size={14} /> {restoring === r.profileId ? 'Restoring…' : 'Restore'}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </CardBody>
    </Card>
  );
}

function AccountDashboard() {
  const session = useSessionStore((s) => s.session);
  const { signOut } = useCloudSession();
  const toast = useToast();
  const navigate = useNavigate();
  const [sessions, setSessions] = useState<CloudSession[] | null>(null);
  const [devices, setDevices] = useState<CloudDevice[] | null>(null);
  /**
   * `null` used to mean both "still loading" and "the load failed", so a
   * collapsed card showed `… known` forever and read as a spinner that had
   * hung. The body already said "unavailable" — only the summary lied. Keep
   * the two apart so the collapsed line can admit the failure.
   */
  const [rosterFailed, setRosterFailed] = useState(false);
  const [syncState, setSyncState] = useState<{ running: boolean; error: string | null; pending: number }>({ running: false, error: null, pending: 0 });
  const [pwOpen, setPwOpen] = useState(false);
  const [currentPw, setCurrentPw] = useState('');
  const [newPw, setNewPw] = useState('');

  const loadRoster = useCallback(async () => {
    try {
      const [s, d] = await Promise.all([cloudApi.sessions(), cloudApi.devices()]);
      setSessions(s.sessions);
      setDevices(d.devices);
      setRosterFailed(false);
    } catch {
      setSessions(null);
      setDevices(null);
      setRosterFailed(true);
    }
  }, []);

  useEffect(() => {
    void loadRoster();
  }, [loadRoster]);

  const doSync = async () => {
    setSyncState((s) => ({ ...s, running: true }));
    const result = await syncNow();
    setSyncState({ running: false, error: result.ok ? null : (result.error ?? 'sync failed'), pending: pendingCount() });
    // No refresh call: `syncNow` -> `markSynced` writes lastSyncAt into the one
    // session store this page already subscribes to, so the stamp below is
    // already on screen by the time this resolves.
    if (result.ok) toast('ok', `Synced — ${result.pushed} pushed, ${result.pulled} pulled`);
    else toast('error', 'Sync failed', result.error);
  };

  const revoke = async (id: string) => {
    try {
      await cloudApi.revokeSession(id);
      void loadRoster();
      toast('ok', 'Session revoked');
    } catch (err) {
      toast('error', 'Could not revoke', err instanceof Error ? err.message : undefined);
    }
  };

  const revokeAll = async () => {
    try {
      const r = await cloudApi.revokeAll();
      await signOut();
      toast('ok', `Signed out everywhere (${r.revoked} sessions revoked)`);
      navigate('/account');
    } catch (err) {
      toast('error', 'Could not revoke sessions', err instanceof Error ? err.message : undefined);
    }
  };

  const changePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await cloudApi.changePassword(currentPw, newPw);
      await signOut(); // the server revoked every session; local state follows
      toast('ok', 'Password changed', 'Sign in again on this device.');
      navigate('/account');
    } catch (err) {
      toast('error', 'Password change failed', err instanceof Error ? err.message : undefined);
    }
  };

  if (!session) return null;
  const user = session.user;

  return (
    <div className="flex flex-col gap-4 p-6">
      <Card>
        <CardHeader
          title="Profile"
          icon={<UserRound size={16} />}
          actions={
            <Button variant="ghost" onClick={() => void signOut().then(() => toast('ok', 'Signed out'))}>
              <LogOut size={14} /> Sign out
            </Button>
          }
        />
        <CardBody>
          <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-1 text-sm">
            <dt className="text-muted">Email</dt>
            <dd className="break-all">{user.email}</dd>
            <dt className="text-muted">Account created</dt>
            <dd>{fmtTime(user.createdAt)}</dd>
            <dt className="text-muted">Last login</dt>
            <dd>{fmtTime(user.lastLoginAt)}</dd>
          </dl>
        </CardBody>
      </Card>

      <Card fold={{ id: 'account-security', defaultOpen: false, summary: 'Change password, sign out everywhere' }}>
        <CardHeader title="Security" icon={<ShieldCheck size={16} />} />
        <CardBody>
          {pwOpen ? (
            <form className="flex max-w-sm flex-col gap-3" onSubmit={changePassword}>
              <Field label="Current password">
                <input type="password" required autoComplete="current-password" value={currentPw} onChange={(e) => setCurrentPw(e.target.value)} className="w-full rounded-md border border-line bg-surface-2 px-3 py-2 text-sm" />
              </Field>
              <Field label="New password" hint="At least 10 characters with upper case, lower case and a digit">
                <input type="password" required minLength={10} autoComplete="new-password" value={newPw} onChange={(e) => setNewPw(e.target.value)} className="w-full rounded-md border border-line bg-surface-2 px-3 py-2 text-sm" />
              </Field>
              <div className="flex gap-2">
                <Button type="submit">Change password</Button>
                <Button type="button" variant="ghost" onClick={() => setPwOpen(false)}>Cancel</Button>
              </div>
            </form>
          ) : (
            <div className="flex flex-wrap gap-2">
              <Button onClick={() => setPwOpen(true)}>Change password</Button>
              <Button variant="ghost" onClick={revokeAll}>
                <LogOut size={14} /> Sign out everywhere
              </Button>
            </div>
          )}
        </CardBody>
      </Card>

      <Card fold={{ id: 'account-sessions', defaultOpen: true, summary: rosterFailed ? 'unavailable' : `${sessions?.length ?? '…'} active` }}>
        <CardHeader title="Sessions" />
        <CardBody>
          {sessions === null ? (
            <p className="text-sm text-muted">Session list unavailable (offline or cloud unreachable).</p>
          ) : sessions.length === 0 ? (
            <p className="text-sm text-muted">No active sessions.</p>
          ) : (
            <div>{sessions.map((s) => <SessionRow key={s.id} session={s} onRevoke={revoke} />)}</div>
          )}
        </CardBody>
      </Card>

      <Card fold={{ id: 'account-devices', defaultOpen: false, summary: rosterFailed ? 'unavailable' : `${devices?.length ?? '…'} known` }}>
        <CardHeader title="Devices" />
        <CardBody>
          {devices === null ? (
            <p className="text-sm text-muted">Device roster unavailable.</p>
          ) : devices.length === 0 ? (
            <p className="text-sm text-muted">No devices registered yet.</p>
          ) : (
            <div className="flex flex-col gap-1 text-sm">
              {devices.map((d) => (
                <div key={d.id} className="flex items-center justify-between border-b border-line py-1.5 last:border-b-0">
                  <div>
                    <p>{d.name}</p>
                    <p className="text-xs text-muted">{[d.os, d.appVersion].filter(Boolean).join(' · ') || '—'} — first seen {fmtTime(d.firstSeenAt)}</p>
                  </div>
                  <span className="text-xs text-muted">active {fmtTime(d.lastActiveAt)}</span>
                </div>
              ))}
            </div>
          )}
        </CardBody>
      </Card>

      <Card fold={{ id: 'account-sync', defaultOpen: true, summary: syncState.error ? 'last sync failed' : 'settings · favorites · profiles' }}>
        <CardHeader title="Synchronization" icon={<RefreshCw size={16} />} />
        <CardBody>
          <div className="flex flex-col gap-2 text-sm">
            <p>
              Last sync: <strong>{fmtTime(session.lastSyncAt)}</strong>
              {pendingCount() > 0 && <span> — {pendingCount()} offline change(s) waiting</span>}
            </p>
            {/* `text-warn`, not a raw palette colour: amber-400 is fixed across themes and
                measured 1.72:1 on white, so this line was invisible to anyone
                reading the light theme — and it only renders once a sync has
                actually failed, which is why the gate only reached it now. */}
            {lastSyncError() && !syncState.running && <p className="text-xs text-warn">Last attempt: {lastSyncError()}</p>}
            <p className="text-xs text-muted">
              Synced to the cloud: settings, favorites, profile <em>names</em>, preferences. Full configs leave only as sealed blobs (see below) —
              unreadable to the cloud, though the sealing key lives on this machine, not in your browser.
            </p>
            <div className="flex gap-2">
              <Button onClick={doSync} disabled={syncState.running}>
                <RefreshCw size={14} /> {syncState.running ? 'Syncing…' : 'Sync now'}
              </Button>
              <Button variant="ghost" onClick={() => { void navigator.clipboard.writeText(user.id); toast('ok', 'Account id copied'); }}>
                <Copy size={14} /> Copy account id
              </Button>
            </div>
          </div>
        </CardBody>
      </Card>

      <EncryptedBackupCard />

      <TelegramIntegrationCard />

      <Card fold={{ id: 'account-danger', defaultOpen: false, summary: 'irreversible account actions' }}>
        <CardHeader title="Danger zone" />
        <CardBody>
          <p className="mb-2 text-sm text-muted">
            Deleting the account removes all cloud data immediately. Local data on this machine is untouched.
          </p>
          <Button
            variant="ghost"
            onClick={async () => {
              if (!window.confirm('Delete your account and all cloud data? This cannot be undone.')) return;
              try {
                await cloudApi.deleteAccount();
                await signOut();
                toast('ok', 'Account deleted');
                navigate('/account');
              } catch (err) {
                toast('error', 'Could not delete account', err instanceof Error ? err.message : undefined);
              }
            }}
          >
            <Trash2 size={14} /> Delete account
          </Button>
        </CardBody>
      </Card>
    </div>
  );
}

export default function AccountPage() {
  const session = useSessionStore((s) => s.session);
  const { ready, init } = useCloudSession();

  useEffect(() => {
    init();
  }, [init]);

  if (!ready) return null;
  return session ? <AccountDashboard /> : <WelcomeGate />;
}
