DROP TABLE IF EXISTS order_items, orders, menu_items;

CREATE TABLE menu_items (
    id          serial PRIMARY KEY,
    name        text NOT NULL,
    price_cents int  NOT NULL CHECK (price_cents > 0),
    stock       int  NOT NULL CHECK (stock >= 0)
);

CREATE TABLE orders (
    id           serial PRIMARY KEY,
    status       text NOT NULL DEFAULT 'NEW'
                 CHECK (status IN ('NEW', 'COOKING', 'READY', 'PICKED_UP')),
    version      int NOT NULL DEFAULT 1,
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now(),
    cooking_at   timestamptz NULL,
    ready_at     timestamptz NULL,
    picked_up_at timestamptz NULL
);

CREATE TABLE order_items (
    id           serial PRIMARY KEY,
    order_id     int NOT NULL REFERENCES orders ON DELETE CASCADE,
    menu_item_id int NOT NULL REFERENCES menu_items,
    quantity     int NOT NULL CHECK (quantity > 0),
    price_cents  int NOT NULL
);
