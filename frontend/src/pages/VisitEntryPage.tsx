import { motion, AnimatePresence } from "framer-motion";
import {
  User,
  Phone,
  Plus,
  Minus,
  Calendar,
  Percent,
  Calculator,
  Banknote,
  CreditCard,
  SplitSquareHorizontal,
  IndianRupee,
} from "lucide-react";
import { SparklesCore } from "@/components/ui/sparkles";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectTrigger,
  SelectContent,
  SelectItem,
  SelectValue,
} from "@/components/ui/select";
import { MultiSelect } from "@/components/ui/multi-select";
import { cn } from "@/lib/utils";
import AppLayout from "@/layouts/AppLayout";
import { useVisitForm } from "@/hooks/useVisitForm";

export default function VisitEntryPage() {
  const {
    formData,
    errors,
    isLoading,
    paymentError,
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
    searchingCustomers,
    handleChange,
    handleSelect,
    handleMultiSelect,
    handleServiceQuantityChange,
    applyCustomerSuggestion,
    handleSubmit,
    handleReset,
  } = useVisitForm();

  return (
    <AppLayout subtitle="Visit Entry & Payment Form">
      <div className="mx-auto max-w-4xl w-full px-4 sm:px-6 pt-8 sm:pt-12 pb-12 sm:pb-16">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.45, ease: "easeOut" }}
        >
          <div className="mb-12">
            <motion.div
              initial={{ opacity: 0, y: -8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.4 }}
              className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full border border-stone-300/60 bg-white/80 backdrop-blur-sm shadow-sm mb-5"
            >
              <span className="text-xs font-semibold text-stone-500 tracking-[0.18em] uppercase">New Visit Entry</span>
            </motion.div>
            <motion.h2
              initial={{ opacity: 0, filter: "blur(10px)", y: 8 }}
              animate={{ opacity: 1, filter: "blur(0px)", y: 0 }}
              transition={{ duration: 0.65, ease: "easeOut", delay: 0.1 }}
              className="text-3xl sm:text-4xl font-black tracking-tight text-stone-900 leading-none mb-3"
            >
              Record Payment
            </motion.h2>
            <motion.p
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.4, delay: 0.25 }}
              className="text-base text-stone-400 font-light"
            >
              Capture customer and payment details first. Service assignment is completed in the next locked step.
            </motion.p>
          </div>

          <form onSubmit={handleSubmit} noValidate>
            {dropdownLoading && (
              <div className="mb-6 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-700 flex items-center gap-2">
                <motion.span
                  animate={{ rotate: 360 }}
                  transition={{ duration: 1, repeat: Infinity, ease: "linear" }}
                  className="inline-block w-4 h-4 border-2 border-amber-300 border-t-amber-600 rounded-full"
                />
                Loading form data...
              </div>
            )}
            {dropdownError && !dropdownLoading && (
              <div className="mb-6 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-600">
                Failed to load form data. Check your connection and refresh.
              </div>
            )}

            <div className="mb-8 rounded-2xl border border-stone-200/80 bg-white shadow-sm overflow-hidden">
              <Section title="Client Details" icon="01">
                <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
                <Field label="Phone Number" required error={errors.phone}>
                  <div className="relative">
                    <Phone className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-stone-400 pointer-events-none" />
                    <Input
                      id="phone"
                      name="phone"
                      type="tel"
                      placeholder="10-digit mobile"
                      value={formData.phone}
                      onChange={handleChange}
                      maxLength={10}
                      autoComplete="tel"
                      className={cn("pl-9", errors.phone && "border-red-400 focus-visible:ring-red-300")}
                    />
                  </div>
                  {searchingCustomers && formData.phone.length >= 3 && (
                    <p className="text-xs text-stone-500">Searching previous customers...</p>
                  )}
                  <AnimatePresence>
                    {customerSuggestions.length > 0 && (
                      <motion.div
                        initial={{ opacity: 0, y: -4 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -4 }}
                        className="mt-2 rounded-xl border border-stone-200 bg-white shadow-sm overflow-hidden"
                      >
                        {customerSuggestions.map((c) => (
                          <button
                            key={`${c.contact}-${c.name}`}
                            type="button"
                            onClick={() => applyCustomerSuggestion(c)}
                            className="w-full text-left px-3 py-2 hover:bg-stone-50 transition-colors border-b border-stone-100 last:border-b-0"
                          >
                            <p className="text-sm font-medium text-stone-800">{c.name} · {c.contact}</p>
                            <p className="text-xs text-stone-500">{c.gender}</p>
                          </button>
                        ))}
                      </motion.div>
                    )}
                  </AnimatePresence>
                </Field>

                <Field label="Full Name" required error={errors.name}>
                  <div className="relative">
                    <User className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-stone-400 pointer-events-none" />
                    <Input
                      id="name"
                      name="name"
                      type="text"
                      placeholder="e.g. Rahul Sharma"
                      value={formData.name}
                      onChange={handleChange}
                      autoComplete="name"
                      className={cn("pl-9", errors.name && "border-red-400 focus-visible:ring-red-300")}
                    />
                  </div>
                </Field>

                <Field label="Gender" required error={errors.gender}>
                  <Select value={formData.gender} onValueChange={handleSelect("gender")}>
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder="Select gender" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="male">Male</SelectItem>
                      <SelectItem value="female">Female</SelectItem>
                      <SelectItem value="other">Other</SelectItem>
                      <SelectItem value="prefer_not">Prefer not to say</SelectItem>
                    </SelectContent>
                  </Select>
                </Field>
                </div>
              </Section>

              <Section title="Visit Details" icon="02">
                <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
                <Field label="Date of Filling" required error={errors.date}>
                  <div className="relative">
                    <Calendar className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-stone-400 pointer-events-none" />
                    <Input
                      id="date"
                      name="date"
                      type="date"
                      value={formData.date}
                      onChange={handleChange}
                      className="pl-9"
                    />
                  </div>
                </Field>

                <Field label="Services" required error={errors.amount} className="sm:col-span-2">
                  {!dropdownLoading && serviceDisplayItems.length === 0 ? (
                    <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-700">
                      No services added yet. Ask the owner to add services first.
                    </div>
                  ) : (
                    <MultiSelect
                      items={serviceDisplayItems}
                      values={formData.searchService}
                      onValuesChange={handleMultiSelect("searchService")}
                      placeholder={dropdownLoading ? "Loading services..." : "Search and select services..."}
                      searchPlaceholder="Type to search (e.g. hair, beard, skin)..."
                    />
                  )}

                  {selectedServiceRows.length > 0 && (
                    <div className="mt-3 rounded-xl border border-stone-200 bg-stone-50 p-3 space-y-2">
                      <p className="text-xs font-semibold tracking-wide uppercase text-stone-500">
                        Service Quantities
                      </p>
                      {selectedServiceRows.map((row) => (
                        <div
                          key={row.id}
                          className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 rounded-lg border border-stone-200 bg-white px-3 py-2"
                        >
                          <div className="min-w-0">
                            <p className="text-sm font-semibold text-stone-800 wrap-break-word">{row.name}</p>
                            <p className="text-xs text-stone-500">INR {row.price.toLocaleString("en-IN")} each</p>
                          </div>

                          <div className="inline-flex items-center rounded-lg border border-stone-300 bg-white self-end sm:self-auto">
                            <button
                              type="button"
                              onClick={() => handleServiceQuantityChange(row.id, -1)}
                              className="px-2.5 py-1.5 text-stone-600 hover:bg-stone-100"
                              aria-label={row.quantity === 1 ? `Remove ${row.name}` : `Decrease ${row.name} quantity`}
                            >
                              <Minus className="w-4 h-4" />
                            </button>
                            <span className="min-w-10 text-center text-sm font-semibold text-stone-800 border-x border-stone-300">
                              {row.quantity}
                            </span>
                            <button
                              type="button"
                              onClick={() => handleServiceQuantityChange(row.id, 1)}
                              className="px-2.5 py-1.5 text-stone-600 hover:bg-stone-100"
                              aria-label={`Increase ${row.name} quantity`}
                            >
                              <Plus className="w-4 h-4" />
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </Field>
                </div>
              </Section>

              <Section title="Payment" icon="03" isLast>
                <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
                <Field label="Amount (INR)" required error={errors.amount}>
                  <div className="relative">
                    <Calculator className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-stone-400 pointer-events-none" />
                    <Input
                      id="amount"
                      name="amount"
                      type="text"
                      value={subtotal > 0 ? `INR ${subtotal.toLocaleString("en-IN")}` : "Select services above"}
                      readOnly
                      tabIndex={-1}
                      className={cn(
                        "pl-9 bg-stone-50 cursor-default text-stone-600",
                        errors.amount && "border-red-400 focus-visible:ring-red-300"
                      )}
                    />
                  </div>
                </Field>

                <Field label="Discount (%)">
                  <div className="relative">
                    <Percent className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-stone-400 pointer-events-none" />
                    <Input
                      id="discount"
                      name="discount"
                      type="number"
                      placeholder="e.g. 10"
                      value={formData.discount}
                      onChange={handleChange}
                      min="0"
                      max="100"
                      className="pl-9"
                    />
                  </div>
                </Field>
              </div>

              <AnimatePresence>
                {subtotal > 0 && (
                  <motion.div
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: "auto" }}
                    exit={{ opacity: 0, height: 0 }}
                    className="mt-5"
                  >
                    <Label className="text-xs font-semibold tracking-wide uppercase text-stone-500 mb-3 block">
                      Payment Method
                    </Label>
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
                      <button
                        type="button"
                        onClick={() => handleSelect("paymentMode")("online")}
                        className={cn(
                          "relative flex flex-col items-center gap-2 rounded-xl border-2 px-4 py-4 transition-all duration-200",
                          formData.paymentMode === "online"
                            ? "border-stone-900 bg-stone-900 text-white shadow-lg"
                            : "border-stone-200 bg-white text-stone-600 hover:border-stone-400 hover:shadow-sm"
                        )}
                      >
                        <CreditCard className="w-5 h-5" />
                        <span className="text-xs font-semibold tracking-wide uppercase">Full Online</span>
                        <span className={cn("text-[10px]", formData.paymentMode === "online" ? "text-stone-300" : "text-stone-400")}>
                          Pay via Razorpay
                        </span>
                      </button>

                      <button
                        type="button"
                        onClick={() => handleSelect("paymentMode")("cash")}
                        className={cn(
                          "relative flex flex-col items-center gap-2 rounded-xl border-2 px-4 py-4 transition-all duration-200",
                          formData.paymentMode === "cash"
                            ? "border-emerald-600 bg-emerald-600 text-white shadow-lg"
                            : "border-stone-200 bg-white text-stone-600 hover:border-stone-400 hover:shadow-sm"
                        )}
                      >
                        <Banknote className="w-5 h-5" />
                        <span className="text-xs font-semibold tracking-wide uppercase">Full Cash</span>
                        <span className={cn("text-[10px]", formData.paymentMode === "cash" ? "text-emerald-200" : "text-stone-400")}>
                          Pay at counter
                        </span>
                      </button>

                      <button
                        type="button"
                        onClick={() => handleSelect("paymentMode")("card")}
                        className={cn(
                          "relative flex flex-col items-center gap-2 rounded-xl border-2 px-4 py-4 transition-all duration-200",
                          formData.paymentMode === "card"
                            ? "border-blue-600 bg-blue-600 text-white shadow-lg"
                            : "border-stone-200 bg-white text-stone-600 hover:border-stone-400 hover:shadow-sm"
                        )}
                      >
                        <CreditCard className="w-5 h-5" />
                        <span className="text-xs font-semibold tracking-wide uppercase">Card at Counter</span>
                        <span className={cn("text-[10px]", formData.paymentMode === "card" ? "text-blue-200" : "text-stone-400")}>
                          POS or swipe machine
                        </span>
                      </button>

                      <button
                        type="button"
                        onClick={() => handleSelect("paymentMode")("partial")}
                        className={cn(
                          "relative flex flex-col items-center gap-2 rounded-xl border-2 px-4 py-4 transition-all duration-200",
                          formData.paymentMode === "partial"
                            ? "border-amber-600 bg-amber-600 text-white shadow-lg"
                            : "border-stone-200 bg-white text-stone-600 hover:border-stone-400 hover:shadow-sm"
                        )}
                      >
                        <SplitSquareHorizontal className="w-5 h-5" />
                        <span className="text-xs font-semibold tracking-wide uppercase">Split Payment</span>
                        <span className={cn("text-[10px]", formData.paymentMode === "partial" ? "text-amber-200" : "text-stone-400")}>
                          Cash plus Online
                        </span>
                      </button>
                    </div>

                    <AnimatePresence>
                      {formData.paymentMode === "partial" && (
                        <motion.div
                          initial={{ opacity: 0, height: 0 }}
                          animate={{ opacity: 1, height: "auto" }}
                          exit={{ opacity: 0, height: 0 }}
                          className="mt-4"
                        >
                          <Field label="Cash Amount (INR)" required error={errors.cashAmount}>
                            <div className="relative">
                              <IndianRupee className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-stone-400 pointer-events-none" />
                              <Input
                                id="cashAmount"
                                name="cashAmount"
                                type="number"
                                placeholder={`Enter cash amount (max INR ${(payable - 1).toLocaleString("en-IN")})`}
                                value={formData.cashAmount}
                                onChange={handleChange}
                                min="0.01"
                                max={payable - 1}
                                step="0.01"
                                className={cn(
                                  "pl-9",
                                  errors.cashAmount && "border-red-400 focus-visible:ring-red-300"
                                )}
                              />
                            </div>
                          </Field>
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </motion.div>
                )}
              </AnimatePresence>

              <AnimatePresence>
                {subtotal > 0 && (
                  <motion.div
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: "auto" }}
                    exit={{ opacity: 0, height: 0 }}
                    className="mt-5 rounded-xl border border-stone-200 bg-stone-50 px-5 py-4"
                  >
                    <div className="flex items-center justify-between text-sm text-stone-500 mb-1">
                      <span>Service total ({selectedServiceIds.length} item{selectedServiceIds.length !== 1 ? "s" : ""})</span>
                      <span>INR {subtotal.toLocaleString("en-IN")}</span>
                    </div>
                    {discountPct > 0 && (
                      <div className="flex items-center justify-between text-sm text-emerald-600 mb-1">
                        <span className="flex items-center gap-1">
                          <Percent className="w-3.5 h-3.5" /> Discount ({discountPct}%)
                        </span>
                        <span>- INR {discountAmt.toLocaleString("en-IN")}</span>
                      </div>
                    )}
                    <div className="border-t border-stone-200 mt-2 pt-2 flex items-center justify-between font-bold text-stone-900">
                      <span>Total Payable</span>
                      <span className="text-xl">INR {payable.toLocaleString("en-IN")}</span>
                    </div>

                    <AnimatePresence>
                      {formData.paymentMode === "partial" && cashAmountNum > 0 && onlinePayable > 0 && (
                        <motion.div
                          initial={{ opacity: 0, height: 0 }}
                          animate={{ opacity: 1, height: "auto" }}
                          exit={{ opacity: 0, height: 0 }}
                          className="border-t border-dashed border-stone-300 mt-3 pt-3 space-y-1.5"
                        >
                          <div className="flex items-center justify-between text-sm">
                            <span className="flex items-center gap-1.5 text-emerald-600">
                              <Banknote className="w-3.5 h-3.5" /> Cash
                            </span>
                            <span className="font-semibold text-emerald-600">
                              INR {cashAmountNum.toLocaleString("en-IN", { minimumFractionDigits: cashAmountNum % 1 ? 2 : 0, maximumFractionDigits: 2 })}
                            </span>
                          </div>
                          <div className="flex items-center justify-between text-sm">
                            <span className="flex items-center gap-1.5 text-blue-600">
                              <CreditCard className="w-3.5 h-3.5" /> Online (Razorpay)
                            </span>
                            <span className="font-semibold text-blue-600">
                              INR {onlinePayable.toLocaleString("en-IN", { minimumFractionDigits: onlinePayable % 1 ? 2 : 0, maximumFractionDigits: 2 })}
                            </span>
                          </div>
                        </motion.div>
                      )}
                    </AnimatePresence>

                    {formData.paymentMode === "cash" && (
                      <div className="border-t border-dashed border-stone-300 mt-3 pt-3">
                        <div className="flex items-center gap-2 text-sm text-emerald-600">
                          <Banknote className="w-4 h-4" />
                          <span className="font-medium">Full amount to be collected in cash</span>
                        </div>
                      </div>
                    )}
                    {formData.paymentMode === "card" && (
                      <div className="border-t border-dashed border-stone-300 mt-3 pt-3">
                        <div className="flex items-center gap-2 text-sm text-blue-600">
                          <CreditCard className="w-4 h-4" />
                          <span className="font-medium">Full amount to be collected using card machine</span>
                        </div>
                      </div>
                    )}
                  </motion.div>
                )}
              </AnimatePresence>
              </Section>
            </div>

            <AnimatePresence>
              {paymentError && (
                <motion.div
                  initial={{ opacity: 0, y: -6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -6 }}
                  className="mb-6 rounded-xl border border-red-200 bg-red-50 px-4 py-3 flex items-start justify-between gap-2 text-sm text-red-700"
                >
                  <div className="flex items-start gap-2">
                    <svg className="w-4 h-4 mt-0.5 shrink-0" fill="currentColor" viewBox="0 0 20 20">
                      <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
                    </svg>
                    {paymentError}
                  </div>
                  <button
                    type="button"
                    onClick={handleReset}
                    className="shrink-0 text-xs text-red-500 underline hover:text-red-700"
                  >
                    Clear
                  </button>
                </motion.div>
              )}
            </AnimatePresence>

            <div className="flex flex-col sm:flex-row gap-3 items-center justify-end">
              <button
                type="button"
                onClick={handleReset}
                className="w-full sm:w-auto px-6 py-2.5 rounded-xl border border-stone-300 text-stone-700 text-sm font-medium hover:bg-stone-100 transition-colors"
              >
                Reset Form
              </button>

              <motion.button
                type="submit"
                disabled={isLoading}
                whileHover={{ scale: isLoading ? 1 : 1.015 }}
                whileTap={{ scale: isLoading ? 1 : 0.985 }}
                className="relative w-full sm:w-80 h-12 rounded-xl overflow-hidden font-semibold text-white disabled:cursor-not-allowed"
              >
                <div className="absolute inset-0 z-0 pointer-events-none">
                  <SparklesCore
                    background="transparent"
                    minSize={0.4}
                    maxSize={1}
                    particleDensity={60}
                    particleColor="#c8a97e"
                  />
                </div>
                <div
                  className={cn(
                    "absolute inset-0 transition-colors duration-200 z-0",
                    formData.paymentMode === "cash"
                      ? "bg-emerald-600 hover:bg-emerald-700"
                      : formData.paymentMode === "card"
                        ? "bg-blue-600 hover:bg-blue-700"
                        : formData.paymentMode === "partial"
                          ? "bg-amber-600 hover:bg-amber-700"
                          : "bg-stone-900 hover:bg-stone-800"
                  )}
                />
                <span className="relative z-10 flex items-center justify-center gap-2">
                  {isLoading ? (
                    <>
                      <motion.span
                        animate={{ rotate: 360 }}
                        transition={{ duration: 1, repeat: Infinity, ease: "linear" }}
                        className="inline-block w-5 h-5 border-2 border-white/30 border-t-white rounded-full"
                      />
                      Processing...
                    </>
                  ) : formData.paymentMode === "cash" ? (
                    <>
                      <Banknote className="w-4 h-4" />
                      {payable > 0
                        ? `Record Cash and Continue - INR ${payable.toLocaleString("en-IN")}`
                        : "Record Cash and Continue"}
                    </>
                  ) : formData.paymentMode === "card" ? (
                    <>
                      <CreditCard className="w-4 h-4" />
                      {payable > 0
                        ? `Record Card and Continue - INR ${payable.toLocaleString("en-IN")}`
                        : "Record Card and Continue"}
                    </>
                  ) : formData.paymentMode === "partial" ? (
                    <>
                      <SplitSquareHorizontal className="w-4 h-4" />
                      {onlinePayable > 0
                        ? `Pay INR ${onlinePayable.toLocaleString("en-IN")} Online, Then Assign`
                        : "Pay with Razorpay"}
                    </>
                  ) : (
                    <>
                      {payable > 0
                        ? `Pay INR ${payable.toLocaleString("en-IN")} Online, Then Assign`
                        : "Pay with Razorpay"}
                    </>
                  )}
                </span>
              </motion.button>
            </div>

            {formData.paymentMode !== "cash" && formData.paymentMode !== "card" && (
              <p className="text-center text-xs text-stone-400 mt-4 flex items-center justify-center gap-1">
                <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M10 1a4.5 4.5 0 00-4.5 4.5V9H5a2 2 0 00-2 2v6a2 2 0 002 2h10a2 2 0 002-2v-6a2 2 0 00-2-2h-.5V5.5A4.5 4.5 0 0010 1zm3 8V5.5a3 3 0 10-6 0V9h6z" clipRule="evenodd" />
                </svg>
                Secured by Razorpay - 256-bit SSL encryption
              </p>
            )}
          </form>
        </motion.div>
      </div>
    </AppLayout>
  );
}

function Section({
  title,
  icon,
  isLast = false,
  children,
}: {
  title: string;
  icon: string;
  isLast?: boolean;
  children: React.ReactNode;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, amount: 0.1 }}
      transition={{ duration: 0.5, ease: "easeOut" }}
      className={cn(!isLast && "border-b border-stone-100")}
    >
      <div className="flex items-center gap-3 px-5 sm:px-7 py-5 border-b border-stone-100">
        <span className="flex items-center justify-center w-7 h-7 rounded-full bg-stone-900 text-white text-xs font-bold shrink-0">
          {icon}
        </span>
        <h3 className="text-sm font-semibold text-stone-700 uppercase tracking-[0.15em]">
          {title}
        </h3>
      </div>
      <div className="px-5 sm:px-7 py-6">{children}</div>
    </motion.div>
  );
}

function Field({
  label,
  required,
  error,
  className,
  children,
}: {
  label: string;
  required?: boolean;
  error?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cn("space-y-1.5", className)}>
      <Label className="text-xs font-semibold tracking-wide uppercase text-stone-500">
        {label}
        {required && <span className="text-red-500 ml-1">*</span>}
      </Label>
      {children}
      <AnimatePresence>
        {error && (
          <motion.p
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            className="text-xs text-red-500"
          >
            {error}
          </motion.p>
        )}
      </AnimatePresence>
    </div>
  );
}
