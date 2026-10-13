package handlers

// These tests run against the real database in DATABASE_URL (or backend/.env)
// and WIPE it. Run `go run . -seed` afterwards to get the demo menu back.

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/joho/godotenv"

	"letmecook/db"
	"letmecook/realtime"
)

type testItem struct {
	name  string
	stock int
}

// setup resets the database, inserts the given items and starts the real
// router. It returns the server URL, the pool and the new item ids in order.
func setup(t *testing.T, items ...testItem) (string, *pgxpool.Pool, []int) {
	t.Helper()
	_ = godotenv.Load("../.env")
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("DATABASE_URL not set; these tests need a database they are allowed to wipe")
	}

	ctx := context.Background()
	pool, err := db.Connect(ctx, url)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	t.Cleanup(pool.Close)

	if err := db.Reset(ctx, pool); err != nil {
		t.Fatalf("reset: %v", err)
	}
	ids := make([]int, len(items))
	for i, it := range items {
		err := pool.QueryRow(ctx,
			`INSERT INTO menu_items (name, price_cents, stock) VALUES ($1, 1000, $2) RETURNING id`,
			it.name, it.stock,
		).Scan(&ids[i])
		if err != nil {
			t.Fatalf("insert %s: %v", it.name, err)
		}
	}

	srv := httptest.NewServer(NewRouter(pool, realtime.NewHub(), []string{"http://localhost:3000"}, false))
	t.Cleanup(srv.Close)
	return srv.URL, pool, ids
}

// fireTogether runs do(i) in n goroutines that all wait on one start channel,
// so the requests hit the server at the same moment. It returns how many
// times each HTTP status code came back.
func fireTogether(n int, do func(i int) int) map[int]int {
	start := make(chan struct{})
	codes := make(chan int, n)
	var wg sync.WaitGroup

	for i := 0; i < n; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			codes <- do(i)
		}()
	}
	close(start)
	wg.Wait()
	close(codes)

	counts := make(map[int]int)
	for c := range codes {
		counts[c]++
	}
	return counts
}

// send makes one request and returns the status code. It is safe to call
// from many goroutines (t.Errorf is, t.Fatalf is not).
func send(t *testing.T, method, url, body string) int {
	req, err := http.NewRequest(method, url, strings.NewReader(body))
	if err != nil {
		t.Errorf("new request: %v", err)
		return -1
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Errorf("%s %s: %v", method, url, err)
		return -1
	}
	defer resp.Body.Close()
	return resp.StatusCode
}

func orderBody(ids ...int) string {
	parts := make([]string, len(ids))
	for i, id := range ids {
		parts[i] = fmt.Sprintf(`{"menuItemId":%d,"quantity":1}`, id)
	}
	return `{"items":[` + strings.Join(parts, ",") + `]}`
}

func stockOf(t *testing.T, pool *pgxpool.Pool, id int) int {
	t.Helper()
	var stock int
	if err := pool.QueryRow(context.Background(), `SELECT stock FROM menu_items WHERE id = $1`, id).Scan(&stock); err != nil {
		t.Fatalf("read stock of %d: %v", id, err)
	}
	return stock
}

func countRows(t *testing.T, pool *pgxpool.Pool, sql string) int {
	t.Helper()
	var n int
	if err := pool.QueryRow(context.Background(), sql).Scan(&n); err != nil {
		t.Fatalf("%s: %v", sql, err)
	}
	return n
}

func TestLastUnit(t *testing.T) {
	url, pool, ids := setup(t, testItem{"Last Samosa", 1})

	counts := fireTogether(2, func(int) int {
		return send(t, http.MethodPost, url+"/api/orders", orderBody(ids[0]))
	})
	t.Logf("2 buyers, stock 1: %v", counts)

	if counts[201] != 1 || counts[409] != 1 {
		t.Errorf("want one 201 and one 409, got %v", counts)
	}
	if got := stockOf(t, pool, ids[0]); got != 0 {
		t.Errorf("final stock = %d, want 0", got)
	}
}

