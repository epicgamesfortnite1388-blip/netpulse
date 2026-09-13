import * as RSwitch from '@radix-ui/react-switch';

export function Switch({
  checked,
  onCheckedChange,
  disabled = false,
}: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <RSwitch.Root
      checked={checked}
      onCheckedChange={onCheckedChange}
      disabled={disabled}
      className={`relative h-5.5 w-10 shrink-0 rounded-full border border-line-strong transition-colors data-[state=checked]:border-accent/50 data-[state=checked]:bg-accent/30 data-[state=unchecked]:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-40 ${
        checked ? '' : ''
      }`}
      style={{ height: 22, width: 40 }}
    >
      <RSwitch.Thumb className="block h-4 w-4 translate-x-1 rounded-full bg-muted shadow transition-transform data-[state=checked]:translate-x-5 data-[state=checked]:bg-accent-strong" />
    </RSwitch.Root>
  );
}
