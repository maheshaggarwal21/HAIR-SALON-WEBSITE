import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Clock3, UserCheck, Scissors, CalendarDays, Wallet, Percent } from "lucide-react";
import { fetchFormData, getVisitAssignmentDraft, confirmVisitAssignment } from "@/services/api";
import type { AssignmentRow } from "@/types/visit";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectTrigger,
  SelectContent,
  SelectItem,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

interface DraftRow {
  serviceEntryId: string;
  serviceName: string;
  servicePrice: number;
  artistId: string;
  startTime: string;
  endTime: string;
}

function isValidTimeRange(start: string, end: string): boolean {
  if (!/^\d{2}:\d{2}$/.test(start) || !/^\d{2}:\d{2}$/.test(end)) return false;
  const [sh, sm] = start.split(":").map(Number);
  const [eh, em] = end.split(":").map(Number);
  const startMins = sh * 60 + sm;
  const endMins = eh * 60 + em;
  return endMins > startMins;
}

function getDurationMins(start: string, end: string): number | null {
  if (!isValidTimeRange(start, end)) return null;
  const [sh, sm] = start.split(":").map(Number);
  const [eh, em] = end.split(":").map(Number);
  return eh * 60 + em - (sh * 60 + sm);
}

function isTerminalAssignmentError(message: string): boolean {
  const text = String(message || "").toLowerCase();
  return (
    text.includes("visit not found") ||
    text.includes("only available for v2 visits") ||
    text.includes("assignment already confirmed") ||
    text.includes("only supported for v2 visits")
  );
}

