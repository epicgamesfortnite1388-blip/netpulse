import { useCallback, useEffect, useRef, useState } from 'react';

import { CheckCircle2, ChevronDown, Download, Loader2, PackageCheck, RefreshCw, SearchCheck, TriangleAlert, X } from 'lucide-react';

import { Button } from '@/components/ui/Button';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { checkForUpdate, installUpdate, statusLine, updateNotice, updaterAvailable } from '@/lib/updater';

import type { CheckResult, DownloadProgress, UpdateInfo } from '@/lib/updater';

import { usePersistentState } from '@/lib/usePersistentState';

type Phase = 'idle' | 'downloading' | 'installing';

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 h — a feed poll is not a hot loop
const LAUNCH_POLL_DELAY_MS = 10_000; // past the startup health burst so the first feed request never competes with sidecar boot traffic

/**
 * The in-app update surface.
 *
 * Polls the feed once shortly after launch (after the transport has settled so
 * the poll cannot race the sidecar boot), then on a long interval while the
 * app stays open. When a version is found the banner shows the release notes
 * and offers install-and-restart; the actual install is streamed with real
 * progress from the plugin and ends with the app relaunching itself.
 */
export function UpdateBanner() {
  const [result, setResult] = useState<CheckResult | null>(null);
  // Dismissal survives tab switches and reloads within the session — an HMR
  // remount or a navigation must not resurrect a banner the user closed.
  const [dismissed, setDismissed] = usePersistentState<boolean>('update-banner-dismissed', false);
  const [phase, setPhase] = useState<Phase>('idle');
  const [progress, setProgress] = useState<DownloadProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notesOpen, setNotesOpen] = useState(false);
  const mounted = useRef(true);

  const available = result !== null && result.kind === 'available' ? result.update : null;

  const poll = useCallback(() => {
    if (!updaterAvailable()) return; // web mode: stay silent forever
    void checkForUpdate().then((r) => {
      if (mounted.current) setResult(r);
    });
  }, []);

  useEffect(() => {
    mounted.current = true;
    // Launch poll: delayed past the startup health burst (see LAUNCH_POLL_DELAY_MS).
    const t0 = setTimeout(poll, LAUNCH_POLL_DELAY_MS);
    const t = setInterval(poll, CHECK_INTERVAL_MS);
    return () => {
      mounted.current = false;
      clearTimeout(t0);
      clearInterval(t);
    };
  }, [poll]);

  const install = useCallback(
    (update: UpdateInfo) => {
      if (phase !== 'idle') return;
      setPhase('downloading');
      setError(null);
      setProgress(null);
      void installUpdate(update, (p) => {
        if (!mounted.current) return;
        setProgress(p);
        if (p.done) setPhase('installing');
      })
        .then(() => {
          // restart_after_install: the shell relaunches; nothing to render.
        })
        .catch((err: unknown) => {
          if (!mounted.current) return;
          setError(err instanceof Error ? err.message : String(err));
          setPhase('idle');
        });
    },
    [phase],
  );

  const notice = updateNotice(result, dismissed);

  // Nothing to say: render nothing (no placeholder chrome).
  if (notice === null && phase === 'idle' && error === null) return null;

  const pct =
    progress !== null && progress.contentLength !== null && progress.contentLength > 0
      ? Math.min(100, Math.round((progress.received / progress.contentLength) * 100))
      : null;

  return (
    <div className="flex items-center justify-center gap-2 border-b border-accent/30 bg-accent/10 px-4 py-2 text-xs text-accent-strong">
      {phase === 'idle' ? (
        available !== null ? (
          <PackageCheck size={13} className="shrink-0" />
        ) : (
          <TriangleAlert size={13} className="shrink-0" />
        )
      ) : (
        <Loader2 size={13} className="shrink-0 animate-spin" />
      )}

      {error !== null ? (
        <span>Update failed: {error}</span>
      ) : phase === 'installing' ? (
        <span>Update downloaded — installing and restarting…</span>
      ) : phase === 'downloading' ? (
        <span>
          Downloading {available?.version ?? 'update'}
          {pct !== null ? ` — ${pct}%` : progress !== null ? ` — ${progress.received.toLocaleString()} bytes` : ''}…
        </span>
      ) : (
        <span>{notice}</span>
      )}

      {available !== null && phase === 'idle' && (
        <>
          {available.body !== null && available.body.trim() !== '' && (
            <button
              type="button"
              onClick={() => setNotesOpen((v) => !v)}
              aria-expanded={notesOpen}
              className="flex shrink-0 items-center gap-1 rounded border border-accent/40 px-1.5 py-0.5 font-medium hover:bg-accent/10"
            >
              Notes
              <ChevronDown size={11} className={`transition-transform ${notesOpen ? '' : '-rotate-90'}`} />
            </button>
          )}
          <Button size="sm" variant="primary" className="h-6 px-2 py-0" onClick={() => install(available)}>
            {phase === 'idle' ? (
              <>
                <Download size={12} /> Install &amp; restart
              </>
            ) : (
              <Loader2 size={12} className="animate-spin" />
            )}
          </Button>
        </>
      )}

      {error !== null && (
        <Button size="sm" variant="secondary" className="h-6 px-2 py-0" onClick={() => available && install(available)}>
          <RefreshCw size={12} /> Retry
        </Button>
      )}

      {phase === 'idle' && notice !== null && (
        <button
          type="button"
          onClick={() => setDismissed(true)}
          aria-label="Dismiss update banner"
          className="ml-1 shrink-0 rounded p-0.5 hover:bg-accent/10"
        >
          <X size={12} />
        </button>
      )}

      {available !== null && available.body !== null && available.body.trim() !== '' && notesOpen && (
        <div className="absolute inset-x-0 top-full z-30 max-h-64 overflow-y-auto border-b border-line bg-surface px-6 py-3 text-xs text-text shadow-lg">
          <div className="mb-1 flex items-center gap-2 text-[10px] uppercase tracking-[0.16em] text-faint">
            <CheckCircle2 size={11} /> Release notes — {available.version}
          </div>
          <pre className="whitespace-pre-wrap font-sans leading-relaxed">{available.body}</pre>
        </div>
      )}
    </div>
  );
}

