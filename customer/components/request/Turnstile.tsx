"use client";

/**
 * Cloudflare Turnstile widget (T0.11, CF §18). Loads Cloudflare's script only
 * when the details step mounts, so the landing page never pays for it.
 *
 * The token it produces is checked by the API (backend/utils/turnstile.js); the
 * widget alone decides nothing. Without a site key (local dev) it renders
 * nothing and reports "no token", and the dev API skips the check.
 *
 * `onFail` fires when the check cannot finish (the script is blocked, Cloudflare reports an
 * error, or no token arrives in 15 seconds), so the page can say so instead of leaving a
 * button greyed out with no explanation.
 */

import { useEffect, useRef } from "react";
import { TURNSTILE_SITE_KEY } from "@/lib/config";

declare global {
  interface Window {
    turnstile?: {
      render: (el: HTMLElement, opts: Record<string, unknown>) => string;
      reset: (id?: string) => void;
      remove: (id: string) => void;
    };
  }
}

const GIVE_UP_MS = 15_000;
const SCRIPT_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
let scriptPromise: Promise<void> | null = null;

function loadScript() {
  if (window.turnstile) return Promise.resolve();
  scriptPromise ??= new Promise<void>((resolve, reject) => {
    const s = document.createElement("script");
    s.src = SCRIPT_SRC;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => {
      scriptPromise = null;
      reject(new Error("Turnstile failed to load"));
    };
    document.head.appendChild(s);
  });
  return scriptPromise;
}

export function Turnstile({ onToken, onFail, resetKey }: { onToken: (token: string | null) => void; onFail?: () => void; resetKey?: number }) {
  const box = useRef<HTMLDivElement>(null);
  const widgetId = useRef<string | null>(null);
  const callback = useRef(onToken);
  const failed = useRef(onFail);
  const gaveUp = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    callback.current = onToken;
    failed.current = onFail;
  }, [onToken, onFail]);

  /** (Re)start the 15-second clock for a token; a token, or leaving the page, stops it. */
  const startClock = () => {
    if (gaveUp.current) clearTimeout(gaveUp.current);
    gaveUp.current = setTimeout(() => failed.current?.(), GIVE_UP_MS);
  };

  useEffect(() => {
    if (!TURNSTILE_SITE_KEY || !box.current) return;
    let cancelled = false;
    loadScript()
      .then(() => {
        if (cancelled || !box.current || !window.turnstile) return;
        widgetId.current = window.turnstile.render(box.current, {
          sitekey: TURNSTILE_SITE_KEY,
          action: "request",
          appearance: "interaction-only",
          callback: (t: string) => {
            if (gaveUp.current) clearTimeout(gaveUp.current);
            callback.current(t);
          },
          "expired-callback": () => callback.current(null),
          "error-callback": () => {
            if (gaveUp.current) clearTimeout(gaveUp.current);
            callback.current(null);
            failed.current?.();
          },
        });
        startClock();
      })
      .catch(() => {
        callback.current(null);
        failed.current?.();
      });
    return () => {
      cancelled = true;
      if (gaveUp.current) clearTimeout(gaveUp.current);
      if (widgetId.current && window.turnstile) window.turnstile.remove(widgetId.current);
      widgetId.current = null;
    };
  }, []);

  // A failed submit burns the token; ask for a fresh one.
  useEffect(() => {
    if (resetKey && widgetId.current && window.turnstile) {
      window.turnstile.reset(widgetId.current);
      callback.current(null);
      startClock();
    }
  }, [resetKey]);

  if (!TURNSTILE_SITE_KEY) return null;
  return <div ref={box} className="min-h-[1px]" />;
}