func TestMassRace(t *testing.T) {
	url, pool, ids := setup(t, testItem{"Popular Thali", 5})

	counts := fireTogether(50, func(int) int {
		return send(t, http.MethodPost, url+"/api/orders", orderBody(ids[0]))
	})
	t.Logf("50 buyers, stock 5: %v", counts)

	if counts[201] != 5 || counts[409] != 45 {
		t.Errorf("want 5 x 201 and 45 x 409, got %v", counts)
	}
	if got := stockOf(t, pool, ids[0]); got != 0 {
		t.Errorf("final stock = %d, want 0", got)
	}
	if got := countRows(t, pool, `SELECT count(*) FROM orders`); got != 5 {
		t.Errorf("orders in table = %d, want 5", got)
	}
}

func TestOverlappingCarts(t *testing.T) {
	url, pool, ids := setup(t, testItem{"Item A", 10}, testItem{"Item B", 10})
	a, b := ids[0], ids[1]

	// Half the carts list A then B, half B then A. Without sorting by id
	// inside PlaceOrder this is the classic recipe for a deadlock.
	counts := fireTogether(20, func(i int) int {
		body := orderBody(a, b)
		if i%2 == 1 {
			body = orderBody(b, a)
		}
		return send(t, http.MethodPost, url+"/api/orders", body)
	})
	t.Logf("20 carts [A,B]/[B,A], stock 10 each: %v", counts)

	if counts[500] != 0 {
		t.Errorf("got %d x 500 (deadlock?)", counts[500])
	}
	if counts[201]+counts[409] != 20 {
		t.Errorf("want only 201 and 409, got %v", counts)
	}

	ok := counts[201]
	stockA, stockB := stockOf(t, pool, a), stockOf(t, pool, b)
	if stockA != 10-ok || stockB != 10-ok {
		t.Errorf("stock A=%d B=%d, want both %d (10 - %d successful orders)", stockA, stockB, 10-ok, ok)
	}
	if stockA < 0 || stockB < 0 {
		t.Errorf("negative stock: A=%d B=%d", stockA, stockB)
	}

	// Every order must contain both items: no half-reserved carts.
	partial := countRows(t, pool,
		`SELECT count(*) FROM (SELECT order_id FROM order_items GROUP BY order_id HAVING count(*) <> 2) x`)
	if partial != 0 {
		t.Errorf("%d orders do not have exactly 2 items", partial)
	}
	if got := countRows(t, pool, `SELECT count(*) FROM orders`); got != ok {
		t.Errorf("orders in table = %d, want %d", got, ok)
	}
}

