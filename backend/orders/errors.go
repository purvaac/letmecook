package orders

import (
	"errors"
	"fmt"

	"letmecook/models"
)

// ErrNotFound is returned when an order or menu item does not exist.
var ErrNotFound = errors.New("not found")

// ShortItem describes one cart item that could not be fully supplied.
type ShortItem struct {
	MenuItemID int    `json:"menuItemId"`
	Name       string `json:"name"`
	Requested  int    `json:"requested"`
	Available  int    `json:"available"`
}

// OutOfStockError is returned by PlaceOrder when at least one item does not
// have enough stock. Nothing is reserved when this happens.
type OutOfStockError struct {
	Items []ShortItem
}

func (e *OutOfStockError) Error() string {
	return fmt.Sprintf("not enough stock for %d item(s)", len(e.Items))
}

// ConflictError is returned when an order was changed by someone else since
// the caller last saw it. Current is the order as it is now.
type ConflictError struct {
	Current models.Order
}

func (e *ConflictError) Error() string {
	return fmt.Sprintf("order %d was changed by someone else (now %s, version %d)",
		e.Current.ID, e.Current.Status, e.Current.Version)
}

// InvalidTransitionError is returned when a status change skips or reverses a stage.
type InvalidTransitionError struct {
	From models.Status
	To   models.Status
}

func (e *InvalidTransitionError) Error() string {
	return fmt.Sprintf("cannot move order from %s to %s", e.From, e.To)
}
