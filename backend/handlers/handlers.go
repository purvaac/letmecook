package handlers

import (
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/jackc/pgx/v5/pgxpool"

	"letmecook/db"
	"letmecook/models"
	"letmecook/orders"
	"letmecook/realtime"
)

const maxQuantity = 10

// resetCooldown stops the demo reset button from being spammed.
const resetCooldown = 15 * time.Second

type server struct {
	pool      *pgxpool.Pool
	hub       *realtime.Hub
	wsOrigins []string // host patterns for websocket.AcceptOptions
	demoReset bool

	resetMu   sync.Mutex
	lastReset time.Time
}

func (s *server) getMenu(w http.ResponseWriter, r *http.Request) {
	items, err := orders.GetMenu(r.Context(), s.pool)
	if err != nil {
		internalError(w, "get menu", err)
		return
	}
	writeJSON(w, http.StatusOK, items)
}

type placeOrderRequest struct {
	Items []struct {
		MenuItemID int `json:"menuItemId"`
		Quantity   int `json:"quantity"`
	} `json:"items"`
}

func (s *server) placeOrder(w http.ResponseWriter, r *http.Request) {
	var req placeOrderRequest
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "VALIDATION",
			`body must be JSON like {"items":[{"menuItemId":1,"quantity":2}]}`)
		return
	}

	items, msg := validateOrder(req)
	if msg != "" {
		writeError(w, http.StatusBadRequest, "VALIDATION", msg)
		return
	}

	order, changes, err := orders.PlaceOrder(r.Context(), s.pool, items)
	var oos *orders.OutOfStockError
	switch {
	case errors.As(err, &oos):
		writeJSON(w, http.StatusConflict, map[string]any{
			"error":   "OUT_OF_STOCK",
			"message": outOfStockMessage(oos.Items),
			"items":   oos.Items,
		})
	case errors.Is(err, orders.ErrNotFound):
		writeError(w, http.StatusNotFound, "NOT_FOUND", "one or more menu items do not exist")
	case err != nil:
		internalError(w, "place order", err)
	default:
		// PlaceOrder has committed, so it is now safe to tell everyone.
		s.hub.Broadcast("menu", "stock:updated", changes)
		s.hub.Broadcast("kitchen", "order:created", order)
		writeJSON(w, http.StatusCreated, order)
	}
}

// validateOrder checks the request and merges duplicate menu items.
// It returns a user-facing message when the request is invalid.
func validateOrder(req placeOrderRequest) ([]orders.LineItem, string) {
	if len(req.Items) == 0 {
		return nil, "order must contain at least one item"
	}

	var items []orders.LineItem
	position := make(map[int]int) // menu item id -> index in items
	for _, it := range req.Items {
		if it.MenuItemID <= 0 {
			return nil, "menuItemId must be a positive number"
		}
		if it.Quantity < 1 || it.Quantity > maxQuantity {
			return nil, fmt.Sprintf("quantity must be between 1 and %d", maxQuantity)
		}
		if i, ok := position[it.MenuItemID]; ok {
			items[i].Quantity += it.Quantity
			continue
		}
		position[it.MenuItemID] = len(items)
		items = append(items, orders.LineItem{MenuItemID: it.MenuItemID, Quantity: it.Quantity})
	}

	for _, li := range items {
		if li.Quantity > maxQuantity {
			return nil, fmt.Sprintf("at most %d of each item per order", maxQuantity)
		}
	}
	return items, ""
}

func outOfStockMessage(items []orders.ShortItem) string {
	parts := make([]string, len(items))
	for i, it := range items {
		parts[i] = fmt.Sprintf("%s (wanted %d, %d left)", it.Name, it.Requested, it.Available)
	}
	return "Not enough stock: " + strings.Join(parts, ", ")
}

func (s *server) listOrders(w http.ResponseWriter, r *http.Request) {
	list, err := orders.ListOrders(r.Context(), s.pool)
	if err != nil {
		internalError(w, "list orders", err)
		return
	}
	writeJSON(w, http.StatusOK, list)
}

func (s *server) getOrder(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.Atoi(r.PathValue("id"))
	if err != nil || id <= 0 {
		writeError(w, http.StatusBadRequest, "VALIDATION", "order id must be a positive number")
		return
	}

	order, err := orders.GetOrder(r.Context(), s.pool, id)
	if errors.Is(err, orders.ErrNotFound) {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "order not found")
		return
	}
	if err != nil {
		internalError(w, "get order", err)
		return
	}
	writeJSON(w, http.StatusOK, order)
}

type updateStatusRequest struct {
	Status  models.Status `json:"status"`
	Version int           `json:"version"`
}

