"use client";

/**
 * First-touch attribution (T1.15, CF §17). On the first landing that carries
 * utm_* or fbclid, remember them for 30 days; the request form attaches them so
 * the staff app shows which ad or post a request came from.
 *
 * First touch wins: a later visit with different UTMs doesn't overwrite them
 * inside the 30 days. localStorage can be unavailable (private mode, in-app
 * browsers, blocked storage), so every access is wrapped and the site works the
 * same without it.
 */

import { useEffect } from "react";

const KEY = "exp_first_touch";
const TTL_MS = 30 * 24 * 60 * 60 * 1000;
const PARAMS = { utm_source: "source", utm_medium: "medium", utm_campaign: "campaign", utm_content: "content", fbclid: "fbclid" } as const;

export type Utm = Partial<Record<(typeof PARAMS)[keyof typeof PARAMS], string>>;

export function readFirstTouch(): Utm | null {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return null;
    const stored = JSON.parse(raw) as { utm: Utm; at: number };
    if (!stored?.at || Date.now() - stored.at > TTL_MS) return null;
    return stored.utm;
  } catch {
    return null;
  }
}

export function UtmCapture() {
  useEffect(() => {
    try {
      const qs = new URLSearchParams(window.location.search);
      const utm: Utm = {};
      for (const [param, field] of Object.entries(PARAMS)) {
        const v = qs.get(param);
        if (v) utm[field] = v.slice(0, field === "fbclid" ? 255 : 100);
      }
      if (!Object.keys(utm).length || readFirstTouch()) return;
      window.localStorage.setItem(KEY, JSON.stringify({ utm, at: Date.now() }));
    } catch {
      // Storage unavailable — attribution is a nice-to-have, never a blocker.
    }
  }, []);
  return null;
}
