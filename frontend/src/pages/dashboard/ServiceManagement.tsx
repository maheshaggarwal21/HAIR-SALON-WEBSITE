/**
 * @file ServiceManagement.tsx
 * @description Service catalogue management panel (owner-only).
 *
 * Full CRUD for salon services:
 *   - List all services in a table (active + inactive)
 *   - Add new service (slide-down panel)
 *   - Edit existing service (modal)
 *   - Deactivate / reactivate (soft delete)
 *
 * Follows the same design language as ArtistManagement.tsx.
 */

import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Scissors,
  Plus,
  XCircle,
  CheckCircle2,
  Pencil,
  X,
  Loader2,
  IndianRupee,
  Tag,
  Trash2,
} from "lucide-react";
import { usePermission } from "@/hooks/usePermission";

const API = import.meta.env.VITE_BACKEND_URL || "";

// ── Types ────────────────────────────────────────────────────────────────────
interface ServiceRecord {
  _id: string;
  name: string;
  price: number;
  category: string;
  durationMinutes?: number | null; // Phase 3: expected duration
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

interface ServiceFormData {
  name: string;
  price: string;
  category: string;
  duration: string; // durationMinutes as string (empty = null/no duration)
}

// ── Field styling (matches ArtistManagement / TeamManagement) ────────────────
const inputClass =
  "w-full h-11 px-4 rounded-xl border border-stone-200 bg-stone-50 text-stone-900 text-sm focus:outline-none focus:ring-2 focus:ring-amber-400/50 focus:border-amber-400 placeholder:text-stone-400 transition-all duration-150";

const EMPTY_FORM: ServiceFormData = { name: "", price: "", category: "", duration: "" };

// ── Component ────────────────────────────────────────────────────────────────
export default function ServiceManagement() {
  const canCrud = usePermission("services.crud");
  const [services, setServices] = useState<ServiceRecord[]>([]);
  const [loadingServices, setLoadingServices] = useState(true);
  const [fetchError, setFetchError] = useState(false);

  // Add panel
  const [showAddPanel, setShowAddPanel] = useState(false);
  const [formData, setFormData] = useState<ServiceFormData>({ ...EMPTY_FORM });
  const [formError, setFormError] = useState("");
  const [formSuccess, setFormSuccess] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // Edit modal
  const [editingService, setEditingService] = useState<ServiceRecord | null>(null);
  const [editForm, setEditForm] = useState<ServiceFormData>({ ...EMPTY_FORM });
  const [editFormError, setEditFormError] = useState("");

  // ── Fetch services (all, including inactive) ──────────────────────────────
  const fetchServices = async () => {
    setLoadingServices(true);
    try {
      const res = await fetch(`${API}/api/services/all`, {
        credentials: "include",
      });
      const data = await res.json();
      setServices(Array.isArray(data) ? data : []);
      setFetchError(false);
    } catch {
      setServices([]);
      setFetchError(true);
    } finally {
      setLoadingServices(false);
    }
  };

  useEffect(() => {
    fetchServices();
  }, []);

  // Sync edit form when editingService changes
  useEffect(() => {
    if (editingService) {
      setEditForm({
        name: editingService.name,
        price: String(editingService.price),
        category: editingService.category || "",
        duration: editingService.durationMinutes != null ? String(editingService.durationMinutes) : "",
      });
      setEditFormError("");
    }
  }, [editingService]);

  // ── Validate price ─────────────────────────────────────────────────────────
  const isValidPrice = (val: string) => {
    const n = Number(val);
    return !isNaN(n) && n >= 0;
  };

  // ── Add service ────────────────────────────────────────────────────────────
  const handleAddService = async () => {
    setFormError("");
    setFormSuccess("");

    if (!formData.name.trim()) {
      setFormError("Service name is required.");
      return;
    }
    if (!formData.price.trim() || !isValidPrice(formData.price)) {
      setFormError("Enter a valid price (≥ 0).");
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch(`${API}/api/services`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: formData.name.trim(),
          price: Number(formData.price),
          category: formData.category.trim(),
          durationMinutes: formData.duration.trim() ? Number(formData.duration) : null,
        }),
      });
      const data = await res.json();
      if (res.ok) {
        setFormSuccess(`${data.name} has been added successfully.`);
        setFormData({ ...EMPTY_FORM });
        fetchServices();
        setTimeout(() => {
          setShowAddPanel(false);
          setFormSuccess("");
        }, 2000);
      } else {
        setFormError(
          data.errors?.[0]?.msg || data.error || "Failed to add service."
        );
      }
    } catch {
      setFormError("Network error. Check your connection.");
    } finally {
      setSubmitting(false);
    }
  };

  // ── Deactivate / Reactivate ────────────────────────────────────────────────
  const handleDeactivate = async (id: string) => {
    const res = await fetch(`${API}/api/services/${id}`, {
      method: "DELETE",
      credentials: "include",
    });
    if (res.ok) fetchServices();
  };

  const handleReactivate = async (id: string) => {
    const res = await fetch(`${API}/api/services/${id}`, {
      method: "PATCH",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ isActive: true }),
    });
    if (res.ok) fetchServices();
  };

  // ── Permanent Delete ─────────────────────────────────────────────────
  const handlePermanentDelete = async (service: ServiceRecord) => {
    const confirmed = window.confirm(
      `Are you sure you want to permanently delete "${service.name}"? This action cannot be undone.`
    );
    if (!confirmed) return;

    try {
      const res = await fetch(`${API}/api/services/${service._id}/permanent`, {
        method: "DELETE",
        credentials: "include",
      });
      if (res.ok) fetchServices();
    } catch {
      // silently fail; user can retry
    }
  };

  // ── Edit save ──────────────────────────────────────────────────────────────
  const handleEditSave = async () => {
    if (!editingService) return;
    setEditFormError("");

    if (!editForm.name.trim()) {
      setEditFormError("Service name is required.");
      return;
    }
    if (!editForm.price.trim() || !isValidPrice(editForm.price)) {
      setEditFormError("Enter a valid price (≥ 0).");
      return;
    }

    try {
      const res = await fetch(`${API}/api/services/${editingService._id}`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: editForm.name.trim(),
          price: Number(editForm.price),
          category: editForm.category.trim(),
          durationMinutes: editForm.duration.trim() ? Number(editForm.duration) : null,
        }),
      });
      const data = await res.json();
      if (res.ok) {
        fetchServices();
        setEditingService(null);
      } else {
        setEditFormError(
          data.errors?.[0]?.msg || data.error || "Failed to update service."
        );
      }
    } catch {
      setEditFormError("Network error. Check your connection.");
    }
  };

  // ── Derived stats ──────────────────────────────────────────────────────────
  const activeCount = services.filter((s) => s.isActive).length;
  const categories = [...new Set(services.map((s) => s.category).filter(Boolean))];

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4 }}
    >
      {/* Page header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-2xl font-bold text-stone-900 flex items-center gap-2">
            <Scissors className="w-6 h-6 text-amber-500" /> Service Catalogue
          </h2>
          <p className="text-sm text-stone-500 mt-0.5">
            Manage salon services, prices, and categories
          </p>
        </div>
        {canCrud && (
          <button
            onClick={() => setShowAddPanel((p) => !p)}
            className="flex items-center gap-2 bg-stone-900 text-white text-sm rounded-xl px-5 py-2.5 hover:bg-stone-800 transition-colors"
          >
            <Plus className="w-4 h-4" />
            Add New Service
          </button>
        )}
      </div>

      {fetchError && (
        <div className="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-600">
          Failed to load services. Check your connection and refresh.
        </div>
      )}

      {/* Stats row */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-6">
        {[
          { label: "Total Services", value: services.length },
          { label: "Active Services", value: activeCount },
          { label: "Categories", value: categories.length },
        ].map((s) => (
          <div
            key={s.label}
            className="bg-white rounded-xl border border-stone-200/80 p-5 shadow-sm"
          >
            <p className="text-2xl font-black text-stone-900">{s.value}</p>
            <p className="text-xs font-semibold uppercase tracking-wider text-stone-500 mt-0.5">
              {s.label}
            </p>
          </div>
        ))}
      </div>

      {/* ── Add Service Panel ── */}
      <AnimatePresence>
        {showAddPanel && (
          <motion.div
            initial={{ opacity: 0, y: -12, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -12, scale: 0.98 }}
            transition={{ duration: 0.2 }}
            className="mb-6 bg-white rounded-2xl border border-stone-200/80 shadow-sm p-7"
          >
            <div className="flex items-center justify-between mb-6">
              <h3 className="text-lg font-bold text-stone-900">
                Add New Service
              </h3>
              <button
                onClick={() => setShowAddPanel(false)}
                className="text-stone-400 hover:text-stone-700 transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5">
              {/* Service Name */}
              <div>
                <label className="block text-xs font-semibold text-stone-600 mb-1.5 uppercase tracking-wider">
                  Service Name
                </label>
                <input
                  type="text"
                  placeholder="e.g. Premium Haircut"
                  value={formData.name}
                  onChange={(e) =>
                    setFormData((p) => ({ ...p, name: e.target.value }))
                  }
                  className={inputClass}
                />
              </div>

              {/* Price */}
              <div>
                <label className="block text-xs font-semibold text-stone-600 mb-1.5 uppercase tracking-wider">
                  Price (₹)
                </label>
                <input
                  type="number"
                  inputMode="numeric"
                  min={0}
                  step={10}
                  placeholder="e.g. 500"
                  value={formData.price}
                  onChange={(e) =>
                    setFormData((p) => ({ ...p, price: e.target.value }))
                  }
                  className={inputClass}
                />
              </div>

              {/* Duration (optional) */}
              <div>
                <label className="block text-xs font-semibold text-stone-600 mb-1.5 uppercase tracking-wider">
                  Duration (min) <span className="text-stone-400 font-normal normal-case tracking-normal">optional</span>
                </label>
                <input
                  type="number"
                  inputMode="numeric"
                  min={1}
                  step={5}
                  placeholder="e.g. 30"
                  value={formData.duration}
                  onChange={(e) =>
                    setFormData((p) => ({ ...p, duration: e.target.value }))
                  }
                  className={inputClass}
                />
              </div>

              {/* Category */}
              <div>
                <label className="block text-xs font-semibold text-stone-600 mb-1.5 uppercase tracking-wider">
                  Category
                </label>
                <input
                  type="text"
                  placeholder="e.g. Haircut"
                  value={formData.category}
                  onChange={(e) =>
                    setFormData((p) => ({ ...p, category: e.target.value }))
                  }
                  className={inputClass}
                  list="category-suggestions"
                />
                <datalist id="category-suggestions">
                  {categories.map((c) => (
                    <option key={c} value={c} />
                  ))}
                </datalist>
              </div>

              {/* Error / Success */}
              {formError && (
                <motion.p
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  className="text-sm text-red-500 col-span-full"
                >
                  {formError}
                </motion.p>
              )}
              {formSuccess && (
                <motion.p
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  className="text-sm text-green-600 col-span-full"
                >
                  {formSuccess}
                </motion.p>
              )}

              {/* Actions */}
              <div className="col-span-full flex justify-end gap-3 mt-2">
                <button
                  onClick={() => setShowAddPanel(false)}
                  className="text-sm text-stone-500 hover:text-stone-800 px-4 py-2 rounded-lg border border-stone-200 hover:border-stone-300 transition-all"
                >
                  Cancel
                </button>
                <button
                  onClick={handleAddService}
                  disabled={submitting}
                  className="flex items-center gap-2 bg-stone-900 text-white text-sm rounded-xl px-6 py-2.5 hover:bg-stone-800 disabled:opacity-60 transition-colors"
                >
                  {submitting ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Plus className="w-4 h-4" />
                  )}
                  {submitting ? "Adding..." : "Add Service"}
                </button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── Services Table ── */}
      <div className="bg-white rounded-2xl border border-stone-200/80 shadow-sm overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-stone-50 border-b border-stone-200">
            <tr>
              <th className="text-left px-6 py-3.5 text-xs font-semibold uppercase tracking-wider text-stone-500">
                Service
              </th>
              <th className="text-left px-6 py-3.5 text-xs font-semibold uppercase tracking-wider text-stone-500">
                Price
              </th>
              <th className="text-left px-6 py-3.5 text-xs font-semibold uppercase tracking-wider text-stone-500">
                Duration
              </th>
              <th className="text-left px-6 py-3.5 text-xs font-semibold uppercase tracking-wider text-stone-500">
                Category
              </th>
              <th className="text-left px-6 py-3.5 text-xs font-semibold uppercase tracking-wider text-stone-500">
                Status
              </th>
              <th className="text-left px-6 py-3.5 text-xs font-semibold uppercase tracking-wider text-stone-500">
                Actions
              </th>
            </tr>
          </thead>
          <tbody>
            {loadingServices
              ? Array.from({ length: 5 }).map((_, i) => (
                  <tr key={i} className="border-b border-stone-100">
                    {[1, 2, 3, 4, 5, 6].map((j) => (
                      <td key={j} className="px-6 py-4">
                        <div className="h-4 bg-stone-100 rounded animate-pulse" />
                      </td>
                    ))}
                  </tr>
                ))
              : services.length === 0
                ? (
                    <tr>
                      <td
                        colSpan={6}
                        className="px-6 py-16 text-center text-stone-400 text-sm"
                      >
                        No services yet. Add your first service above.
                      </td>
                    </tr>
                  )
                : services.map((s) => (
                    <tr
                      key={s._id}
                      className="group border-b border-stone-100 hover:bg-stone-50/50 transition-colors"
                    >
                      {/* Name with timestamps */}
                      <td className="px-6 py-4">
                        <p className="font-medium text-stone-900">{s.name}</p>
                        <div className="text-[11px] text-stone-500 mt-1 leading-snug opacity-0 max-h-0 overflow-hidden group-hover:opacity-100 group-hover:max-h-16 transition-all duration-200">
                          <span className="block">
                            Created: {new Date(s.createdAt).toLocaleString("en-IN", {
                              day: "numeric",
                              month: "short",
                              year: "numeric",
                              hour: "2-digit",
                              minute: "2-digit",
                              hour12: true,
                            })}
                          </span>
                          <span className="block">
                            Updated: {new Date(s.updatedAt).toLocaleString("en-IN", {
                              day: "numeric",
                              month: "short",
                              year: "numeric",
                              hour: "2-digit",
                              minute: "2-digit",
                              hour12: true,
                            })}
                          </span>
                        </div>
                      </td>

                      {/* Price */}
                      <td className="px-6 py-4">
                        <span className="inline-flex items-center gap-1 text-amber-600 font-bold">
                          <IndianRupee className="w-3.5 h-3.5" />
                          {s.price.toLocaleString("en-IN")}
                        </span>
                      </td>

                      {/* Duration */}
                      <td className="px-6 py-4">
                        {s.durationMinutes != null ? (
                          <span className="text-stone-700 text-sm font-medium">{s.durationMinutes} min</span>
                        ) : (
                          <span className="text-stone-400 text-xs">—</span>
                        )}
                      </td>

                      {/* Category */}
                      <td className="px-6 py-4">
                        {s.category ? (
                          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-medium bg-amber-50 text-amber-800 border border-amber-200">
                            <Tag className="w-3 h-3" />
                            {s.category}
                          </span>
                        ) : (
                          <span className="text-stone-400 text-xs">—</span>
                        )}
                      </td>

                      {/* Status badge */}
                      <td className="px-6 py-4">
                        {s.isActive ? (
                          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-medium bg-green-50 text-green-700 border border-green-200">
                            <span className="w-1.5 h-1.5 rounded-full bg-green-500" />{" "}
                            Active
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-medium bg-stone-100 text-stone-500 border border-stone-200">
                            <span className="w-1.5 h-1.5 rounded-full bg-stone-400" />{" "}
                            Inactive
                          </span>
                        )}
                      </td>

                      {/* Actions */}
                      <td className="px-6 py-4">
                        <div className="flex items-center gap-2">
                          {canCrud && (
                            <button
                              onClick={() => setEditingService(s)}
                              className="flex items-center gap-1.5 text-xs text-stone-600 hover:text-stone-900 border border-stone-200 hover:border-stone-300 rounded-lg px-3 py-1.5 transition-all"
                            >
                              <Pencil className="w-3 h-3" /> Edit
                            </button>
                          )}

                          {canCrud && s.isActive && (
                            <button
                              onClick={() => handleDeactivate(s._id)}
                              className="flex items-center gap-1.5 text-xs text-red-500 hover:text-red-700 border border-red-100 hover:border-red-200 rounded-lg px-3 py-1.5 transition-all"
                            >
                              <XCircle className="w-3 h-3" /> Deactivate
                            </button>
                          )}

                          {canCrud && !s.isActive && (
                            <button
                              onClick={() => handleReactivate(s._id)}
                              className="flex items-center gap-1.5 text-xs text-green-600 hover:text-green-800 border border-green-100 hover:border-green-200 rounded-lg px-3 py-1.5 transition-all"
                            >
                              <CheckCircle2 className="w-3 h-3" /> Reactivate
                            </button>
                          )}

                          {canCrud && (
                            <button
                              onClick={() => handlePermanentDelete(s)}
                              className="flex items-center gap-1.5 text-xs text-red-600 hover:text-white hover:bg-red-600 border border-red-200 hover:border-red-600 rounded-lg px-3 py-1.5 transition-all"
                              title="Permanently delete from database"
                            >
                              <Trash2 className="w-3 h-3" /> Delete
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
          </tbody>
        </table>
      </div>

      {/* ── Edit Service Modal ── */}
      <AnimatePresence>
        {editingService && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
            <motion.div
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              transition={{ duration: 0.2 }}
              className="bg-white rounded-2xl shadow-2xl w-full max-w-md mx-4 p-7"
            >
              {/* Header */}
              <div className="flex items-center justify-between mb-6">
                <h3 className="text-lg font-bold text-stone-900">
                  Edit Service
                </h3>
                <button
                  onClick={() => setEditingService(null)}
                  className="text-stone-400 hover:text-stone-700 transition-colors"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              {/* Fields */}
              <div className="space-y-4">
                <div>
                  <label className="block text-xs font-semibold text-stone-600 mb-1.5 uppercase tracking-wider">
                    Service Name
                  </label>
                  <input
                    type="text"
                    value={editForm.name}
                    onChange={(e) =>
                      setEditForm((p) => ({ ...p, name: e.target.value }))
                    }
                    className={inputClass}
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-stone-600 mb-1.5 uppercase tracking-wider">
                    Price (₹)
                  </label>
                  <input
                    type="number"
                    inputMode="numeric"
                    min={0}
                    step={10}
                    value={editForm.price}
                    onChange={(e) =>
                      setEditForm((p) => ({ ...p, price: e.target.value }))
                    }
                    className={inputClass}
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-stone-600 mb-1.5 uppercase tracking-wider">
                    Duration (min) <span className="text-stone-400 font-normal normal-case tracking-normal">optional</span>
                  </label>
                  <input
                    type="number"
                    inputMode="numeric"
                    min={1}
                    step={5}
                    placeholder="e.g. 30"
                    value={editForm.duration}
                    onChange={(e) =>
                      setEditForm((p) => ({ ...p, duration: e.target.value }))
                    }
                    className={inputClass}
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-stone-600 mb-1.5 uppercase tracking-wider">
                    Category
                  </label>
                  <input
                    type="text"
                    value={editForm.category}
                    onChange={(e) =>
                      setEditForm((p) => ({ ...p, category: e.target.value }))
                    }
                    className={inputClass}
                    placeholder="e.g. Haircut"
                    list="edit-category-suggestions"
                  />
                  <datalist id="edit-category-suggestions">
                    {categories.map((c) => (
                      <option key={c} value={c} />
                    ))}
                  </datalist>
                </div>

                {editFormError && (
                  <p className="text-sm text-red-500">{editFormError}</p>
                )}
              </div>

              {/* Footer */}
              <div className="flex justify-end gap-3 mt-6">
                <button
                  onClick={() => setEditingService(null)}
                  className="text-sm text-stone-500 hover:text-stone-800 px-4 py-2 rounded-lg border border-stone-200 hover:border-stone-300 transition-all"
                >
                  {canCrud ? "Cancel" : "Close"}
                </button>
                {canCrud && (
                  <button
                    onClick={handleEditSave}
                    className="flex items-center gap-2 bg-stone-900 text-white text-sm rounded-xl px-6 py-2.5 hover:bg-stone-800 transition-colors"
                  >
                    Save Changes
                  </button>
                )}
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}
