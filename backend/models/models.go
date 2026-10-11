package models

import "time"

type Status string

const (
	StatusNew      Status = "NEW"
	StatusCooking  Status = "COOKING"
	StatusReady    Status = "READY"
	StatusPickedUp Status = "PICKED_UP"
)

type MenuItem struct {
	ID         int    `json:"id"`
	Name       string `json:"name"`
	PriceCents int    `json:"priceCents"`
	Stock      int    `json:"stock"`
}

type OrderItem struct {
	MenuItemID int    `json:"menuItemId"`
	Name       string `json:"name"`
	Quantity   int    `json:"quantity"`
	PriceCents int    `json:"priceCents"`
}

// Order timestamps for stages not reached yet are nil and encode as null.
type Order struct {
	ID         int         `json:"id"`
	Status     Status      `json:"status"`
	Version    int         `json:"version"`
	Items      []OrderItem `json:"items"`
	TotalCents int         `json:"totalCents"`
	CreatedAt  time.Time   `json:"createdAt"`
	CookingAt  *time.Time  `json:"cookingAt"`
	ReadyAt    *time.Time  `json:"readyAt"`
	PickedUpAt *time.Time  `json:"pickedUpAt"`
}
