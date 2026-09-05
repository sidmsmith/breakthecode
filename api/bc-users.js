import { getPool, cors, ensureBcTables } from "./db.js";

export default async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const client = await getPool().connect();
  try {
    await ensureBcTables(client);
    const { rows } = await client.query(`
      SELECT DISTINCT username FROM (
        SELECT LOWER(username) AS username FROM bc_room_players
        UNION
        SELECT username FROM bc_lobby
      ) u
      ORDER BY username ASC
      LIMIT 50
    `);
    return res.status(200).json({ users: rows.map((r) => r.username) });
  } finally {
    client.release();
  }
}
