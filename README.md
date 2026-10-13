# letmecook - Live Kitchen Operations

This is my submission for the Full Stack Developer Intern assignment. It is a small food ordering system with two screens:

- **Customer screen** (`/`): menu with live stock, a cart, placing orders, and a "Your orders" panel where you can watch your order move through the kitchen.
- **Kitchen screen** (`/kitchen`): a board with four columns (New, Cooking, Ready, Picked up), a timer on every order, and Slow / Late flags for orders that are taking too long.

The backend is Go with PostgreSQL, the frontend is Next.js, and the two talk over REST plus a WebSocket for live updates.

### Live demo

- Customer screen: https://letmecook-frontend-production.up.railway.app
- Kitchen screen: https://letmecook-frontend-production.up.railway.app/kitchen

Open the customer screen in two windows to be two customers, and the kitchen in two more windows to be two kitchen screens. If things are sold out because someone tested before you, press **Reset demo** in the top right. It puts the stock back and clears all orders (more on that [below](#demo-reset-button)).

I spent most of my time on the part the brief says matters most: making sure stock can never go wrong when lots of orders come in at once, and making sure every open screen shows the same thing.

---

## a. Setup and run

### Versions I used

| Tool | Version |
|---|---|
| Go | 1.25.0 (from `go.mod`; see note below) |
| PostgreSQL | 18.6 (Neon, AWS ap-southeast-1) |
| Node.js | 22.13.1 |
| npm | 10.9.2 |
| Next.js | 16.4.0 |
| React | 19.3.0 |
| OS | macOS (Apple Silicon) |

On Railway the frontend is built with Node 24.21.0 (that is what Railway's builder picked). Next 16 supports both, and the build passes on both.

Note about Go: `go.mod` says `go 1.25.0` because pgx v5.11.0 needs it. I actually have Go 1.22.3 installed, and Go downloads the 1.25 toolchain by itself the first time you run a command (this is the default `GOTOOLCHAIN=auto` behaviour). So any Go from 1.21 up should work, the first run just takes a bit longer.

### 1. Database

I used a free Postgres database on [Neon](https://neon.tech). Any PostgreSQL should work.

1. Create a Neon project and copy the connection string (the direct one, not the pooled one).
2. In `backend/`, copy the example env file and paste the connection string in:

```bash
cd backend
cp .env.example .env
# edit .env and set DATABASE_URL=postgresql://...?sslmode=require
```

`.env` has these values:

```
PORT=4000
DATABASE_URL=postgresql://USER:PASSWORD@HOST.neon.tech/DBNAME?sslmode=require
CORS_ORIGINS=http://localhost:3000
```

You can also set `DEMO_RESET=true`, but only on the public demo (see "Demo reset button"). It isn't in `.env.example` because you don't want it locally.

`CORS_ORIGINS` is a comma-separated list. The same list is used for the WebSocket origin check, so it has to match the frontend's address exactly (with `https://`, no slash at the end).

### 2. Backend

```bash
cd backend
go run . -seed   # creates the tables and the menu (wipes the database every time)
go run .         # starts the server on http://localhost:4000
```

The seed puts six items on the menu. Two of them have a stock of 1 on purpose, so the "last unit" case is easy to show:

| # | Item | Price | Stock |
|---|---|---|---|
| 1 | Masala Dosa | Rs 120 | 12 |
| 2 | Paneer Tikka Wrap | Rs 150 | **1** |
| 3 | Veg Biryani | Rs 180 | 8 |
| 4 | Chole Bhature | Rs 140 | 10 |
| 5 | Filter Coffee | Rs 40 | 20 |
| 6 | Gulab Jamun | Rs 60 | **1** |

You can check it is up with `curl localhost:4000/api/health`, which should print `{"demoReset":false,"ok":true}`.

### 3. Frontend

```bash
cd frontend
npm install
npm run dev      # http://localhost:3000
```

The frontend expects the backend at `http://localhost:4000`. If yours is somewhere else, copy `frontend/.env.example` to `frontend/.env.local` and change `NEXT_PUBLIC_API_URL`.

Then open:

- http://localhost:3000 for the customer screen (open it in two windows to be two customers)
- http://localhost:3000/kitchen for the kitchen board (open it in two windows to be two kitchen screens)

To reset the stock and delete all orders, run `go run . -seed` again in `backend/` and refresh the open pages.

### 4. Tests

```bash
cd backend
go test -race -count=1 -v ./...
go run . -seed   # the tests wipe the database, so seed again afterwards
```

**Careful:** the tests run against the database in `DATABASE_URL` and they wipe it. Don't point them at a database you care about. I learned this the hard way once the app was deployed: my laptop and the live site were using the same database, so running the tests would have wiped the live demo. Now I use two Neon branches, `production` for the live site and `dev` for my laptop and the tests.

---

## b. How the sync works

### The short version

1. **The database is the only source of truth for stock.** Stock only changes in one place in the code, with a single SQL statement that refuses to go below zero (apart from the demo reset button, see [Deployment](#demo-reset-button)).
2. **After a change is committed**, the server pushes the new state to every screen that cares, over a WebSocket.
3. **Messages are written so that applying them twice, late, or out of order cannot break anything.** Stock messages carry the absolute number, and order messages carry a version number.
4. **Whenever a screen (re)connects**, it reloads everything over HTTP first, because anything sent while it was offline is gone.

### Where stock is handled

All the ordering logic is in `backend/orders/orders.go`, in `PlaceOrder`. Placing an order is one database transaction:

```sql
UPDATE menu_items SET stock = stock - $1
WHERE id = $2 AND stock >= $1
RETURNING id, name, price_cents, stock
```

This runs once per item in the cart, then the order and its items are inserted and the transaction is committed.

Why this is safe when two people order the last unit at the same moment:

- The `UPDATE` locks the row. If a second transaction tries to update the same row, Postgres makes it wait until the first one commits.
- When the second one continues, Postgres re-checks `stock >= $1` against the new value (0). It no longer matches, so zero rows come back.
- No rows means "not enough stock". I roll back the whole transaction, so nothing from that order is kept (no half orders). Then I return a **409 OUT_OF_STOCK** saying which item was short and how many are left.
- The table also has `CHECK (stock >= 0)` as a backstop, so even a bug in my code could not store negative stock.

### Kitchen screens agreeing with each other

Every order has a `version` number, which goes up by one on every status change. To move an order, a kitchen screen sends the status it wants **and** the version it is looking at:

```
PATCH /api/orders/{id}/status   {"status": "COOKING", "version": 1}
```

The server only applies it if the order is still at that version (`WHERE id = ... AND status = ... AND version = ...`). If two cooks press "Start cooking" at the same time, only one update matches. The other gets a **409 CONFLICT** together with the current order, and that screen shows "Order #12 was already moved by another screen". Then both screens end up identical.

Status changes can only go forward one step (NEW -> COOKING -> READY -> PICKED_UP). Anything else is a 400.

### The WebSocket part

The backend has a small hub (`backend/realtime/hub.go`) with "rooms". Clients send `{"type":"subscribe","room":"menu"}` and so on.

| Message | Sent to | Payload |
|---|---|---|
| `stock:updated` | room `menu` (customer screens) | `[{menuItemId, stock}]`, the absolute stock after the order |
| `order:created` | room `kitchen` | the new order |
| `order:updated` | room `kitchen` and room `order:<id>` (the customer who placed it) | the order with its new version |

Some rules I stuck to:

- **Broadcast only after COMMIT.** Otherwise a screen could show something that then gets rolled back.
- **Absolute values, not "minus 1".** If a message is applied twice nothing changes, and a missed message gets corrected by the next one.
- **Versions on orders.** Every screen keeps an order only if the incoming version is higher than the one it has, so an old message can never move an order backwards.
- **A slow client can't slow down everyone else.** Each client has its own small send buffer, and the broadcast never waits on the network. If a client's buffer is full, that client gets disconnected, and it reconnects and reloads.

On the frontend, all of this lives in `frontend/lib/socket.ts` (one shared WebSocket per tab) and `frontend/lib/store.ts` (Zustand stores):

- Reconnect: retries every 2 s, or after 250 ms if the server closed the socket on purpose (code 1013).
- After (re)connect: re-subscribes and reloads over HTTP; live messages wait until the reload is done.
- Stock: the menu keeps the lower value, since orders only lower stock. A full reload (e.g. after a demo reset) replaces everything.

### How I checked it holds up when orders arrive at once

I wrote Go tests that start the real server (`httptest`) against a real Postgres. They fire many requests at exactly the same moment: all goroutines wait on one channel and are released together. They run with `-race`.

| Test | What it does | Result |
|---|---|---|
| `TestLastUnit` | 2 buyers, 1 unit in stock | 1 x 201, 1 x 409, stock ends at 0 |
| `TestOverlappingCarts` | 20 carts with the same 2 items, half [A,B] and half [B,A], 10 of each | 10 x 201, 10 x 409, no 500s (no deadlocks), stock matches, every order has both items |
| `TestKitchenRace` | 5 kitchen screens press "Start cooking" on the same order | 1 x 200, 4 x 409, order ends at COOKING version 2 |
| `TestDemoReset` | the reset endpoint (see below) | 404 when it is switched off; restores stock and clears orders; order ids keep counting up; a subscribed WebSocket gets closed with 1013; 429 straight after; 200 again after the 5 s cooldown |

To make sure the tests can actually catch a bug, I temporarily removed the sorting in `PlaceOrder` and ran `TestOverlappingCarts` again. It failed with 13 x 500 caused by Postgres deadlocks. With the sorting back it passes. I did the same for the reset: with the line that disconnects the clients commented out, `TestDemoReset` fails.

I also checked everything by hand in the browser:

- Two customer windows with the last Paneer Tikka Wrap in both carts, Place order clicked in both at the same time. One got "Order placed", the other got "Someone just ordered the last Paneer Tikka Wrap. Available now: 0.", and both menus switched to Sold out without a refresh.
- Two kitchen boards clicking the same button at the same time. One moved the order, the other showed the notice, and both boards ended up the same.

And once more on the deployed version on Railway (real internet, real WebSocket through Railway's proxy): two simultaneous orders for the last Paneer Tikka Wrap gave one 201 and one 409 with stock 0, the menu socket got `stock: 0`, both kitchen sockets got the new order, two simultaneous "Mark ready" requests gave one 200 and one 409, and both kitchen sockets plus the customer's order socket got every update.

---

## c. Packages and why

### Backend (Go)

| Package | Why |
|---|---|
| Go standard library `net/http` | Go 1.22+ routing understands `GET /api/orders/{id}`, so I didn't need a router library like chi or gin. |
| `github.com/jackc/pgx/v5` v5.11.0 | The most used Postgres driver for Go. I use its connection pool (`pgxpool`) and plain SQL. I didn't want an ORM because the whole point here is the exact SQL that does the stock check. |
| `github.com/coder/websocket` v1.8.15 | A small, maintained WebSocket library that supports `context`. gorilla/websocket also works, but it was archived for a while and needs more manual setup. |
| `github.com/joho/godotenv` v1.5.1 | Loads `backend/.env` so the database URL isn't in the code. |

Tests only use the standard library (`testing`, `net/http/httptest`).

### Frontend

| Package | Why |
|---|---|
| `next` 16.4.0, `react` / `react-dom` 19.3.0 | The brief asks for React / Next.js. I used the App Router. |
| `zustand` 5.0.15 | Very small state library, no provider needed. Components subscribe to just the part of the state they use, so a stock change only re-renders that menu card. |
| `tailwindcss` 4.3.3 | Quick styling without writing separate CSS files. All colours are defined once as theme tokens in `app/globals.css`. |
| `typescript` 5.9.3, `eslint` 9.39.5, `eslint-config-next` 16.4.0 | Came with `create-next-app`. TypeScript helped a lot to keep the frontend types in line with the Go JSON. |

No WebSocket library on the frontend: the browser's built-in `WebSocket` is enough because the server speaks plain WebSocket (not socket.io). The font (Plus Jakarta Sans) comes from `next/font`, which is built into Next.

---

## d. Assumptions

- **No login.** A customer is a browser tab. The ids of orders placed in a tab are kept in `sessionStorage`, so two windows in the same browser act like two different customers, and a refresh keeps your orders. Closing the tab forgets them (the orders still exist in the kitchen).
- **No cancellations and no restocking.** Stock only goes down when people order. The only ways to restock are `go run . -seed` (after which open pages should be refreshed) and, on the live demo, the Reset demo button (which refreshes all open pages by itself).
- **An order is all or nothing.** If even one item in the cart is short, nothing is ordered and the customer is told exactly which item and how many are left. Their cart is lowered to what is available, so they can just press Place order again.
- **At most 10 of one item per order**, so one person can't empty the whole stock by accident. The backend enforces it and the + button stops there too.
- **Stages only move forward one at a time:** New -> Cooking -> Ready -> Picked up. No going back and no skipping.
- **Slow / Late:** an order is Slow after 5 minutes and Late after 10 minutes from when it was placed (`WARN_MINUTES` / `LATE_MINUTES` in `frontend/components/OrderCard.tsx`). Picked-up orders stop their timer and are never flagged.
- **The kitchen board shows the last 10 picked-up orders** so the column doesn't grow forever. The count in the header is still the full number.
- **Prices are stored in paise** (integers), so there are no rounding problems. They are shown in rupees.
- **One backend instance.** The WebSocket hub lives in memory in one server process. Running several backend instances would need something like Postgres LISTEN/NOTIFY or Redis pub/sub between them, which I left out because the brief doesn't need it. Stock would still be correct with several instances (the database decides), but screens connected to different instances wouldn't hear about each other's orders. On Railway it runs as 1 replica.
- **The Reset demo button is for everyone.** There is no login, so anyone with the link can press it, and it resets the demo for everyone who is testing at that moment.

---

## Deployment

Both parts run on [Railway](https://railway.app), and the database stays on Neon.

```
Railway project
  backend  service  root dir /backend   -> https://letmecook-production-cc6e.up.railway.app
  frontend service  root dir /frontend  -> https://letmecook-frontend-production.up.railway.app
Neon project (Singapore)
  production branch -> used by the Railway backend
  dev branch        -> used by my laptop and the tests
```


| Service | Variable | Value |
|---|---|---|
| backend | `DATABASE_URL` | Neon `production` branch, direct connection (not the pooler) |
| backend | `CORS_ORIGINS` | `https://letmecook-frontend-production.up.railway.app` |
| backend | `DEMO_RESET` | `true` |
| frontend | `NEXT_PUBLIC_API_URL` | `https://letmecook-production-cc6e.up.railway.app` |

Railway sets `PORT` itself (8080), and the backend already reads it. Both services are in the Singapore region, next to the database, because one order is several round trips to Postgres. Railway builds them with its own builder (Railpack), so there is no Dockerfile.

Things that tripped me up:

- The first build failed with "Railpack could not determine how to build the app", because Railway was looking at the repo root, which only has the `backend/` and `frontend/` folders. Setting the Root Directory of each service fixed it.
- `NEXT_PUBLIC_API_URL` gets baked into the JavaScript when the frontend is built, so changing it needs a redeploy, not just a restart.
- The frontend loaded but couldn't talk to the backend until `CORS_ORIGINS` was the frontend's real https address. Before that the API had no CORS header and the WebSocket handshake got a 403.
- The new `production` branch was empty at first ("relation menu_items does not exist"), so I had to seed it once with `go run . -seed` pointed at that branch.

### Demo reset buttonReset demo button

Stock only goes down, so after one “last unit” test the item stays sold out for everyone. To keep the live demo usable, the deployed version has a Reset demo button in the header.

Off by default. It only exists when the backend runs with DEMO_RESET=true; otherwise POST /api/demo/reset returns 404 and the button is hidden.
One transaction. It restores every item’s seed stock and deletes all orders, locking rows in the same id order as PlaceOrder, so it can’t deadlock with an order.
Order ids keep counting up. Customer tabs remember their order ids, so restarting at 1 could show someone else’s order as theirs.
Screens refresh by reconnecting. After the commit, the server closes every WebSocket (code 1013), and each screen reconnects and reloads over HTTP. A normal stock message wouldn’t work, because the menu ignores live stock increases.
5-second cooldown, shown as a countdown on the button.

---


Thanks for taking the time to look at this. If you have questions about a decision, I'm happy to walk through it.
