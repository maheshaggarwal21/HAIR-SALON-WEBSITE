/**
 * @file HeldMessages.tsx
 * @description A short warning on the Website Requests page when WhatsApp messages to
 * customers did not go out (failed, or held back because WhatsApp is not set up).
 * Shows nothing when everything went. Held-back messages are resent automatically
 * while they are still useful; this list is so the desk knows who to message by hand.
 */

import { useEffect, useState } from "react";
import { AlertTriangle } from "lucide-react";

const API = import.meta.env.VITE_BACKEND_URL || "";
const IST = "Asia/Kolkata";

interface Held {
  _id: string;
  type: string;
  status: "failed" | "skipped";
  error: string | null;
  to: string | null;
  ref: string | null;
  name: string | null;
  at: string;
}

const label = (type: string) => type.replace(/_/g, " ");
const time = (iso: string) => new Date(iso).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit", hour12: true, timeZone: IST });

export default function HeldMessages() {
  const [rows, setRows] = useState<Held[]>([]);
  const [dryRun, setDryRun] = useState(0);

  useEffect(() => {
    fetch(`${API}/api/bookings/messages`, { credentials: "include" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!d) return;
        setRows(Array.isArray(d.messages) ? d.messages : []);
        setDryRun(Number(d.dryRun) || 0);
      })
      .catch(() => undefined); // a warning is a bonus: never block the page
  }, []);

  if (!rows.length && !dryRun) return null;

  return (
    <div className="mb-5 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
      <div className="flex items-center gap-2 font-semibold">
        <AlertTriangle className="w-4 h-4" />
        {rows.length ? `${rows.length} WhatsApp message${rows.length === 1 ? "" : "s"} did not reach customers (last 7 days)` : "WhatsApp is in test mode"}
      </div>
      {dryRun > 0 && (
        <p className="mt-1 text-amber-800">
          {dryRun} message{dryRun === 1 ? " was" : "s were"} held back on purpose (test mode). Customers are not being messaged until test mode is turned off.
        </p>
      )}
      {rows.length > 0 && (
        <ul className="mt-2 space-y-1">
          {rows.slice(0, 10).map((m) => (
            <li key={m._id}>
              <span className="font-medium">{m.ref ?? "—"}</span> {m.name ? `· ${m.name} ` : ""}
              {m.to ? `· ${m.to} ` : ""}· {label(m.type)} · {m.status === "failed" ? "failed" : "not sent yet"} · {time(m.at)}
              {m.error ? <span className="text-amber-800/80"> ({m.error})</span> : null}
            </li>
          ))}
          {rows.length > 10 && <li>…and {rows.length - 10} more</li>}
        </ul>
      )}
    </div>
  );
}
