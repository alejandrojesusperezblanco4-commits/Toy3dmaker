import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";

// DATA_DIR = /data en Railway (Volume), ./data en local
export const dataDir    = process.env.DATA_DIR ?? "./data";
export const uploadsDir = path.join(dataDir, "uploads");

fs.mkdirSync(uploadsDir, { recursive: true });

const db = new Database(path.join(dataDir, "toy3dmaker.db"));
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS orders (
    id                   TEXT PRIMARY KEY,
    created_at           TEXT NOT NULL,
    updated_at           TEXT NOT NULL,

    -- Cliente
    name                 TEXT NOT NULL,
    email                TEXT NOT NULL,
    phone                TEXT,

    -- Pedido
    description          TEXT,
    material             TEXT NOT NULL DEFAULT 'PLA',
    quality              TEXT NOT NULL DEFAULT 'estandar',
    size_cm              TEXT,
    quantity             INTEGER NOT NULL DEFAULT 1,

    -- Archivo STL
    stl_filename         TEXT,
    stl_path             TEXT,

    -- Precio
    price_estimate       REAL,
    price_final          REAL,

    -- Estado: pendiente_pago | pagado | en_cola | imprimiendo | listo | entregado | cancelado
    status               TEXT NOT NULL DEFAULT 'pendiente_pago',

    -- Stripe
    stripe_session_id    TEXT UNIQUE,
    stripe_payment_id    TEXT,

    -- Impresora asignada (bambu | kobra | null)
    printer              TEXT,

    -- Notas internas del taller
    notes                TEXT
  );
`);

export default db;
