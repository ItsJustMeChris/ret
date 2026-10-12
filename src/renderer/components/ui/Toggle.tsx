import { Check } from "lucide-react";

/** Styled checkbox (no native input). */
export function Checkbox({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label?: React.ReactNode;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      className={`checkbox ${checked ? "on" : ""}`}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <span className="checkbox-box">{checked && <Check size={11} strokeWidth={3} />}</span>
      {label && <span className="checkbox-label">{label}</span>}
    </button>
  );
}

/** Styled on/off switch (no native input). */
export function Switch({ checked, onChange, title, disabled }: { checked: boolean; onChange: (checked: boolean) => void; title?: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      className={`switch ${checked ? "on" : ""}`}
      title={title}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <span className="switch-knob" />
    </button>
  );
}
