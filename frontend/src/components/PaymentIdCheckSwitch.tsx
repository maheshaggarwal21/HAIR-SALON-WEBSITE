/**
 * @file PaymentIdCheckSwitch.tsx
 * @description "Payment ID check: Log only / Enforce" — the small switch above Sign Out (audit #1, D70).
 *
 * Log only (the default): every sale is saved; a payment id that does not check out is only listed under
 * Fix numbers & errors → Payment log errors. Enforce: a sale is refused when its payment id is clearly
 * wrong. Switching TO enforce asks first; switching back does not. The server decides who may use it
 * (owner, or anyone with paymentcheck.manage, visit.create or datafixes.manage); for anyone else the first request is refused
 * and nothing is drawn. Every change is audited on the server and tells the owner on Telegram.
 */

import { useEffect, useState } from "react";

const API = import.meta.env.VITE_BACKEND_URL || "";

type Mode = "log" | "enforce";

const TIP: Record<Mode, string> = {
  log: "Log only: every sale is saved. A payment id that doesn't check out is listed under Fix numbers & errors → Payment log errors.",
  enforce: "Enforce: a sale is refused if its payment id is clearly wrong (not a Razorpay payment, failed, or the wrong amount). Switch back to Log only if a sale gets blocked.",
};

async function request(init?: RequestInit): Promise<Mode> {
  const res = await fetch(`${API}/api/payment-id-check`, { credentials: "include", headers: { "Content-Type": "application/json" }, ...init });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Could not change the setting");
  return data.mode === "enforce" ? "enforce" : "log";
}

export default function PaymentIdCheckSwitch() {
  const [mode, setMode] = useState<Mode | null>(null);
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    let live = true;
    request()
      .then((m) => live && setMode(m))
      .catch(() => {}); // not allowed to use it (or offline): the switch stays hidden
    return () => {
      live = false;
    };
  }, []);

  if (!mode) return null;

  const change = async (next: Mode) => {
    setBusy(true);
    setErr("");
    try {
      setMode(await request({ method: "PUT", body: JSON.stringify({ mode: next }) }));
      setAsking(false);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const enforce = mode === "enforce";
  return (
    <div className="shrink-0 px-4 pb-2 pt-3" title={TIP[mode]}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs leading-tight text-stone-400">
          Payment ID check:
          <br />
          <span className={enforce ? "text-stone-500" : "font-semibold text-stone-100"}>Log only</span>
          <span className="text-stone-500"> / </span>
          <span className={enforce ? "font-semibold text-amber-400" : "text-stone-500"}>Enforce</span>
        </span>
        <button
          type="button"
          role="switch"
          aria-checked={enforce}
          aria-label="Payment ID check: Log only or Enforce"
          disabled={busy}
          onClick={() => (enforce ? change("log") : setAsking(true))}
          className={`relative h-5 w-9 shrink-0 rounded-full transition-colors disabled:opacity-50 ${enforce ? "bg-amber-600" : "bg-stone-600"}`}
        >
          <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all ${enforce ? "left-[18px]" : "left-0.5"}`} />
        </button>
      </div>
      {asking && !enforce && (
        <div className="mt-2 rounded-lg bg-stone-800 p-2.5 text-xs text-stone-200">
          Saves will be refused if a payment id doesn't match. Switch back to Log only if a sale gets blocked.
          <div className="mt-2 flex gap-2">
            <button disabled={busy} onClick={() => change("enforce")} className="rounded-md bg-amber-600 px-2.5 py-1 font-medium text-white disabled:opacity-50">
              {busy ? "Switching…" : "Switch to Enforce"}
            </button>
            <button disabled={busy} onClick={() => setAsking(false)} className="rounded-md px-2.5 py-1 text-stone-300 hover:bg-stone-700">
              Cancel
            </button>
          </div>
        </div>
      )}
      {err && <p className="mt-1 text-xs text-red-400">{err}</p>}
    </div>
  );
}
