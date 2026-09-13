import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from 'react';

export function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[13px] font-medium text-text">{label}</span>
      {children}
      {hint && !error && <span className="mt-1 block text-xs text-faint">{hint}</span>}
      {error && <span className="mt-1 block text-xs text-danger">{error}</span>}
    </label>
  );
}

export function Input({ className = '', ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={`h-9 w-full rounded-lg border border-line bg-surface-2 px-3 text-sm text-text placeholder:text-faint transition-colors focus:border-accent/50 focus:outline-none disabled:opacity-40 ${className}`}
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
      className={`h-9 w-full rounded-lg border border-line bg-surface-2 px-3 text-sm text-text transition-colors focus:border-accent/50 focus:outline-none disabled:opacity-40 ${className}`}
      {...rest}
    >
      {children}
    </select>
  );
}
