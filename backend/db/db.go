package db

import (
	"context"
	_ "embed"
	"fmt"

	"github.com/jackc/pgx/v5/pgxpool"

	"letmecook/models"
)

//go:embed schema.sql
var schema string

// Connect opens a connection pool and pings the database once.
func Connect(ctx context.Context, url string) (*pgxpool.Pool, error) {
	pool, err := pgxpool.New(ctx, url)
	if err != nil {
		return nil, fmt.Errorf("create pool: %w", err)
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("ping database: %w", err)
	}
	return pool, nil
}

// Reset drops and recreates all tables. All existing data is lost.
func Reset(ctx context.Context, pool *pgxpool.Pool) error {
	if _, err := pool.Exec(ctx, schema); err != nil {
		return fmt.Errorf("run schema: %w", err)
	}
	return nil
}

// seedItems is the hardcoded menu. Prices are in paise.
// Paneer Tikka Wrap and Gulab Jamun have stock 1 for the last-unit demo.
var seedItems = []models.MenuItem{
	{Name: "Masala Dosa", PriceCents: 12000, Stock: 12},
	{Name: "Paneer Tikka Wrap", PriceCents: 15000, Stock: 1},
	{Name: "Veg Biryani", PriceCents: 18000, Stock: 8},
	{Name: "Chole Bhature", PriceCents: 14000, Stock: 10},
	{Name: "Filter Coffee", PriceCents: 4000, Stock: 20},
	{Name: "Gulab Jamun", PriceCents: 6000, Stock: 1},
}

// SeedMenu inserts the hardcoded menu in one transaction and returns the
// inserted items with their ids.
func SeedMenu(ctx context.Context, pool *pgxpool.Pool) ([]models.MenuItem, error) {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return nil, fmt.Errorf("begin seed: %w", err)
	}
	defer tx.Rollback(ctx)

	items := make([]models.MenuItem, 0, len(seedItems))
	for _, item := range seedItems {
		err := tx.QueryRow(ctx,
			`INSERT INTO menu_items (name, price_cents, stock) VALUES ($1, $2, $3) RETURNING id`,
			item.Name, item.PriceCents, item.Stock,
		).Scan(&item.ID)
		if err != nil {
			return nil, fmt.Errorf("insert %q: %w", item.Name, err)
		}
		items = append(items, item)
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("commit seed: %w", err)
	}
	return items, nil
}
