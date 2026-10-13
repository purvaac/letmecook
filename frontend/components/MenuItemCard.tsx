"use client";

import { MAX_PER_ITEM, useCartStore } from "@/lib/store";
import type { MenuItem } from "@/lib/types";

const rupees = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR" });

export default function MenuItemCard({ item }: { item: MenuItem }) {
  const inCart = useCartStore((s) => s.lines.find((l) => l.menuItemId === item.id)?.quantity ?? 0);
  const add = useCartStore((s) => s.add);

  const soldOut = item.stock <= 0;
  const canAdd = !soldOut && inCart < Math.min(item.stock, MAX_PER_ITEM);

  return (
    <article className="flex flex-col gap-3 rounded-lg border border-line bg-card p-4">
      <div className="flex items-start justify-between gap-3">
        <h3 className="text-lg font-bold leading-snug">{item.name}</h3>
        {soldOut ? (
          <span className="shrink-0 rounded-full bg-danger/10 px-2 py-0.5 text-xs font-semibold text-danger">Sold out</span>
        ) : (
          <span className="shrink-0 text-sm text-muted">{item.stock} left</span>
        )}
      </div>

      <div className="mt-auto flex items-center justify-between gap-3">
        <span className="font-semibold">{rupees.format(item.priceCents / 100)}</span>
        <div className="flex items-center gap-3">
          {inCart > 0 && <span className="text-sm text-brand-dark">{inCart} in cart</span>}
          <button
            type="button"
            onClick={() => add(item.id)}
            disabled={!canAdd}
            className="min-h-10 rounded-md bg-brand px-4 text-sm font-semibold text-ink hover:brightness-95 disabled:cursor-not-allowed disabled:bg-line disabled:text-muted disabled:hover:brightness-100"
          >
            {soldOut ? "Sold out" : "Add"}
          </button>
        </div>
      </div>
    </article>
  );
}
