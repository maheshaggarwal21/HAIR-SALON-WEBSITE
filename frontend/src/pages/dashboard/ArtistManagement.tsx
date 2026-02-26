/**
 * @file ArtistManagement.tsx
 * @description Artist directory management panel (manager + owner).
 *
 * CRUD for salon artists (simple name + phone entries, NOT user accounts):
 *   - List all artists in a table
 *   - Add new artist (slide-down panel)
 *   - Edit existing artist (modal)
 *   - Deactivate / reactivate (soft delete)
 */

import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { motion, AnimatePresence } from "framer-motion";
import {
  Palette,
  UserPlus,
  UserX,
  UserCheck,
  Pencil,
  X,
  Loader2,
  Phone,
  Trash2,
  Mail,
  BadgePercent,
  Key,
  Briefcase,
  Eye,
} from "lucide-react";

const API = import.meta.env.VITE_BACKEND_URL || "";

// ── Types ────────────────────────────────────────────────────────────────────
interface ArtistRecord {
  _id: string;
  name: string;
  phone: string;
  email: string | null;
  registrationId: string | null;
  commission: number;
  photo: string | null;
  userId: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

interface ArtistFormData {
  name: string;
  phone: string;
  email: string;
  password: string;
  registrationId: string;
  commission: string;
}

// ── Field styling (matches TeamManagement) ───────────────────────────────────
const inputClass =
  "w-full h-11 px-4 rounded-xl border border-stone-200 bg-stone-50 text-stone-900 text-sm focus:outline-none focus:ring-2 focus:ring-amber-400/50 focus:border-amber-400 placeholder:text-stone-400 transition-all duration-150";

// ── Component ────────────────────────────────────────────────────────────────
export default function ArtistManagement() {
  const navigate = useNavigate();
  const [artists, setArtists] = useState<ArtistRecord[]>([]);
  const [loadingArtists, setLoadingArtists] = useState(true);
  const [fetchError, setFetchError] = useState(false);

  // Add panel
  const [showAddPanel, setShowAddPanel] = useState(false);
  const [formData, setFormData] = useState<ArtistFormData>({
    name: "",
    phone: "",
    email: "",
    password: "",
    registrationId: "",
    commission: "",
  });
  const [formError, setFormError] = useState("");
  const [formSuccess, setFormSuccess] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // Edit modal
  const [editingArtist, setEditingArtist] = useState<ArtistRecord | null>(null);
  const [editForm, setEditForm] = useState<ArtistFormData>({
    name: "",
    phone: "",
    email: "",
    password: "",
    registrationId: "",
    commission: "",
  });
  const [editFormError, setEditFormError] = useState("");

  // ── Fetch artists (all, including inactive) ────────────────────────────────
  const fetchArtists = async () => {
    setLoadingArtists(true);
    try {
      const res = await fetch(`${API}/api/artists/all`, {
        credentials: "include",
      });
      const data = await res.json();
      setArtists(Array.isArray(data) ? data : []);
      setFetchError(false);
    } catch {
      setArtists([]);
      setFetchError(true);
    } finally {
      setLoadingArtists(false);
    }
  };

  useEffect(() => {
    fetchArtists();
  }, []);

  // Sync edit form when editingArtist changes
  useEffect(() => {
    if (editingArtist) {
      setEditForm({
        name: editingArtist.name,
        phone: editingArtist.phone,
        email: editingArtist.email || "",
        password: "",
        registrationId: editingArtist.registrationId || "",
        commission: editingArtist.commission?.toString() || "0",
      });
      setEditFormError("");
    }
  }, [editingArtist]);

  // ── Validate phone (10-digit Indian mobile) ───────────────────────────────
  const isValidPhone = (phone: string) => /^[6-9]\d{9}$/.test(phone);

  // ── Add artist ─────────────────────────────────────────────────────────────
  const handleAddArtist = async () => {
    setFormError("");
    setFormSuccess("");

    if (!formData.name.trim() || !formData.phone.trim()) {
      setFormError("Both name and phone are required.");
      return;
    }
    if (!isValidPhone(formData.phone)) {
      setFormError("Enter a valid 10-digit Indian mobile number.");
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch(`${API}/api/artists`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(formData),
      });
      const data = await res.json();
      if (res.ok) {
        setFormSuccess(`${data.name} has been added successfully.`);
        setFormData({ name: "", phone: "", email: "", password: "", registrationId: "", commission: "" });
        fetchArtists();
        setTimeout(() => {
          setShowAddPanel(false);
          setFormSuccess("");
        }, 2000);
      } else {
        setFormError(
          data.errors?.[0]?.msg || data.error || "Failed to add artist."
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
    const res = await fetch(`${API}/api/artists/${id}`, {
      method: "DELETE",
      credentials: "include",
    });
    if (res.ok) fetchArtists();
  };

  const handleReactivate = async (id: string) => {
    const res = await fetch(`${API}/api/artists/${id}`, {
      method: "PATCH",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ isActive: true }),
    });
    if (res.ok) fetchArtists();
  };

  // ── Permanent Delete ─────────────────────────────────────────────────
  const handlePermanentDelete = async (artist: ArtistRecord) => {
    const confirmed = window.confirm(
      `Are you sure you want to permanently delete "${artist.name}"? This action cannot be undone.`
    );
    if (!confirmed) return;

    try {
      const res = await fetch(`${API}/api/artists/${artist._id}/permanent`, {
        method: "DELETE",
        credentials: "include",
      });
      if (res.ok) fetchArtists();
    } catch {
      // silently fail; user can retry
    }
  };

  // ── Edit save ──────────────────────────────────────────────────────────────
  const handleEditSave = async () => {
    if (!editingArtist) return;
    setEditFormError("");

    if (!editForm.name.trim() || !editForm.phone.trim()) {
      setEditFormError("Both name and phone are required.");
      return;
    }
    if (!isValidPhone(editForm.phone)) {
      setEditFormError("Enter a valid 10-digit Indian mobile number.");
      return;
    }

    // Validate optional password length
    if (editForm.password && editForm.password.length < 8) {
      setEditFormError("Password must be at least 8 characters.");
      return;
    }

    try {
      const body: Record<string, unknown> = {
        name: editForm.name,
        phone: editForm.phone,
        registrationId: editForm.registrationId || null,
        commission: editForm.commission ? Number(editForm.commission) : 0,
        email: editForm.email || null,
      };
      if (editForm.password) body.password = editForm.password;

      const res = await fetch(`${API}/api/artists/${editingArtist._id}`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (res.ok) {
        fetchArtists();
        setEditingArtist(null);
      } else {
        setEditFormError(
          data.errors?.[0]?.msg || data.error || "Failed to update artist."
        );
      }
    } catch {
      setEditFormError("Network error. Check your connection.");
    }
  };

  // ── Stats ──────────────────────────────────────────────────────────────────
  const activeCount = artists.filter((a) => a.isActive).length;
  const inactiveCount = artists.filter((a) => !a.isActive).length;

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4 }}
    >
      {/* Page header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-6">
        <div>
          <h2 className="text-2xl font-bold text-stone-900 flex items-center gap-2">
            <Palette className="w-6 h-6 text-amber-500" /> Artist Directory
          </h2>
          <p className="text-sm text-stone-500 mt-0.5">
            Manage salon artists and their contact details
          </p>
        </div>
        <button
          onClick={() => setShowAddPanel((p) => !p)}
          className="relative z-10 flex items-center gap-2 bg-stone-900 text-white text-sm rounded-xl px-5 py-2.5 hover:bg-stone-800 active:scale-95 transition-all w-full sm:w-auto justify-center sm:justify-start"
        >
          <UserPlus className="w-4 h-4" />
          Add New Artist
        </button>
      </div>

      {fetchError && (
        <div className="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-600">
          Failed to load artists. Check your connection and refresh.
        </div>
      )}

      {/* Stats row */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-6">
        {[
          { label: "Total Artists", value: artists.length },
          { label: "Active Artists", value: activeCount },
          { label: "Inactive", value: inactiveCount },
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

      {/* ── Add Artist Panel ── */}
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
                Add New Artist
              </h3>
              <button
                onClick={() => setShowAddPanel(false)}
                className="text-stone-400 hover:text-stone-700 transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
              {/* Full Name */}
              <div>
                <label className="block text-xs font-semibold text-stone-600 mb-1.5 uppercase tracking-wider">
                  Full Name *
                </label>
                <input
                  type="text"
                  placeholder="e.g. Ravi Kumar"
                  value={formData.name}
                  onChange={(e) =>
                    setFormData((p) => ({ ...p, name: e.target.value }))
                  }
                  className={inputClass}
                />
              </div>

              {/* Phone */}
              <div>
                <label className="block text-xs font-semibold text-stone-600 mb-1.5 uppercase tracking-wider">
                  Phone Number *
                </label>
                <input
                  type="tel"
                  inputMode="numeric"
                  maxLength={10}
                  placeholder="e.g. 9876543210"
                  value={formData.phone}
                  onChange={(e) =>
                    setFormData((p) => ({
                      ...p,
                      phone: e.target.value.replace(/\D/g, "").slice(0, 10),
                    }))
                  }
                  className={inputClass}
                />
              </div>

              {/* Email (for dashboard login) */}
              <div>
                <label className="block text-xs font-semibold text-stone-600 mb-1.5 uppercase tracking-wider">
                  <Mail className="w-3 h-3 inline mr-1" /> Email
                  <span className="text-stone-400 font-normal ml-1">(for dashboard login)</span>
                </label>
                <input
                  type="email"
                  placeholder="artist@theexperts.in"
                  value={formData.email}
                  onChange={(e) =>
                    setFormData((p) => ({ ...p, email: e.target.value }))
                  }
                  className={inputClass}
                />
              </div>

              {/* Password */}
              <div>
                <label className="block text-xs font-semibold text-stone-600 mb-1.5 uppercase tracking-wider">
                  <Key className="w-3 h-3 inline mr-1" /> Password
                  <span className="text-stone-400 font-normal ml-1">(min 8 chars)</span>
                </label>
                <input
                  type="password"
                  placeholder="••••••••"
                  value={formData.password}
                  onChange={(e) =>
                    setFormData((p) => ({ ...p, password: e.target.value }))
                  }
                  className={inputClass}
                />
              </div>

              {/* Registration ID */}
              <div>
                <label className="block text-xs font-semibold text-stone-600 mb-1.5 uppercase tracking-wider">
                  <Briefcase className="w-3 h-3 inline mr-1" /> Registration ID
                </label>
                <input
                  type="text"
                  placeholder="e.g. REG-001"
                  value={formData.registrationId}
                  onChange={(e) =>
                    setFormData((p) => ({ ...p, registrationId: e.target.value }))
                  }
                  className={inputClass}
                />
              </div>

              {/* Commission % */}
              <div>
                <label className="block text-xs font-semibold text-stone-600 mb-1.5 uppercase tracking-wider">
                  <BadgePercent className="w-3 h-3 inline mr-1" /> Commission (%)
                </label>
                <input
                  type="number"
                  min={0}
                  max={100}
                  step={1}
                  placeholder="e.g. 30"
                  value={formData.commission}
                  onChange={(e) =>
                    setFormData((p) => ({ ...p, commission: e.target.value }))
                  }
                  className={inputClass}
                />
              </div>

              {/* Error / Success */}
              {formError && (
                <motion.p
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  className="text-sm text-red-500 col-span-2"
                >
                  {formError}
                </motion.p>
              )}
              {formSuccess && (
                <motion.p
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  className="text-sm text-green-600 col-span-2"
                >
                  {formSuccess}
                </motion.p>
              )}

              {/* Actions */}
              <div className="col-span-2 flex justify-end gap-3 mt-2">
                <button
                  onClick={() => setShowAddPanel(false)}
                  className="text-sm text-stone-500 hover:text-stone-800 px-4 py-2 rounded-lg border border-stone-200 hover:border-stone-300 transition-all"
                >
                  Cancel
                </button>
                <button
                  onClick={handleAddArtist}
                  disabled={submitting}
                  className="flex items-center gap-2 bg-stone-900 text-white text-sm rounded-xl px-6 py-2.5 hover:bg-stone-800 disabled:opacity-60 transition-colors"
                >
                  {submitting ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <UserPlus className="w-4 h-4" />
                  )}
                  {submitting ? "Adding..." : "Add Artist"}
                </button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── Artists Table ── */}
      <div className="bg-white rounded-2xl border border-stone-200/80 shadow-sm overflow-x-auto">
        <table className="w-full text-sm min-w-[700px]">
          <thead className="bg-stone-50 border-b border-stone-200">
            <tr>
              <th className="text-left px-6 py-3.5 text-xs font-semibold uppercase tracking-wider text-stone-500">
                Name &amp; Email
              </th>
              <th className="text-left px-6 py-3.5 text-xs font-semibold uppercase tracking-wider text-stone-500">
                Phone
              </th>
              <th className="text-left px-6 py-3.5 text-xs font-semibold uppercase tracking-wider text-stone-500">
                Commission
              </th>
              <th className="text-left px-6 py-3.5 text-xs font-semibold uppercase tracking-wider text-stone-500">
                Status
              </th>
              <th className="text-left px-6 py-3.5 text-xs font-semibold uppercase tracking-wider text-stone-500">
                Login
              </th>
              <th className="text-left px-6 py-3.5 text-xs font-semibold uppercase tracking-wider text-stone-500">
                Actions
              </th>
            </tr>
          </thead>
          <tbody>
            {loadingArtists
              ? Array.from({ length: 4 }).map((_, i) => (
                  <tr key={i} className="border-b border-stone-100">
                    {[1, 2, 3, 4, 5, 6].map((j) => (
                      <td key={j} className="px-6 py-4">
                        <div className="h-4 bg-stone-100 rounded animate-pulse" />
                      </td>
                    ))}
                  </tr>
                ))
              : artists.length === 0
                ? (
                    <tr>
                      <td
                        colSpan={6}
                        className="px-6 py-16 text-center text-stone-400 text-sm"
                      >
                        No artists yet. Add your first artist above.
                      </td>
                    </tr>
                  )
                : artists.map((a) => (
                    <tr
                      key={a._id}
                      className="group border-b border-stone-100 hover:bg-stone-50/50 transition-colors"
                    >
                      {/* Name with timestamps */}
                      <td className="px-6 py-4">
                        <div className="flex items-center gap-3">
                          <div className="w-8 h-8 rounded-full bg-amber-100 text-amber-700 text-xs font-bold flex items-center justify-center uppercase shrink-0">
                            {a.name.charAt(0)}
                          </div>
                          <p className="font-medium text-stone-900">{a.name}</p>
                        </div>
                        <p className="text-xs text-stone-500 mt-0.5">{a.email || a.phone}</p>
                        <div className="text-[11px] text-stone-500 mt-1 leading-snug opacity-0 max-h-0 overflow-hidden group-hover:opacity-100 group-hover:max-h-16 transition-all duration-200">
                          <span className="block">
                            Created: {new Date(a.createdAt).toLocaleString("en-IN", {
                              day: "numeric",
                              month: "short",
                              year: "numeric",
                              hour: "2-digit",
                              minute: "2-digit",
                              hour12: true,
                            })}
                          </span>
                          <span className="block">
                            Updated: {new Date(a.updatedAt).toLocaleString("en-IN", {
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

                      {/* Phone */}
                      <td className="px-6 py-4">
                        <span className="inline-flex items-center gap-1.5 text-stone-600">
                          <Phone className="w-3.5 h-3.5 text-stone-400" />
                          {a.phone}
                        </span>
                      </td>

                      {/* Commission */}
                      <td className="px-6 py-4">
                        <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-bold bg-amber-50 text-amber-700 border border-amber-200">
                          {a.commission || 0}%
                        </span>
                      </td>

                      {/* Status badge */}
                      <td className="px-6 py-4">
                        {a.isActive ? (
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

                      {/* Login enabled */}
                      <td className="px-6 py-4">
                        {a.userId ? (
                          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-medium bg-blue-50 text-blue-700 border border-blue-200">
                            ✓ Enabled
                          </span>
                        ) : (
                          <span className="text-xs text-stone-400">—</span>
                        )}
                      </td>

                      {/* Actions */}
                      <td className="px-6 py-4">
                        <div className="flex items-center gap-2">
                          <button
                            onClick={() => navigate(`/dashboard/owner/artist-view/${a._id}`)}
                            className="flex items-center gap-1.5 text-xs text-amber-600 hover:text-amber-800 border border-amber-200 hover:border-amber-300 rounded-lg px-3 py-1.5 transition-all"
                            title="View artist dashboard"
                          >
                            <Eye className="w-3 h-3" /> Dashboard
                          </button>

                          <button
                            onClick={() => setEditingArtist(a)}
                            className="flex items-center gap-1.5 text-xs text-stone-600 hover:text-stone-900 border border-stone-200 hover:border-stone-300 rounded-lg px-3 py-1.5 transition-all"
                          >
                            <Pencil className="w-3 h-3" /> Edit
                          </button>

                          {a.isActive ? (
                            <button
                              onClick={() => handleDeactivate(a._id)}
                              className="flex items-center gap-1.5 text-xs text-red-500 hover:text-red-700 border border-red-100 hover:border-red-200 rounded-lg px-3 py-1.5 transition-all"
                            >
                              <UserX className="w-3 h-3" /> Deactivate
                            </button>
                          ) : (
                            <button
                              onClick={() => handleReactivate(a._id)}
                              className="flex items-center gap-1.5 text-xs text-green-600 hover:text-green-800 border border-green-100 hover:border-green-200 rounded-lg px-3 py-1.5 transition-all"
                            >
                              <UserCheck className="w-3 h-3" /> Reactivate
                            </button>
                          )}

                          <button
                            onClick={() => handlePermanentDelete(a)}
                            className="flex items-center gap-1.5 text-xs text-red-600 hover:text-white hover:bg-red-600 border border-red-200 hover:border-red-600 rounded-lg px-3 py-1.5 transition-all"
                            title="Permanently delete from database"
                          >
                            <Trash2 className="w-3 h-3" /> Delete
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
          </tbody>
        </table>
      </div>

      {/* ── Edit Artist Modal ── */}
      <AnimatePresence>
        {editingArtist && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm overflow-y-auto p-4">
            <motion.div
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              transition={{ duration: 0.2 }}
              className="bg-white rounded-2xl shadow-2xl w-full max-w-md p-7 my-auto"
            >
              {/* Header */}
              <div className="flex items-center justify-between mb-6">
                <h3 className="text-lg font-bold text-stone-900">
                  Edit Artist
                </h3>
                <button
                  onClick={() => setEditingArtist(null)}
                  className="text-stone-400 hover:text-stone-700 transition-colors"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              {/* Fields */}
              <div className="space-y-4">
                <div>
                  <label className="block text-xs font-semibold text-stone-600 mb-1.5 uppercase tracking-wider">
                    Full Name
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
                    Phone Number
                  </label>
                  <input
                    type="tel"
                    inputMode="numeric"
                    maxLength={10}
                    value={editForm.phone}
                    onChange={(e) =>
                      setEditForm((p) => ({
                        ...p,
                        phone: e.target.value.replace(/\D/g, "").slice(0, 10),
                      }))
                    }
                    className={inputClass}
                  />
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs font-semibold text-stone-600 mb-1.5 uppercase tracking-wider">
                      Registration ID
                    </label>
                    <input
                      type="text"
                      placeholder="e.g. REG-001"
                      value={editForm.registrationId}
                      onChange={(e) =>
                        setEditForm((p) => ({ ...p, registrationId: e.target.value }))
                      }
                      className={inputClass}
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-stone-600 mb-1.5 uppercase tracking-wider">
                      Commission (%)
                    </label>
                    <input
                      type="number"
                      min={0}
                      max={100}
                      step={1}
                      value={editForm.commission}
                      onChange={(e) =>
                        setEditForm((p) => ({ ...p, commission: e.target.value }))
                      }
                      className={inputClass}
                    />
                  </div>
                </div>

                {/* Divider for login credentials */}
                <div className="border-t border-stone-100 pt-4">
                  <p className="text-xs font-semibold text-stone-500 uppercase tracking-wider mb-3 flex items-center gap-1.5">
                    <Key className="w-3 h-3" /> Dashboard Login Credentials
                    <span className="font-normal normal-case tracking-normal text-stone-400 ml-1">— optional</span>
                  </p>
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="block text-xs font-semibold text-stone-600 mb-1.5 uppercase tracking-wider">
                        Email
                      </label>
                      <input
                        type="email"
                        placeholder="artist@theexperts.in"
                        value={editForm.email}
                        onChange={(e) =>
                          setEditForm((p) => ({ ...p, email: e.target.value }))
                        }
                        className={inputClass}
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-semibold text-stone-600 mb-1.5 uppercase tracking-wider">
                        New Password
                      </label>
                      <input
                        type="password"
                        placeholder="Leave blank to keep current"
                        value={editForm.password}
                        onChange={(e) =>
                          setEditForm((p) => ({ ...p, password: e.target.value }))
                        }
                        className={inputClass}
                      />
                    </div>
                  </div>
                </div>

                {editFormError && (
                  <p className="text-sm text-red-500">{editFormError}</p>
                )}
              </div>

              {/* Footer */}
              <div className="flex justify-end gap-3 mt-6">
                <button
                  onClick={() => setEditingArtist(null)}
                  className="text-sm text-stone-500 hover:text-stone-800 px-4 py-2 rounded-lg border border-stone-200 hover:border-stone-300 transition-all"
                >
                  Cancel
                </button>
                <button
                  onClick={handleEditSave}
                  className="flex items-center gap-2 bg-stone-900 text-white text-sm rounded-xl px-6 py-2.5 hover:bg-stone-800 transition-colors"
                >
                  Save Changes
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}
