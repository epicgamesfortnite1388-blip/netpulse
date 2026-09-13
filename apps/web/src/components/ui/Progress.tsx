export function Progress({
  value,
  indeterminate = false,
}: {
  /** 0-100 */
  value?: number;
  indeterminate?: boolean;
}) {
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-2">
      {indeterminate ? (
        <div className="h-full w-1/3 animate-[pulse-dot_1.2s_ease-in-out_infinite] rounded-full bg-accent/60" />
      ) : (
        <div
          className="h-full rounded-full bg-accent transition-[width] duration-300"
          style={{ width: `${Math.max(0, Math.min(100, value ?? 0))}%` }}
        />
      )}
    </div>
  );
}
