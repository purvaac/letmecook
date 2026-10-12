package orders

import (
	"cmp"
	"context"
	"errors"
	"fmt"
	"slices"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"letmecook/models"
)

// LineItem is one validated cart entry. Each MenuItemID appears at most once.
type LineItem struct {
	MenuItemID int
	Quantity   int
}

// StockChange is the absolute stock of a menu item after a committed order.
type StockChange struct {
	MenuItemID int `json:"menuItemId"`
	Stock      int `json:"stock"`
}

// GetMenu returns every menu item ordered by id.
func GetMenu(ctx context.Context, pool *pgxpool.Pool) ([]models.MenuItem, error) {
	rows, err := pool.Query(ctx, `SELECT id, name, price_cents, stock FROM menu_items ORDER BY id`)
	if err != nil {
		return nil, fmt.Errorf("query menu: %w", err)
	}
	defer rows.Close()

	items := []models.MenuItem{}
	for rows.Next() {
		var m models.MenuItem
		if err := rows.Scan(&m.ID, &m.Name, &m.PriceCents, &m.Stock); err != nil {
			return nil, fmt.Errorf("scan menu item: %w", err)
		}
		items = append(items, m)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("read menu: %w", err)
	}
	return items, nil
}

// PlaceOrder reserves stock for every item and creates the order, all in one
// transaction. Either the whole order goes through or nothing changes.
// It returns the new order and the new absolute stock of each item it
// changed, so the caller can broadcast them after the commit.
func PlaceOrder(ctx context.Context, pool *pgxpool.Pool, items []LineItem) (models.Order, []StockChange, error) {
	// Lock rows in a fixed order (by id) so two carts that share items always
	// wait on each other in the same order and can never deadlock.
	sorted := slices.Clone(items)
	slices.SortFunc(sorted, func(a, b LineItem) int { return cmp.Compare(a.MenuItemID, b.MenuItemID) })

	tx, err := pool.Begin(ctx)
	if err != nil {
		return models.Order{}, nil, fmt.Errorf("begin order: %w", err)
	}
	defer tx.Rollback(ctx) // no-op after Commit

	order := models.Order{Items: make([]models.OrderItem, 0, len(sorted))}
	changes := make([]StockChange, 0, len(sorted))

	for _, li := range sorted {
		item := models.OrderItem{Quantity: li.Quantity}
		var stock int

		// Under READ COMMITTED this UPDATE locks the row. A second transaction
		// updating the same row waits until we commit or roll back, then
		// re-checks "stock >= $1" against the newly committed value. So two
		// buyers can never both take the last unit: the second one matches no
		// row and gets pgx.ErrNoRows. CHECK (stock >= 0) is the backstop.
		err := tx.QueryRow(ctx,
			`UPDATE menu_items SET stock = stock - $1
			 WHERE id = $2 AND stock >= $1
			 RETURNING id, name, price_cents, stock`,
			li.Quantity, li.MenuItemID,
		).Scan(&item.MenuItemID, &item.Name, &item.PriceCents, &stock)
		if errors.Is(err, pgx.ErrNoRows) {
			// Release our row locks before reading current stock.
			if err := tx.Rollback(ctx); err != nil {
				return models.Order{}, nil, fmt.Errorf("rollback order: %w", err)
			}
			return models.Order{}, nil, shortageError(ctx, pool, sorted)
		}
		if err != nil {
			return models.Order{}, nil, fmt.Errorf("reserve item %d: %w", li.MenuItemID, err)
		}

		order.Items = append(order.Items, item)
		order.TotalCents += item.PriceCents * item.Quantity
		changes = append(changes, StockChange{MenuItemID: item.MenuItemID, Stock: stock})
	}

	err = tx.QueryRow(ctx,
		`INSERT INTO orders DEFAULT VALUES RETURNING id, status, version, created_at`,
	).Scan(&order.ID, &order.Status, &order.Version, &order.CreatedAt)
	if err != nil {
		return models.Order{}, nil, fmt.Errorf("insert order: %w", err)
	}

	for _, item := range order.Items {
		_, err := tx.Exec(ctx,
			`INSERT INTO order_items (order_id, menu_item_id, quantity, price_cents) VALUES ($1, $2, $3, $4)`,
			order.ID, item.MenuItemID, item.Quantity, item.PriceCents,
		)
		if err != nil {
			return models.Order{}, nil, fmt.Errorf("insert order item %d: %w", item.MenuItemID, err)
		}
	}

	if err := tx.Commit(ctx); err != nil {
		return models.Order{}, nil, fmt.Errorf("commit order: %w", err)
	}
	return order, changes, nil
}

// shortageError explains why a stock UPDATE matched no row: either an item
// does not exist (ErrNotFound) or one or more items are short (OutOfStockError).
func shortageError(ctx context.Context, pool *pgxpool.Pool, items []LineItem) error {
	ids := make([]int, len(items))
	for i, li := range items {
		ids[i] = li.MenuItemID
	}

	rows, err := pool.Query(ctx, `SELECT id, name, stock FROM menu_items WHERE id = ANY($1)`, ids)
	if err != nil {
		return fmt.Errorf("query stock: %w", err)
	}
	defer rows.Close()

	found := make(map[int]ShortItem, len(ids))
	for rows.Next() {
		var s ShortItem
		if err := rows.Scan(&s.MenuItemID, &s.Name, &s.Available); err != nil {
			return fmt.Errorf("scan stock: %w", err)
		}
		found[s.MenuItemID] = s
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("read stock: %w", err)
	}

	var short []ShortItem
	for _, li := range items {
		s, ok := found[li.MenuItemID]
		if !ok {
			return ErrNotFound
		}
		if li.Quantity > s.Available {
			s.Requested = li.Quantity
			short = append(short, s)
		}
	}
	if len(short) == 0 {
		// Stock only goes down while the server runs, so this means the
		// database was reset (re-seeded) between the UPDATE and this read.
		return errors.New("stock changed while placing the order")
	}
	return &OutOfStockError{Items: short}
}

