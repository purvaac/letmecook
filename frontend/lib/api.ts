import type { ApiError, MenuItem, Order, OrderStatus } from "./types";

export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

export type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; error: ApiError };

// status is 0 when the server could not be reached at all.
async function request<T>(path: string, method = "GET", body?: unknown): Promise<ApiResult<T>> {
  let res: Response;
  try {
    res = await fetch(API_URL + path, {
      method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store",
    });
  } catch {
    return {
      ok: false,
      status: 0,
      error: { error: "NETWORK", message: "Could not reach the server. Is the backend running?" },
    };
  }

  const json = await res.json().catch(() => null);
  if (res.ok) {
    return { ok: true, data: json as T };
  }
  return {
    ok: false,
    status: res.status,
    error: (json as ApiError) ?? { error: "INTERNAL", message: `Request failed (${res.status})` },
  };
}

export function getMenu() {
  return request<MenuItem[]>("/api/menu");
}

export function placeOrder(items: { menuItemId: number; quantity: number }[]) {
  return request<Order>("/api/orders", "POST", { items });
}

export function getOrder(id: number) {
  return request<Order>(`/api/orders/${id}`);
}

export function getOrders() {
  return request<Order[]>("/api/orders");
}

export function updateStatus(id: number, status: OrderStatus, version: number) {
  return request<Order>(`/api/orders/${id}/status`, "PATCH", { status, version });
}

export function getHealth() {
  return request<{ ok: boolean; demoReset?: boolean }>("/api/health");
}

// Only works when the backend runs with DEMO_RESET=true (the public demo).
export function resetDemo() {
  return request<{ ok: boolean }>("/api/demo/reset", "POST");
}
