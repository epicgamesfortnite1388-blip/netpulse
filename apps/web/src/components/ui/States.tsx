import { AlertCircle, Loader2 } from 'lucide-react';

import { Button } from '@/components/ui/Button';
import { headingTag, useHeadingLevel } from '@/components/ui/HeadingLevel';
import { ApiError, isRetryableError } from '@/lib/api';

import type { ReactNode } from 'react';

export function EmptyState({
  icon,
  title,
  message,
  action,
}: {
  icon?: ReactNode;
  title: string;
  message: string;
  action?: ReactNode;
}) {
  // An empty state stands in for the content of the section it sits in, so its
  // title belongs at that section's heading rank. Hardcoding h3 here made pages
  // whose first heading was an h2 read h1 -> h3 with nothing between.
  const Tag = headingTag(useHeadingLevel());
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-line-strong bg-surface/50 px-6 py-14 text-center">
      {icon && (
        <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-xl border border-line bg-surface-2 text-accent">
          {icon}
        </div>
      )}
      <Tag className="text-sm font-semibold">{title}</Tag>
      <p className="mt-1.5 max-w-md text-sm leading-relaxed text-muted">{message}</p>
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

export function ErrorState({ error, retry }: { error: unknown; retry?: () => void }) {
  const isApi = error instanceof ApiError;
  // A retry only helps when the same request could succeed later. Offering it
  // for a permanent failure (bad id, missing record) taught the user that
  // "Try again" is a button you press regardless of what the error says.
  const canRetry = retry != null && isRetryableError(error);
  return (
    <div className="flex flex-col items-start gap-3 rounded-xl border border-danger/30 bg-danger/5 px-5 py-4">
      <div className="flex items-start gap-2.5">
        <AlertCircle size={16} className="mt-0.5 shrink-0 text-danger" />
        <div>
          <p className="text-sm font-medium text-danger">
            {isApi ? error.message : 'Something went wrong'}
          </p>
          {isApi && error.hint && <p className="mt-1 text-xs text-muted">{error.hint}</p>}
          {isApi && <p className="mt-1 font-mono text-micro text-faint">{error.code}</p>}
        </div>
      </div>
      {canRetry && (
        <Button size="sm" variant="secondary" onClick={retry}>
          Try again
        </Button>
      )}
    </div>
  );
}

/**
 * The Suspense fallback for a lazy route: a progress rail plus the SHAPE of a
 * page (title, a row of panels, one wide panel).
 *
 * This replaces a centred spinner. A spinner says "something is happening" and
 * nothing else, so the window looked empty for the length of a chunk download
 * and then snapped to a fully drawn page. A skeleton of the right shape makes
 * the wait read as the page arriving, and the arrival (the `page-enter`
 * animation around the real page) completes the movement instead of restarting
 * it from blank.
 *
 * Everything visual is `aria-hidden`; the announcement is the single status
 * line, so assistive tech hears one "Opening page" rather than a dozen empty
 * boxes.
 */
export function PageSkeleton() {
  return (
    <div role="status" aria-live="polite">
      <span className="sr-only">Opening page</span>
      <div className="route-progress" aria-hidden="true" />
      <div aria-hidden="true" className="animate-fade-up space-y-6">
        <div className="space-y-2.5">
          <div className="skeleton h-6 w-56" />
          <div className="skeleton h-3.5 w-80 max-w-full" />
        </div>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="rounded-xl border border-line bg-surface/60 p-5 shadow-raised">
              <div className="skeleton h-3 w-24" />
              <div className="skeleton mt-3 h-7 w-32" />
              <div className="skeleton mt-4 h-2.5 w-full" />
            </div>
          ))}
        </div>
        <div className="rounded-xl border border-line bg-surface/60 p-5 shadow-raised">
          <div className="skeleton h-3 w-28" />
          <div className="mt-4 space-y-2.5">
            <div className="skeleton h-3 w-full" />
            <div className="skeleton h-3 w-11/12" />
            <div className="skeleton h-3 w-3/4" />
          </div>
        </div>
      </div>
    </div>
  );
}

export function LoadingState({ label = 'Loading' }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2.5 rounded-xl border border-line bg-surface/50 px-6 py-14 text-sm text-muted">
      <Loader2 size={15} className="animate-spin text-accent" />
      {label}…
    </div>
  );
}