/**
 * Manual check surface for the Settings page — reuses the banner's policy
 * (`updateNotice`) and bridge calls, but is user-paced instead of launch-paced.
 *
 * Where the banner stays silent unless it has something to say, this card
 * answers every click honestly: "latest version" on up-to-date, the real
 * reason on a failed check, and — when the feed has one — the same notes and
 * install-and-restart action the banner offers. In web mode there is no
 * updater at all, so the card says exactly that instead of offering a button
 * that could never work.
 */
export function UpdateChecker() {
  const [result, setResult] = useState<CheckResult | null>(null);
  const [checking, setChecking] = useState(false);
  const [phase, setPhase] = useState<Phase>('idle');
  const [progress, setProgress] = useState<DownloadProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notesOpen, setNotesOpen] = useState(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const available = result !== null && result.kind === 'available' ? result.update : null;
  const desktop = updaterAvailable();

  const check = useCallback(() => {
    if (checking) return;
    setChecking(true);
    void checkForUpdate()
      .then((r) => {
        if (mounted.current) setResult(r);
      })
      .finally(() => {
        if (mounted.current) setChecking(false);
      });
  }, [checking]);

  const install = useCallback(
    (update: UpdateInfo) => {
      if (phase !== 'idle') return;
      setPhase('downloading');
      setError(null);
      setProgress(null);
      void installUpdate(update, (p) => {
        if (!mounted.current) return;
        setProgress(p);
        if (p.done) setPhase('installing');
      })
        .catch((err: unknown) => {
          if (!mounted.current) return;
          setError(err instanceof Error ? err.message : String(err));
          setPhase('idle');
        });
    },
    [phase],
  );

  const pct =
    progress !== null && progress.contentLength !== null && progress.contentLength > 0
      ? Math.min(100, Math.round((progress.received / progress.contentLength) * 100))
      : null;

  const line = result !== null ? statusLine(result) : null;

  return (
    <Card>
      <CardHeader
        title="Updates"
        subtitle="Checks the release feed for a newer NetPulse version"
      />
      <CardBody className="max-w-xl space-y-4">
        {!desktop ? (
          <p className="text-xs text-faint">
            Updates are handled by the NetPulse desktop app. This web session cannot check for or install updates.
          </p>
        ) : (
          <>
            <div className="flex items-center gap-3">
              <Button variant="secondary" loading={checking} onClick={check}>
                <SearchCheck size={14} /> Check for updates
              </Button>
              {line !== null && phase === 'idle' && error === null && <span className="text-xs text-muted">{line}</span>}
            </div>

            {error !== null ? (
              <div className="flex items-center gap-2 text-xs text-danger">
                <TriangleAlert size={13} className="shrink-0" />
                <span>Update failed: {error}</span>
                {available !== null && (
                  <Button size="sm" variant="secondary" className="h-6 px-2 py-0" onClick={() => install(available)}>
                    <RefreshCw size={12} /> Retry
                  </Button>
                )}
              </div>
            ) : phase === 'installing' ? (
              <div className="flex items-center gap-2 text-xs text-accent-strong">
                <Loader2 size={13} className="shrink-0 animate-spin" />
                <span>Update downloaded — installing and restarting…</span>
              </div>
            ) : phase === 'downloading' ? (
              <div className="flex items-center gap-2 text-xs text-accent-strong">
                <Loader2 size={13} className="shrink-0 animate-spin" />
                <span>
                  Downloading {available?.version ?? 'update'}
                  {pct !== null ? ` — ${pct}%` : progress !== null ? ` — ${progress.received.toLocaleString()} bytes` : ''}…
                </span>
              </div>
            ) : available !== null ? (
              <div className="space-y-2">
                {available.body !== null && available.body.trim() !== '' && (
                  <>
                    <button
                      type="button"
                      onClick={() => setNotesOpen((v) => !v)}
                      aria-expanded={notesOpen}
                      className="flex items-center gap-1 text-xs font-medium text-accent-strong hover:underline"
                    >
                      Release notes
                      <ChevronDown size={12} className={`transition-transform ${notesOpen ? '' : '-rotate-90'}`} />
                    </button>
                    {notesOpen && (
                      <pre className="max-h-64 overflow-y-auto whitespace-pre-wrap rounded-lg border border-line bg-surface-2 p-3 font-sans text-xs leading-relaxed text-text">
                        {available.body}
                      </pre>
                    )}
                  </>
                )}
                <div>
                  <Button size="sm" variant="primary" onClick={() => install(available)}>
                    <Download size={12} /> Install &amp; restart
                  </Button>
                </div>
              </div>
            ) : null}
          </>
        )}
      </CardBody>
    </Card>
  );
}
