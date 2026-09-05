import { getPool, cors, ensureBcTables } from "./db.js";
import { ablyPublish, LOBBY_CHANNEL } from "./ably.js";
import {
  LOBBY_AVAILABLE_SECONDS,
  abandonStaleLobbyRooms,
  retireLobbyUsername,
} from "./bc-lobby-util.js";

const availableInterval = `${LOBBY_AVAILABLE_SECONDS} seconds`;

export default async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(200).end();

  const client = await getPool().connect();
  try {
    await ensureBcTables(client);
    await abandonStaleLobbyRooms(client);

    if (req.method === "POST") {
      const { username, previous_username, leave } = req.body || {};
      if (!username) return res.status(400).json({ error: "username required" });
      const u = username.toLowerCase();
      const prev = previous_username ? String(previous_username).toLowerCase() : null;

      if (leave) {
        await retireLobbyUsername(client, u);
        await ablyPublish(LOBBY_CHANNEL, "lobby-update", { username: u, left: true });
        return res.status(200).json({ ok: true });
      }

      if (prev && prev !== u) {
        await retireLobbyUsername(client, prev);
      }

      await client.query(
        `INSERT INTO bc_lobby (username, last_seen) VALUES ($1, NOW())
         ON CONFLICT (username) DO UPDATE SET last_seen = NOW()`,
        [u]
      );

      await ablyPublish(LOBBY_CHANNEL, "lobby-update", { username: u, previous_username: prev });
      return res.status(200).json({ ok: true });
    }

    if (req.method === "GET") {
      // Presence for Game Lobby only. Players in an active game are hidden until
      // they leave/end and open Game Lobby again.
      const { rows } = await client.query(
        `
        SELECT
          u.username,
          CASE
            WHEN rm.role = 'host' AND rm.room_status = 'lobby' THEN 'host'
            WHEN rm.player_status = 'accepted' AND rm.room_status = 'lobby' THEN 'ready'
            WHEN rm.player_status = 'invited' AND rm.room_status = 'lobby' THEN 'waiting'
            WHEN l.last_seen > NOW() - $1::INTERVAL THEN 'available'
            ELSE 'offline'
          END AS status
        FROM (
          SELECT username FROM bc_lobby
          UNION
          SELECT fp.username
          FROM bc_room_players fp
          JOIN bc_rooms fr ON fr.id = fp.room_id
          WHERE fr.status = 'lobby'
            AND fp.status NOT IN ('left', 'declined')
        ) u
        LEFT JOIN bc_lobby l ON l.username = u.username
        LEFT JOIN LATERAL (
          SELECT fr.status AS room_status, fp.role, fp.status AS player_status
          FROM bc_room_players fp
          JOIN bc_rooms fr ON fr.id = fp.room_id
          WHERE fp.username = u.username
            AND fr.status IN ('lobby', 'active')
            AND fp.status NOT IN ('left', 'declined')
          ORDER BY
            CASE fr.status WHEN 'active' THEN 0 WHEN 'lobby' THEN 1 ELSE 2 END,
            fr.created_at DESC
          LIMIT 1
        ) rm ON true
        WHERE
          (rm.room_status IS NULL OR rm.room_status = 'lobby')
          AND (
            l.last_seen > NOW() - $1::INTERVAL
            OR rm.room_status = 'lobby'
          )
        ORDER BY
          CASE
            WHEN rm.role = 'host' AND rm.room_status = 'lobby' THEN 1
            WHEN rm.player_status = 'accepted' AND rm.room_status = 'lobby' THEN 1
            WHEN rm.player_status = 'invited' AND rm.room_status = 'lobby' THEN 2
            WHEN l.last_seen > NOW() - $1::INTERVAL THEN 0
            ELSE 3
          END,
          u.username ASC
        `,
        [availableInterval]
      );
      return res.status(200).json({ players: rows });
    }

    return res.status(405).json({ error: "Method not allowed" });
  } finally {
    client.release();
  }
}
