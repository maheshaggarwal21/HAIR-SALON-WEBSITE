/**
 * @file Management.tsx
 * @description The Management tab — a canvas flow that branches into the four
 * things the owner actually administers.
 *
 * The canvas exists because the mental model is genuinely a tree, and a flat
 * list of tabs hid it: role defaults FEED new accounts, individual permissions
 * OVERRIDE those defaults, the approval gate layers on top, and break-glass sits
 * beside all of it. Drawing the edges makes the precedence legible at a glance,
 * which is the thing owners kept getting wrong.
 *
 * Selecting a node swaps the canvas for that panel; the breadcrumb returns.
 */

import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Users2,
  UsersRound,
  ShieldCheck,
  LifeBuoy,
  ChevronLeft,
  ArrowRight,
  Network,
} from "lucide-react";
import { useAuth } from "@/context/AuthContext";
import { usePermission } from "@/hooks/usePermission";
import AccessDenied from "@/components/AccessDenied";
import RoleDefaultsPanel from "./management/RoleDefaultsPanel";
import PeoplePanel from "./management/PeoplePanel";
import ApprovalPanel from "./management/ApprovalPanel";
import BreakGlassPanel from "./management/BreakGlassPanel";

type NodeId = "team" | "people" | "approval" | "breakglass";

interface FlowNode {
  id: NodeId;
  label: string;
  sub: string;
  blurb: string;
  icon: React.ElementType;
  accent: string;
  ownerOnly?: boolean;
}

const NODES: FlowNode[] = [
  {
    id: "team",
    label: "Team",
    sub: "Role defaults",
    blurb:
      "Set what a Receptionist, Manager or Artist can do the moment their account is created.",
    icon: Users2,
    accent: "from-blue-500/10 to-blue-500/0 border-blue-200 text-blue-600",
  },
  {
    id: "people",
    label: "People",
    sub: "Individual access",
    blurb:
      "Every artist and staff member in one roster. Override permissions, reset passwords, revoke devices.",
    icon: UsersRound,
    accent: "from-amber-500/10 to-amber-500/0 border-amber-200 text-amber-600",
  },
  {
    id: "approval",
    label: "OTP",
    sub: "Login approval",
    blurb:
      "Decide which roles and people need your approval to sign in, and how you receive the request.",
    icon: ShieldCheck,
    accent: "from-emerald-500/10 to-emerald-500/0 border-emerald-200 text-emerald-600",
  },
  {
    id: "breakglass",
    label: "Break glass",
    sub: "Emergency access",
    blurb:
      "The bypass code for when your phone is dead and the salon still has to open. Plus the security log.",
    icon: LifeBuoy,
    accent: "from-rose-500/10 to-rose-500/0 border-rose-200 text-rose-600",
    ownerOnly: true,
  },
];

export default function Management() {
  const { user } = useAuth();
  const canView = usePermission("team.view");
  const canManage = usePermission("team.manage");
  const isOwner = user?.role === "owner";

  const [active, setActive] = useState<NodeId | null>(null);

  if (!canView) {
    return <AccessDenied permission="team.view" backTo="/dashboard/owner" />;
  }

  const visibleNodes = NODES.filter((n) => !n.ownerOnly || isOwner);
  const activeNode = visibleNodes.find((n) => n.id === active) ?? null;

  return (
    <div>
      {/* Breadcrumb */}
      <div className="flex items-center gap-2 mb-6 text-sm">
        <button
          onClick={() => setActive(null)}
          disabled={!activeNode}
          className={`flex items-center gap-1.5 transition-colors ${
            activeNode
              ? "text-stone-500 hover:text-stone-900"
              : "text-stone-900 font-semibold cursor-default"
          }`}
        >
          {activeNode && <ChevronLeft className="w-4 h-4" />}
          <Network className="w-4 h-4" />
          Management
        </button>
        {activeNode && (
          <>
            <span className="text-stone-300">/</span>
            <span className="font-semibold text-stone-900">{activeNode.label}</span>
            <span className="text-stone-400 text-xs hidden sm:inline">· {activeNode.sub}</span>
          </>
        )}
      </div>

      <AnimatePresence mode="wait">
        {!activeNode ? (
          <motion.div
            key="canvas"
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.25 }}
          >
            <FlowCanvas nodes={visibleNodes} onSelect={setActive} ownerName={user?.name ?? "Owner"} />
          </motion.div>
        ) : (
          <motion.div
            key={activeNode.id}
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.25 }}
          >
            {activeNode.id === "team" && <RoleDefaultsPanel canManage={canManage} />}
            {activeNode.id === "people" && <PeoplePanel canManage={canManage} />}
            {activeNode.id === "approval" && <ApprovalPanel canManage={canManage} />}
            {activeNode.id === "breakglass" && <BreakGlassPanel isOwner={isOwner} />}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ─── The canvas ──────────────────────────────────────────────────────────────

