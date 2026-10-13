import { create } from "zustand";
import type { MenuItem, Order, StockChange } from "./types";

type MenuState = {
  items: Record<number, MenuItem>;
  setAll: (items: MenuItem[]) => void;
  applyStock: (changes: StockChange[]) => void;
};

export const useMenuStore = create<MenuState>()((set) => ({
  items: {},
  setAll: (items) => set({ items: Object.fromEntries(items.map((i) => [i.id, i])) }),
  applyStock: (changes) =>
    set((state) => {
      const items = { ...state.items };
      for (const c of changes) {
        const item = items[c.menuItemId];
        // Stock never goes up while the server runs (no cancellations or
        // restocks), so the lower value is always the newer one. This keeps a
        // late message from two near-simultaneous orders from raising stock
        // back up. setAll (the HTTP re-fetch) still replaces everything.
        if (item && c.stock < item.stock) {
          items[c.menuItemId] = { ...item, stock: c.stock };
        }
      }
      return { items };
    }),
}));

// The backend rejects more than 10 of one item in an order.
export const MAX_PER_ITEM = 10;

export type CartLine = { menuItemId: number; quantity: number };
export type CappedLine = { menuItemId: number; from: number; to: number };

type CartState = {
  lines: CartLine[];
  add: (menuItemId: number) => void;
  increment: (menuItemId: number) => void;
  decrement: (menuItemId: number) => void;
  remove: (menuItemId: number) => void;
  clear: () => void;
  capToStock: (items: Record<number, MenuItem>) => CappedLine[];
};

export const useCartStore = create<CartState>()((set, get) => ({
  lines: [],
  add: (menuItemId) => {
    if (get().lines.some((l) => l.menuItemId === menuItemId)) {
      get().increment(menuItemId);
    } else {
      set((s) => ({ lines: [...s.lines, { menuItemId, quantity: 1 }] }));
    }
  },
  increment: (menuItemId) =>
    set((s) => ({
      lines: s.lines.map((l) => (l.menuItemId === menuItemId ? { ...l, quantity: l.quantity + 1 } : l)),
    })),
  decrement: (menuItemId) =>
    set((s) => ({
      lines: s.lines
        .map((l) => (l.menuItemId === menuItemId ? { ...l, quantity: l.quantity - 1 } : l))
        .filter((l) => l.quantity > 0),
    })),
  remove: (menuItemId) => set((s) => ({ lines: s.lines.filter((l) => l.menuItemId !== menuItemId) })),
  clear: () => set({ lines: [] }),
  // Lowers any quantity above live stock (removing lines that hit 0) and
  // returns what changed, so the page can tell the customer.
  capToStock: (items) => {
    const changed: CappedLine[] = [];
    const lines: CartLine[] = [];
    for (const l of get().lines) {
      const stock = items[l.menuItemId]?.stock ?? 0;
      if (l.quantity > stock) {
        changed.push({ menuItemId: l.menuItemId, from: l.quantity, to: stock });
        if (stock > 0) lines.push({ ...l, quantity: stock });
      } else {
        lines.push(l);
      }
    }
    if (changed.length > 0) set({ lines });
    return changed;
  },
}));

type KitchenState = {
  orders: Record<number, Order>;
  setAll: (orders: Order[]) => void;
  upsert: (order: Order) => void;
};

export const useKitchenStore = create<KitchenState>()((set) => ({
  orders: {},
  setAll: (orders) => set({ orders: Object.fromEntries(orders.map((o) => [o.id, o])) }),
  // Ignores anything older than what we already have: messages and HTTP
  // responses can arrive out of order, the version cannot go backwards.
  upsert: (order) =>
    set((state) => {
      const current = state.orders[order.id];
      if (current && order.version <= current.version) return state;
      return { orders: { ...state.orders, [order.id]: order } };
    }),
}));

// How many demo resets this tab has seen. The header bumps it on every
// demo:reset message; it is always mounted, unlike pages, which Next hides
// (not unmounts) on navigation and whose listeners are off while hidden.
// Pages stamp each notice with this number and only show notices from the
// current one, so a page hidden during a reset drops its stale notices as
// soon as it is shown again.
type DemoState = { resets: number; bumpResets: () => void };

export const useDemoStore = create<DemoState>()((set) => ({
  resets: 0,
  bumpResets: () => set((s) => ({ resets: s.resets + 1 })),
}));
