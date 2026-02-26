/**
 * @file time-picker.tsx
 * @description Input field that opens a floating iPhone-style drum-roll
 * time picker dropdown on click.
 *
 * - Shows a styled input with the current time value (or a placeholder).
 * - Clicking the input opens a portal-rendered floating panel with three
 *   scroll-snap drum columns: HH · MM · AM/PM.
 * - Clicking outside closes the panel.
 * - Fires `onChange` with a 24-hour "HH:mm" string.
 */

import {
  useEffect,
  useRef,
  useCallback,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { Clock } from "lucide-react";
import { cn } from "@/lib/utils";

// ─── helpers ─────────────────────────────────────────────────────────────────

function parseTime(value: string) {
  const [hStr = "09", mStr = "00"] = value.split(":");
  let h = parseInt(hStr, 10);
  const m = parseInt(mStr, 10);
  const period: "AM" | "PM" = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return { h12: h, minute: m, period };
}

function buildTime(h12: number, minute: number, period: "AM" | "PM"): string {
  let h24 = h12 % 12;
  if (period === "PM") h24 += 12;
  return `${String(h24).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function formatDisplay(value: string): string {
  if (!value) return "";
  const { h12, minute, period } = parseTime(value);
  return `${String(h12).padStart(2, "0")}:${String(minute).padStart(2, "0")} ${period}`;
}

const HOURS = Array.from({ length: 12 }, (_, i) => i + 1);
const MINUTES = Array.from({ length: 60 }, (_, i) => i);
const PERIODS: ("AM" | "PM")[] = ["AM", "PM"];

const ITEM_H = 44;

// ─── Drum column ─────────────────────────────────────────────────────────────

interface DrumColProps<T extends number | string> {
  items: T[];
  selected: T;
  onSelect: (v: T) => void;
  format?: (v: T) => string;
  label: string;
}

function DrumCol<T extends number | string>({
  items,
  selected,
  onSelect,
  format = (v) => String(v).padStart(2, "0"),
  label,
}: DrumColProps<T>) {
  const listRef = useRef<HTMLUListElement>(null);
  const isSyncing = useRef(false);

  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const idx = items.indexOf(selected);
    if (idx === -1) return;
    isSyncing.current = true;
    el.scrollTo({ top: idx * ITEM_H, behavior: "smooth" });
    const t = setTimeout(() => { isSyncing.current = false; }, 400);
    return () => clearTimeout(t);
  }, [selected, items]);

  const snapTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const handleScroll = useCallback(() => {
    if (isSyncing.current) return;
    const el = listRef.current;
    if (!el) return;
    const idx = Math.round(el.scrollTop / ITEM_H);
    const clamped = Math.max(0, Math.min(idx, items.length - 1));
    if (items[clamped] !== selected) onSelect(items[clamped]);
  }, [items, selected, onSelect]);

  const handleScrollEnd = useCallback(() => {
    clearTimeout(snapTimer.current);
    snapTimer.current = setTimeout(() => {
      const el = listRef.current;
      if (!el || isSyncing.current) return;
      const idx = Math.round(el.scrollTop / ITEM_H);
      const clamped = Math.max(0, Math.min(idx, items.length - 1));
      isSyncing.current = true;
      el.scrollTo({ top: clamped * ITEM_H, behavior: "smooth" });
      onSelect(items[clamped]);
      setTimeout(() => { isSyncing.current = false; }, 400);
    }, 80);
  }, [items, onSelect]);

  return (
    <div className="relative flex flex-col items-center flex-1">
      {/* Column label */}
      <span className="text-[9px] font-bold tracking-widest uppercase text-stone-400 mb-1 select-none">
        {label}
      </span>

      {/* Wrapper clips the scrolling list */}
      <div className="relative w-full" style={{ height: ITEM_H * 3 }}>

        {/* Selected-row highlight — sits behind the list via z-0 */}
        <div
          className="pointer-events-none absolute left-1 right-1 rounded-lg border border-stone-200"
          style={{
            top: ITEM_H,          // second row = centre
            height: ITEM_H,
            zIndex: 0,
            backgroundColor: "rgba(231,229,228,0.5)", // stone-200 at 50% opacity
          }}
        />

        {/* Top fade — only covers top row, stops before centre */}
        <div
          className="pointer-events-none absolute left-0 right-0 top-0"
          style={{
            height: ITEM_H,
            zIndex: 2,
            background: "linear-gradient(to bottom, rgba(255,255,255,1) 0%, rgba(255,255,255,0) 100%)",
          }}
        />
        {/* Bottom fade — only covers bottom row, stops before centre */}
        <div
          className="pointer-events-none absolute left-0 right-0 bottom-0"
          style={{
            height: ITEM_H,
            zIndex: 2,
            background: "linear-gradient(to top, rgba(255,255,255,1) 0%, rgba(255,255,255,0) 100%)",
          }}
        />

        {/* Scrolling list — z-1 so it renders above highlight, below fades */}
        <ul
          ref={listRef}
          onScroll={handleScroll}
          onTouchEnd={handleScrollEnd}
          onMouseUp={handleScrollEnd}
          className="overflow-y-scroll no-scrollbar select-none w-full absolute inset-0"
          style={{
            height: ITEM_H * 3,
            scrollSnapType: "y mandatory",
            WebkitOverflowScrolling: "touch",
            zIndex: 1,
          }}
          role="listbox"
          aria-label={label}
        >
          <li style={{ height: ITEM_H, flexShrink: 0 }} aria-hidden />
          {items.map((item) => (
            <li
              key={String(item)}
              role="option"
              aria-selected={item === selected}
              onClick={() => onSelect(item)}
              style={{ height: ITEM_H, scrollSnapAlign: "center" }}
              className={cn(
                "flex items-center justify-center cursor-pointer transition-all duration-150 text-base font-semibold rounded-lg mx-1",
                item === selected
                  ? "text-stone-900"
                  : "text-stone-400 hover:text-stone-600"
              )}
            >
              {format(item)}
            </li>
          ))}
          <li style={{ height: ITEM_H, flexShrink: 0 }} aria-hidden />
        </ul>
      </div>
    </div>
  );
}

// ─── Public component ─────────────────────────────────────────────────────────

interface TimePickerProps {
  value: string;
  onChange: (value: string) => void;
  className?: string;
}

export function TimePicker({ value, onChange, className }: TimePickerProps) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const [dropdownStyle, setDropdownStyle] = useState<React.CSSProperties>({});

  const parsed = value ? parseTime(value) : { h12: 9, minute: 0, period: "AM" as const };
  const [h12, setH12] = useState(parsed.h12);
  const [minute, setMinute] = useState(parsed.minute);
  const [period, setPeriod] = useState<"AM" | "PM">(parsed.period);

  // Sync internal state when external value changes (e.g. form reset)
  useEffect(() => {
    if (!value) {
      setH12(9); setMinute(0); setPeriod("AM");
      return;
    }
    const p = parseTime(value);
    setH12(p.h12);
    setMinute(p.minute);
    setPeriod(p.period);
  }, [value]);

  const emit = useCallback(
    (nh: number, nm: number, np: "AM" | "PM") => onChange(buildTime(nh, nm, np)),
    [onChange]
  );

  // Position the floating dropdown below (or above) the trigger
  const positionDropdown = useCallback(() => {
    const anchor = wrapperRef.current;
    if (!anchor) return;
    const rect = anchor.getBoundingClientRect();
    const dropH = 200; // approximate dropdown height
    const spaceBelow = window.innerHeight - rect.bottom;
    const top = spaceBelow >= dropH
      ? rect.bottom + window.scrollY + 6
      : rect.top + window.scrollY - dropH - 6;
    setDropdownStyle({
      position: "absolute",
      top,
      left: rect.left + window.scrollX,
      width: rect.width,
      zIndex: 9999,
    });
  }, []);

  const handleOpen = () => {
    positionDropdown();
    setOpen(true);
  };

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (
        wrapperRef.current?.contains(e.target as Node) ||
        dropdownRef.current?.contains(e.target as Node)
      ) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  // Reposition on scroll/resize while open
  useEffect(() => {
    if (!open) return;
    const handler = () => positionDropdown();
    window.addEventListener("scroll", handler, true);
    window.addEventListener("resize", handler);
    return () => {
      window.removeEventListener("scroll", handler, true);
      window.removeEventListener("resize", handler);
    };
  }, [open, positionDropdown]);

  const displayValue = formatDisplay(value);

  return (
    <div ref={wrapperRef} className={cn("relative", className)}>
      {/* Trigger input */}
      <button
        type="button"
        onClick={handleOpen}
        className={cn(
          "w-full flex items-center gap-2.5 px-3 h-10 rounded-lg border text-sm transition-colors text-left",
          open
            ? "border-stone-400 ring-2 ring-stone-200 bg-white"
            : "border-stone-200 bg-white hover:border-stone-300",
          !displayValue && "text-stone-400"
        )}
      >
        <Clock className="w-4 h-4 text-stone-400 shrink-0" />
        <span className={displayValue ? "text-stone-800 font-medium" : "text-stone-400"}>
          {displayValue || "Select time"}
        </span>
      </button>

      {/* Floating drum-roll panel — rendered in a portal */}
      {open && createPortal(
        <div
          ref={dropdownRef}
          style={dropdownStyle}
          className="rounded-xl border border-stone-200 bg-white shadow-xl overflow-hidden"
        >
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-2.5 border-b border-stone-100 bg-stone-50">
            <span className="text-xs font-semibold uppercase tracking-widest text-stone-500">
              Select Time
            </span>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="text-xs font-semibold text-stone-900 hover:text-stone-600 transition-colors"
            >
              Done
            </button>
          </div>

          {/* Drums */}
          <div className="flex items-stretch px-2 py-1 gap-1">
            <DrumCol
              items={HOURS}
              selected={h12}
              onSelect={(v) => { setH12(v); emit(v, minute, period); }}
              format={(v) => String(v).padStart(2, "0")}
              label="HH"
            />
            <div className="flex items-center justify-center text-lg font-bold text-stone-300 pb-0 select-none self-center">
              :
            </div>
            <DrumCol
              items={MINUTES}
              selected={minute}
              onSelect={(v) => { setMinute(v); emit(h12, v, period); }}
              format={(v) => String(v).padStart(2, "0")}
              label="MM"
            />
            <DrumCol
              items={PERIODS}
              selected={period}
              onSelect={(v) => { setPeriod(v); emit(h12, minute, v); }}
              format={(v) => v}
              label="AM/PM"
            />
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}

// ─── MaskedTimeInput ──────────────────────────────────────────────────────────
/**
 * A 12-hour typed time input with an adjacent AM/PM toggle button.
 *
 * HOW IT WORKS:
 *   - User types up to 4 digits (e.g. "0930") → auto-masked to "09:30".
 *   - Hours are clamped to 1–12; minutes to 0–59.
 *   - An AM / PM pill button sits right next to the field. Tapping
 *     it toggles the period instantly and re-fires onChange.
 *   - onChange always fires a 24h "HH:mm" string (same contract as before)
 *     so the hook, backend and DB are completely untouched.
 *   - The external `value` prop is a 24h "HH:mm" string; when it changes
 *     (e.g. form reset) the display and period are re-derived.
 */
interface MaskedTimeInputProps {
  value: string;          // "HH:mm" 24h or ""
  onChange: (v: string) => void;
  placeholder?: string;
  hasError?: boolean;
  className?: string;
}

/** Parse a 24h "HH:mm" into { display12: "hh:mm", period } for the typed field. */
function to12hDisplay(v: string): { display: string; period: "AM" | "PM" } {
  if (!v || !/^\d{2}:\d{2}$/.test(v)) return { display: "", period: "AM" };
  const { h12, minute, period } = parseTime(v);
  return {
    display: `${String(h12).padStart(2, "0")}:${String(minute).padStart(2, "0")}`,
    period,
  };
}

export function MaskedTimeInput({
  value,
  onChange,
  placeholder = "hh:mm",
  hasError = false,
  className,
}: MaskedTimeInputProps) {
  const initial = to12hDisplay(value);
  const [display, setDisplay] = useState(initial.display);
  const [period, setPeriod] = useState<"AM" | "PM">(initial.period);

  // Sync when external value changes (e.g. form reset)
  useEffect(() => {
    const parsed = to12hDisplay(value);
    setDisplay(parsed.display);
    setPeriod(parsed.period);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  /** Convert local 12h state → 24h string and fire parent onChange. */
  const emit = (disp: string, per: "AM" | "PM") => {
    const digits = disp.replace(/\D/g, "");
    if (digits.length < 4) return; // need all 4 digits (HHMM) before firing
    const h12 = Math.min(12, Math.max(1, Number(digits.slice(0, 2) || "12")));
    const m   = Math.min(59, Number(digits.slice(2, 4) || "0"));
    onChange(buildTime(h12, m, per));
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    // Keep only digits, max 4
    const digits = e.target.value.replace(/\D/g, "").slice(0, 4);

    // Rebuild 12h masked display: insert colon after 2 digits
    let masked = digits;
    if (digits.length >= 3) masked = digits.slice(0, 2) + ":" + digits.slice(2);
    setDisplay(masked);

    // Fire early only when 4 digits are entered and hours are valid (1–12)
    if (digits.length === 4) {
      const h12 = Number(digits.slice(0, 2));
      const m   = Number(digits.slice(2, 4));
      if (h12 >= 1 && h12 <= 12 && m <= 59) {
        onChange(buildTime(h12, m, period));
      }
    }
  };

  const handleBlur = () => {
    const digits = display.replace(/\D/g, "");
    if (!digits) return;
    // Clamp and complete any partial input
    const h12 = Math.min(12, Math.max(1, Number(digits.slice(0, 2) || "12")));
    const m   = Math.min(59, Number(digits.slice(2, 4) || "0"));
    const completed = `${String(h12).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
    setDisplay(completed);
    onChange(buildTime(h12, m, period));
  };

  const togglePeriod = () => {
    const next: "AM" | "PM" = period === "AM" ? "PM" : "AM";
    setPeriod(next);
    emit(display, next); // re-fire with new period immediately
  };

  return (
    <div className={cn("flex items-center gap-2", className)}>
      {/* Typed 12h field */}
      <div className="relative flex-1">
        <Clock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-stone-400 pointer-events-none" />
        <input
          type="text"
          inputMode="numeric"
          value={display}
          onChange={handleChange}
          onBlur={handleBlur}
          placeholder={placeholder}
          maxLength={5}
          className={cn(
            "w-full h-11 pl-10 pr-4 rounded-xl border bg-stone-50 text-stone-900 text-sm",
            "focus:outline-none focus:ring-2 focus:ring-amber-400/50 focus:border-amber-400",
            "placeholder:text-stone-400 transition-all duration-150",
            hasError ? "border-red-400" : "border-stone-200"
          )}
        />
      </div>

      {/* AM / PM toggle pill */}
      <button
        type="button"
        onClick={togglePeriod}
        className={cn(
          "h-11 px-3 rounded-xl border text-sm font-bold select-none transition-all min-w-[54px]",
          period === "AM"
            ? "bg-amber-50 border-amber-300 text-amber-700 hover:bg-amber-100"
            : "bg-stone-800 border-stone-700 text-white hover:bg-stone-700"
        )}
      >
        {period}
      </button>
    </div>
  );
}
