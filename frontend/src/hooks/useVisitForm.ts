import { useState, useEffect, useMemo, useRef } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import type {
  VisitFormData,
  VisitFormErrors,
  ApiFormData,
  RazorpayResponse,
  CustomerSuggestion,
} from "@/types/visit";
import { loadRazorpayScript } from "@/services/razorpay";
import { checkPaymentSum } from "@/lib/paymentSum";
import { toLocalDateKey } from "@/lib/utils";
import {
  fetchFormData,
  createOrder,
  verifyOrderPayment,
  createVisitDraftV2,
  searchCustomers,
  fetchOrderStatus,
  fetchRecoverablePayment,
  fetchAppointmentBill,
  type RecoverablePayment,
  type AppointmentBill,
} from "@/services/api";

/** How often to ask our own server whether the order has been paid. */
const ORDER_POLL_INTERVAL_MS = 5000;
/** Give the customer this long to complete a payment before we stop watching. */
const ORDER_POLL_TIMEOUT_MS = 10 * 60 * 1000;
/**
 * Keep watching briefly after the window is closed.
 *
 * The failure this guards against looks exactly like this: Checkout wrongly
 * reports failure, staff closes it, and the customer's payment lands a few
 * seconds later. Without this grace period that money arrives with nobody
 * listening.
 */
const ORDER_POLL_GRACE_AFTER_DISMISS_MS = 45 * 1000;

// Local date, not UTC — `toISOString()` would date a visit logged before
// 05:30 IST to the previous day.
const today = toLocalDateKey(new Date());

/**
 * Retry a call that runs after money has already changed hands.
 *
 * A single 429 or dropped connection between Razorpay capturing the payment and
 * the visit being saved used to lose the record permanently. Three attempts with
 * a short backoff covers the transient cases; anything still failing is surfaced
 * to staff rather than swallowed.
 */
async function withRetry<T>(fn: () => Promise<T>, attempts = 3, delayMs = 800): Promise<T> {
  let lastError: unknown;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (i < attempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, delayMs * (i + 1)));
      }
    }
  }
  throw lastError;
}

const EMPTY_FORM: VisitFormData = {
  name: "",
  phone: "",
  amount: "",
  gender: "",
  serviceType: [],
  searchService: [],
  serviceQuantities: {},
  discount: "50",
  discountReason: "",
  date: today,
  paymentMode: "online",
  cashAmount: "",
};