func (s *server) updateStatus(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.Atoi(r.PathValue("id"))
	if err != nil || id <= 0 {
		writeError(w, http.StatusBadRequest, "VALIDATION", "order id must be a positive number")
		return
	}

	var req updateStatusRequest
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "VALIDATION", `body must be JSON like {"status":"COOKING","version":1}`)
		return
	}
	switch req.Status {
	case models.StatusNew, models.StatusCooking, models.StatusReady, models.StatusPickedUp:
	default:
		writeError(w, http.StatusBadRequest, "VALIDATION", "status must be NEW, COOKING, READY or PICKED_UP")
		return
	}
	if req.Version < 1 {
		writeError(w, http.StatusBadRequest, "VALIDATION", "version must be a positive number")
		return
	}

	order, err := orders.UpdateStatus(r.Context(), s.pool, id, req.Status, req.Version)
	var invalid *orders.InvalidTransitionError
	var conflict *orders.ConflictError
	switch {
	case errors.As(err, &invalid):
		writeJSON(w, http.StatusBadRequest, map[string]any{
			"error":   "INVALID_TRANSITION",
			"message": fmt.Sprintf("cannot move an order from %s to %s", invalid.From, invalid.To),
			"from":    invalid.From,
			"to":      invalid.To,
		})
	case errors.As(err, &conflict):
		writeJSON(w, http.StatusConflict, map[string]any{
			"error":   "CONFLICT",
			"message": "this order was updated on another screen",
			"order":   conflict.Current,
		})
	case errors.Is(err, orders.ErrNotFound):
		writeError(w, http.StatusNotFound, "NOT_FOUND", "order not found")
	case err != nil:
		internalError(w, "update status", err)
	default:
		// UpdateStatus has committed, so it is now safe to tell everyone.
		s.hub.Broadcast("kitchen", "order:updated", order)
		s.hub.Broadcast(realtime.OrderRoom(order.ID), "order:updated", order)
		writeJSON(w, http.StatusOK, order)
	}
}

// resetDemo restocks the menu and deletes all orders, then drops every
// WebSocket client so all screens reconnect and reload. It only exists on the
// public demo (DEMO_RESET=true); everywhere else it is a 404.
func (s *server) resetDemo(w http.ResponseWriter, r *http.Request) {
	if !s.demoReset {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "not found")
		return
	}

	s.resetMu.Lock()
	if time.Since(s.lastReset) < resetCooldown {
		s.resetMu.Unlock()
		writeError(w, http.StatusTooManyRequests, "TOO_SOON", "The demo was just reset, try again in a few seconds.")
		return
	}
	s.lastReset = time.Now()
	s.resetMu.Unlock()

	if err := db.RestockDemo(r.Context(), s.pool); err != nil {
		s.resetMu.Lock()
		s.lastReset = time.Time{}
		s.resetMu.Unlock()
		internalError(w, "reset demo", err)
		return
	}

	// The reset has committed. Screens ignore stock going up from live
	// messages, so instead of sending one we make every screen re-fetch.
	s.hub.DisconnectAll()
	log.Printf("demo reset: stock restored, orders cleared, all clients disconnected")
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// wsMessage is what clients send over the socket, for example
// {"type":"subscribe","room":"order","orderId":7}.
type wsMessage struct {
	Type    string `json:"type"`
	Room    string `json:"room"`
	OrderID int    `json:"orderId"`
}

func (s *server) serveWS(w http.ResponseWriter, r *http.Request) {
	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{OriginPatterns: s.wsOrigins})
	if err != nil {
		// Accept has already written an HTTP error response.
		log.Printf("websocket accept: %v", err)
		return
	}
	ctx := r.Context()

	c := realtime.NewClient(conn)
	go c.WritePump(ctx)
	defer func() {
		s.hub.RemoveClient(c)
		conn.CloseNow()
	}()

	for {
		_, data, err := conn.Read(ctx)
		if err != nil {
			return // client closed the socket or the connection broke
		}
		var msg wsMessage
		if err := json.Unmarshal(data, &msg); err != nil {
			continue
		}

		var room string
		switch {
		case msg.Room == "menu" || msg.Room == "kitchen":
			room = msg.Room
		case msg.Room == "order" && msg.OrderID > 0:
			room = realtime.OrderRoom(msg.OrderID)
		default:
			continue
		}

		switch msg.Type {
		case "subscribe":
			s.hub.Subscribe(c, room)
		case "unsubscribe":
			s.hub.Unsubscribe(c, room)
		}
	}
}

// internalError logs the real error and sends a generic 500 to the client.
func internalError(w http.ResponseWriter, action string, err error) {
	log.Printf("%s: %v", action, err)
	writeError(w, http.StatusInternalServerError, "INTERNAL", "something went wrong, please try again")
}
