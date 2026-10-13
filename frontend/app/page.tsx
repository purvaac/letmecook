"use client";

import { useEffect, useRef, useState } from "react";
import Cart from "@/components/Cart";
import MenuItemCard from "@/components/MenuItemCard";
import { API_URL, getMenu, placeOrder } from "@/lib/api";
import { onMessage, onOpen, subscribe, unsubscribe } from "@/lib/socket";
import { useCartStore, useMenuStore, type CappedLine } from "@/lib/store";
import type { StockChange } from "@/lib/types";

const ORDERS_KEY = "letmecook:orders";

type Notice = { id: number; tone: "info" | "success" | "error"; text: string };

const noticeStyles: Record<Notice["tone"], string> = {
  info: "border-warn/40 bg-warn/10",
  success: "border-brand/40 bg-brand/10",
  error: "border-danger/40 bg-danger/10",
};

let nextNoticeId = 1;

function rememberOrder(id: number) {
  try {
    const ids: number[] = JSON.parse(sessionStorage.getItem(ORDERS_KEY) ?? "[]");
    sessionStorage.setItem(ORDERS_KEY, JSON.stringify([...ids, id]));
  } catch {
    // Private mode or storage full: the order is placed, we just cannot list it later.
  }
}

export default function CustomerPage() {
  const items = useMenuStore((s) => s.items);
  const [loadState, setLoadState] = useState<"loading" | "ready" | "error">("loading");
  const [loadError, setLoadError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  // While an order is in flight its own stock:updated message can arrive
  // before the HTTP response. The cart must not be trimmed then, or the
  // winner would be told their item was removed.
  const submittingRef = useRef(false);
  const [notices, setNotices] = useState<Notice[]>([]);

  function notify(tone: Notice["tone"], text: string) {
    setNotices((list) => [{ id: nextNoticeId++, tone, text }, ...list].slice(0, 5));
  }

  // Tells the customer about cart lines that were lowered because stock dropped.
  function reportCapped(capped: CappedLine[]) {
    const menu = useMenuStore.getState().items;
    for (const c of capped) {
      const name = menu[c.menuItemId]?.name ?? "An item";
      notify(
        "info",
        c.to === 0
          ? `${name} just sold out and was removed from your cart.`
          : `Only ${c.to} ${name} left now, your cart was updated.`,
      );
    }
  }

  useEffect(() => {
    // Runs on mount and after every reconnect. The socket holds live
    // messages until this resolves, so they are applied on top of it.
    async function load() {
      const res = await getMenu();
      if (!res.ok) {
        setLoadError(res.error.message);
        setLoadState((s) => (s === "ready" ? s : "error"));
        return;
      }
      useMenuStore.getState().setAll(res.data);
      setLoadState("ready");
      reportCapped(useCartStore.getState().capToStock(useMenuStore.getState().items));
    }

    subscribe("menu");
    const offOpen = onOpen(load);
    const offStock = onMessage<StockChange[]>("stock:updated", (changes) => {
      useMenuStore.getState().applyStock(changes);
      if (!submittingRef.current) {
        reportCapped(useCartStore.getState().capToStock(useMenuStore.getState().items));
      }
    });

    return () => {
      offOpen();
      offStock();
      unsubscribe("menu");
    };
    // reportCapped only uses stable setters and store getters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handlePlaceOrder() {
    const lines = useCartStore.getState().lines;
    if (lines.length === 0 || submittingRef.current) return;

    submittingRef.current = true;
    setSubmitting(true);
    try {
      const res = await placeOrder(lines);
      if (res.ok) {
        useCartStore.getState().clear();
        rememberOrder(res.data.id);
        notify("success", `Order #${res.data.id} placed.`);
        return;
      }

      if (res.status === 409 && res.error.error === "OUT_OF_STOCK" && res.error.items) {
        const short = res.error.items;
        // available is the stock at the moment our order was checked. The
        // menu store keeps the lower value, so this is safe even if the
        // winner's stock:updated message arrives later.
        useMenuStore.getState().applyStock(short.map((s) => ({ menuItemId: s.menuItemId, stock: s.available })));
        useCartStore.getState().capToStock(useMenuStore.getState().items);
        for (const s of short) {
          notify(
            "error",
            s.available === 0
              ? `Someone just ordered the last ${s.name}. Available now: 0.`
              : `Not enough ${s.name}: you wanted ${s.requested}. Available now: ${s.available}. Your cart was updated.`,
          );
        }
        return;
      }

      notify("error", `Your order was not placed: ${res.error.message}`);
      reportCapped(useCartStore.getState().capToStock(useMenuStore.getState().items));
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  const menu = Object.values(items).sort((a, b) => a.id - b.id);

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px] lg:items-start">
      <section>
        <h1 className="mb-4 text-2xl font-bold sm:text-3xl">Menu</h1>

        {loadState === "loading" && (
          <p className="rounded-lg border border-line bg-card p-4 text-sm text-muted">
            Loading menu... If this takes long, check that the backend is running at {API_URL}.
          </p>
        )}
        {loadState === "error" && (
          <p className="rounded-lg border border-danger/40 bg-danger/10 p-4 text-sm text-danger">
            Could not load the menu: {loadError}. It will retry when the connection comes back.
          </p>
        )}
        {loadState === "ready" && menu.length === 0 && (
          <p className="rounded-lg border border-line bg-card p-4 text-sm text-muted">No items on the menu right now.</p>
        )}
        {loadState === "ready" && menu.length > 0 && (
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {menu.map((item) => (
              <MenuItemCard key={item.id} item={item} />
            ))}
          </div>
        )}
      </section>

      <aside className="flex flex-col gap-6">
        {notices.length > 0 && (
          <ul className="flex flex-col gap-2" aria-live="polite">
            {notices.map((n) => (
              <li
                key={n.id}
                className={`flex items-start justify-between gap-2 rounded-lg border p-3 text-sm ${noticeStyles[n.tone]}`}
              >
                <span className={n.tone === "error" ? "text-danger" : n.tone === "success" ? "text-brand-dark" : ""}>
                  {n.text}
                </span>
                <button
                  type="button"
                  aria-label="Dismiss"
                  onClick={() => setNotices((list) => list.filter((x) => x.id !== n.id))}
                  className="-my-2 -mr-1 flex size-10 shrink-0 items-center justify-center rounded-md text-muted hover:text-ink"
                >
                  x
                </button>
              </li>
            ))}
          </ul>
        )}

        <Cart submitting={submitting} onPlaceOrder={handlePlaceOrder} />

        <section className="rounded-lg border border-line bg-card p-4">
          <h2 className="mb-2 text-lg font-bold">Your orders</h2>
          <p className="text-sm text-muted">No orders yet.</p>
        </section>
      </aside>
    </div>
  );
}
