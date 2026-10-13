"use client";

import { useEffect, useRef, useState } from "react";
import Cart from "@/components/Cart";
import MenuItemCard from "@/components/MenuItemCard";
import StatusTracker from "@/components/StatusTracker";
import { API_URL, getMenu, getOrder, placeOrder } from "@/lib/api";
import { onMessage, onOpen, subscribe, unsubscribe } from "@/lib/socket";
import { useCartStore, useMenuStore, type CappedLine } from "@/lib/store";
import type { Order, OrderStatus, StockChange } from "@/lib/types";

// sessionStorage, not localStorage: each window only lists the orders placed
// in it, so two customer windows in one browser behave like two customers.
const ORDERS_KEY = "letmecook:orders";

const rupees = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR" });

const statusBadge: Record<OrderStatus, { label: string; className: string }> = {
  NEW: { label: "New", className: "bg-line text-muted" },
  COOKING: { label: "Cooking", className: "bg-brand/10 text-brand-dark" },
  READY: { label: "Ready", className: "bg-brand text-ink" },
  PICKED_UP: { label: "Picked up", className: "bg-line text-muted" },
};

type Notice = { id: number; tone: "info" | "success" | "error"; text: string };

const noticeStyles: Record<Notice["tone"], string> = {
  info: "border-warn/40 bg-warn/10",
  success: "border-brand/40 bg-brand/10",
  error: "border-danger/40 bg-danger/10",
};

let nextNoticeId = 1;

function readOrderIds(): number[] {
  try {
    const ids: unknown = JSON.parse(sessionStorage.getItem(ORDERS_KEY) ?? "[]");
    return Array.isArray(ids) ? ids.filter((id) => Number.isInteger(id)) : [];
  } catch {
    return [];
  }
}

function writeOrderIds(ids: number[]) {
  try {
    sessionStorage.setItem(ORDERS_KEY, JSON.stringify(ids));
  } catch {
    // Private mode or storage full: the order is placed, we just cannot list it after a refresh.
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
  const [myOrders, setMyOrders] = useState<Record<number, Order>>({});
  const [ordersLoaded, setOrdersLoaded] = useState(false);
  const followed = useRef(new Set<number>());

  // Orders and live messages can arrive in any order; the version decides.
  function keepNewer(order: Order) {
    setMyOrders((prev) => {
      const current = prev[order.id];
      if (current && order.version <= current.version) return prev;
      return { ...prev, [order.id]: order };
    });
  }

  function follow(id: number) {
    followed.current.add(id);
    subscribe("order", id);
  }

  function forget(id: number) {
    followed.current.delete(id);
    unsubscribe("order", id);
    writeOrderIds(readOrderIds().filter((x) => x !== id));
    setMyOrders((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }

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

    // Subscribe first, then fetch, so no update falls between the two.
    // An id that 404s no longer exists (for example after a re-seed).
    async function loadOrders() {
      await Promise.all(
        readOrderIds().map(async (id) => {
          follow(id);
          const res = await getOrder(id);
          if (res.ok) {
            keepNewer(res.data);
          } else if (res.status === 404) {
            forget(id);
          }
        }),
      );
      setOrdersLoaded(true);
    }

    subscribe("menu");
    const offOpen = onOpen(load);
    const offOpenOrders = onOpen(loadOrders);
    const offOrder = onMessage<Order>("order:updated", (order) => {
      if (followed.current.has(order.id)) keepNewer(order);
    });
    const offStock = onMessage<StockChange[]>("stock:updated", (changes) => {
      useMenuStore.getState().applyStock(changes);
      if (!submittingRef.current) {
        reportCapped(useCartStore.getState().capToStock(useMenuStore.getState().items));
      }
    });

    const following = followed.current;
    return () => {
      offOpen();
      offOpenOrders();
      offStock();
      offOrder();
      unsubscribe("menu");
      following.forEach((id) => unsubscribe("order", id));
      following.clear();
    };
    // The helpers only use stable setters, refs and store getters.
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
        const id = res.data.id;
        useCartStore.getState().clear();
        writeOrderIds([...readOrderIds().filter((x) => x !== id), id]);
        follow(id);
        keepNewer(res.data);
        notify("success", `Order #${id} placed. You can follow it under Your orders.`);
        // The kitchen could move it between the 201 and our subscribe.
        getOrder(id).then((r) => r.ok && keepNewer(r.data));
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
  const orderList = Object.values(myOrders).sort((a, b) => b.id - a.id);

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px] lg:items-start">
      <section>
        <h1 className="mb-4 text-2xl font-extrabold sm:text-3xl">Menu</h1>

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
          <h2 className="mb-3 text-lg font-bold">Your orders</h2>
          {orderList.length === 0 ? (
            <p className="text-sm text-muted">{ordersLoaded ? "No orders yet." : "Loading your orders..."}</p>
          ) : (
            <ul className="flex flex-col gap-3">
              {orderList.map((o) => (
                <li
                  key={o.id}
                  className={`flex flex-col gap-3 rounded-md border border-line p-3 ${
                    o.status === "PICKED_UP" ? "opacity-60" : ""
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <h3 className="font-bold">Order #{o.id}</h3>
                    <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${statusBadge[o.status].className}`}>
                      {statusBadge[o.status].label}
                    </span>
                  </div>
                  <ul className="text-sm">
                    {o.items.map((it) => (
                      <li key={it.menuItemId} className="flex justify-between gap-2">
                        <span>
                          {it.name} x {it.quantity}
                        </span>
                        <span className="text-muted tabular-nums">{rupees.format((it.priceCents * it.quantity) / 100)}</span>
                      </li>
                    ))}
                  </ul>
                  <div className="flex justify-between text-sm font-semibold">
                    <span>Total</span>
                    <span className="tabular-nums">{rupees.format(o.totalCents / 100)}</span>
                  </div>
                  <StatusTracker order={o} />
                </li>
              ))}
            </ul>
          )}
        </section>
      </aside>
    </div>
  );
}
