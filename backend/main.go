package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/joho/godotenv"

	"letmecook/db"
	"letmecook/handlers"
)

func main() {
	seed := flag.Bool("seed", false, "drop and recreate the tables, seed the menu, then exit")
	flag.Parse()

	if err := run(*seed); err != nil {
		log.Fatal(err)
	}
}

func run(seed bool) error {
	// .env is optional; real environment variables still work without it.
	if err := godotenv.Load(); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("load .env: %w", err)
	}

	port := os.Getenv("PORT")
	if port == "" {
		port = "4000"
	}
	databaseURL := os.Getenv("DATABASE_URL")
	if databaseURL == "" {
		return errors.New("DATABASE_URL is not set: copy .env.example to .env and add your Neon connection string")
	}
	origins := parseOrigins(os.Getenv("CORS_ORIGINS"))

	connectCtx, cancelConnect := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancelConnect()
	pool, err := db.Connect(connectCtx, databaseURL)
	if err != nil {
		return err
	}
	defer pool.Close()

	if seed {
		return runSeed(pool)
	}

	srv := &http.Server{
		Addr:              ":" + port,
		Handler:           handlers.NewRouter(pool, origins),
		ReadHeaderTimeout: 5 * time.Second,
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	errCh := make(chan error, 1)
	go func() {
		log.Printf("listening on :%s (allowed origins: %v)", port, origins)
		errCh <- srv.ListenAndServe()
	}()

	select {
	case err := <-errCh:
		return fmt.Errorf("server: %w", err)
	case <-ctx.Done():
	}

	log.Println("shutting down")
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		return fmt.Errorf("shutdown: %w", err)
	}
	// The deferred pool.Close runs after Shutdown has drained requests.
	return nil
}

func runSeed(pool *pgxpool.Pool) error {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	if err := db.Reset(ctx, pool); err != nil {
		return err
	}
	items, err := db.SeedMenu(ctx, pool)
	if err != nil {
		return err
	}

	fmt.Printf("Database reset. Seeded %d menu items:\n", len(items))
	for _, item := range items {
		fmt.Printf("  %d. %-18s Rs %7.2f  stock %d\n", item.ID, item.Name, float64(item.PriceCents)/100, item.Stock)
	}
	return nil
}

func parseOrigins(s string) []string {
	if s == "" {
		return []string{"http://localhost:3000"}
	}
	var origins []string
	for _, o := range strings.Split(s, ",") {
		if o = strings.TrimSpace(o); o != "" {
			origins = append(origins, o)
		}
	}
	return origins
}
