import { Loader2 } from 'lucide-react';

import type { ButtonHTMLAttributes, ReactNode } from 'react';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
type Size = 'sm' | 'md' | 'lg';

const VARIANTS: Record<Variant, string> = {
  primary:
    'bg-accent text-on-accent border border-transparent hover:bg-accent-strong disabled:hover:bg-accent',
  secondary:
    'bg-surface-2 text-text border border-line hover:border-line-strong hover:bg-surface-3',
  ghost: 'bg-transparent text-muted border border-transparent hover:text-text hover:bg-surface-2',
  danger: 'bg-danger text-white border border-transparent hover:brightness-110',
};

const SIZES: Record<Size, string> = {
  sm: 'h-8 px-3 text-xs gap-1.5',
  md: 'h-9 px-4 text-sm gap-2',
  lg: 'h-11 px-5 text-sm gap-2',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  children?: ReactNode;
}

export function Button({
  variant = 'secondary',
  size = 'md',
  loading = false,
  disabled,
  className = '',
  children,
  ...rest
}: ButtonProps) {
  return (
    <button
      // `active:scale` is the whole of the press feedback: 3% is enough to feel
      // the button give under the cursor without the row shifting. Colour,
      // border and shadow animate; the transform is instantaneous in, eased out
      // — a springy press-release on a 32px-high button reads as a wobble.
      className={`inline-flex items-center justify-center rounded-lg font-medium transition-[transform,background-color,border-color,color,box-shadow] duration-200 ease-out focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-50 disabled:active:scale-100 motion-reduce:transform-none ${VARIANTS[variant]} ${SIZES[size]} ${className}`}
      disabled={disabled || loading}
      {...rest}
    >
      {loading && <Loader2 size={14} className="animate-spin" />}
      {children}
    </button>
  );
}
