import { useState, useEffect, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import type {
  VisitFormData,
  VisitFormErrors,
  ApiFormData,
  RazorpayResponse,
  CustomerSuggestion,
} from "@/types/visit";
import { loadRazorpayScript } from "@/services/razorpay";
import {
  fetchFormData,
  createOrder,
  verifyOrderPayment,
  createVisitDraftV2,
  searchCustomersByPhone,
} from "@/services/api";

const today = new Date().toISOString().split("T")[0];

const EMPTY_FORM: VisitFormData = {
  name: "",
  phone: "",
  amount: "",
  gender: "",
  serviceType: [],
  searchService: [],
  discount: "50",
  date: today,
  paymentMode: "online",
  cashAmount: "",
};

export function useVisitForm() {
  const navigate = useNavigate();

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
  const [searchingCustomers, setSearchingCustomers] = useState(false);

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

  const serviceDisplayItems = useMemo(
    () =>
      dropdownData.services.map((s) => ({
        id: s.id,
        name: `${s.name} — ₹${s.price.toLocaleString("en-IN")}`,
      })),
    [dropdownData.services]
  );

  const subtotal = useMemo(() => {
    return formData.searchService.reduce((sum, id) => {
      const svc = dropdownData.services.find((s) => s.id === id);
      return sum + (svc?.price ?? 0);
    }, 0);
  }, [formData.searchService, dropdownData.services]);

  const discountPct = Math.min(100, Math.max(0, Number(formData.discount) || 0));
  const discountAmt = Math.round(subtotal * (discountPct / 100));
  const payable = Math.max(0, subtotal - discountAmt);
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

  useEffect(() => {
    const phone = formData.phone.trim();
    if (!/^[0-9]{3,10}$/.test(phone)) {
      setCustomerSuggestions([]);
      return;
    }

    const timeout = window.setTimeout(async () => {
      try {
        setSearchingCustomers(true);
        const customers = await searchCustomersByPhone(phone);
        setCustomerSuggestions(customers);
      } catch {
        setCustomerSuggestions([]);
      } finally {
        setSearchingCustomers(false);
      }
    }, 250);

    return () => window.clearTimeout(timeout);
  }, [formData.phone]);

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
    else if (payable <= 0) e.amount = "Payable amount must be greater than ₹0";

    // Partial-payment validation
    if (formData.paymentMode === "partial") {
      if (cashAmountNum <= 0) e.cashAmount = "Cash amount must be greater than ₹0";
      else if (cashAmountNum >= payable)
        e.cashAmount = `Cash amount must be less than ₹${payable.toLocaleString("en-IN")}`;
      else if (payable - cashAmountNum < 1)
        e.cashAmount = `Online portion must be at least ₹1 (max cash: ₹${(payable - 1).toLocaleString("en-IN")})`;
    }

    if (formData.paymentMode === "card" && payable <= 0) {
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
      setFormData((prev) => ({ ...prev, [field]: values }));
    };

  const applyCustomerSuggestion = (customer: CustomerSuggestion) => {
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
        serviceIds: formData.searchService,
        discountPercent: discountPct,
        paymentMethod: opts.paymentMethod,
        razorpayPaymentId: opts.razorpayPaymentId,
        cashAmount: opts.cashAmount,
        cardAmount: opts.cardAmount,
        onlineAmount: opts.onlineAmount,
        lockUntilAssigned: true,
      });

      localStorage.setItem("pendingAssignmentVisitId", draft.visitId);
      navigate(`/visit-assignment/${draft.visitId}`);
    };

    try {
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
        serviceIds: formData.searchService,
        discountPercent: discountPct,
        paymentMode: formData.paymentMode as "online" | "partial",
        cashAmount: formData.paymentMode === "partial" ? cashAmountNum : 0,
      });

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
          ondismiss: () => {
            setIsLoading(false);
            setPaymentError("Payment was cancelled. Please try again.");
          },
        },
        handler: async (response: RazorpayResponse) => {
          const result = await verifyOrderPayment({
            razorpay_order_id: response.razorpay_order_id,
            razorpay_payment_id: response.razorpay_payment_id,
            razorpay_signature: response.razorpay_signature,
            name: formData.name.trim(),
            phone: formData.phone.trim(),
            amount: order.amount,
          });

          if (result.success) {
            await persistDraft({
              paymentMethod: formData.paymentMode === "partial" ? "partial" : "online",
              razorpayPaymentId: result.payment_id,
              cashAmount: formData.paymentMode === "partial" ? cashAmountNum : 0,
              onlineAmount: chargeOnline,
            });
          } else {
            setPaymentError("Payment verification failed. Contact support.");
            setIsLoading(false);
          }
        },
      });

      rzp.open();
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
    subtotal,
    discountPct,
    discountAmt,
    payable,
    cashAmountNum,
    onlinePayable,
    customerSuggestions,
    searchingCustomers,
    handleChange,
    handleSelect,
    handleMultiSelect,
    applyCustomerSuggestion,
    handleSubmit,
    handleReset,
  };
}
