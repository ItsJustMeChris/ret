import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown } from "lucide-react";

export interface SelectOption<T extends string = string> {
  value: T;
  label: string;
  description?: string;
  icon?: React.ReactNode;
  disabled?: boolean;
}

interface Props<T extends string> {
  value: T;
  options: SelectOption<T>[];
  onChange: (value: T) => void;
  /** pill = compact toolbar control (composer); field = full-width form control. */
  variant?: "pill" | "field";
  title?: string;
  className?: string;
  /** Override what the closed control shows (defaults to the selected option's icon + label). */
  renderValue?: (option: SelectOption<T> | undefined) => React.ReactNode;
  placeholder?: string;
  disabled?: boolean;
  menuMinWidth?: number;
}

/** Fully styled replacement for <select>: portal popover, keyboard navigation, type-ahead. */
export function Select<T extends string>({
  value,
  options,
  onChange,
  variant = "pill",
  title,
  className,
  renderValue,
  placeholder = "Select…",
  disabled,
  menuMinWidth,
}: Props<T>) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const selected = options.find((o) => o.value === value);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (open) return; // the menu owns the keyboard while open
    if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      setOpen(true);
    }
  };

  return (
    <>
      <button
        ref={trigger}
        type="button"
        className={`sel sel-${variant} ${open ? "open" : ""} ${className ?? ""}`}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={onKeyDown}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={title}
        disabled={disabled}
      >
        {renderValue ? (
          renderValue(selected)
        ) : (
          <>
            {selected?.icon && <span className="sel-icon">{selected.icon}</span>}
            <span className="sel-label">{selected?.label ?? placeholder}</span>
          </>
        )}
        <ChevronDown className="sel-chev" size={12} />
      </button>
      {open && trigger.current && (
        <SelectMenu
          anchor={trigger.current}
          options={options}
          value={value}
          minWidth={menuMinWidth}
          onPick={(v) => {
            setOpen(false);
            if (v !== value) onChange(v);
            trigger.current?.focus();
          }}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

function SelectMenu<T extends string>({
  anchor,
  options,
  value,
  minWidth,
  onPick,
  onClose,
}: {
  anchor: HTMLElement;
  options: SelectOption<T>[];
  value: T;
  minWidth?: number;
  onPick: (v: T) => void;
  onClose: () => void;
}) {
  const menu = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(() => Math.max(0, options.findIndex((o) => o.value === value)));
  const [pos, setPos] = useState<{ left: number; top: number; maxHeight: number; above: boolean } | null>(null);
  const typed = useRef({ text: "", at: 0 });

  const place = useCallback(() => {
    const r = anchor.getBoundingClientRect();
    const el = menu.current;
    const h = el?.scrollHeight ?? 240;
    const w = el?.offsetWidth ?? 220;
    const below = window.innerHeight - r.bottom - 8;
    const above = r.top - 8;
    const flip = below < Math.min(h, 240) && above > below;
    const maxHeight = Math.min(360, flip ? above - 4 : below - 4);
    setPos({
      left: Math.max(8, Math.min(r.left, window.innerWidth - w - 8)),
      top: flip ? r.top - 4 - Math.min(h, maxHeight) : r.bottom + 4,
      maxHeight,
      above: flip,
    });
  }, [anchor]);

  useLayoutEffect(place, [place]);

  useEffect(() => {
    menu.current?.querySelector<HTMLElement>(".sel-opt.active")?.scrollIntoView({ block: "nearest" });
  }, [active, pos]);

  useEffect(() => {
    const move = (dir: 1 | -1, from = active) => {
      for (let i = 1; i <= options.length; i++) {
        const idx = (from + dir * i + options.length) % options.length;
        if (!options[idx].disabled) return setActive(idx);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" || e.key === "Tab") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        move(1);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        move(-1);
      } else if (e.key === "Home") {
        e.preventDefault();
        move(1, -1);
      } else if (e.key === "End") {
        e.preventDefault();
        move(-1, options.length);
      } else if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        const opt = options[active];
        if (opt && !opt.disabled) onPick(opt.value);
      } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
        // Type-ahead: jump to the first option whose label starts with what was typed.
        const now = Date.now();
        typed.current = { text: (now - typed.current.at < 700 ? typed.current.text : "") + e.key.toLowerCase(), at: now };
        const hit = options.findIndex((o) => !o.disabled && o.label.toLowerCase().startsWith(typed.current.text));
        if (hit >= 0) setActive(hit);
      }
    };
    const onDown = (e: PointerEvent) => {
      if (!menu.current?.contains(e.target as Node) && !anchor.contains(e.target as Node)) onClose();
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("resize", onClose);
    window.addEventListener("blur", onClose);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("resize", onClose);
      window.removeEventListener("blur", onClose);
    };
  }, [active, options, onPick, onClose, anchor]);

  const hasDescriptions = options.some((o) => o.description);

  return createPortal(
    <div
      ref={menu}
      role="listbox"
      className={`sel-menu ${hasDescriptions ? "rich" : ""} ${pos?.above ? "above" : ""}`}
      style={{
        left: pos?.left ?? -9999,
        top: pos?.top ?? -9999,
        maxHeight: pos?.maxHeight,
        minWidth: Math.max(minWidth ?? 0, anchor.getBoundingClientRect().width),
      }}
    >
      {options.map((o, i) => (
        <div
          key={o.value}
          role="option"
          aria-selected={o.value === value}
          aria-disabled={o.disabled}
          className={`sel-opt ${i === active ? "active" : ""} ${o.value === value ? "selected" : ""} ${o.disabled ? "disabled" : ""}`}
          onPointerMove={() => i !== active && !o.disabled && setActive(i)}
          onClick={() => !o.disabled && onPick(o.value)}
        >
          <span className="sel-opt-icon">{o.icon}</span>
          <span className="sel-opt-text">
            <span className="sel-opt-label">{o.label}</span>
            {o.description && <span className="sel-opt-desc">{o.description}</span>}
          </span>
          <span className="sel-opt-check">{o.value === value && <Check size={13} />}</span>
        </div>
      ))}
    </div>,
    document.body,
  );
}
