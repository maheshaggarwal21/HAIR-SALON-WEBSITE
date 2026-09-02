/**
 * @file AccessDenied.tsx
 * @description In-place 403 panel for a page the signed-in user may not view.
 *
 * Used instead of a redirect when the user reached a dashboard sub-route they
 * lack the permission for. Previously these pages mounted anyway, fired their
 * API calls, got 403s back, and rendered as empty tables — indistinguishable
 * from a bug. This says plainly what happened and who to ask.
 */

import { ShieldX } from "lucide-react";
import { Link } from "react-router-dom";

interface Props {
  /** The permission key that was missing, shown as a hint for the owner. */
  permission?: string;
  /** Where "Go back" points. Defaults to the signed-in user's dashboard root. */
  backTo?: string;
}

export default function AccessDenied({ permission, backTo }: Props) {
  return (
    <div className="flex flex-col items-center justify-center py-24 px-6 text-center">
      <div className="w-14 h-14 rounded-2xl bg-stone-100 border border-stone-200 flex items-center justify-center mb-5">
        <ShieldX className="w-6 h-6 text-stone-400" />
      </div>

      <h2 className="text-xl font-bold text-stone-900">You don't have access to this</h2>

      <p className="mt-2 max-w-sm text-sm text-stone-500 leading-relaxed">
        Your account doesn't include this feature. Ask the salon owner to grant it from
        Management → People.
      </p>

      {permission && (
        <code className="mt-4 rounded-lg bg-stone-100 border border-stone-200 px-3 py-1.5 text-xs text-stone-500">
          {permission}
        </code>
      )}

      {backTo && (
        <Link
          to={backTo}
          className="mt-7 rounded-xl bg-stone-900 hover:bg-stone-800 text-white text-sm font-medium px-6 py-2.5 transition-colors"
        >
          Go back
        </Link>
      )}
    </div>
  );
}
