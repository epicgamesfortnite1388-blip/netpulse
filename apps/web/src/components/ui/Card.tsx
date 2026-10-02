import { ChevronDown } from 'lucide-react';
import { Children, createContext, isValidElement, useContext } from 'react';

import { useDisclosure, useDisclosureScopeName } from '@/components/ui/Disclosure';
import { HeadingLevelProvider, headingTag, useHeadingLevel } from '@/components/ui/HeadingLevel';

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

/**
 * The heading rank a card's BODY opens for its own children.
 *
 * Kept separate from the provider that CardHeader reads, because the header is
 * the card's own heading — it must render at the level the card sits at, while
 * everything inside the body sits one level deeper. Wrapping the whole card
 * instead would push the header down with its own children and shift every card
 * in the app by one.
 */
const CardChildLevelContext = createContext<number | null>(null);

/** The heading rank the card's own `CardHeader` renders at. */

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

  // A card that renders a heading consumes one level; a card used purely as a
  // container (a CardBody with no CardHeader — the map's custom-target row, the
  // route-checker's input strip) renders no heading of its own, so it must not
  // consume one either. Otherwise its nested card jumps an outline level and the
  // page reads h1 -> h3 with no h2 anywhere.
  const level = useHeadingLevel();
  const rendersHeading = Children.toArray(children).some(
    (child) => isValidElement(child) && child.type === CardHeader,
  );

  return (
    <div
      className={`rounded-xl border border-line bg-surface shadow-raised transition-colors ${className}`}
      {...rest}
    >
      <CardChildLevelContext.Provider value={level + (rendersHeading ? 1 : 0)}>
        <CardFoldContext.Provider value={state}>{children}</CardFoldContext.Provider>
      </CardChildLevelContext.Provider>
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
  // Rank comes from nesting depth, not from a prop every call site would have to
  // keep correct: the page title is h1, a top-level card is h2, and so on.
  const Tag = headingTag(useHeadingLevel());

  // The toggle lives INSIDE the heading and is stretched over the header with a
  // pseudo-element, rather than the heading living inside the button. Both were
  // considered: wrapping the heading in the button is invalid — `button` accepts
  // phrasing content only, and a heading is flow content — and the browser then
  // has to guess how to expose it. A button inside the heading is valid, still
  // announces as the title, and still makes the whole header clickable.
  const titleNode = fold ? (
    <button
      type="button"
      onClick={fold.toggle}
      aria-expanded={fold.open}
      aria-controls={fold.bodyId}
      className="text-left transition-colors hover:text-text after:absolute after:inset-0 after:content-['']"
    >
      {title}
    </button>
  ) : (
    title
  );

  const headerClass =
    'relative flex items-start justify-between gap-3 border-b border-line px-5 py-3.5';

  return (
    <div className={headerClass}>
      <div className="flex min-w-0 items-start gap-2.5">
        {fold && (
          <ChevronDown
            size={15}
            aria-hidden
            className={`mt-0.5 shrink-0 text-faint transition-transform duration-200 ${fold.open ? '' : '-rotate-90'}`}
          />
        )}
        {icon && <span className="mt-0.5 text-accent">{icon}</span>}
        <div className="min-w-0">
          <Tag className="truncate text-sm font-semibold tracking-tight">{titleNode}</Tag>
          {subtitle && fold?.open !== false && (
            <p className="mt-0.5 text-xs text-muted">{subtitle}</p>
          )}
          {fold && !fold.open && fold.summary && (
            <p className="mt-0.5 text-xs text-faint">{fold.summary}</p>
          )}
        </div>
      </div>
      {/* Above the stretched toggle, or the overlay would swallow its clicks. */}
      {actions && <div className="relative z-10 flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}

export function CardBody({ className = '', children, ...rest }: React.HTMLAttributes<HTMLDivElement>) {
  const fold = useContext(CardFoldContext);
  const childLevel = useContext(CardChildLevelContext);
  // A folded card renders no body at all — keeping it mounted but hidden would
  // leave live subtrees (charts, pollers) running behind a closed section.
  if (fold && !fold.open) return null;
  const body = (
    <div id={fold?.bodyId} className={`px-5 py-4 ${className}`} {...rest}>
      {children}
    </div>
  );
  // Only a card that rendered a heading opens a level for what it contains.
  return childLevel == null ? body : <HeadingLevelProvider level={childLevel}>{body}</HeadingLevelProvider>;
}
