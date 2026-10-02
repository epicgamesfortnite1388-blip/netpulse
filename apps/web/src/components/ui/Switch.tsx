import * as RSwitch from '@radix-ui/react-switch';

export interface SwitchProps {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  /**
   * REQUIRED: the control's accessible name.
   *
   * A switch is a labelled "on/off" box — it conveys STATE but says nothing
   * about WHAT it turns on, so an unlabelled one is announced as just "switch,
   * on". The settings rows render their title as a sibling <div>, which no
   * assistive tech can associate; the label prop is what binds the two, and
   * making it required means the next switch added here cannot be nameless.
   */
  label: string;
}

export function Switch({ checked, onCheckedChange, disabled = false, label }: SwitchProps) {
  return (
    <RSwitch.Root
      checked={checked}
      onCheckedChange={onCheckedChange}
      disabled={disabled}
      aria-label={label}
      title={label}
      className="relative h-5.5 w-10 shrink-0 rounded-full border border-line-strong transition-colors data-[state=checked]:border-accent/50 data-[state=checked]:bg-accent/30 data-[state=unchecked]:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-40"
      style={{ height: 22, width: 40 }}
    >
      <RSwitch.Thumb className="block h-4 w-4 translate-x-1 rounded-full bg-muted shadow transition-transform data-[state=checked]:translate-x-5 data-[state=checked]:bg-accent-strong" />
    </RSwitch.Root>
  );
}