/**
 * Hub-and-spoke layout. On large screens the connectors are drawn as SVG curves
 * behind the cards; below `lg` the SVG is hidden and the nodes stack, because a
 * flow diagram squeezed into a phone width is just a worse list.
 */
function FlowCanvas({
  nodes,
  onSelect,
  ownerName,
}: {
  nodes: FlowNode[];
  onSelect: (id: NodeId) => void;
  ownerName: string;
}) {
  return (
    <div className="relative">
      {/* Root node */}
      <div className="flex justify-center mb-2">
        <div className="relative z-10 inline-flex items-center gap-3 rounded-2xl bg-stone-900 text-white px-6 py-4 shadow-lg">
          <div className="w-9 h-9 rounded-xl bg-amber-500 flex items-center justify-center">
            <Network className="w-4.5 h-4.5 text-stone-950" />
          </div>
          <div>
            <p className="font-bold text-sm leading-tight">Salon access</p>
            <p className="text-[0.7rem] text-white/50 mt-0.5">Managed by {ownerName}</p>
          </div>
        </div>
      </div>

      {/* Connectors — decorative, so hidden from assistive tech */}
      <div className="hidden lg:block relative h-14" aria-hidden="true">
        <svg className="absolute inset-0 w-full h-full" preserveAspectRatio="none">
          {nodes.map((_, i) => {
            const span = 100 / nodes.length;
            const x = span * i + span / 2;
            return (
              <path
                key={i}
                d={`M 50% 0 C 50% 60%, ${x}% 40%, ${x}% 100%`}
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeDasharray="4 4"
                className="text-stone-300"
              />
            );
          })}
        </svg>
      </div>

      {/* Branch nodes */}
      <div
        className="grid gap-4 lg:gap-5 mt-4 lg:mt-0"
        style={{ gridTemplateColumns: `repeat(auto-fit, minmax(15rem, 1fr))` }}
      >
        {nodes.map((node, i) => {
          const Icon = node.icon;
          return (
            <motion.button
              key={node.id}
              initial={{ opacity: 0, y: 14 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.3, delay: i * 0.06 }}
              whileHover={{ y: -3 }}
              onClick={() => onSelect(node.id)}
              className={`group relative text-left rounded-2xl border bg-linear-to-b ${node.accent} bg-white p-5 shadow-sm hover:shadow-md transition-shadow`}
            >
              <div className="flex items-center justify-between mb-3">
                <div className="w-10 h-10 rounded-xl bg-white border border-current/15 flex items-center justify-center shadow-sm">
                  <Icon className="w-5 h-5" />
                </div>
                <ArrowRight className="w-4 h-4 text-stone-300 group-hover:text-stone-600 group-hover:translate-x-0.5 transition-all" />
              </div>

              <p className="font-bold text-stone-900 text-base leading-tight">{node.label}</p>
              <p className="text-[0.7rem] font-semibold uppercase tracking-wider text-stone-400 mt-0.5">
                {node.sub}
              </p>
              <p className="text-xs text-stone-500 mt-2.5 leading-relaxed">{node.blurb}</p>
            </motion.button>
          );
        })}
      </div>

      {/* Precedence key — the thing the canvas is really there to teach */}
      <div className="mt-8 rounded-2xl border border-stone-200 bg-stone-50/60 px-6 py-5">
        <p className="text-xs font-semibold uppercase tracking-wider text-stone-500 mb-3">
          How access is decided
        </p>
        <ol className="flex flex-wrap items-center gap-x-2 gap-y-2 text-xs text-stone-600">
          {[
            "Role default seeds the account",
            "Individual edits override it",
            "Approval gate layers on sign-in",
            "Bypass code overrides everything",
          ].map((step, i, arr) => (
            <li key={step} className="flex items-center gap-2">
              <span className="rounded-lg bg-white border border-stone-200 px-3 py-1.5">{step}</span>
              {i < arr.length - 1 && <ArrowRight className="w-3.5 h-3.5 text-stone-300" />}
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}