func TestKitchenRace(t *testing.T) {
	url, pool, ids := setup(t, testItem{"Masala Chai", 10})

	if code := send(t, http.MethodPost, url+"/api/orders", orderBody(ids[0])); code != 201 {
		t.Fatalf("place order: got %d", code)
	}
	var orderID int
	if err := pool.QueryRow(context.Background(), `SELECT id FROM orders`).Scan(&orderID); err != nil {
		t.Fatalf("read order id: %v", err)
	}

	statusURL := fmt.Sprintf("%s/api/orders/%d/status", url, orderID)
	counts := fireTogether(5, func(int) int {
		return send(t, http.MethodPatch, statusURL, `{"status":"COOKING","version":1}`)
	})
	t.Logf("5 kitchen screens, NEW->COOKING v1: %v", counts)

	if counts[200] != 1 || counts[409] != 4 {
		t.Errorf("want one 200 and four 409, got %v", counts)
	}

	resp, err := http.Get(fmt.Sprintf("%s/api/orders/%d", url, orderID))
	if err != nil {
		t.Fatalf("get order: %v", err)
	}
	defer resp.Body.Close()
	var order struct {
		Status  string `json:"status"`
		Version int    `json:"version"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&order); err != nil {
		t.Fatalf("decode order: %v", err)
	}
	if order.Status != "COOKING" || order.Version != 2 {
		t.Errorf("order is %s v%d, want COOKING v2", order.Status, order.Version)
	}
}

func TestValidation(t *testing.T) {
	url, _, ids := setup(t, testItem{"Vada Pav", 10})

	cases := []struct {
		name, method, path, body string
	}{
		{"not json", http.MethodPost, "/api/orders", `nope`},
		{"empty cart", http.MethodPost, "/api/orders", `{"items":[]}`},
		{"quantity 11", http.MethodPost, "/api/orders", fmt.Sprintf(`{"items":[{"menuItemId":%d,"quantity":11}]}`, ids[0])},
		{"skip NEW to READY", http.MethodPatch, "/api/orders/1/status", `{"status":"READY","version":1}`},
	}

	if code := send(t, http.MethodPost, url+"/api/orders", orderBody(ids[0])); code != 201 {
		t.Fatalf("place order: got %d", code)
	}
	for _, tc := range cases {
		if code := send(t, tc.method, url+tc.path, tc.body); code != 400 {
			t.Errorf("%s: got %d, want 400", tc.name, code)
		}
	}
}

func TestDemoReset(t *testing.T) {
	url, pool, _ := setup(t)
	if code := send(t, http.MethodPost, url+"/api/demo/reset", ""); code != 404 {
		t.Fatalf("reset with DEMO_RESET off: got %d, want 404", code)
	}

	ctx := context.Background()
	items, err := db.SeedMenu(ctx, pool)
	if err != nil {
		t.Fatalf("seed: %v", err)
	}
	wrap := items[1] // Paneer Tikka Wrap, stock 1
	srv := httptest.NewServer(NewRouter(pool, realtime.NewHub(), []string{"http://localhost:3000"}, true))
	t.Cleanup(srv.Close)

	// A menu screen, subscribed before anything happens.
	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http") + "/ws"
	conn, _, err := websocket.Dial(ctx, wsURL, nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer conn.CloseNow()
	if err := conn.Write(ctx, websocket.MessageText, []byte(`{"type":"subscribe","room":"menu"}`)); err != nil {
		t.Fatalf("subscribe: %v", err)
	}

	if code := send(t, http.MethodPost, srv.URL+"/api/orders", orderBody(wrap.ID)); code != 201 {
		t.Fatalf("place order: got %d", code)
	}
	// The stock:updated message proves the subscription is active.
	readCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	if _, _, err := conn.Read(readCtx); err != nil {
		t.Fatalf("waiting for stock:updated: %v", err)
	}
	firstID := countRows(t, pool, `SELECT max(id) FROM orders`)

	if code := send(t, http.MethodPost, srv.URL+"/api/demo/reset", ""); code != 200 {
		t.Fatalf("reset: got %d, want 200", code)
	}
	if got := stockOf(t, pool, wrap.ID); got != 1 {
		t.Errorf("stock after reset = %d, want 1", got)
	}
	if got := countRows(t, pool, `SELECT count(*) FROM orders`); got != 0 {
		t.Errorf("orders after reset = %d, want 0", got)
	}

	// The screen is told a reset happened, then to reconnect and re-fetch.
	_, data, err := conn.Read(readCtx)
	if err != nil || !strings.Contains(string(data), `"type":"demo:reset"`) {
		t.Errorf("first message after reset: got %q (err %v), want a demo:reset message", data, err)
	}
	_, _, err = conn.Read(readCtx)
	if status := websocket.CloseStatus(err); status != websocket.StatusTryAgainLater {
		t.Errorf("socket after reset: got %v (status %d), want close status %d", err, status, websocket.StatusTryAgainLater)
	}

	if code := send(t, http.MethodPost, srv.URL+"/api/demo/reset", ""); code != 429 {
		t.Errorf("second reset straight away: got %d, want 429", code)
	}
	time.Sleep(resetCooldown)
	if code := send(t, http.MethodPost, srv.URL+"/api/demo/reset", ""); code != 200 {
		t.Errorf("reset after the cooldown: got %d, want 200", code)
	}

	if code := send(t, http.MethodPost, srv.URL+"/api/orders", orderBody(wrap.ID)); code != 201 {
		t.Fatalf("order after reset: got %d", code)
	}
	if got := countRows(t, pool, `SELECT max(id) FROM orders`); got <= firstID {
		t.Errorf("order id after reset = %d, want > %d (ids must not restart)", got, firstID)
	}
}
