// These mirror the JSON sent by the Go backend (backend/models/models.go).
// Prices are in paise; timestamps are ISO strings, null for stages not reached.

export type OrderStatus = "NEW" | "COOKING" | "READY" | "PICKED_UP";

export type MenuItem = {
  id: number;
  name: string;
  priceCents: number;
  stock: number;
};

export type OrderItem = {
  menuItemId: number;
  name: string;
  quantity: number;
  priceCents: number;
};

export type Order = {
  id: number;
  status: OrderStatus;
  version: number;
  items: OrderItem[];
  totalCents: number;
  createdAt: string;
  cookingAt: string | null;
  readyAt: string | null;
  pickedUpAt: string | null;
};

// Payload of a stock:updated message: the absolute stock after a committed order.
export type StockChange = {
  menuItemId: number;
  stock: number;
};

export type ShortItem = {
  menuItemId: number;
  name: string;
  requested: number;
  available: number;
};

// Error body sent by the backend. items comes with OUT_OF_STOCK, order with
// CONFLICT, from and to with INVALID_TRANSITION.
export type ApiError = {
  error: string;
  message: string;
  items?: ShortItem[];
  order?: Order;
  from?: OrderStatus;
  to?: OrderStatus;
};
