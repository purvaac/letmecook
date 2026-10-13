// Package realtime keeps track of WebSocket clients and the rooms they
// subscribe to, and fans out messages to them.
//
// Every message is JSON: {"type": <type>, "payload": <payload>}.
//
//	type           room(s)                payload
//	stock:updated  "menu"                 [{menuItemId, stock}] absolute stock after a commit
//	order:created  "kitchen"              the new Order (version 1)
//	order:updated  "kitchen", "order:<id>" the Order after a status change (higher version)
//
// Messages are only sent after the database transaction has committed.
// A client that misses messages (slow or disconnected) is expected to
// re-fetch over HTTP when it reconnects.
package realtime

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"sync"
	"time"

	"github.com/coder/websocket"
)

const sendBuffer = 16

type Client struct {
	conn   *websocket.Conn
	send   chan []byte
	closed bool // guarded by Hub.mu; true once send has been closed
}

func NewClient(conn *websocket.Conn) *Client {
	return &Client{conn: conn, send: make(chan []byte, sendBuffer)}
}

// WritePump writes queued messages to the socket. It runs in its own
// goroutine and returns when the hub closes send or a write fails.
func (c *Client) WritePump(ctx context.Context) {
	for msg := range c.send {
		writeCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
		err := c.conn.Write(writeCtx, websocket.MessageText, msg)
		cancel()
		if err != nil {
			log.Printf("websocket write failed, closing client: %v", err)
			// Closing the socket also ends the read loop, which removes us from the hub.
			c.conn.CloseNow()
			return
		}
	}
	// send was closed by the hub: either the client was too slow or it is
	// being removed. Ask it to reconnect; it will re-fetch state over HTTP.
	c.conn.Close(websocket.StatusTryAgainLater, "reconnect and re-fetch")
}

type Hub struct {
	mu    sync.Mutex
	rooms map[string]map[*Client]bool
}

func NewHub() *Hub {
	return &Hub{rooms: make(map[string]map[*Client]bool)}
}

// OrderRoom is the room a customer joins to follow one order.
func OrderRoom(id int) string {
	return fmt.Sprintf("order:%d", id)
}

func (h *Hub) Subscribe(c *Client, room string) {
	h.mu.Lock()
	defer h.mu.Unlock()

	// A client dropped for being slow must not be added back, or a later
	// Broadcast would send on its closed channel.
	if c.closed {
		return
	}
	if h.rooms[room] == nil {
		h.rooms[room] = make(map[*Client]bool)
	}
	h.rooms[room][c] = true
}

func (h *Hub) Unsubscribe(c *Client, room string) {
	h.mu.Lock()
	defer h.mu.Unlock()

	delete(h.rooms[room], c)
	if len(h.rooms[room]) == 0 {
		delete(h.rooms, room)
	}
}

// RemoveClient takes the client out of every room and closes its send channel.
func (h *Hub) RemoveClient(c *Client) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.removeLocked(c)
}

// removeLocked must be called with h.mu held. Closing send only ever happens
// here, under the lock, so no Broadcast can send on a closed channel.
func (h *Hub) removeLocked(c *Client) {
	for room, clients := range h.rooms {
		delete(clients, c)
		if len(clients) == 0 {
			delete(h.rooms, room)
		}
	}
	if !c.closed {
		c.closed = true
		close(c.send)
	}
}

// Broadcast sends {type, payload} to every client in room. It never blocks:
// the lock only covers channel sends, and the actual network writes happen
// in each client's WritePump. A client whose buffer is full is dropped
// instead of slowing everyone else down.
func (h *Hub) Broadcast(room, msgType string, payload any) {
	msg, err := json.Marshal(map[string]any{"type": msgType, "payload": payload})
	if err != nil {
		log.Printf("broadcast %s: marshal: %v", msgType, err)
		return
	}

	h.mu.Lock()
	defer h.mu.Unlock()
	for c := range h.rooms[room] {
		select {
		case c.send <- msg:
		default:
			log.Printf("broadcast %s: client too slow, dropping it", msgType)
			h.removeLocked(c)
		}
	}
}
