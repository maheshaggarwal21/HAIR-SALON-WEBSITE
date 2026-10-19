/**
 * @file PageBoundary.tsx
 * @description Loading + error wrapper for every dashboard page.
 *
 * Two real failures used to leave the staff app blank (19 Oct 2026):
 *   - a page threw while rendering (a reply of the wrong shape) and, with
 *     nothing to catch it, React unmounted the whole app;
 *   - a deploy renamed a page's file while the tab was still open, so the
 *     lazy download failed.
 * Now the sidebar stays and the page area says what happened, with a way out.
 * (A missing file is also reloaded once automatically — see main.tsx.)
 */

import { Component, Suspense, type ErrorInfo, type ReactNode } from "react";

interface State {
  error: Error | null;
}

class Boundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[page] crashed:", error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="max-w-xl mx-auto mt-16 rounded-2xl border border-stone-200 bg-white p-8 text-center shadow-sm">
        <h2 className="text-lg font-semibold text-stone-900">This page hit a problem</h2>
        <p className="mt-2 text-sm text-stone-500">
          Nothing was lost. Reloading usually fixes it — the app may have just been updated.
        </p>
        <p className="mt-3 break-words rounded-lg bg-stone-50 px-3 py-2 text-left text-xs text-stone-500">
          {this.state.error.message}
        </p>
        <button
          onClick={() => window.location.reload()}
          className="mt-5 rounded-xl bg-stone-900 px-5 py-2.5 text-sm font-medium text-white hover:bg-stone-800"
        >
          Reload
        </button>
      </div>
    );
  }
}

export default function PageBoundary({ children }: { children: ReactNode }) {
  return (
    <Boundary>
      <Suspense fallback={<div className="py-16 text-center text-sm text-stone-400">Loading…</div>}>{children}</Suspense>
    </Boundary>
  );
}
