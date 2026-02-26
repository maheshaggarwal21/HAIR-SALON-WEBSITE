/**
 * @file TeamManagement.tsx
 * @description Owner-only team management panel.
 *
 * CRUD for receptionist / manager accounts:
 *   - List all users in a table
 *   - Add new team member (slide-down panel)
 *   - Edit existing member (modal)
 *   - Deactivate / reactivate members (soft delete)
 */

import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { motion, AnimatePresence } from "framer-motion";
import {
  Users,
  UserPlus,
  UserX,
  UserCheck,
  Pencil,
  X,
  Loader2,
  Eye,
  EyeOff,
  Trash2,
} from "lucide-react";
import { useAuth } from "../../context/AuthContext";

const API = import.meta.env.VITE_BACKEND_URL || "";

// ── Types ────────────────────────────────────────────────────────────────────
interface UserRecord {
  _id: string;
  name: string;
  email: string;
  role: "receptionist" | "manager" | "owner";
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

interface UserFormData {
  name: string;
  email: string;
  password: string;
  role: "receptionist" | "manager";
}

// ── Field styling ────────────────────────────────────────────────────────────
const inputClass =
  "w-full h-11 px-4 rounded-xl border border-stone-200 bg-stone-50 text-stone-900 text-sm focus:outline-none focus:ring-2 focus:ring-amber-400/50 focus:border-amber-400 placeholder:text-stone-400 transition-all duration-150";

const selectClass =
  "w-full h-11 px-4 rounded-xl border border-stone-200 bg-stone-50 text-stone-900 text-sm focus:outline-none focus:ring-2 focus:ring-amber-400/50 focus:border-amber-400 transition-all duration-150";

// ── Component ────────────────────────────────────────────────────────────────
export default function TeamManagement() {
  const navigate = useNavigate();
  const { user, logout } = useAuth();
  const [users, setUsers] = useState<UserRecord[]>([]);
  const [loadingUsers, setLoadingUsers] = useState(true);
  const [fetchError, setFetchError] = useState(false);

  // Add panel
  const [showAddPanel, setShowAddPanel] = useState(false);
  const [formData, setFormData] = useState<UserFormData>({
    name: "",
    email: "",
    password: "",
    role: "receptionist",
  });
  const [showPassword, setShowPassword] = useState(false);
  const [formError, setFormError] = useState("");
  const [formSuccess, setFormSuccess] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // Edit modal
  const [editingUser, setEditingUser] = useState<UserRecord | null>(null);
  const [editForm, setEditForm] = useState({
    name: "",
    email: "",
    role: "receptionist" as "receptionist" | "manager" | "owner",
    newPassword: "",
  });
  const [editFormError, setEditFormError] = useState("");
  const [showEditPassword, setShowEditPassword] = useState(false);
  const [newPasswordReveal, setNewPasswordReveal] = useState<
    | null
    | {
        name: string;
        email: string;
        password: string;
      }
  >(null);

  // ── Fetch users ────────────────────────────────────────────────────────────
  const fetchUsers = async () => {
    setLoadingUsers(true);
    try {
      const res = await fetch(`${API}/api/admin/users`, { credentials: "include" });
      const data = await res.json();
      setUsers(Array.isArray(data) ? data : []);
      setFetchError(false);
    } catch {
      setUsers([]);
      setFetchError(true);
    } finally {
      setLoadingUsers(false);
    }
  };

  useEffect(() => {
    fetchUsers();
  }, []);

  useEffect(() => {
    if (editingUser) {
      setEditForm({
        name: editingUser.name,
        email: editingUser.email,
        role: editingUser.role,
        newPassword: "",
      });
      setEditFormError("");
      setShowEditPassword(false);
    }
  }, [editingUser]);

  // ── Add user ───────────────────────────────────────────────────────────────
  const handleAddUser = async () => {
    setFormError("");
    setFormSuccess("");
    if (
      !formData.name.trim() ||
      !formData.email.trim() ||
      !formData.password ||
      !formData.role
    ) {
      setFormError("All fields are required.");
      return;
    }
    if (formData.password.length < 8) {
      setFormError("Password must be at least 8 characters.");
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch(`${API}/api/admin/users`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(formData),
      });
      const data = await res.json();
      if (res.ok) {
        setFormSuccess(`${data.name} has been added successfully.`);
        setFormData({ name: "", email: "", password: "", role: "receptionist" });
        fetchUsers();
        setTimeout(() => {
          setShowAddPanel(false);
          setFormSuccess("");
        }, 2000);
      } else {
        setFormError(data.error || "Failed to create user.");
      }
    } catch {
      setFormError("Network error. Check your connection.");
    } finally {
      setSubmitting(false);
    }
  };