// nextStatus is the only allowed move from each stage. PICKED_UP is final.
var nextStatus = map[models.Status]models.Status{
	models.StatusNew:     models.StatusCooking,
	models.StatusCooking: models.StatusReady,
	models.StatusReady:   models.StatusPickedUp,
}

// UpdateStatus moves an order one stage forward. expectedVersion is the
// version the caller last saw; if the order changed since then, it returns
// ConflictError with the current order and changes nothing.
func UpdateStatus(ctx context.Context, pool *pgxpool.Pool, id int, next models.Status, expectedVersion int) (models.Order, error) {
	current, err := GetOrder(ctx, pool, id)
	if err != nil {
		return models.Order{}, err
	}
	// A stale caller gets the latest order back instead of a confusing
	// "invalid transition" for a move another screen already made.
	if current.Version != expectedVersion {
		return models.Order{}, &ConflictError{Current: current}
	}
	if nextStatus[current.Status] != next {
		return models.Order{}, &InvalidTransitionError{From: current.Status, To: next}
	}

	// The column name comes from this switch only, never from the request.
	var column string
	switch next {
	case models.StatusCooking:
		column = "cooking_at"
	case models.StatusReady:
		column = "ready_at"
	case models.StatusPickedUp:
		column = "picked_up_at"
	}

	// Two kitchen screens can load the same order and click at the same
	// moment. Both pass the checks above, but the WHERE clause re-checks
	// status and version on the locked row, so only the first UPDATE matches;
	// the second sees the bumped version, matches no row and becomes a conflict.
	sql := fmt.Sprintf(
		`UPDATE orders
		 SET status = $1, version = version + 1, updated_at = now(), %s = now()
		 WHERE id = $2 AND status = $3 AND version = $4
		 RETURNING `+orderColumns, column)

	updated := models.Order{Items: current.Items, TotalCents: current.TotalCents}
	err = pool.QueryRow(ctx, sql, next, id, current.Status, expectedVersion).Scan(
		&updated.ID, &updated.Status, &updated.Version, &updated.CreatedAt,
		&updated.CookingAt, &updated.ReadyAt, &updated.PickedUpAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		latest, err := GetOrder(ctx, pool, id)
		if err != nil {
			return models.Order{}, err
		}
		return models.Order{}, &ConflictError{Current: latest}
	}
	if err != nil {
		return models.Order{}, fmt.Errorf("update order %d status: %w", id, err)
	}
	return updated, nil
}

const orderColumns = `id, status, version, created_at, cooking_at, ready_at, picked_up_at`

// GetOrder returns one order with its items, or ErrNotFound.
func GetOrder(ctx context.Context, pool *pgxpool.Pool, id int) (models.Order, error) {
	list, err := queryOrders(ctx, pool, `SELECT `+orderColumns+` FROM orders WHERE id = $1`, id)
	if err != nil {
		return models.Order{}, err
	}
	if len(list) == 0 {
		return models.Order{}, ErrNotFound
	}
	return list[0], nil
}

// ListOrders returns every order with its items, oldest first.
func ListOrders(ctx context.Context, pool *pgxpool.Pool) ([]models.Order, error) {
	return queryOrders(ctx, pool, `SELECT `+orderColumns+` FROM orders ORDER BY created_at, id`)
}

// queryOrders runs an orders query, then loads the items of all returned
// orders with a single second query (not one query per order).
func queryOrders(ctx context.Context, pool *pgxpool.Pool, sql string, args ...any) ([]models.Order, error) {
	rows, err := pool.Query(ctx, sql, args...)
	if err != nil {
		return nil, fmt.Errorf("query orders: %w", err)
	}
	defer rows.Close()

	list := []models.Order{}
	index := make(map[int]int) // order id -> position in list
	for rows.Next() {
		o := models.Order{Items: []models.OrderItem{}}
		if err := rows.Scan(&o.ID, &o.Status, &o.Version, &o.CreatedAt, &o.CookingAt, &o.ReadyAt, &o.PickedUpAt); err != nil {
			return nil, fmt.Errorf("scan order: %w", err)
		}
		index[o.ID] = len(list)
		list = append(list, o)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("read orders: %w", err)
	}
	if len(list) == 0 {
		return list, nil
	}

	ids := make([]int, len(list))
	for i, o := range list {
		ids[i] = o.ID
	}
	itemRows, err := pool.Query(ctx,
		`SELECT oi.order_id, oi.menu_item_id, m.name, oi.quantity, oi.price_cents
		 FROM order_items oi
		 JOIN menu_items m ON m.id = oi.menu_item_id
		 WHERE oi.order_id = ANY($1)
		 ORDER BY oi.order_id, oi.menu_item_id`,
		ids,
	)
	if err != nil {
		return nil, fmt.Errorf("query order items: %w", err)
	}
	defer itemRows.Close()

	for itemRows.Next() {
		var orderID int
		var item models.OrderItem
		if err := itemRows.Scan(&orderID, &item.MenuItemID, &item.Name, &item.Quantity, &item.PriceCents); err != nil {
			return nil, fmt.Errorf("scan order item: %w", err)
		}
		o := &list[index[orderID]]
		o.Items = append(o.Items, item)
		o.TotalCents += item.PriceCents * item.Quantity
	}
	if err := itemRows.Err(); err != nil {
		return nil, fmt.Errorf("read order items: %w", err)
	}
	return list, nil
}
