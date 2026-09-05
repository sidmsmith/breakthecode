import pg from "pg";

const { Pool } = pg;
let pool = null;

export function getPool() {
  if (!pool) {
    const connectionString = process.env.NEON_DATABASE_URL;
    if (!connectionString) throw new Error("NEON_DATABASE_URL is required");
    pool = new Pool({
      connectionString,
      ssl: { rejectUnauthorized: false },
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
    });
  }
  return pool;
}

export function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

export async function ensureBcTables(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS bc_lobby (
      username VARCHAR(64) PRIMARY KEY,
      last_seen TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS bc_rooms (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      host_username VARCHAR(64) NOT NULL,
      status VARCHAR(16) NOT NULL DEFAULT 'lobby',
      game_state JSONB,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      started_at TIMESTAMP,
      ended_at TIMESTAMP
    )
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS bc_room_players (
      id BIGSERIAL PRIMARY KEY,
      room_id UUID REFERENCES bc_rooms(id) ON DELETE CASCADE,
      username VARCHAR(64) NOT NULL,
      role VARCHAR(16) NOT NULL DEFAULT 'player',
      status VARCHAR(16) NOT NULL DEFAULT 'invited',
      seat_index INTEGER,
      UNIQUE(room_id, username)
    )
  `);
}