export function useVisitForm() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  /**
   * Recovery mode — reached from the unreconciled-payments panel via
   * `/visit-entry?recover=pay_xxx`.
   *
   * The customer has already paid; what is missing is everything Razorpay never
   * knew — which services were done, at what discount, by whom. So the normal
   * form does all the work and only the payment step changes: no order is
   * created, no Checkout window opens, and the visit is attached to the payment
   * that already exists.
   */
  const recoverPaymentId = searchParams.get("recover");
  const [recovery, setRecovery] = useState<RecoverablePayment | null>(null);
  const [recoveryLoading, setRecoveryLoading] = useState(!!recoverPaymentId);
  const [recoveryError, setRecoveryError] = useState<string | null>(null);

  /**
   * Booking mode — reached from the Today board's "Check in" via
   * `/visit-entry?appointment=<id>` (CF §8, T2.16).
   *
   * The client, services and artists come from the booking. Prices are the
   * SERVER's bill (booked items at their snapshot price, desk extras at the
   * website price, no desk discount) and anything paid online when booking is
   * already taken off, so "Total payable" is what is still due. The bill is
   * fetched again whenever a service is added or removed, and the same server
   * code prices the Razorpay order and the Visit — the screen can't disagree
   * with the charge.
   */
  const appointmentId = searchParams.get("appointment");
  const [booking, setBooking] = useState<AppointmentBill | null>(null);
  const [bookingError, setBookingError] = useState<string | null>(null);
  const bookingPrefilled = useRef(false);

  const [formData, setFormData] = useState<VisitFormData>(EMPTY_FORM);
  const [errors, setErrors] = useState<VisitFormErrors>({});
  const [isLoading, setIsLoading] = useState(false);
  const [paymentError, setPaymentError] = useState<string | null>(null);
  const [dropdownData, setDropdownData] = useState<ApiFormData>({
    artists: [],
    serviceTypes: [],
    services: [],
  });
  const [dropdownLoading, setDropdownLoading] = useState(true);
  const [dropdownError, setDropdownError] = useState(false);
  const [customerSuggestions, setCustomerSuggestions] = useState<CustomerSuggestion[]>([]);
  /** Which field the open suggestion list belongs to, so it renders under it. */
  const [customerLookupBy, setCustomerLookupBy] = useState<"phone" | "name">("phone");
  const [searchingCustomers, setSearchingCustomers] = useState(false);
  /** The number just filled from a suggestion — don't search it again. */
  const appliedPhone = useRef<string | null>(null);

  useEffect(() => {
    setDropdownLoading(true);
    fetchFormData()
      .then((data) => {
        setDropdownData(data);
        setDropdownError(false);
      })
      .catch(() => {
        setDropdownError(true);
      })
      .finally(() => setDropdownLoading(false));
  }, []);

  // Pre-fill from the payment Razorpay already took. The customer's name and
  // number come from the payment itself, and the date is the day they actually
  // paid — not today, which may be days later.
  useEffect(() => {
    if (!recoverPaymentId) return;
    let cancelled = false;

    setRecoveryLoading(true);
    fetchRecoverablePayment(recoverPaymentId)
      .then((payment) => {
        if (cancelled) return;
        if (!payment) {
          setRecoveryError(
            "That payment is no longer outstanding — it may already have been recorded."
          );
          return;
        }
        setRecovery(payment);
        setFormData((prev) => ({
          ...prev,
          name: payment.customerName || prev.name,
          phone: payment.contact || prev.phone,
          date: toLocalDateKey(new Date(payment.capturedAt)),
          paymentMode: "online",
        }));
      })
      .catch(() => {
        if (!cancelled) setRecoveryError("Could not load that payment. Check your connection.");
      })
      .finally(() => {
        if (!cancelled) setRecoveryLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [recoverPaymentId]);

  // Booking mode: load the booking once and fill the form from it.
  useEffect(() => {
    if (!appointmentId) return;
    let cancelled = false;
    fetchAppointmentBill(appointmentId)
      .then((bill) => {
        if (cancelled) return;
        setBooking(bill);
        const counts: Record<string, number> = {};
        for (const id of bill.services.map((x) => x.serviceId)) counts[id] = (counts[id] || 0) + 1;
        appliedPhone.current = bill.appointment.contact;
        setFormData((prev) => ({
          ...prev,
          // A walk-in saved without a name is stored as "Walk-in" — leave the field for the desk to fill.
          name: bill.appointment.name === "Walk-in" ? prev.name : bill.appointment.name,
          phone: /^\d{10}$/.test(bill.appointment.contact) ? bill.appointment.contact : prev.phone,
          gender: bill.appointment.gender || prev.gender,
          searchService: Object.keys(counts),
          serviceQuantities: counts,
          discount: "0",
          date: today,
        }));
        bookingPrefilled.current = true;
      })
      .catch((err) => {
        if (!cancelled) setBookingError(err instanceof Error ? err.message : "Could not load the booking");
      });
    return () => {
      cancelled = true;
    };
  }, [appointmentId]);

  const serviceDisplayItems = useMemo(
    () =>
      dropdownData.services.map((s) => ({
        id: s.id,
        name: `${s.name} — ₹${s.price.toLocaleString("en-IN")}`,
      })),
    [dropdownData.services]
  );

  const selectedServiceIds = useMemo(() => {
    return formData.searchService.flatMap((serviceId) => {
      const qty = Math.max(1, Number(formData.serviceQuantities[serviceId] || 1));
      return Array.from({ length: qty }, () => serviceId);
    });
  }, [formData.searchService, formData.serviceQuantities]);

  const selectedServiceRows = useMemo(() => {
    return formData.searchService
      .map((serviceId) => {
        const service = dropdownData.services.find((s) => s.id === serviceId);
        if (!service) return null;
        return {
          id: serviceId,
          name: service.name,
          price: booking?.services.find((x) => x.serviceId === serviceId)?.price ?? service.price,
          quantity: Math.max(1, Number(formData.serviceQuantities[serviceId] || 1)),
        };
      })
      .filter((row): row is { id: string; name: string; price: number; quantity: number } => !!row);
  }, [formData.searchService, formData.serviceQuantities, dropdownData.services, booking]);

  const deskSubtotal = useMemo(() => {
    return selectedServiceIds.reduce((sum, id) => {
      const svc = dropdownData.services.find((s) => s.id === id);
      return sum + (svc?.price ?? 0);
    }, 0);
  }, [selectedServiceIds, dropdownData.services]);

  // Booking mode: re-price on the server whenever the services change.
  const selectedKey = selectedServiceIds.join(",");
  useEffect(() => {
    if (!appointmentId || !bookingPrefilled.current || !selectedKey) return;
    let stale = false;
    const t = window.setTimeout(() => {
      fetchAppointmentBill(appointmentId, selectedKey.split(","))
        .then((bill) => {
          if (!stale) {
            setBooking(bill);
            setBookingError(null);
          }
        })
        .catch((err) => {
          if (!stale) setBookingError(err instanceof Error ? err.message : "Could not price the booking");
        });
    }, 250);
    return () => {
      stale = true;
      window.clearTimeout(t);
    };
  }, [appointmentId, selectedKey]);

  // In booking mode every figure is the server's bill; "payable" is what is still due.
  const subtotal = booking ? booking.subtotal : deskSubtotal;
  const discountPct = booking ? 0 : Math.min(100, Math.max(0, Number(formData.discount) || 0));
  const discountAmt = booking ? booking.discountAmount : Math.round(subtotal * (discountPct / 100));
  const payable = booking ? booking.remainder : Math.max(0, subtotal - discountAmt);
  const cashAmountNum = Math.max(0, Math.round((Number(formData.cashAmount) || 0) * 100) / 100);
  const onlinePayable = formData.paymentMode === "partial"
    ? Math.max(0, payable - cashAmountNum)
    : formData.paymentMode === "cash"
      ? 0
      : payable;

  // Keep formData.amount in sync so the rest of the flow sees it
  useEffect(() => {
    setFormData((prev) => {
      const next = String(payable);
      return prev.amount !== next ? { ...prev, amount: next } : prev;
    });
  }, [payable]);

  // The name only matters while the phone box is empty; with digits in it,
  // re-running on every name keystroke would just repeat the same search.
  const nameQuery = formData.phone.trim() ? "" : formData.name.trim();

  /**
   * Returning-customer lookup.
   *
   * Digits in the phone box search by number, as before. With the phone box
   * empty, typing a name searches by name instead — regulars don't want to
   * read their number out on every visit (owner, 14 Oct 2026), so the desk
   * types "rahul sh", picks the right Rahul, and the number fills itself in.
   */
  useEffect(() => {
    const phone = formData.phone.trim();
    const name = nameQuery;
    if (phone && phone === appliedPhone.current) {
      setCustomerSuggestions([]);
      return;
    }

    let query: { phone: string } | { name: string } | null = null;
    if (/^[0-9]{3,10}$/.test(phone)) query = { phone };
    else if (!phone && name.replace(/\s/g, "").length >= 2) query = { name };
    if (!query) {
      setCustomerSuggestions([]);
      return;
    }

    const lookupBy = "phone" in query ? "phone" : "name";
    let stale = false;
    const timeout = window.setTimeout(async () => {
      try {
        setCustomerLookupBy(lookupBy);
        setSearchingCustomers(true);
        const customers = await searchCustomers(query);
        if (stale) return;
        setCustomerSuggestions(customers);
      } catch {
        if (!stale) setCustomerSuggestions([]);
      } finally {
        setSearchingCustomers(false);
      }
    }, 250);

    return () => {
      stale = true;
      window.clearTimeout(timeout);
    };
  }, [formData.phone, nameQuery]);

  // ── Validation ─────────────────────────────────────────────────────────────
  const validate = (): boolean => {
    const e: VisitFormErrors = {};
    if (!formData.name.trim()) e.name = "Name is required";
    else if (formData.name.trim().length < 2) e.name = "At least 2 characters";
    if (!formData.phone.trim()) e.phone = "Phone is required";
    else if (!/^[6-9]\d{9}$/.test(formData.phone.trim()))
      e.phone = "Valid 10-digit Indian mobile number";
    if (!formData.gender) e.gender = "Gender is required";
    if (!formData.date) e.date = "Date is required";
    if (subtotal <= 0) e.amount = "Select at least one service";
    else if (payable <= 0 && !booking) e.amount = "Payable amount must be greater than ₹0";
    if (bookingError) e.amount = bookingError;

    // Partial-payment validation
    if (formData.paymentMode === "partial") {
      if (cashAmountNum <= 0) e.cashAmount = "Cash amount must be greater than ₹0";
      else if (cashAmountNum >= payable)
        e.cashAmount = `Cash amount must be less than ₹${payable.toLocaleString("en-IN")}`;
      else if (payable - cashAmountNum < 1)
        e.cashAmount = `Online portion must be at least ₹1 (max cash: ₹${(payable - 1).toLocaleString("en-IN")})`;
    }

    // Sum check (D60): the parts must add up to the total, in whole rupees.
    if (!recovery && payable > 0) {
      const sumProblem = checkPaymentSum(formData.paymentMode, payable, cashAmountNum);
      if (sumProblem) e[sumProblem.field] = e[sumProblem.field] ?? sumProblem.message;
    }

    if (formData.paymentMode === "card" && payable <= 0 && !booking) {
      e.amount = "Payable amount must be greater than ₹0";
    }

    setErrors(e);
    return Object.keys(e).length === 0;
  };

  // ── Change handlers ────────────────────────────────────────────────────────
  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target;
    setFormData((prev) => ({ ...prev, [name]: value }));
    if (errors[name as keyof VisitFormErrors]) {
      setErrors((prev) => ({ ...prev, [name]: undefined }));
    }
  };

  const handleSelect = (field: keyof VisitFormData) => (value: string) => {
    setFormData((prev) => ({ ...prev, [field]: value }));
    if (errors[field as keyof VisitFormErrors]) {
      setErrors((prev) => ({ ...prev, [field]: undefined }));
    }
  };

  /** For multi-select fields (string[] values) — replaces the whole array. */
  const handleMultiSelect =
    (field: keyof VisitFormData) => (values: string[]) => {
      if (field !== "searchService") {
        setFormData((prev) => ({ ...prev, [field]: values }));
        return;
      }

      setFormData((prev) => {
        const nextQuantities: Record<string, number> = {};
        values.forEach((serviceId) => {
          nextQuantities[serviceId] = Math.max(1, Number(prev.serviceQuantities[serviceId] || 1));
        });

        return {
          ...prev,
          searchService: values,
          serviceQuantities: nextQuantities,
        };
      });
    };

  const handleServiceQuantityChange = (serviceId: string, delta: 1 | -1) => {
    setFormData((prev) => {
      if (!prev.searchService.includes(serviceId)) return prev;

      const current = Math.max(1, Number(prev.serviceQuantities[serviceId] || 1));
      if (delta === -1 && current === 1) {
        const nextSearchService = prev.searchService.filter((id) => id !== serviceId);
        const nextQuantities = { ...prev.serviceQuantities };
        delete nextQuantities[serviceId];

        return {
          ...prev,
          searchService: nextSearchService,
          serviceQuantities: nextQuantities,
        };
      }

      const next = Math.max(1, current + delta);

      return {
        ...prev,
        serviceQuantities: {
          ...prev.serviceQuantities,
          [serviceId]: next,
        },
      };
    });
  };

  const applyCustomerSuggestion = (customer: CustomerSuggestion) => {
    appliedPhone.current = customer.contact;
    setFormData((prev) => ({
      ...prev,
      name: customer.name || prev.name,
      phone: customer.contact || prev.phone,
      gender: customer.gender || prev.gender,
    }));
    setCustomerSuggestions([]);
  };

  // ── Reset ──────────────────────────────────────────────────────────────────
  const handleReset = () => {
    setFormData({ ...EMPTY_FORM, date: today });
    setErrors({});
    setPaymentError(null);
    setCustomerSuggestions([]);
    appliedPhone.current = null;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!validate()) return;
    setIsLoading(true);
    setPaymentError(null);

    const serviceTypeStr =
      formData.serviceType.length > 0
        ? formData.serviceType.join(", ")
        : undefined;

    const persistDraft = async (opts: {
      paymentMethod: "online" | "cash" | "card" | "partial";
      razorpayPaymentId?: string;
      recoveredPaymentId?: string;
      cashAmount?: number;
      cardAmount?: number;
      onlineAmount?: number;
    }) => {
      const draft = await createVisitDraftV2({
        name: formData.name.trim(),
        contact: formData.phone.trim(),
        gender: formData.gender,
        date: formData.date,
        serviceType: serviceTypeStr,
        serviceIds: selectedServiceIds,
        discountPercent: discountPct,
        discountReason: discountPct > 0 ? formData.discountReason.trim() || undefined : undefined,
        paymentMethod: opts.paymentMethod,
        razorpayPaymentId: opts.razorpayPaymentId,
        recoveredPaymentId: opts.recoveredPaymentId,
        cashAmount: opts.cashAmount,
        cardAmount: opts.cardAmount,
        onlineAmount: opts.onlineAmount,
        lockUntilAssigned: true,
        appointmentId: booking?.appointment._id,
      });

      localStorage.setItem("pendingAssignmentVisitId", draft.visitId);
      navigate(`/visit-assignment/${draft.visitId}`);
    };

    try {
      /**
       * Recovery: the money is already at Razorpay, so there is nothing to
       * charge. Attach the visit to that payment and go straight to assignment.
       */
      if (recovery) {
        await withRetry(() =>
          persistDraft({
            paymentMethod: "online",
            recoveredPaymentId: recovery.razorpayPaymentId,
            onlineAmount: payable,
          })
        );
        return;
      }

      // Booking already paid in full online: nothing to collect, go to assignment.
      if (booking && payable === 0) {
        await withRetry(() => persistDraft({ paymentMethod: "online", onlineAmount: 0 }));
        return;
      }

      if (formData.paymentMode === "cash") {
        await persistDraft({
          paymentMethod: "cash",
          cashAmount: payable,
          onlineAmount: 0,
        });
        return;
      }

      if (formData.paymentMode === "card") {
        await persistDraft({
          paymentMethod: "card",
          cardAmount: payable,
          onlineAmount: 0,
        });
        return;
      }

      const loaded = await loadRazorpayScript();
      if (!loaded)
        throw new Error("Failed to load Razorpay SDK. Check your connection.");

      const chargeOnline = formData.paymentMode === "partial"
        ? onlinePayable
        : payable;

      const order = await createOrder({
        name: formData.name.trim(),
        phone: formData.phone.trim(),
        serviceIds: selectedServiceIds,
        discountPercent: discountPct,
        paymentMode: formData.paymentMode as "online" | "partial",
        cashAmount: formData.paymentMode === "partial" ? cashAmountNum : 0,
        appointmentId: booking?.appointment._id,
      });

      /**
       * A payment is settled exactly once, by whichever witness sees it first.
       *
       * Razorpay Checkout is no longer trusted as the only witness to its own
       * success. On 7 Aug a customer paid ₹150 by UPI, Razorpay captured it, and
       * Checkout still showed "Payment could not be completed — Too many
       * requests" and went back to offering a QR: its `handler` never ran, so no
       * visit was created for money the salon had already taken. Checkout polls
       * Razorpay from this browser, and every device in the salon shares one
       * public IP, so it is that polling — not the payment — that gets throttled.
       *
       * So two witnesses now race: Checkout's handler, and a poll of our own
       * server (which asks Razorpay with the salon's API key, from a different
       * address). Whichever sees the payment first saves the visit; this flag
       * makes sure the other one does nothing. `/visits/v2` is idempotent on the
       * payment id as a second line of defence.
       */
      let settled = false;
      let dismissed = false;
      let pollTimer: number | undefined;
      let pollDeadline = Date.now() + ORDER_POLL_TIMEOUT_MS;

      const stopPolling = () => {
        if (pollTimer !== undefined) {
          window.clearInterval(pollTimer);
          pollTimer = undefined;
        }
      };

      /**
       * Save the visit for a payment we now know Razorpay has captured.
       *
       * `settled` is raised before anything else, so the Checkout window can be
       * closed here without its `ondismiss` handler mistaking that for the
       * customer walking away.
       *
       * The money is already gone by the time this runs, so a failure here has
       * to be loud and has to surface the payment id — that reference is the
       * only way to reconcile it later.
       */
      const settle = async (paymentId: string) => {
        if (settled) return;
        settled = true;
        stopPolling();
        setPaymentError(null);
        setIsLoading(true);
        try { rzp.close(); } catch { /* already closed, or never opened */ }

        try {
          await withRetry(() =>
            persistDraft({
              paymentMethod: formData.paymentMode === "partial" ? "partial" : "online",
              razorpayPaymentId: paymentId,
              cashAmount: formData.paymentMode === "partial" ? cashAmountNum : 0,
              onlineAmount: chargeOnline,
            })
          );
        } catch (err) {
          console.error("[visit] post-payment save failed", paymentId, err);
          setPaymentError(
            `PAYMENT RECEIVED but the visit could not be saved. ` +
              `The money HAS been collected — do not charge the customer again. ` +
              `Note this reference and report it: ${paymentId}. ` +
              `${err instanceof Error ? `(${err.message})` : ""}`
          );
          setIsLoading(false);
        }
      };

      const rzp = new window.Razorpay({
        key: order.key_id,
        amount: order.amount,
        currency: order.currency,
        name: "Hair Salon",
        description:
          formData.paymentMode === "partial"
            ? `Partial Online Payment (Cash: ₹${cashAmountNum.toLocaleString("en-IN")})`
            : "Visit Payment",
        order_id: order.order_id,
        prefill: {
          name: formData.name.trim(),
          contact: `+91${formData.phone.trim()}`,
        },
        readonly: {
          contact: true,
          name: true,
        },
        theme: { color: "#1c1917" },
        modal: {
          /**
           * Closing the window is not proof the customer did not pay — it is
           * often staff giving up on a Checkout error while the payment is still
           * in flight. Keep watching for a little longer instead of declaring it
           * cancelled and walking away.
           */
          ondismiss: () => {
            if (settled) return;
            dismissed = true;
            setIsLoading(false);
            setPaymentError(
              "Payment window closed — still confirming with Razorpay. " +
                "Wait for this message to clear before charging the customer again."
            );
            pollDeadline = Math.min(
              pollDeadline,
              Date.now() + ORDER_POLL_GRACE_AFTER_DISMISS_MS
            );
          },
        },
        /**
         * Runs AFTER Razorpay has already taken the customer's money.
         *
         * Everything in here must be guarded. This callback previously had no
         * try/catch, so a throw from either call became an unhandled promise
         * rejection: silently swallowed, `setIsLoading(false)` never ran, and
         * staff were left on a "Processing…" spinner with the payment captured
         * and no visit recorded. That lost 14 payments (₹3,185.70) before it
         * was found.
         */
        handler: async (response: RazorpayResponse) => {
          if (settled) return;
          try {
            const result = await withRetry(() =>
              verifyOrderPayment({
                razorpay_order_id: response.razorpay_order_id,
                razorpay_payment_id: response.razorpay_payment_id,
                razorpay_signature: response.razorpay_signature,
                name: formData.name.trim(),
                phone: formData.phone.trim(),
                amount: order.amount,
              })
            );

            if (!result.success) {
              throw new Error("Payment verification failed");
            }

            await settle(result.payment_id);
          } catch (err) {
            // Verification itself failed. The poller is still running and asks
            // Razorpay directly, so let it have the final word rather than
            // giving up on a payment that may well have gone through.
            console.error("[visit] checkout handler failed, leaving it to the poller", err);
          }
        },
      });

      rzp.open();

      // Second witness: our own server, asking Razorpay whether this order was
      // actually paid. Immune to whatever throttling Checkout has run into.
      pollTimer = window.setInterval(async () => {
        if (settled) return stopPolling();

        if (Date.now() > pollDeadline) {
          stopPolling();
          // Only speak up if the window has been closed. If it is still open,
          // Checkout owns the screen and the customer may yet pay — saying
          // anything here would just contradict what is in front of them.
          if (dismissed) {
            setIsLoading(false);
            setPaymentError("Payment was not completed. Please try again.");
          }
          return;
        }

        try {
          const status = await fetchOrderStatus(order.order_id);
          if (status.paid && status.payment_id) {
            await settle(status.payment_id);
          }
        } catch (err) {
          // A poll that could not reach the server tells us nothing about the
          // payment. Stay quiet and try again on the next tick.
          console.warn("[visit] order status poll failed", err);
        }
      }, ORDER_POLL_INTERVAL_MS);
    } catch (err) {
      setPaymentError(
        err instanceof Error
          ? err.message
          : "Something went wrong. Please try again."
      );
      setIsLoading(false);
    }
  };

  return {
    formData,
    errors,
    isLoading,
    paymentError,
    dropdownData,
    dropdownLoading,
    dropdownError,
    serviceDisplayItems,
    selectedServiceRows,
    selectedServiceIds,
    subtotal,
    discountPct,
    discountAmt,
    payable,
    cashAmountNum,
    onlinePayable,
    customerSuggestions,
    customerLookupBy,
    searchingCustomers,
    recovery,
    recoveryLoading,
    recoveryError,
    booking,
    bookingError,
    handleChange,
    handleSelect,
    handleMultiSelect,
    handleServiceQuantityChange,
    applyCustomerSuggestion,
    handleSubmit,
    handleReset,
  };
}
