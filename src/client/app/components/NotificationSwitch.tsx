type NotificationSwitchProps = {
  checked: boolean;
  disabled: boolean;
  label: string;
  busy?: boolean;
  onCheckedChange: (checked: boolean) => void;
};

export const NotificationSwitch = ({
  checked,
  disabled,
  label,
  busy = false,
  onCheckedChange,
}: NotificationSwitchProps) => (
  <label
    className={`relative inline-flex shrink-0 items-center ${disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer"}`}
    data-notification-switch="true"
  >
    <input
      type="checkbox"
      role="switch"
      checked={checked}
      disabled={disabled}
      aria-label={label}
      aria-busy={busy}
      className="peer sr-only"
      onChange={(event) => onCheckedChange(event.currentTarget.checked)}
    />
    <span className="h-7 w-12 rounded-full border border-[color:var(--sg-border-strong)] bg-[color:var(--sg-surface-muted)] shadow-inner transition-colors peer-checked:border-green-500 peer-checked:bg-green-500 peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-[color:var(--sg-border-strong)]" />
    <span className="pointer-events-none absolute left-0.5 top-0.5 h-6 w-6 rounded-full bg-white shadow-sm transition-transform peer-checked:translate-x-5" />
  </label>
);
