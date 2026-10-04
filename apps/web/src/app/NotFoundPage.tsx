/**
 * NotFoundPage — the catch-all route (`path: '*'`).
 *
 * Without it, an unmatched URL matched no route, so React Router rendered its
 * own default error element *instead of* the AppShell: the sidebar, topbar and
 * every other way out of the page disappeared, leaving a developer-facing
 * "Unexpected Application Error! 404 Not Found — Hey developer 👋" screen with
 * no navigation. A mistyped URL, a stale bookmark or a path that lost a
 * segment was an unrecoverable dead end.
 *
 * AppErrorBoundary already covers render crashes, but React Router resolves an
 * unmatched route through its own boundary, which sits above ours — so the
 * recovery UI never got a chance to run. This route is the fix: it keeps the
 * user inside the shell and gives them somewhere to go.
 */

import { Compass, Radar } from 'lucide-react';
import { Link, useLocation } from 'react-router';

import { EmptyState } from '@/components/ui/States';
import { PageHeader } from '@/components/ui/PageHeader';

export default function NotFoundPage() {
  const { pathname } = useLocation();

  return (
    <div className="animate-fade-up">
      <PageHeader
        title="Page not found"
        description="Nothing in the app is served from this address."
      />
      <EmptyState
        icon={<Compass size={22} />}
        title="No page at this address"
        message={`"${pathname}" does not match any screen in NetPulse. It may have been renamed, or the link may have been cut short.`}
        action={
          <div className="flex flex-wrap justify-center gap-2">
            <Link
              to="/"
              className="rounded-lg border border-accent/40 bg-accent-soft px-4 py-2 text-sm font-medium text-accent hover:brightness-110"
            >
              Back to Dashboard
            </Link>
            <Link
              to="/nodes"
              className="flex items-center gap-2 rounded-lg border border-line bg-surface-2 px-4 py-2 text-sm text-muted hover:text-text"
            >
              <Radar size={15} /> Browse nodes
            </Link>
          </div>
        }
      />
    </div>
  );
}