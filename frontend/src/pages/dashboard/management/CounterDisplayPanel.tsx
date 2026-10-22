/**
 * @file CounterDisplayPanel.tsx
 * @description Owner: pair, rename and revoke the counter tablets (D60, A7).
 *
 * Pairing: the owner types a name, gets a one-time 6-digit code (valid 5 minutes,
 * works once), and enters it on the tablet at /display. The tablet is then trusted with
 * a private token; revoking it here stops it at once.
 */

import { useCallback, useEffect, useState } from "react";
import { Loader2, MonitorSmartphone, Pencil, Plus, Trash2 } from "lucide-react";
import {
  CounterApiError,
  createPairingCode,
  fetchCounterDevices,
  renameCounterDevice,
  revokeCounterDevice,
  type CounterDeviceRow,
} from "@/services/counter";
import { Card, PanelHeader } from "./ui";

const DISPLAY_URL = "app.thexpertshair.com/display";

function ago(iso: string | null): string {
  if (!iso) return "never";
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 90) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
}

export default function CounterDisplayPanel() {
  const [devices, setDevices] = useState<CounterDeviceRow[] | null>(null);
  const [off, setOff] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("Counter tablet");
  const [pairing, setPairing] = useState<{ code: string; name: string; expiresAt: number } | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [confirmRevoke, setConfirmRevoke] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setDevices(await fetchCounterDevices());
      setOff(false);
    } catch (e) {
      if (e instanceof CounterApiError && e.status === 404) setOff(true);
      else setError(e instanceof Error ? e.message : "Could not load tablets");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // While a code is showing: tick the countdown, and look for the tablet joining every 5 s.
  useEffect(() => {
    if (!pairing) return;
    const tick = window.setInterval(() => setNow(Date.now()), 1000);
    const watch = window.setInterval(() => void load(), 5000);
    return () => {
      window.clearInterval(tick);
      window.clearInterval(watch);
    };
  }, [pairing, load]);

  const known = devices?.length ?? 0;
  const [seenCount, setSeenCount] = useState(0);
  // The code is single use: once a new tablet appears, the code is spent, so hide it.
  useEffect(() => {
    if (pairing && devices && devices.length > seenCount) {
      setPairing(null);
    }
  }, [devices, pairing, seenCount]);

  const makeCode = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await createPairingCode(name);
      setSeenCount(known);
      setNow(Date.now());
      setPairing({ code: r.code, name: r.name, expiresAt: new Date(r.expiresAt).getTime() });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not create a code");
    } finally {
      setBusy(false);
    }
  };

  const doRename = async () => {
    if (!renaming) return;
    try {
      await renameCounterDevice(renaming.id, renaming.name);
      setRenaming(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not rename");
    }
  };

  const doRevoke = async (id: string) => {
    try {
      await revokeCounterDevice(id);
      setConfirmRevoke(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not revoke");
    }
  };

  const left = pairing ? Math.max(0, Math.round((pairing.expiresAt - now) / 1000)) : 0;

  return (
    <div>
      <PanelHeader icon={MonitorSmartphone} title="Counter display" subtitle="The customer-facing tablet that shows the UPI payment QR" />

      {off && (
        <Card className="p-5 text-sm text-stone-700">
          <p className="font-semibold text-stone-900">Counter payments are switched off.</p>
          <p className="mt-1">
            To turn them on, set <code className="rounded bg-stone-100 px-1.5 py-0.5">COUNTER_DISPLAY_ENABLED=true</code> in the API project's environment variables on Vercel and redeploy. Until then the visit form
            keeps using Razorpay Checkout.
          </p>
        </Card>
      )}

      {error && <p className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p>}

      {!off && (
        <div className="space-y-6">
          <Card className="p-5">
            <h3 className="text-sm font-semibold text-stone-900">Pair a tablet</h3>
            <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm text-stone-600">
              <li>
                On the tablet, open <span className="font-medium text-stone-900">{DISPLAY_URL}</span>
              </li>
              <li>Press the button below to get a code, then type it on the tablet.</li>
            </ol>
            <div className="mt-4 flex flex-wrap items-end gap-3">
              <label className="text-xs font-semibold uppercase tracking-wide text-stone-500">
                Name
                <input value={name} maxLength={60} onChange={(e) => setName(e.target.value)} className="mt-1 block w-60 rounded-lg border border-stone-300 px-3 py-2 text-sm font-normal normal-case text-stone-900" />
              </label>
              <button type="button" onClick={makeCode} disabled={busy || !name.trim()} className="inline-flex items-center gap-1.5 rounded-lg bg-stone-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-40">
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />} Get pairing code
              </button>
            </div>
            {pairing && (
              <div className="mt-5 rounded-xl border border-amber-200 bg-amber-50 p-5 text-center">
                <p className="text-xs uppercase tracking-widest text-amber-800">Type this on “{pairing.name}”</p>
                <p className="mt-2 text-5xl font-semibold tracking-[0.3em] tabular-nums text-stone-900">{pairing.code}</p>
                <p className="mt-2 text-sm text-amber-900">
                  {left > 0 ? `Works once · expires in ${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}` : "Expired. Get a new code."}
                </p>
              </div>
            )}
          </Card>

          <Card>
            <div className="border-b border-stone-100 px-5 py-3 text-sm font-semibold text-stone-900">Paired tablets</div>
            {devices === null ? (
              <p className="p-5 text-sm text-stone-500">Loading…</p>
            ) : devices.length === 0 ? (
              <p className="p-5 text-sm text-stone-500">No tablet is paired yet.</p>
            ) : (
              <ul className="divide-y divide-stone-100">
                {devices.map((d) => (
                  <li key={d.id} className="flex flex-wrap items-center gap-3 px-5 py-3 text-sm">
                    <span className={`h-2 w-2 rounded-full ${d.online ? "bg-emerald-500" : "bg-red-500"}`} />
                    {renaming?.id === d.id ? (
                      <>
                        <input value={renaming.name} maxLength={60} onChange={(e) => setRenaming({ id: d.id, name: e.target.value })} className="rounded-lg border border-stone-300 px-2 py-1" />
                        <button type="button" onClick={doRename} className="font-medium text-stone-900 underline">Save</button>
                        <button type="button" onClick={() => setRenaming(null)} className="text-stone-500 underline">Cancel</button>
                      </>
                    ) : (
                      <>
                        <span className="font-medium text-stone-900">{d.name}</span>
                        <span className="text-stone-500">{d.online ? "online" : "offline"} · seen {ago(d.lastSeenAt)}</span>
                        <span className="text-xs text-stone-400">paired by {d.pairedBy ?? "owner"}</span>
                        <span className="ml-auto flex items-center gap-3">
                          <button type="button" onClick={() => setRenaming({ id: d.id, name: d.name })} aria-label={`Rename ${d.name}`} className="text-stone-500 hover:text-stone-900">
                            <Pencil className="h-4 w-4" />
                          </button>
                          {confirmRevoke === d.id ? (
                            <span className="flex items-center gap-2 text-xs">
                              <button type="button" onClick={() => doRevoke(d.id)} className="font-semibold text-red-700 underline">Yes, remove it</button>
                              <button type="button" onClick={() => setConfirmRevoke(null)} className="text-stone-500 underline">No</button>
                            </span>
                          ) : (
                            <button type="button" onClick={() => setConfirmRevoke(d.id)} aria-label={`Remove ${d.name}`} className="text-stone-500 hover:text-red-700">
                              <Trash2 className="h-4 w-4" />
                            </button>
                          )}
                        </span>
                      </>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <p className="text-xs text-stone-500">
            Removing a tablet stops it at once; it shows the pairing screen again. A tablet that missed its check-ins shows as offline and the visit form then shows the QR on the staff screen.
          </p>
        </div>
      )}
    </div>
  );
}
