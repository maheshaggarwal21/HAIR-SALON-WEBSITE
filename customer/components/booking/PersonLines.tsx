/**
 * @file PersonLines.tsx
 * @description A group booking, one block per person: their name, then each service with its artist
 * and time (D67). Used on the booking sheet's confirmation and on the manage page. A one-person
 * booking never uses this: it keeps its plain list.
 */
import type { PublicBooking } from "@/lib/types";
import { rupees } from "@/lib/format";

const time = (iso: string) => new Date(iso).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit", hour12: true, timeZone: "Asia/Kolkata" });

export function PersonLines({ guests, showPrice = true }: { guests: PublicBooking["guests"]; showPrice?: boolean }) {
  return (
    <div className="space-y-3">
      {guests.map((g, idx) => (
        <div key={g.key}>
          <div className="font-semibold">{g.name || (idx === 0 ? "You" : `Guest ${idx + 1}`)}</div>
          <ul className="mt-1 space-y-1">
            {g.items.map((i, n) => (
              <li key={`${g.key}-${n}`} className="flex justify-between gap-3">
                <span>
                  {i.name}
                  {i.artistName ? <span className="text-ink-muted"> · {i.artistName}</span> : null}
                  {i.startAt ? <span className="text-ink-muted"> · {time(i.startAt)}</span> : null}
                </span>
                {showPrice && <span className="tabular">{rupees(i.price)}</span>}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}
