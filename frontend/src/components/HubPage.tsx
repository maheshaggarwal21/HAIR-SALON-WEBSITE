/**
 * @file HubPage.tsx
 * @description One sidebar entry that opens a set of related screens — the same
 * idea as Management, so the sidebar stays short.
 *
 * The cards show only the screens this person may use; picking one opens it in
 * place (`?tab=` keeps the choice across a refresh and makes it linkable) and a
 * breadcrumb returns to the cards. The screens themselves are unchanged and
 * keep their own routes, so old bookmarks still work.
 */

import type { ComponentType, LazyExoticComponent } from "react";
import { useSearchParams } from "react-router-dom";
import { motion } from "framer-motion";
import { ArrowRight, ChevronLeft, type LucideIcon } from "lucide-react";
import { useAuth } from "@/context/AuthContext";
import AccessDenied from "@/components/AccessDenied";
import PageBoundary from "@/components/PageBoundary";

export interface HubTab {
  id: string;
  label: string;
  blurb: string;
  icon: LucideIcon;
  /** Any-of. Omitted = everyone who can reach the hub. */
  permission?: string | string[];
  Component: LazyExoticComponent<ComponentType> | ComponentType;
}

interface Props {
  title: string;
  icon: LucideIcon;
  intro: string;
  tabs: HubTab[];
}

export default function HubPage({ title, icon: Icon, intro, tabs }: Props) {
  const { user } = useAuth();
  const [params, setParams] = useSearchParams();

  const allowed = (t: HubTab) => {
    if (!t.permission || user?.role === "owner") return true;
    const perms = user?.permissions ?? [];
    return (Array.isArray(t.permission) ? t.permission : [t.permission]).some((p) => perms.includes(p));
  };
  const visible = tabs.filter(allowed);
  const active = visible.find((t) => t.id === params.get("tab"));

  if (!visible.length) return <AccessDenied permission={title} />;

  if (active) {
    const { Component } = active;
    return (
      <div>
        <button
          onClick={() => setParams({})}
          className="mb-5 inline-flex items-center gap-1 text-sm font-medium text-stone-500 hover:text-stone-900"
        >
          <ChevronLeft className="h-4 w-4" /> {title}
          <span className="text-stone-300">/</span>
          <span className="text-stone-900">{active.label}</span>
        </button>
        <PageBoundary>
          <Component />
        </PageBoundary>
      </div>
    );
  }

  return (
    <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3 }} className="max-w-5xl">
      <h2 className="flex items-center gap-2 text-2xl font-bold text-stone-900">
        <Icon className="h-6 w-6" /> {title}
      </h2>
      <p className="mt-1 text-sm text-stone-500">{intro}</p>
      <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {visible.map((t) => (
          <button
            key={t.id}
            onClick={() => setParams({ tab: t.id })}
            className="group rounded-2xl border border-stone-200 bg-white p-5 text-left shadow-sm transition hover:border-amber-300 hover:shadow-md"
          >
            <div className="flex items-start justify-between">
              <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-amber-50 text-amber-600">
                <t.icon className="h-5 w-5" />
              </span>
              <ArrowRight className="h-4 w-4 text-stone-300 transition group-hover:translate-x-0.5 group-hover:text-amber-600" />
            </div>
            <p className="mt-4 font-semibold text-stone-900">{t.label}</p>
            <p className="mt-1 text-sm leading-relaxed text-stone-500">{t.blurb}</p>
          </button>
        ))}
      </div>
    </motion.div>
  );
}
