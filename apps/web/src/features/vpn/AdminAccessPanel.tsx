import { Activity, AlertTriangle, RefreshCw, ShieldAlert, ShieldCheck, Terminal } from 'lucide-react';

import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { useToast } from '@/components/Toaster';
import { DataList, DataRow, Notice, Panel } from '@/components/ui/Surface';
import { useAdminStatus, useDesktopAdminRights, useElevatedRelaunch, useRecheckAdmin } from '@/lib/admin';
import { isDesktop } from '@/lib/transport';

import type { AdminStatus, PrivilegeCapability } from '@netpulse/shared';

/**
 * Administrator rights — one panel, two honest observations.
 *
 * The app has exactly three features Windows gates behind an elevated token:
 * creating a TUN adapter (system-wide routing), handing a tunnel config to the
 * WireGuard service, and raw-socket ICMP. Each either works, or says why it does
 * not and — where the app can actually fix it — offers the fix. A refusal the
 * user cannot act on is the defect this surface removes.
 *
 * Attribution is explicit because the two answers can legitimately differ:
 *   - "Backend" is the sidecar, the process that runs the cores.
 *   - "App process" is the Tauri shell, the only layer that can raise a UAC
 *     prompt. Its answer is what makes the relaunch button truthful.
 *
 * Nothing is inferred from a setting, and in the browser build there is no
 * process to elevate — that is stated, not hidden behind a disabled button.
 */

const PRIVILEGE_ICON: Record<PrivilegeCapability['id'], typeof ShieldCheck> = {
  'tun-gateway': Terminal,
  'wireguard-tunnel-install': ShieldCheck,
  'raw-icmp': Activity,
};

export function AdminAccessPanel({ compact = false }: { compact?: boolean }) {
  const adminQuery = useAdminStatus();
  const desktopRights = useDesktopAdminRights();
  const relaunch = useElevatedRelaunch();
  const recheck = useRecheckAdmin();
  const toast = useToast();

  const admin = adminQuery.data?.admin;
  const desktopElevated = desktopRights.data?.elevated ?? null;
  const canRelaunch = admin?.canRelaunchElevated === true && desktopRights.data?.can_relaunch === true;

  const onRelaunch = () => {
    relaunch.mutate(undefined, {
      onSuccess: (outcome) => {
        if (outcome.armed) toast('ok', 'Relaunching with administrator rights', outcome.message);
        else toast('warn', 'Could not request administrator rights', outcome.message);
      },
    });
  };

  const onRecheck = () => {
    recheck.mutate(undefined, {
      onSuccess: (data) => {
        toast(
          data.admin.elevated ? 'ok' : 'warn',
          data.admin.elevated ? 'Administrator rights confirmed' : 'Still running without administrator rights',
          data.admin.note,
        );
      },
      onError: (err) => toast('error', 'Could not re-check privileges', err instanceof Error ? err.message : undefined),
    });
  };

  return (
    <Panel tone="quiet" className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          {admin?.elevated ? (
            <ShieldCheck size={15} className="shrink-0 text-ok" />
          ) : (
            <ShieldAlert size={15} className="shrink-0 text-warn" />
          )}
          <span className="text-xs font-medium text-text">
            {adminQuery.isLoading ? 'Checking administrator rights…' : admin?.elevated ? 'Running as administrator' : 'Running without administrator rights'}
          </span>
          {desktopElevated != null && (
            <Badge tone={desktopElevated ? 'ok' : 'neutral'}>
              {desktopElevated ? 'app process: elevated' : 'app process: standard'}
            </Badge>
          )}
        </div>

        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={onRecheck} loading={recheck.isPending}>
            <RefreshCw size={13} />
            Re-check
          </Button>
          {canRelaunch && (
            <Button variant="secondary" size="sm" onClick={onRelaunch} loading={relaunch.isPending}>
              <ShieldCheck size={13} />
              Restart with admin rights
            </Button>
          )}
        </div>
      </div>

      {admin && (
        <Notice tone={admin.elevated ? 'ok' : 'info'}>{admin.note}</Notice>
      )}

      {/* The relaunch is only offered when BOTH layers agree it can work;
          otherwise the reason is the honest one, not a disabled button. */}
      {admin && !admin.elevated && !canRelaunch && (
        <Notice tone="warn" icon={<AlertTriangle size={13} />}>
          {!isDesktop()
            ? 'This is the browser build, so there is no app process to relaunch with administrator rights.'
            : (desktopRights.data?.can_relaunch === false
                ? 'The desktop shell reports no elevated relaunch is available on this machine.'
                : 'The backend cannot confirm an elevated relaunch from here.')}
        </Notice>
      )}

      <DataList>
        {(admin?.privileges ?? []).map((p) => {
          const Icon = PRIVILEGE_ICON[p.id] ?? ShieldCheck;
          return (
            <DataRow
              key={p.id}
              leading={<Icon size={14} className={p.available ? 'text-ok' : p.requiresAdmin ? 'text-warn' : 'text-faint'} />}
              title={p.label}
              subtitle={compact ? undefined : p.reason}
              meta={
                <Badge tone={p.available ? 'ok' : p.requiresAdmin ? 'warn' : 'neutral'}>
                  {p.available ? 'available' : p.requiresAdmin ? 'needs admin' : 'limited'}
                </Badge>
              }
              actions={
                !p.available && p.remedy ? (
                  <span className="max-w-[22rem] text-right text-micro leading-snug text-muted">{p.remedy}</span>
                ) : undefined
              }
            />
          );
        })}
      </DataList>

      {adminQuery.isError && (
        <Notice tone="danger" icon={<AlertTriangle size={13} />}>
          The backend could not report its privilege level — treat every admin-gated feature as unavailable rather than assuming it works.
        </Notice>
      )}
    </Panel>
  );
}

/**
 * The narrow slice other surfaces need: one capability's honest state, plus the
 * elevation action when it is the thing standing in the way. Used next to the
 * TUN toggle so a user never has to leave the control to fix it.
 */
export function PrivilegeGate({ id, className = '' }: { id: PrivilegeCapability['id']; className?: string }) {
  const adminQuery = useAdminStatus();
  const desktopRights = useDesktopAdminRights();
  const relaunch = useElevatedRelaunch();
  const toast = useToast();

  const admin: AdminStatus | undefined = adminQuery.data?.admin;
  const privilege = admin?.privileges.find((p) => p.id === id);
  if (!admin || !privilege) return null;
  if (privilege.available) return null;

  const canRelaunch = admin.canRelaunchElevated && desktopRights.data?.can_relaunch === true;

  return (
    <Notice tone={privilege.requiresAdmin ? 'warn' : 'info'} className={className} icon={<ShieldAlert size={13} />}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 flex-1">{privilege.reason}</span>
        {canRelaunch && privilege.requiresAdmin && (
          <Button
            variant="secondary"
            size="sm"
            loading={relaunch.isPending}
            onClick={() =>
              relaunch.mutate(undefined, {
                onSuccess: (outcome) =>
                  outcome.armed
                    ? toast('ok', 'Relaunching with administrator rights', outcome.message)
                    : toast('warn', 'Could not request administrator rights', outcome.message),
              })
            }
          >
            <ShieldCheck size={13} />
            Grant admin rights
          </Button>
        )}
      </div>
      {privilege.remedy && <div className="mt-1 text-micro text-faint">{privilege.remedy}</div>}
    </Notice>
  );
}
