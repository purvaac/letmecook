"use client";

import { useEffect, useState } from "react";
import OrderCard from "@/components/OrderCard";
import { getOrders, updateStatus } from "@/lib/api";
import { onMessage, onOpen, subscribe, unsubscribe } from "@/lib/socket";
import { useKitchenStore } from "@/lib/store";
import type { Order, OrderStatus } from "@/lib/types";

const PICKED_UP_SHOWN = 10;

const columns: { status: OrderStatus; title: string }[] = [
  { status: "NEW", title: "New" },
  { status: "COOKING", title: "Cooking" },
  { status: "READY", title: "Ready" },
  { status: "PICKED_UP", title: "Picked up" },
];

type Notice = { id: number; text: string };
let nextNoticeId = 1;

export default function KitchenPage() {
  const orders = useKitchenStore((s) => s.orders);
  const [loadState, setLoadState] = useState<"loading" | "ready" | "error">("loading");
  const [loadError, setLoadError] = useState("");
  const [notices, setNotices] = useState<Notice[]>([]);
  // One shared clock for every card's age, instead of one interval per card.
  // It starts at 0 because Date.now() is not allowed while Next prerenders;
  // load() sets it before any card is shown.
  const [now, setNow] = useState(0);

  function notify(text: string) {
    setNotices((list) => [{ id: nextNoticeId++, text }, ...list].slice(0, 5));
  }

  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, []);

  useEffect(() => {
    // Runs on mount and after every reconnect. The socket holds live
    // messages until this resolves, so they are applied on top of it.
    async function load() {
      const res = await getOrders();
      if (!res.ok) {
        setLoadError(res.error.message);
        setLoadState((s) => (s === "ready" ? s : "error"));
        return;
      }
      useKitchenStore.getState().setAll(res.data);
      setNow(Date.now());
      setLoadState("ready");
    }

    subscribe("kitchen");
    const offOpen = onOpen(load);
    const upsert = (order: Order) => useKitchenStore.getState().upsert(order);
    const offCreated = onMessage<Order>("order:created", upsert);
    const offUpdated = onMessage<Order>("order:updated", upsert);
    // Someone pressed Reset demo: notices about old orders no longer apply.
    const offReset = onMessage("demo:reset", () => {
      setNotices([{ id: nextNoticeId++, text: "The demo was reset: all orders were cleared." }]);
    });

    return () => {
      offOpen();
      offCreated();
      offUpdated();
      offReset();
      unsubscribe("kitchen");
    };
  }, []);

  async function advance(order: Order, next: OrderStatus) {
    const res = await updateStatus(order.id, next, order.version);
    if (res.ok) {
      useKitchenStore.getState().upsert(res.data);
      return;
    }
    if (res.status === 409 && res.error.error === "CONFLICT" && res.error.order) {
      // Another screen got there first: show what it did.
      useKitchenStore.getState().upsert(res.error.order);
      notify(`Order #${order.id} was already moved by another screen.`);
      return;
    }
    if (res.status === 400) {
      notify(`Order #${order.id}: ${res.error.message}`);
      return;
    }
    notify(`Could not update order #${order.id}: ${res.error.message}`);
  }

  const all = Object.values(orders);
  // Compare as times, not strings: Go trims trailing zeros from fractional seconds.
  const time = (iso: string | null) => (iso ? new Date(iso).getTime() : 0);
  const byAge = (a: Order, b: Order) => time(a.createdAt) - time(b.createdAt) || a.id - b.id;
  const newestPickup = (a: Order, b: Order) => time(b.pickedUpAt) - time(a.pickedUpAt) || b.id - a.id;

  return (
    <div>
      <h1 className="mb-4 text-2xl font-extrabold sm:text-3xl">Kitchen</h1>

      {notices.length > 0 && (
        <ul className="mb-4 flex flex-col gap-2" aria-live="polite">
          {notices.map((n) => (
            <li
              key={n.id}
              className="flex items-start justify-between gap-2 rounded-lg border border-warn/40 bg-warn/10 p-3 text-sm"
            >
              <span>{n.text}</span>
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

      {loadState === "loading" && (
        <p className="rounded-lg border border-line bg-card p-4 text-sm text-muted">Loading orders...</p>
      )}
      {loadState === "error" && (
        <p className="rounded-lg border border-danger/40 bg-danger/10 p-4 text-sm text-danger">
          Could not load orders: {loadError}. It will retry when the connection comes back.
        </p>
      )}

      {loadState === "ready" && (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {columns.map((col) => {
            const inColumn = all.filter((o) => o.status === col.status);
            const shown =
              col.status === "PICKED_UP"
                ? inColumn.sort(newestPickup).slice(0, PICKED_UP_SHOWN)
                : inColumn.sort(byAge);
            return (
              <section key={col.status} className="flex min-w-0 flex-col gap-3">
                <div className="flex items-center justify-between border-b border-line pb-2">
                  <h2 className="text-lg font-bold">{col.title}</h2>
                  <span className="rounded-full bg-line px-2 text-sm font-semibold text-muted tabular-nums">
                    {inColumn.length}
                  </span>
                </div>
                {shown.length === 0 && <p className="text-sm text-muted">No orders.</p>}
                {shown.map((o) => (
                  <OrderCard key={o.id} order={o} now={now} onAdvance={advance} />
                ))}
                {col.status === "PICKED_UP" && inColumn.length > PICKED_UP_SHOWN && (
                  <p className="text-xs text-muted">Showing the last {PICKED_UP_SHOWN}.</p>
                )}
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