  // ── Deactivate / Reactivate ────────────────────────────────────────────────
  const handleDeactivate = async (id: string) => {
    const res = await fetch(`${API}/api/admin/users/${id}`, {
      method: "DELETE",
      credentials: "include",
    });
    if (res.ok) fetchUsers();
  };

  const handleReactivate = async (id: string) => {
    const res = await fetch(`${API}/api/admin/users/${id}`, {
      method: "PATCH",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ isActive: true }),
    });
    if (res.ok) fetchUsers();
  };

  // ── Permanent Delete ─────────────────────────────────────────────────
  const handlePermanentDelete = async (user: UserRecord) => {
    const confirmed = window.confirm(
      `Are you sure you want to permanently delete "${user.name}"? This action cannot be undone.`
    );
    if (!confirmed) return;

    try {
      const res = await fetch(`${API}/api/admin/users/${user._id}/permanent`, {
        method: "DELETE",
        credentials: "include",
      });
      if (res.ok) fetchUsers();
    } catch {
      // silently fail; user can retry
    }
  };

  // ── Edit save ──────────────────────────────────────────────────────────────
  const handleEditSave = async () => {
    if (!editingUser) return;
    setEditFormError("");
    const trimmedEmail = editForm.email.trim();
    const newPassword = editForm.newPassword.trim();
    const body: Record<string, string> = {
      name: editForm.name,
      email: trimmedEmail,
      role: editForm.role,
    };
    if (newPassword) {
      if (newPassword.length < 8) {
        setEditFormError("New password must be at least 8 characters.");
        return;
      }
      body.password = newPassword;
    }
    try {
      const res = await fetch(`${API}/api/admin/users/${editingUser._id}`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (res.ok) {
        fetchUsers();
        if (newPassword) {
          setNewPasswordReveal({
            name: editingUser.name,
            email: trimmedEmail,
            password: newPassword,
          });
          if (editingUser._id === user?.id) {
            await logout();
            navigate("/signin");
          }
        }
        setEditingUser(null);
        setShowEditPassword(false);
      } else {
        setEditFormError(data.error || "Failed to update user.");
      }
    } catch {
      setEditFormError("Network error. Check your connection.");
    }
  };

  // ── Stats ──────────────────────────────────────────────────────────────────
  const activeCount = users.filter((u) => u.isActive).length;
  const inactiveCount = users.filter((u) => !u.isActive).length;

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
            <Users className="w-6 h-6 text-amber-500" /> Team Management
          </h2>
          <p className="text-sm text-stone-500 mt-0.5">
            Manage staff access and roles
          </p>
        </div>
        <button
          onClick={() => setShowAddPanel((p) => !p)}
          className="flex items-center gap-2 bg-stone-900 text-white text-sm rounded-xl px-5 py-2.5 hover:bg-stone-800 transition-colors"
        >
          <UserPlus className="w-4 h-4" />
          Add New Member
        </button>
      </div>

      {fetchError && (
        <div className="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-600">
          Failed to load team members. Check your connection and refresh.
        </div>
      )}

      {newPasswordReveal && (
        <div className="mb-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-sm font-semibold text-amber-900">
                New password saved for {newPasswordReveal.name}
              </p>
              <p className="text-xs text-amber-700 mt-0.5">
                Shown once. Login email: <span className="font-mono">{newPasswordReveal.email}</span>
              </p>
              <div className="mt-2 flex items-center gap-2">
                <span className="font-mono text-base bg-white border border-amber-200 rounded-lg px-3 py-1">
                  {newPasswordReveal.password}
                </span>
                <button
                  type="button"
                  onClick={() => navigator.clipboard.writeText(newPasswordReveal.password)}
                  className="text-xs px-3 py-1.5 rounded-lg border border-amber-200 bg-white text-amber-800 hover:bg-amber-100 transition-colors"
                >
                  Copy
                </button>
              </div>
            </div>
            <button
              type="button"
              onClick={() => setNewPasswordReveal(null)}
              className="text-amber-700 hover:text-amber-900"
              aria-label="Dismiss new password notification"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>
      )}

      {/* Stats row */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-6">
        {[
          { label: "Total Staff", value: users.length },
          { label: "Active Members", value: activeCount },
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

      {/* ── Add User Panel ── */}
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
                Add New Team Member
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
                  Full Name
                </label>
                <input
                  type="text"
                  placeholder="e.g. Anjali Desai"
                  value={formData.name}
                  onChange={(e) =>
                    setFormData((p) => ({ ...p, name: e.target.value }))
                  }
                  className={inputClass}
                />
              </div>

              {/* Email */}
              <div>
                <label className="block text-xs font-semibold text-stone-600 mb-1.5 uppercase tracking-wider">
                  Email Address
                </label>
                <input
                  type="email"
                  placeholder="e.g. anjali@theexperts.in"
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
                  Temporary Password
                </label>
                <div className="relative">
                  <input
                    type={showPassword ? "text" : "password"}
                    placeholder="Min 8 characters"
                    value={formData.password}
                    onChange={(e) =>
                      setFormData((p) => ({ ...p, password: e.target.value }))
                    }
                    className={inputClass}
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((s) => !s)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-stone-400 hover:text-stone-700 transition-colors"
                  >
                    {showPassword ? (
                      <EyeOff className="w-4 h-4" />
                    ) : (
                      <Eye className="w-4 h-4" />
                    )}
                  </button>
                </div>
              </div>

              {/* Role */}
              <div>
                <label className="block text-xs font-semibold text-stone-600 mb-1.5 uppercase tracking-wider">
                  Role
                </label>
                <select
                  value={formData.role}
                  onChange={(e) =>
                    setFormData((p) => ({
                      ...p,
                      role: e.target.value as "receptionist" | "manager",
                    }))
                  }
                  className={selectClass}
                >
                  <option value="receptionist">Receptionist</option>
                  <option value="manager">Manager</option>
                </select>
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
                  onClick={handleAddUser}
                  disabled={submitting}
                  className="flex items-center gap-2 bg-stone-900 text-white text-sm rounded-xl px-6 py-2.5 hover:bg-stone-800 disabled:opacity-60 transition-colors"
                >
                  {submitting ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <UserPlus className="w-4 h-4" />
                  )}
                  {submitting ? "Creating..." : "Create Account"}
                </button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── Users Table ── */}
      <div className="bg-white rounded-2xl border border-stone-200/80 shadow-sm overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-stone-50 border-b border-stone-200">
            <tr>
              <th className="text-left px-6 py-3.5 text-xs font-semibold uppercase tracking-wider text-stone-500">
                Name &amp; Email
              </th>
              <th className="text-left px-6 py-3.5 text-xs font-semibold uppercase tracking-wider text-stone-500">
                Role
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
            {loadingUsers
              ? Array.from({ length: 4 }).map((_, i) => (
                  <tr key={i} className="border-b border-stone-100">
                    {[1, 2, 3, 4].map((j) => (
                      <td key={j} className="px-6 py-4">
                        <div className="h-4 bg-stone-100 rounded animate-pulse" />
                      </td>
                    ))}
                  </tr>
                ))
              : users.length === 0
                ? (
                    <tr>
                      <td
                        colSpan={4}
                        className="px-6 py-16 text-center text-stone-400 text-sm"
                      >
                        No team members yet. Add your first member above.
                      </td>
                    </tr>
                  )
                : users.map((u) => (
                    <tr
                      key={u._id}
                      className="group border-b border-stone-100 hover:bg-stone-50/50 transition-colors"
                    >
                      {/* Name & Email with timestamps */}
                      <td className="px-6 py-4">
                        <p className="font-medium text-stone-900">{u.name}</p>
                        <p className="text-xs text-stone-500 mt-0.5">
                          {u.email}
                        </p>
                        <div className="text-[11px] text-stone-500 mt-1 leading-snug opacity-0 max-h-0 overflow-hidden group-hover:opacity-100 group-hover:max-h-16 transition-all duration-200">
                          <span className="block">
                            Created: {new Date(u.createdAt).toLocaleString("en-IN", {
                              day: "numeric",
                              month: "short",
                              year: "numeric",
                              hour: "2-digit",
                              minute: "2-digit",
                              hour12: true,
                            })}
                          </span>
                          <span className="block">
                            Updated: {new Date(u.updatedAt).toLocaleString("en-IN", {
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

                      {/* Role badge */}
                      <td className="px-6 py-4">
                        {u.role === "manager" ? (
                          <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-amber-50 text-amber-700 border border-amber-200 capitalize">
                            {u.role}
                          </span>
                        ) : (
                          <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-blue-50 text-blue-700 border border-blue-200 capitalize">
                            {u.role}
                          </span>
                        )}
                      </td>

                      {/* Status badge */}
                      <td className="px-6 py-4">
                        {u.isActive ? (
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
                          <button
                            onClick={() => setEditingUser(u)}
                            className="flex items-center gap-1.5 text-xs text-stone-600 hover:text-stone-900 border border-stone-200 hover:border-stone-300 rounded-lg px-3 py-1.5 transition-all"
                          >
                            <Pencil className="w-3 h-3" /> Edit
                          </button>

                          {u.isActive ? (
                            <button
                              onClick={() => handleDeactivate(u._id)}
                              className="flex items-center gap-1.5 text-xs text-red-500 hover:text-red-700 border border-red-100 hover:border-red-200 rounded-lg px-3 py-1.5 transition-all"
                            >
                              <UserX className="w-3 h-3" /> Deactivate
                            </button>
                          ) : (
                            <button
                              onClick={() => handleReactivate(u._id)}
                              className="flex items-center gap-1.5 text-xs text-green-600 hover:text-green-800 border border-green-100 hover:border-green-200 rounded-lg px-3 py-1.5 transition-all"
                            >
                              <UserCheck className="w-3 h-3" /> Reactivate
                            </button>
                          )}

                          {u.role !== "owner" && (
                            <button
                              onClick={() => handlePermanentDelete(u)}
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

      {/* ── Edit User Modal ── */}
      <AnimatePresence>
        {editingUser && (
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
                  Edit Team Member
                </h3>
                <button
                  onClick={() => setEditingUser(null)}
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
                    Email
                  </label>
                  <input
                    type="email"
                    value={editForm.email}
                    onChange={(e) =>
                      setEditForm((p) => ({ ...p, email: e.target.value }))
                    }
                    className={inputClass}
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-stone-600 mb-1.5 uppercase tracking-wider">
                    Role
                  </label>
                  <select
                    value={editForm.role}
                    onChange={(e) =>
                      setEditForm((p) => ({
                        ...p,
                        role: e.target.value as "receptionist" | "manager",
                      }))
                    }
                    className={selectClass}
                  >
                    <option value="receptionist">Receptionist</option>
                    <option value="manager">Manager</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-semibold text-stone-600 mb-1.5 uppercase tracking-wider">
                    New Password (optional)
                  </label>
                  <div className="relative">
                    <input
                      type={showEditPassword ? "text" : "password"}
                      placeholder="Leave blank to keep current password"
                      value={editForm.newPassword}
                      onChange={(e) =>
                        setEditForm((p) => ({
                          ...p,
                          newPassword: e.target.value,
                        }))
                      }
                      className={`${inputClass} pr-11`}
                    />
                    <button
                      type="button"
                      onClick={() => setShowEditPassword((p) => !p)}
                      className="absolute inset-y-0 right-3 flex items-center text-stone-400 hover:text-stone-700"
                      aria-label={showEditPassword ? "Hide password" : "Show password"}
                    >
                      {showEditPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                  </div>
                  <p className="text-xs text-stone-400 mt-1">
                    Password will be shown once after saving.
                  </p>
                </div>

                {editFormError && (
                  <p className="text-sm text-red-500">{editFormError}</p>
                )}
              </div>

              {/* Footer */}
              <div className="flex justify-end gap-3 mt-6">
                <button
                  onClick={() => setEditingUser(null)}
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
