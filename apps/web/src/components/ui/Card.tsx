import { ChevronDown } from 'lucide-react';
import { createContext, useContext } from 'react';

import { useDisclosure, useDisclosureScopeName } from '@/components/ui/Disclosure';

import type { ReactNode } from 'react';

/**
 * The card shell: `Card` + `CardHeader` + `CardBody`, the shape every page
 * builds its panels from.
 *
 * FOLDING: pass `fold={{ id }}` to make the header a fold target. The state and
 * the rules live in the one Disclosure owner (`components/ui/Disclosure.tsx`)
 * — this file only wires a `Card`'s own header/body to it through context, so a
 * page turns a card into a foldable section by adding one prop instead of
 * re-shaping the card's markup. Without `fold`, every part behaves exactly as
 * before (a plain, always-open panel).
 */

interface FoldState {
  open: boolean;
  toggle: () => void;
  /** Always-visible line for the folded header: what is inside, in counts. */
  summary?: ReactNode;
  bodyId: string;
}

const CardFoldContext = createContext<FoldState | null>(null);

export interface CardFold {
  /** Stable and unique within the page — also the storage identity. */
  id: string;
  /** Open state before the user chooses. Secondary cards fold by default. */
  defaultOpen?: boolean;
  /** Keeps the card out of the page-level Expand all / Collapse all. */
  pinned?: boolean;
  /** Shown only while folded, so a closed card still says what it holds. */
  summary?: ReactNode;
}

export function Card({
  className = '',
  children,
  fold,
  ...rest
}: React.HTMLAttributes<HTMLDivElement> & { fold?: CardFold }) {
  const scope = useDisclosureScopeName();
  // A plain (unfoldable) card must not join the fold group at all — see
  // useDisclosure's `enabled` note.
  const [open, setOpen] = useDisclosure(
    { id: fold?.id ?? 'card', defaultOpen: fold?.defaultOpen ?? true, pinned: fold?.pinned },
    scope,
    fold != null,
  );

  const bodyId = `card-${scope}-${fold?.id ?? 'card'}`.replace(/[^a-zA-Z0-9_-]/g, '-');
  const state: FoldState | null = fold
    ? { open, toggle: () => setOpen(!open), summary: fold.summary, bodyId }
    : null;

  return (
    <div
      className={`rounded-xl border border-line bg-surface shadow-[0_1px_2px_rgba(0,0,0,0.4)] transition-colors ${className}`}
      {...rest}
    >
      <CardFoldContext.Provider value={state}>{children}</CardFoldContext.Provider>
    </div>
  );
}

export function CardHeader({
  title,
  subtitle,
  actions,
  icon,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  icon?: ReactNode;
}) {
  const fold = useContext(CardFoldContext);

  const heading = (
    <>
      {fold && (
        <ChevronDown
          size={15}
          aria-hidden
          className={`mt-0.5 shrink-0 text-faint transition-transform duration-200 ${fold.open ? '' : '-rotate-90'}`}
        />
      )}
      {icon && <span className="mt-0.5 text-accent">{icon}</span>}
      <div className="min-w-0">
        <h3 className="truncate text-sm font-semibold tracking-tight">{title}</h3>
        {subtitle && fold?.open !== false && (
          <p className="mt-0.5 text-xs text-muted">{subtitle}</p>
        )}
        {fold && !fold.open && fold.summary && (
          <p className="mt-0.5 text-xs text-faint">{fold.summary}</p>
        )}
      </div>
    </>
  );

  const headerClass = 'flex items-start justify-between gap-3 border-b border-line px-5 py-3.5';

  return (
    <div className={headerClass}>
      {fold ? (
        <button
          type="button"
          onClick={fold.toggle}
          aria-expanded={fold.open}
          aria-controls={fold.bodyId}
          className="flex min-w-0 items-start gap-2.5 rounded-lg text-left transition-colors hover:text-text"
        >
          {heading}
        </button>
      ) : (
        <div className="flex min-w-0 items-start gap-2.5">{heading}</div>
      )}
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}

export function CardBody({ className = '', children, ...rest }: React.HTMLAttributes<HTMLDivElement>) {
  const fold = useContext(CardFoldContext);
  // A folded card renders no body at all — keeping it mounted but hidden would
  // leave live subtrees (charts, pollers) running behind a closed section.
  if (fold && !fold.open) return null;
  return (
    <div id={fold?.bodyId} className={`px-5 py-4 ${className}`} {...rest}>
      {children}
    </div>
  );
}
