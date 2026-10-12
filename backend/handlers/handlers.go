package handlers

import (
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5/pgxpool"

	"letmecook/orders"
)

const maxQuantity = 10

type server struct {
	pool *pgxpool.Pool
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

	order, _, err := orders.PlaceOrder(r.Context(), s.pool, items)
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

// internalError logs the real error and sends a generic 500 to the client.
func internalError(w http.ResponseWriter, action string, err error) {
	log.Printf("%s: %v", action, err)
	writeError(w, http.StatusInternalServerError, "INTERNAL", "something went wrong, please try again")
}
