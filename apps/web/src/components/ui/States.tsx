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

export function LoadingState({ label = 'Loading' }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2.5 rounded-xl border border-line bg-surface/50 px-6 py-14 text-sm text-muted">
      <Loader2 size={15} className="animate-spin text-accent" />
      {label}…
    </div>
  );
}
