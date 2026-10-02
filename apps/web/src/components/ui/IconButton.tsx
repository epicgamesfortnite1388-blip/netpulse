import { Button } from './Button';

import type { ButtonProps } from './Button';
import type { ReactNode } from 'react';

/**
 * A button whose entire content is an icon.
 *
 * Why this exists: an icon carries no words, so a screen reader announces the
 * control as just "button" and a keyboard user tabbing the page hears a run of
 * identical, meaningless stops. The audit found 54 of them — a "Measure" play
 * icon repeated down the map's target list, a bare trash can per server card.
 *
 * The fix is a type, not a lint rule: `label` is REQUIRED and `children` is
 * required, so an icon-only button cannot be written without naming what it
 * does. There is no way to reach a nameless icon button without deleting this
 * component. The name goes on `aria-label` (what assistive tech announces) and
 * `title` (what a sighted mouse user gets on hover), and callers are expected to
 * make the label name the specific target — "Measure 1.1.1.1:443", not
 * "Measure" — so the list of stops is meaningful out of context.
 */
export interface IconButtonProps extends Omit<ButtonProps, 'children' | 'aria-label'> {
  /** REQUIRED: the control's accessible name. Names the specific target. */
  label: string;
  /** The icon itself, and nothing else. */
  children: ReactNode;
}

export function IconButton({ label, children, ...rest }: IconButtonProps) {
  return (
    <Button aria-label={label} title={label} {...rest}>
      {children}
    </Button>
  );
}