/**
 * @file useCounterPayment.ts
 * @description The staff screen's side of a counter UPI payment (D60, part A).
 *
 * Replaces Razorpay Checkout for "UPI (QR)" and the UPI part of a split, when the
 * feature is on. Flow: ask the server to start a payment (it prices the sale and
 * makes the QR) → the customer sees it on the tablet, or here if the tablet is off →
 * poll the server every 2.5 s → once the SERVER says paid, save the visit with just
 * the session's id. This screen never decides that money arrived.
 *
 * Polling is the cost to watch on Vercel: one cheap GET every 2.5 s only while a QR is
 * waiting (stops the moment it is paid, cancelled or expired), plus a tablet-status
 * check every ~20 s while this page is open on a UPI payment mode.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  CounterApiError,
  cancelCounterSession,
  createCounterSession,
  fetchCounterSession,
  fetchCounterStatus,
  showCounterQrHere,
  type CounterSaleInput,
  type CounterSessionView,
  type CounterStatus,
} from "@/services/counter";

const SESSION_POLL_MS = 2500;

interface Options {
  /** UPI is the chosen method and this is an ordinary desk sale (not a booking or a recovery). */
  relevant: boolean;
  /** Save the visit for a paid session. Throwing shows the loud "payment received" error. */
  onPaid: (session: CounterSessionView) => Promise<void>;
}

export function useCounterPayment({ relevant, onPaid }: Options) {
  const [status, setStatus] = useState<CounterStatus | null>(null);
  const [wantTablet, setWantTablet] = useState(true);
  const [session, setSession] = useState<CounterSessionView | null>(null);
  const [starting, setStarting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [checkoutInstead, setCheckoutInstead] = useState(false);
  const handled = useRef<string | null>(null);
  const onPaidRef = useRef(onPaid);
  useEffect(() => {
    onPaidRef.current = onPaid;
  }, [onPaid]);

  // Is the tablet there? Asked every ~20 s while this page is on a UPI method.
  useEffect(() => {
    if (!relevant) return;
    let stopped = false;
    let timer: number | undefined;
    const run = async () => {
      let next = 60_000;
      if (!document.hidden) {
        try {
          const s = await fetchCounterStatus();
          if (stopped) return;
          setStatus(s);
          if (!s.enabled) return; // switched off: never ask again
          next = s.nextPollMs ?? 20_000;
        } catch {
          /* keep the last answer */
        }
      }
      if (!stopped) timer = window.setTimeout(() => void run(), next);
    };
    void run();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [relevant]);

  // Watch a waiting QR until the server says otherwise.
  const sessionId = session?.id;
  const pending = session?.status === "pending";
  useEffect(() => {
    if (!sessionId || !pending) return;
    let stopped = false;
    let timer: number | undefined;
    const run = async () => {
      let next = SESSION_POLL_MS;
      try {
        const s = await fetchCounterSession(sessionId);
        if (stopped) return;
        setSession(s);
        if (s.status !== "pending") return;
      } catch {
        next = 4000; // a blip tells us nothing about the payment
      }
      if (!stopped) timer = window.setTimeout(() => void run(), next);
    };
    void run();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [sessionId, pending]);

  // The server says paid: save the visit, once.
  useEffect(() => {
    if (session?.status !== "paid" || handled.current === session.id) return;
    handled.current = session.id;
    setSaving(true);
    onPaidRef
      .current(session)
      .catch((err) => {
        setError(
          `PAYMENT RECEIVED but the visit could not be saved. The customer HAS paid ₹${session.amount.toLocaleString("en-IN")} — do not charge again. ` +
            `Try again; if it keeps failing, record it from Payments → Unreconciled. ${err instanceof Error ? `(${err.message})` : ""}`
        );
        handled.current = null; // allow a retry
      })
      .finally(() => setSaving(false));
  }, [session]);

  const tabletOnline = !!status?.anyOnline;
  const enabled = status?.enabled === true && relevant && !checkoutInstead;
  const target: "tablet" | "pc" = wantTablet && tabletOnline ? "tablet" : "pc";

  const start = useCallback(
    async (sale: Omit<CounterSaleInput, "target">) => {
      setError(null);
      setStarting(true);
      try {
        setSession(await createCounterSession({ ...sale, target }));
      } catch (err) {
        if (err instanceof CounterApiError && err.busy) setWantTablet(false);
        if (err instanceof CounterApiError && err.qrFailed) setCheckoutInstead(true);
        setError(err instanceof Error ? err.message : "Could not start the payment");
      } finally {
        setStarting(false);
      }
    },
    [target]
  );

  const cancel = useCallback(async () => {
    if (!session) return;
    try {
      const after = await cancelCounterSession(session.id);
      setSession(after.status === "paid" ? after : null); // a payment that just landed wins
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not cancel");
    }
  }, [session]);

  const showHere = useCallback(async () => {
    if (!session) return;
    try {
      setSession(await showCounterQrHere(session.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not show the QR here");
    }
  }, [session]);

  /** Try saving the visit again for a payment that already arrived. */
  const retrySave = useCallback(() => {
    setError(null);
    handled.current = null;
    setSession((s) => (s ? { ...s } : s)); // re-runs the save effect
  }, []);

  const dismiss = useCallback(() => {
    setSession(null);
    setError(null);
  }, []);

  return {
    /** Use the QR flow for this payment (otherwise Razorpay Checkout, as before). */
    enabled,
    tabletKnown: status !== null,
    tabletOnline,
    wantTablet,
    setWantTablet,
    session,
    starting,
    saving,
    error,
    /** The screen is locked on a payment: waiting for the customer, or saving. */
    busy: starting || saving || session?.status === "pending" || session?.status === "paid",
    start,
    cancel,
    showHere,
    retrySave,
    dismiss,
    useCheckoutInstead: () => {
      setCheckoutInstead(true);
      setError(null);
    },
  };
}