export default function VisitAssignmentPage() {
  const { visitId = "" } = useParams();
  const navigate = useNavigate();

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draftRows, setDraftRows] = useState<DraftRow[]>([]);
  const [artists, setArtists] = useState<Array<{ id: string; name: string }>>([]);
  const [customerName, setCustomerName] = useState("");
  const [customerPhone, setCustomerPhone] = useState("");
  const [customerGender, setCustomerGender] = useState("");
  const [visitDate, setVisitDate] = useState("");
  const [paymentMethod, setPaymentMethod] = useState<"online" | "cash" | "card" | "partial">("online");
  const [subtotal, setSubtotal] = useState(0);
  const [discountPercent, setDiscountPercent] = useState(0);
  const [discountAmount, setDiscountAmount] = useState(0);
  const [finalTotal, setFinalTotal] = useState(0);
  const [cashAmount, setCashAmount] = useState(0);
  const [cardAmount, setCardAmount] = useState(0);
  const [onlineAmount, setOnlineAmount] = useState(0);
  const [canClearLock, setCanClearLock] = useState(false);
  const objectIdPattern = /^[a-f\d]{24}$/i;

  const clearPendingAssignmentLock = () => {
    localStorage.removeItem("pendingAssignmentVisitId");
    navigate("/visit-entry", { replace: true });
  };

  useEffect(() => {
    const beforeUnload = (e: BeforeUnloadEvent) => {
      if (!saving) {
        e.preventDefault();
        e.returnValue = "";
      }
    };

    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [saving]);

  useEffect(() => {
    let mounted = true;

    const run = async () => {
      // Hardening: reject malformed route params early to avoid noisy API calls
      // and give staff a direct recovery path from stale URL/local lock state.
      if (!objectIdPattern.test(visitId)) {
        setError("Invalid assignment draft link. The visit ID is malformed.");
        setCanClearLock(true);
        setLoading(false);
        return;
      }

      try {
        setLoading(true);
        const [draft, formData] = await Promise.all([
          getVisitAssignmentDraft(visitId),
          fetchFormData(),
        ]);

        if (!mounted) return;

        if (draft.assignmentStatus === "completed") {
          localStorage.removeItem("pendingAssignmentVisitId");
          navigate("/visit-entry", { replace: true });
          return;
        }

        // Hardening: if backend indicates this visit is no longer lock-gated,
        // release local lock and return to regular flow.
        if (!draft.lockUntilAssigned) {
          localStorage.removeItem("pendingAssignmentVisitId");
          navigate("/visit-entry", { replace: true });
          return;
        }

        setCustomerName(draft.name);
        setCustomerPhone(draft.contact);
        setCustomerGender(draft.gender || "");
        setVisitDate(draft.date || "");
        setPaymentMethod(draft.paymentMethod || "online");
        setSubtotal(Number(draft.subtotal || 0));
        setDiscountPercent(Number(draft.discountPercent || 0));
        setDiscountAmount(Number(draft.discountAmount || 0));
        setFinalTotal(Number(draft.finalTotal || 0));
        setCashAmount(Number(draft.cashAmount || 0));
        setCardAmount(Number(draft.cardAmount || 0));
        setOnlineAmount(Number(draft.onlineAmount || 0));
        setArtists(formData.artists);
        setDraftRows(
          draft.services.map((s) => ({
            serviceEntryId: s.serviceEntryId,
            serviceName: s.serviceName,
            servicePrice: s.servicePrice,
            artistId: s.artistId || "",
            startTime: s.startTime || "",
            endTime: s.endTime || "",
          }))
        );
      } catch (e) {
        const message = e instanceof Error ? e.message : "Failed to load assignment draft";
        setError(message);

        // Hardening: if the draft is no longer recoverable (deleted/confirmed/wrong schema),
        // allow receptionist to clear stale local lock and continue normal workflow.
        setCanClearLock(isTerminalAssignmentError(message));
      } finally {
        if (mounted) setLoading(false);
      }
    };

    run();
    return () => {
      mounted = false;
    };
  }, [visitId, navigate]);

  const rowErrors = useMemo(() => {
    return draftRows.map((row) => ({
      artistId: !row.artistId,
      startTime: !row.startTime,
      endTime: !row.endTime,
      range: row.startTime && row.endTime ? !isValidTimeRange(row.startTime, row.endTime) : false,
    }));
  }, [draftRows]);

  const hasErrors = rowErrors.some((r) => r.artistId || r.startTime || r.endTime || r.range);

  const updateRow = (index: number, patch: Partial<DraftRow>) => {
    setDraftRows((prev) => prev.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  };

  const handleConfirm = async () => {
    if (!objectIdPattern.test(visitId)) {
      setError("Invalid visit ID. Please clear stale lock and return to visit entry.");
      setCanClearLock(true);
      return;
    }

    if (hasErrors) {
      setError("All rows must have artist, start time, and end time. End time must be after start time.");
      return;
    }

    try {
      setSaving(true);
      setError(null);

      const assignments: AssignmentRow[] = draftRows.map((row) => ({
        serviceEntryId: row.serviceEntryId,
        artistId: row.artistId,
        startTime: row.startTime,
        endTime: row.endTime,
      }));

      await confirmVisitAssignment(visitId, { assignments });
      localStorage.removeItem("pendingAssignmentVisitId");
      navigate("/visit-entry", { replace: true });
    } catch (e) {
      const message = e instanceof Error ? e.message : "Failed to confirm assignment";
      setError(message);
      setCanClearLock(isTerminalAssignmentError(message));
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-stone-100 flex items-center justify-center text-stone-600">
        Loading assignment workspace...
      </div>
    );
  }

  const paymentMethodLabel =
    paymentMethod === "cash"
      ? "Cash"
      : paymentMethod === "card"
        ? "Card"
        : paymentMethod === "partial"
          ? "Split (Cash + Online)"
          : "Online";

  return (
    <div className="min-h-screen bg-stone-100 px-4 py-8">
      <div className="mx-auto max-w-5xl bg-white border border-stone-200 rounded-2xl shadow-sm p-6">
        <div className="mb-6">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-stone-500">Locked Assignment Step</p>
          <h1 className="text-2xl font-bold text-stone-900 mt-1">Assign Artist and Time Per Service</h1>
          <p className="text-sm text-stone-500 mt-2">
            Complete every service row to unlock this visit. Partial save is not allowed.
          </p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 mb-6 rounded-xl border border-stone-200 bg-stone-50 p-4">
          <div>
            <p className="text-xs uppercase tracking-wide text-stone-500">Customer</p>
            <p className="text-sm font-semibold text-stone-800">{customerName}</p>
          </div>
          <div>
            <p className="text-xs uppercase tracking-wide text-stone-500">Phone</p>
            <p className="text-sm font-semibold text-stone-800">{customerPhone}</p>
          </div>
          <div>
            <p className="text-xs uppercase tracking-wide text-stone-500">Gender</p>
            <p className="text-sm font-semibold text-stone-800 capitalize">{customerGender || "Not provided"}</p>
          </div>
          <div>
            <p className="text-xs uppercase tracking-wide text-stone-500 flex items-center gap-1">
              <CalendarDays className="w-3.5 h-3.5" /> Date
            </p>
            <p className="text-sm font-semibold text-stone-800">
              {visitDate ? new Date(visitDate).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }) : "-"}
            </p>
          </div>
          <div>
            <p className="text-xs uppercase tracking-wide text-stone-500 flex items-center gap-1">
              <Wallet className="w-3.5 h-3.5" /> Payment Mode
            </p>
            <p className="text-sm font-semibold text-stone-800">{paymentMethodLabel}</p>
          </div>
          <div>
            <p className="text-xs uppercase tracking-wide text-stone-500">Total Paid</p>
            <p className="text-sm font-semibold text-stone-800">INR {finalTotal.toLocaleString("en-IN")}</p>
          </div>
          <div>
            <p className="text-xs uppercase tracking-wide text-stone-500 flex items-center gap-1">
              <Percent className="w-3.5 h-3.5" /> Discount
            </p>
            <p className="text-sm font-semibold text-stone-800">
              {discountPercent > 0
                ? `${discountPercent.toLocaleString("en-IN")}% (INR ${discountAmount.toLocaleString("en-IN")})`
                : "No discount"}
            </p>
          </div>
          <div>
            <p className="text-xs uppercase tracking-wide text-stone-500">Subtotal</p>
            <p className="text-sm font-semibold text-stone-800">INR {subtotal.toLocaleString("en-IN")}</p>
          </div>
          {paymentMethod === "partial" && (
            <>
              <div>
                <p className="text-xs uppercase tracking-wide text-stone-500">Cash Portion</p>
                <p className="text-sm font-semibold text-emerald-700">INR {cashAmount.toLocaleString("en-IN")}</p>
              </div>
              <div>
                <p className="text-xs uppercase tracking-wide text-stone-500">Online Portion</p>
                <p className="text-sm font-semibold text-blue-700">INR {onlineAmount.toLocaleString("en-IN")}</p>
              </div>
            </>
          )}
          {paymentMethod === "card" && (
            <div>
              <p className="text-xs uppercase tracking-wide text-stone-500">Card Amount</p>
              <p className="text-sm font-semibold text-blue-700">INR {cardAmount.toLocaleString("en-IN")}</p>
            </div>
          )}
        </div>

        {error && (
          <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            <p>{error}</p>
            {canClearLock && (
              <button
                type="button"
                onClick={clearPendingAssignmentLock}
                className="mt-2 text-xs underline text-red-700 hover:text-red-900"
              >
                Clear stale lock and return to visit entry
              </button>
            )}
          </div>
        )}

        <div className="space-y-4">
          {draftRows.map((row, index) => {
            const e = rowErrors[index];
            const durationMins = getDurationMins(row.startTime, row.endTime);
            return (
              <div key={row.serviceEntryId} className="rounded-xl border border-stone-200 p-4">
                <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 mb-4">
                  <div className="flex items-start gap-2 text-stone-800 min-w-0">
                    <Scissors className="w-4 h-4" />
                    <span className="font-semibold wrap-break-word">{row.serviceName}</span>
                  </div>
                  <span className="text-sm text-stone-500">INR {row.servicePrice.toLocaleString("en-IN")}</span>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <div>
                    <Label className="text-xs uppercase tracking-wide text-stone-500 mb-1.5 block">Artist</Label>
                    <Select value={row.artistId} onValueChange={(v) => updateRow(index, { artistId: v })}>
                      <SelectTrigger className={cn(e.artistId && "border-red-400")}> 
                        <SelectValue placeholder="Select artist" />
                      </SelectTrigger>
                      <SelectContent>
                        {artists.map((a) => (
                          <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  <div>
                    <Label className="text-xs uppercase tracking-wide text-stone-500 mb-1.5 block">Start Time</Label>
                    <div className="relative">
                      <Clock3 className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-stone-400" />
                      <Input
                        type="time"
                        value={row.startTime}
                        onChange={(ev) => updateRow(index, { startTime: ev.target.value })}
                        className={cn("pl-9", (e.startTime || e.range) && "border-red-400")}
                      />
                    </div>
                  </div>

                  <div>
                    <Label className="text-xs uppercase tracking-wide text-stone-500 mb-1.5 block">End Time</Label>
                    <div className="relative">
                      <Clock3 className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-stone-400" />
                      <Input
                        type="time"
                        value={row.endTime}
                        onChange={(ev) => updateRow(index, { endTime: ev.target.value })}
                        className={cn("pl-9", (e.endTime || e.range) && "border-red-400")}
                      />
                    </div>
                  </div>
                </div>

                {e.range && (
                  <p className="text-xs text-red-600 mt-2">End time must be after start time.</p>
                )}

                {durationMins !== null && (
                  <div className="mt-3 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2">
                    <p className="text-xs font-semibold uppercase tracking-wide text-emerald-700">
                      Time Taken
                    </p>
                    <p className="text-sm font-semibold text-emerald-800">
                      This service is scheduled for {durationMins} minute{durationMins !== 1 ? "s" : ""}.
                    </p>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div className="mt-6 flex justify-end">
          <button
            type="button"
            onClick={handleConfirm}
            disabled={saving || hasErrors}
            className="inline-flex w-full sm:w-auto justify-center items-center gap-2 rounded-xl px-5 py-3 bg-stone-900 text-white font-semibold disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <UserCheck className="w-4 h-4" />
            {saving ? "Saving Assignment..." : "Save All Assignments"}
          </button>
        </div>
      </div>
    </div>
  );
}
