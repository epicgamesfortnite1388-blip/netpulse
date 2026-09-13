import { Component } from 'react';

import { tauriInvoke } from '@/lib/transport';

import type { ErrorInfo, ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

function invokeReset(): void {
  // In desktop mode reset_app_state stops the sidecar, moves every data file
  // into a timestamped backup dir and respawns a fresh backend. The page then
  // reloads against the fresh database. In web mode this is a no-op reload.
  Promise.resolve(tauriInvoke('reset_app_state')).finally(() => {
    window.location.reload();
  });
}

/**
 * Last-resort boundary around the whole router. A render crash used to show
 * React Router's developer error screen ("provide your own ErrorBoundary") —
 * unacceptable in a shipped desktop app. Now the user gets real recovery
 * actions: retry, Safe Mode and Reset App State.
 */
export class AppErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // Best-effort breadcrumb in the webview console; desktop builds also have
    // the Rust-side log for native crashes.
    console.error('[netpulse] render crash:', error, info.componentStack);
  }

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    const isDesktop = Boolean(
      (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__,
    );
    return (
      <div className="flex min-h-screen items-center justify-center bg-bg p-6 text-text">
        <div className="w-full max-w-lg space-y-5 rounded-xl border border-line bg-surface p-6">
          <div>
            <h1 className="text-lg font-semibold">Something went wrong</h1>
            <p className="mt-1 text-sm text-muted">
              A screen failed to render. Your data is safe — the actions below
              recover without deleting anything.
            </p>
          </div>
          <pre className="max-h-40 overflow-auto rounded-lg border border-line bg-surface-2 p-3 font-mono text-xs text-faint">
            {error.message || String(error)}
          </pre>
          <div className="flex flex-wrap gap-2">
            <button
              className="rounded-lg border border-accent/40 bg-accent-soft px-4 py-2 text-sm font-medium text-accent hover:brightness-110"
              onClick={() => this.setState({ error: null })}
            >
              Try again
            </button>
            <button
              className="rounded-lg border border-line bg-surface-2 px-4 py-2 text-sm text-muted hover:text-text"
              onClick={() => window.location.reload()}
            >
              Reload app
            </button>
            {isDesktop && (
              <button
                className="rounded-lg border border-line bg-surface-2 px-4 py-2 text-sm text-muted hover:text-text"
                onClick={invokeReset}
              >
                Reset app state…
              </button>
            )}
          </div>
          <p className="text-xs text-faint">
            Reset moves all app data (history, settings, profiles) into a
            timestamped backup folder inside the app data directory and starts
            fresh. Nothing is deleted.
          </p>
        </div>
      </div>
    );
  }
}
