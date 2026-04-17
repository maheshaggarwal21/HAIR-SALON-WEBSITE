/**
 * @file ServicesView.tsx
 * @description Read-only display of service categories and the service catalogue.
 *
 * Fetches active services from GET /api/services and categories from
 * GET /api/services/categories. Used by the Manager dashboard (read-only).
 * The Owner dashboard uses ServiceManagement.tsx with full CRUD instead.
 */

import { useEffect, useState } from "react";
import { motion } from "framer-motion";

const API = import.meta.env.VITE_BACKEND_URL || "";

interface Service {
  _id: string;
  name: string;
  price: number;
  category: string;
}

interface ViewData {
  categories: string[];
  services: Service[];
}

export default function ServicesView() {
  const [data, setData] = useState<ViewData | null>(null);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState(false);

  useEffect(() => {
    setFetchError(false);
    Promise.all([
      fetch(`${API}/api/services`, { credentials: "include" }).then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      }),
      fetch(`${API}/api/services/categories`, { credentials: "include" }).then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      }),
    ])
      .then(([services, categories]) =>
        setData({ services, categories })
      )
      .catch(() => { setData(null); setFetchError(true); })
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="animate-pulse bg-stone-100 rounded-2xl h-24" />
        <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="animate-pulse bg-stone-100 rounded-xl h-24" />
          ))}
        </div>
      </div>
    );
  }

  if (!data) {
    return (
      <p className="text-stone-400 text-center py-16">
        {fetchError
          ? "Failed to load services. Please check your connection and try again."
          : "No services found."}
      </p>
    );
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4 }}
    >
      {/* Page header */}
      <div className="mb-8">
        <h2 className="text-2xl font-bold text-stone-900">Services</h2>
        <p className="text-sm text-stone-500 mt-0.5">
          Services offered at The Experts
        </p>
      </div>

      {/* Section 1 — Categories */}
      <div className="mb-8">
        <h3 className="text-lg font-bold text-stone-800 mb-4">Categories</h3>
        {data.categories.length === 0 ? (
          <p className="text-stone-400 text-sm py-4">No categories yet. Categories will appear once services are added.</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {data.categories.map((cat) => (
              <span
                key={cat}
                className="px-4 py-2 rounded-full bg-amber-50 text-amber-800 border border-amber-200 text-sm font-medium"
              >
                {cat}
              </span>
            ))}
          </div>
        )}
      </div>

      {/* Section 2 — Catalogue */}
      <div className="mt-8">
        <h3 className="text-lg font-bold text-stone-800 mb-4">All Services</h3>
        {data.services.length === 0 ? (
          <div className="bg-white rounded-xl border border-stone-200/80 p-12 shadow-sm text-center">
            <p className="text-stone-400 text-sm">No services added yet.</p>
            <p className="text-stone-400 text-xs mt-1">Ask the owner to add services from the Owner Dashboard.</p>
          </div>
        ) : (
          <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
            {data.services.map((service) => (
              <div
                key={service._id}
                className="bg-white rounded-xl border border-stone-200/80 p-5 shadow-sm"
              >
                <p className="font-semibold text-stone-900 text-sm">
                  {service.name}
                </p>
                {service.category && (
                  <p className="text-xs text-stone-400 mt-0.5">{service.category}</p>
                )}
                <p className="text-amber-600 font-bold text-lg mt-1">
                  ₹{service.price.toLocaleString("en-IN")}
                </p>
              </div>
            ))}
          </div>
        )}
      </div>
    </motion.div>
  );
}
