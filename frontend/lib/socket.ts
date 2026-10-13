import { API_URL } from "./api";

// One shared WebSocket for the whole tab. It connects on first use, retries
// every 2 seconds after a close, and re-sends every active subscription on
// each open.
//
// Messages sent while we were disconnected are lost, so after every (re)connect
// the pages re-fetch over HTTP (their onOpen handlers). Live messages that
// arrive during that re-fetch are held back and applied only after it finishes,
// so an older HTTP snapshot never overwrites a newer live update.

export type SocketStatus = "connected" | "reconnecting";
export type Room = "menu" | "kitchen" | "order";

type Message = { type: string; payload: unknown };
type OpenHandler = () => unknown;

const WS_URL = API_URL.replace(/^http/, "ws") + "/ws";
const RETRY_MS = 2000;

let ws: WebSocket | null = null;
let status: SocketStatus = "reconnecting";

const subscriptions = new Map<string, { room: Room; orderId?: number }>();
const messageHandlers = new Map<string, Set<(payload: unknown) => void>>();
const openHandlers = new Set<OpenHandler>();
const statusHandlers = new Set<(s: SocketStatus) => void>();

let syncing = 0;
let held: Message[] = [];

function connect() {
  if (typeof window === "undefined" || ws) return;

  const socket = new WebSocket(WS_URL);
  ws = socket;

  socket.onopen = () => {
    setStatus("connected");
    for (const sub of subscriptions.values()) {
      send({ type: "subscribe", ...sub });
    }
    resync([...openHandlers]);
  };

  socket.onmessage = (event) => {
    let msg: Message;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    if (syncing > 0) {
      held.push(msg);
    } else {
      dispatch(msg);
    }
  };

  // onerror is always followed by onclose, so retrying here covers both.
  socket.onclose = () => {
    ws = null;
    setStatus("reconnecting");
    setTimeout(connect, RETRY_MS);
  };
}

async function resync(handlers: OpenHandler[]) {
  syncing++;
  await Promise.allSettled(handlers.map((h) => h()));
  syncing--;
  if (syncing === 0) {
    const queued = held;
    held = [];
    queued.forEach(dispatch);
  }
}

function dispatch(msg: Message) {
  messageHandlers.get(msg.type)?.forEach((h) => h(msg.payload));
}

function send(msg: object) {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

function setStatus(s: SocketStatus) {
  status = s;
  statusHandlers.forEach((h) => h(s));
}

function key(room: Room, orderId?: number) {
  return room === "order" ? `order:${orderId}` : room;
}

export function subscribe(room: Room, orderId?: number) {
  connect();
  subscriptions.set(key(room, orderId), { room, orderId });
  send({ type: "subscribe", room, orderId });
}

export function unsubscribe(room: Room, orderId?: number) {
  subscriptions.delete(key(room, orderId));
  send({ type: "unsubscribe", room, orderId });
}

export function onMessage<T>(type: string, handler: (payload: T) => void) {
  connect();
  const h = handler as (payload: unknown) => void;
  if (!messageHandlers.has(type)) messageHandlers.set(type, new Set());
  messageHandlers.get(type)!.add(h);
  return () => {
    messageHandlers.get(type)?.delete(h);
  };
}

// handler runs after every (re)connect. If the socket is already open it also
// runs once right away, so a page that mounts later still loads its data.
// It may return a promise; live messages are held until it settles.
export function onOpen(handler: OpenHandler) {
  connect();
  openHandlers.add(handler);
  if (status === "connected") {
    resync([handler]);
  }
  return () => {
    openHandlers.delete(handler);
  };
}

// handler is called right away with the current status, then on every change.
export function onStatus(handler: (s: SocketStatus) => void) {
  connect();
  statusHandlers.add(handler);
  handler(status);
  return () => {
    statusHandlers.delete(handler);
  };
}
