"use client";

import { useState } from "react";
import type { Order, OrderStatus } from "@/lib/types";

// An active order older than this is flagged Slow (amber), then Late (red).
export const WARN_MINUTES = 5;
export const LATE_MINUTES = 10;

const nextStep: Partial<Record<OrderStatus, { status: OrderStatus; label: string }>> = {
  NEW: { status: "COOKING", label: "Start cooking" },
  COOKING: { status: "READY", label: "Mark ready" },
  READY: { status: "PICKED_UP", label: "Picked up" },
};

function formatAge(ms: number) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const mm = String(Math.floor(total / 60)).padStart(2, "0");
  const ss = String(total % 60).padStart(2, "0");
  return `${mm}:${ss}`;
}

type Props = {
  order: Order;
  now: number;
  onAdvance: (order: Order, next: OrderStatus) => Promise<void>;
};

export default function OrderCard({ order, now, onAdvance }: Props) {
  const [busy, setBusy] = useState(false);

  const pickedUp = order.status === "PICKED_UP";
  const created = new Date(order.createdAt).getTime();
  // Picked-up orders show how long they took in total; the clock stops there.
  const ageMs = pickedUp && order.pickedUpAt ? new Date(order.pickedUpAt).getTime() - created : now - created;
  const minutes = ageMs / 60000;
  const flag = pickedUp ? null : minutes >= LATE_MINUTES ? "Late" : minutes >= WARN_MINUTES ? "Slow" : null;
  const step = nextStep[order.status];

  async function advance() {
    if (!step || busy) return;
    setBusy(true);
    try {
      await onAdvance(order, step.status);
    } finally {
      setBusy(false);
    }
  }

  return (
    <article
      className={`flex flex-col gap-3 rounded-lg border-2 bg-card p-3 ${
        flag === "Late" ? "border-danger" : flag === "Slow" ? "border-warn" : "border-line"
      } ${pickedUp ? "opacity-60" : ""}`}
    >
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-lg font-bold">#{order.id}</h3>
        <div className="flex items-center gap-2">
          {flag && (
            <span
              className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
                flag === "Late" ? "bg-danger/10 text-danger" : "bg-warn/10 text-warn"
              }`}
            >
              {flag}
            </span>
          )}
          <span
            className={`font-semibold tabular-nums ${
              flag === "Late" ? "text-danger" : flag === "Slow" ? "text-warn" : "text-muted"
            }`}
            title={pickedUp ? "Total time from order to pickup" : "Waiting since the order was placed"}
          >
            {formatAge(ageMs)}
          </span>
        </div>
      </div>

      <ul className="text-sm">
        {order.items.map((it) => (
          <li key={it.menuItemId}>
            <span className="font-semibold tabular-nums">{it.quantity} x</span> {it.name}
          </li>
        ))}
      </ul>

      {step && (
        <button
          type="button"
          onClick={advance}
          disabled={busy}
          className="min-h-10 w-full rounded-md bg-brand text-sm font-semibold text-ink hover:brightness-95 disabled:cursor-not-allowed disabled:bg-line disabled:text-muted disabled:hover:brightness-100"
        >
          {busy ? "Saving..." : step.label}
        </button>
      )}
    </article>
  );
}
