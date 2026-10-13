"use client";

import { MAX_PER_ITEM, useCartStore, useMenuStore } from "@/lib/store";

const rupees = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR" });

const stepButton =
  "flex size-10 items-center justify-center rounded-md text-lg font-semibold text-brand-dark hover:bg-brand/20 disabled:cursor-not-allowed disabled:text-muted disabled:hover:bg-transparent";

export default function Cart({ submitting, onPlaceOrder }: { submitting: boolean; onPlaceOrder: () => void }) {
  const lines = useCartStore((s) => s.lines);
  const increment = useCartStore((s) => s.increment);
  const decrement = useCartStore((s) => s.decrement);
  const remove = useCartStore((s) => s.remove);
  const items = useMenuStore((s) => s.items);

  const total = lines.reduce((sum, l) => sum + (items[l.menuItemId]?.priceCents ?? 0) * l.quantity, 0);

  return (
    <section className="rounded-lg border border-line bg-card p-4">
      <h2 className="mb-3 text-lg font-bold">Your cart</h2>

      {lines.length === 0 ? (
        <p className="text-sm text-muted">Your cart is empty. Add something from the menu.</p>
      ) : (
        <ul className="flex flex-col divide-y divide-line">
          {lines.map((l) => {
            const item = items[l.menuItemId];
            const max = Math.min(item?.stock ?? 0, MAX_PER_ITEM);
            return (
              <li key={l.menuItemId} className="flex flex-col gap-2 py-3 first:pt-0">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="font-medium">{item?.name ?? `Item ${l.menuItemId}`}</span>
                  <span className="text-sm">{rupees.format(((item?.priceCents ?? 0) * l.quantity) / 100)}</span>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center rounded-md bg-brand/10">
                    <button
                      type="button"
                      aria-label={`One less ${item?.name ?? ""}`}
                      onClick={() => decrement(l.menuItemId)}
                      className={stepButton}
                    >
                      -
                    </button>
                    <span className="w-8 text-center font-semibold text-brand-dark tabular-nums">{l.quantity}</span>
                    <button
                      type="button"
                      aria-label={`One more ${item?.name ?? ""}`}
                      onClick={() => increment(l.menuItemId)}
                      disabled={l.quantity >= max}
                      className={stepButton}
                    >
                      +
                    </button>
                  </div>
                  <button
                    type="button"
                    onClick={() => remove(l.menuItemId)}
                    className="min-h-10 px-2 text-sm text-muted hover:text-danger"
                  >
                    Remove
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <div className="mt-3 flex items-center justify-between border-t border-line pt-3">
        <span className="font-semibold">Total</span>
        <span className="font-semibold tabular-nums">{rupees.format(total / 100)}</span>
      </div>

      <button
        type="button"
        onClick={onPlaceOrder}
        disabled={lines.length === 0 || submitting}
        className="btn-primary mt-4 min-h-11 w-full"
      >
        {submitting ? "Placing order..." : "Place order"}
      </button>
    </section>
  );
}
