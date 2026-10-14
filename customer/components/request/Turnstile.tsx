"use client";

/**
 * Cloudflare Turnstile widget (T0.11, CF §18). Loads Cloudflare's script only
 * when the details step mounts, so the landing page never pays for it.
 *
 * The token it produces is checked by the API (backend/utils/turnstile.js); the
 * widget alone decides nothing. Without a site key (local dev) it renders
 * nothing and reports "no token", and the dev API skips the check.
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

export function Turnstile({ onToken, resetKey }: { onToken: (token: string | null) => void; resetKey?: number }) {
  const box = useRef<HTMLDivElement>(null);
  const widgetId = useRef<string | null>(null);
  const callback = useRef(onToken);

  useEffect(() => {
    callback.current = onToken;
  }, [onToken]);

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
          callback: (t: string) => callback.current(t),
          "expired-callback": () => callback.current(null),
          "error-callback": () => callback.current(null),
        });
      })
      .catch(() => callback.current(null));
    return () => {
      cancelled = true;
      if (widgetId.current && window.turnstile) window.turnstile.remove(widgetId.current);
      widgetId.current = null;
    };
  }, []);

  // A failed submit burns the token; ask for a fresh one.
  useEffect(() => {
    if (resetKey && widgetId.current && window.turnstile) {
      window.turnstile.reset(widgetId.current);
      callback.current(null);
    }
  }, [resetKey]);

  if (!TURNSTILE_SITE_KEY) return null;
  return <div ref={box} className="min-h-[1px]" />;
}
