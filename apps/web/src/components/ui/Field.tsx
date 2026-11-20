import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from 'react';

/**
 * A labelled form field.
 *
 * The wrapping `<label>` is the right default because it needs no id plumbing
 * and labels a single control automatically. It breaks, though, as soon as a
 * field groups several controls: on the map, one "Custom target" label wrapped a
 * host input, a protocol select, a port input and the Measure button, so the
 * host input inherited the whole lot as its name — announced as "Cu tom target
 * tcptl http udpdn Mea ure" — while the other two controls got no name at all.
 *
 * Passing `htmlFor` switches to explicit association instead of wrapping, which
 * is the only correct option for a group: the visible label names the control
 * it belongs to, and each sibling control carries its own `aria-label`.
 */
export function Field({
  label,
  hint,
  error,
  htmlFor,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  /** Set this when the field holds more than one control; see the note above. */
  htmlFor?: string;
  children: ReactNode;
}) {
  // Label, then the control, then the help text.
  //
  // The hint used to sit between the label and the control, which pushed that
  // field's control down by a line. In a single column nobody noticed; the
  // moment two fields share a row, the one with a hint sits 20px lower than its
  // neighbour and the row looks broken. Help text below the control is also the
  // convention users expect.
  const labelEl = <span className="mb-1.5 block text-mini font-medium text-text">{label}</span>;
  const help = error ? (
    <span className="mt-1.5 block text-xs text-danger">{error}</span>
  ) : hint ? (
    <span className="mt-1.5 block text-xs text-faint">{hint}</span>
  ) : null;

  // Explicit association: the label names ONE control and the controls are its
  // SIBLINGS, not its descendants. Keeping them inside would label every one of
  // them with the caption and nothing else.
  if (htmlFor) {
    return (
      <div className="block">
        <label className="block" htmlFor={htmlFor}>
          {labelEl}
        </label>
        {children}
        {help}
      </div>
    );
  }

  return (
    <label className="block">
      {labelEl}
      {children}
      {help}
    </label>
  );
}

export function Input({ className = '', ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={`h-9 w-full rounded-lg border border-line bg-surface-2 px-3 text-sm text-text placeholder:text-faint transition-[border-color,box-shadow] focus:border-accent/60 focus:shadow-[0_0_0_1px_var(--color-accent)] focus:outline-none disabled:opacity-40 ${className}`}
      {...rest}
    />
  );
}

export function Select({
  className = '',
  children,
  ...rest
}: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={`h-9 w-full rounded-lg border border-line bg-surface-2 px-3 text-sm text-text transition-[border-color,box-shadow] focus:border-accent/60 focus:shadow-[0_0_0_1px_var(--color-accent)] focus:outline-none disabled:opacity-40 ${className}`}
      {...rest}
    >
      {children}
    </select>
  );
}