package handlers

import (
	"encoding/json"
	"log"
	"net/http"
	"net/url"

	"github.com/jackc/pgx/v5/pgxpool"

	"letmecook/realtime"
)

// NewRouter registers all routes and wraps them in the CORS middleware.
// origins are full URLs like http://localhost:3000.
func NewRouter(pool *pgxpool.Pool, hub *realtime.Hub, origins []string) http.Handler {
	s := &server{pool: pool, hub: hub, wsOrigins: originHosts(origins)}
	mux := http.NewServeMux()

	mux.HandleFunc("GET /api/health", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	})
	mux.HandleFunc("GET /api/menu", s.getMenu)
	mux.HandleFunc("GET /api/orders", s.listOrders)
	mux.HandleFunc("POST /api/orders", s.placeOrder)
	mux.HandleFunc("GET /api/orders/{id}", s.getOrder)
	mux.HandleFunc("PATCH /api/orders/{id}/status", s.updateStatus)
	mux.HandleFunc("GET /ws", s.serveWS)

	return withCORS(mux, origins)
}

// originHosts turns "http://localhost:3000" into "localhost:3000", because
// websocket.AcceptOptions.OriginPatterns matches against the host only.
func originHosts(origins []string) []string {
	hosts := make([]string, 0, len(origins))
	for _, o := range origins {
		u, err := url.Parse(o)
		if err != nil || u.Host == "" {
			log.Printf("ignoring invalid CORS origin %q", o)
			continue
		}
		hosts = append(hosts, u.Host)
	}
	return hosts
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(v); err != nil {
		log.Printf("write json: %v", err)
	}
}

// writeError sends {error, message} to the client. message must be safe to
// show to users; internal error details are logged by the caller, never sent.
func writeError(w http.ResponseWriter, status int, code, message string) {
	writeJSON(w, status, map[string]string{"error": code, "message": message})
}

func withCORS(next http.Handler, origins []string) http.Handler {
	allowed := make(map[string]bool, len(origins))
	for _, o := range origins {
		allowed[o] = true
	}

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Add("Vary", "Origin")
		if origin := r.Header.Get("Origin"); allowed[origin] {
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PATCH, OPTIONS")
			w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		}
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}
