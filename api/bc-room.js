import { getPool, cors, ensureBcTables } from "./db.js";
import { ablyPublish, LOBBY_CHANNEL, roomChannel } from "./ably.js";
import { MIN_PLAYERS, MAX_PLAYERS } from "../lib/bc-constants.js";
import {
  abandonStaleLobbyRooms,
  assertInviteesAvailable,
  listPendingInvites,
} from "./bc-lobby-util.js";

async function getRoomWithPlayers(client, roomId) {
  const { rows: roomRows } = await client.query(
    `SELECT * FROM bc_rooms WHERE id = $1`,
    [roomId]
  );
  const { rows: players } = await client.query(
    `SELECT username, role, status, seat_index
     FROM bc_room_players WHERE room_id = $1 ORDER BY role DESC, username ASC`,
    [roomId]
  );
  return { room: roomRows[0] || null, players };
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(200).end();

  const client = await getPool().connect();
  try {
    await ensureBcTables(client);
    await abandonStaleLobbyRooms(client);

    if (req.method === "POST") {
      const { username, invitees = [] } = req.body || {};
      if (!username) return res.status(400).json({ error: "username required" });

      const host = username.toLowerCase();
      const uniqueInvitees = [...new Set(invitees.map((i) => i.toLowerCase()))].filter(
        (i) => i !== host
      );

      const totalPlayers = 1 + uniqueInvitees.length;
      if (totalPlayers < MIN_PLAYERS || totalPlayers > MAX_PLAYERS) {
        return res.status(400).json({
          error: `Break the Code requires ${MIN_PLAYERS}-${MAX_PLAYERS} players (${totalPlayers} selected).`,
        });
      }

      const availErr = await assertInviteesAvailable(client, uniqueInvitees);
      if (availErr) return res.status(400).json({ error: availErr });

      const { rows: [room] } = await client.query(
        `INSERT INTO bc_rooms (host_username) VALUES ($1) RETURNING id`,
        [host]
      );
      const roomId = room.id;

      await client.query(
        `INSERT INTO bc_room_players (room_id, username, role, status, seat_index)
         VALUES ($1,$2,'host','accepted',0)`,
        [roomId, host]
      );

      for (let idx = 0; idx < uniqueInvitees.length; idx++) {
        const invitee = uniqueInvitees[idx];
        await client.query(
          `INSERT INTO bc_room_players (room_id, username, role, status, seat_index)
           VALUES ($1,$2,'player','invited',$3)
           ON CONFLICT (room_id, username) DO NOTHING`,
          [roomId, invitee, idx + 1]
        );
      }

      for (const invitee of uniqueInvitees) {
        await ablyPublish(LOBBY_CHANNEL, "invite", {
          invitee,
          host,
          room_id: roomId,
        });
      }

      return res.status(200).json({ room_id: roomId, game_mode: "breakthecode" });
    }

    if (req.method === "GET") {
      const { room_id, username } = req.query;

      if (username && !room_id) {
        const u = String(username).toLowerCase();
        const pending_invites = await listPendingInvites(client, u);

        const { rows } = await client.query(
          `SELECT fr.id, fr.host_username, fr.status, fr.created_at,
                  fp.role, fp.status AS player_status
           FROM bc_room_players fp
           JOIN bc_rooms fr ON fr.id = fp.room_id
           WHERE fp.username = $1 AND fr.status IN ('lobby', 'active')
             AND fp.status NOT IN ('left', 'declined', 'invited')
           ORDER BY fr.created_at DESC
           LIMIT 1`,
          [u]
        );
        if (!rows.length) {
          return res.status(200).json({ room_id: null, pending_invites });
        }
        const row = rows[0];
        const { players } = await getRoomWithPlayers(client, row.id);
        return res.status(200).json({
          room_id: row.id,
          role: row.role,
          player_status: row.player_status,
          pending_invites,
          room: {
            id: row.id,
            host_username: row.host_username,
            status: row.status,
            game_mode: "breakthecode",
          },
          players,
        });
      }

      if (!room_id) {
        return res.status(400).json({ error: "room_id or username required" });
      }
      const { room, players } = await getRoomWithPlayers(client, room_id);
      if (!room) return res.status(404).json({ error: "room not found" });
      return res.status(200).json({
        room: { ...room, game_mode: "breakthecode" },
        players,
      });
    }

    if (req.method === "PATCH") {
      const { action, room_id, username, previous_username } = req.body || {};
      const user = username ? username.toLowerCase() : null;

      if (action === "rename_username") {
        const prev = previous_username ? String(previous_username).toLowerCase() : null;
        const next = user;
        if (!prev || !next || prev === next) {
          return res.status(400).json({ error: "previous_username and username required" });
        }

        const { rows: memberships } = await client.query(
          `SELECT fr.id, fr.status, fr.host_username, fp.role
           FROM bc_room_players fp
           JOIN bc_rooms fr ON fr.id = fp.room_id
           WHERE fp.username = $1 AND fr.status IN ('lobby', 'active')
           ORDER BY fr.created_at DESC
           LIMIT 1`,
          [prev]
        );
        if (!memberships.length) {
          return res.status(200).json({ ok: true, room_id: null });
        }

        const { id: rid, status, host_username, role } = memberships[0];
        if (status === "active") {
          return res.status(400).json({ error: "Cannot rename during an active game." });
        }

        const { rows: taken } = await client.query(
          `SELECT 1 FROM bc_room_players WHERE room_id = $1 AND username = $2 LIMIT 1`,
          [rid, next]
        );
        if (taken.length) {
          return res.status(400).json({ error: "That name is already in this room." });
        }

        await client.query(
          `UPDATE bc_room_players SET username = $3 WHERE room_id = $1 AND username = $2`,
          [rid, prev, next]
        );
        if (host_username === prev) {
          await client.query(`UPDATE bc_rooms SET host_username = $2 WHERE id = $1`, [rid, next]);
        }

        const { players } = await getRoomWithPlayers(client, rid);
        await ablyPublish(roomChannel(rid), "player-status", { players });

        return res.status(200).json({ ok: true, room_id: rid, role });
      }

      if (!action || !room_id) {
        return res.status(400).json({ error: "action and room_id required" });
      }

      if (action === "accept") {
        const { room } = await getRoomWithPlayers(client, room_id);
        if (!room) return res.status(404).json({ error: "room not found" });
        if (room.status !== "lobby") {
          return res.status(400).json({ error: "That invite is no longer available." });
        }
        await client.query(
          `UPDATE bc_room_players SET status='accepted'
           WHERE room_id=$1 AND username=$2 AND status='invited'`,
          [room_id, user]
        );
        const { players } = await getRoomWithPlayers(client, room_id);
        await ablyPublish(roomChannel(room_id), "player-status", { players });
        return res.status(200).json({ ok: true });
      }

      if (action === "decline") {
        const { room } = await getRoomWithPlayers(client, room_id);
        if (!room) return res.status(404).json({ error: "room not found" });
        if (room.status !== "lobby") {
          // Game already started / cancelled — treat as cleared.
          return res.status(200).json({ ok: true, cleared: true });
        }
        await client.query(
          `UPDATE bc_room_players SET status='declined' WHERE room_id=$1 AND username=$2`,
          [room_id, user]
        );
        const { players } = await getRoomWithPlayers(client, room_id);
        await ablyPublish(roomChannel(room_id), "player-status", { players });
        return res.status(200).json({ ok: true });
      }

      // Host invites more players (or re-invites declined) into an existing lobby room.
      if (action === "invite") {
        const invitees = Array.isArray(req.body?.invitees) ? req.body.invitees : [];
        const uniqueInvitees = [...new Set(invitees.map((i) => String(i).toLowerCase()))].filter(
          (i) => i && i !== user
        );
        if (!uniqueInvitees.length) {
          return res.status(400).json({ error: "invitees required" });
        }

        const { room, players } = await getRoomWithPlayers(client, room_id);
        if (!room) return res.status(404).json({ error: "room not found" });
        if (room.status !== "lobby") {
          return res.status(400).json({ error: "Can only invite while the lobby is open." });
        }
        if (String(room.host_username).toLowerCase() !== user) {
          return res.status(403).json({ error: "Only the host can invite" });
        }

        const byName = new Map(players.map((p) => [p.username.toLowerCase(), p]));
        for (const name of uniqueInvitees) {
          const existing = byName.get(name);
          if (existing && (existing.status === "accepted" || existing.status === "invited")) {
            return res.status(400).json({
              error: `${name.toUpperCase()} is already in this lobby.`,
            });
          }
        }

        const seated = players.filter(
          (p) => p.status === "accepted" || p.status === "invited" || p.role === "host"
        ).length;
        const adding = uniqueInvitees.filter((name) => {
          const existing = byName.get(name);
          return !existing || existing.status === "declined" || existing.status === "left";
        }).length;
        if (seated + adding > MAX_PLAYERS) {
          return res.status(400).json({
            error: `Break the Code allows at most ${MAX_PLAYERS} players.`,
          });
        }

        const availErr = await assertInviteesAvailable(client, uniqueInvitees);
        if (availErr) return res.status(400).json({ error: availErr });

        let nextSeat = players.reduce((m, p) => Math.max(m, p.seat_index ?? 0), 0) + 1;
        for (const invitee of uniqueInvitees) {
          const existing = byName.get(invitee);
          if (existing) {
            await client.query(
              `UPDATE bc_room_players SET status='invited', role='player'
               WHERE room_id=$1 AND username=$2`,
              [room_id, invitee]
            );
          } else {
            await client.query(
              `INSERT INTO bc_room_players (room_id, username, role, status, seat_index)
               VALUES ($1,$2,'player','invited',$3)`,
              [room_id, invitee, nextSeat++]
            );
          }
          await ablyPublish(LOBBY_CHANNEL, "invite", {
            invitee,
            host: user,
            room_id,
          });
        }

        const updated = await getRoomWithPlayers(client, room_id);
        await ablyPublish(roomChannel(room_id), "player-status", { players: updated.players });
        return res.status(200).json({ ok: true, players: updated.players });
      }

      // Host starts the game — no game engine yet, so this just flips the room to
      // 'active' and cancels any invites that never got accepted.
      if (action === "start") {
        const { room, players } = await getRoomWithPlayers(client, room_id);
        if (!room) return res.status(404).json({ error: "room not found" });
        if (room.status !== "lobby") {
          return res.status(400).json({ error: "That lobby is no longer open." });
        }
        if (String(room.host_username).toLowerCase() !== user) {
          return res.status(403).json({ error: "Only the host can start the game" });
        }
        const seated = players.filter(
          (p) => p.role === "host" || p.status === "accepted"
        ).length;
        if (seated < MIN_PLAYERS) {
          return res.status(400).json({
            error: `Need at least ${MIN_PLAYERS} players to start.`,
          });
        }

        const cancelledInvites = players
          .filter((p) => p.status === "invited")
          .map((p) => p.username);

        await client.query(
          `UPDATE bc_room_players SET status='left' WHERE room_id=$1 AND status='invited'`,
          [room_id]
        );
        await client.query(
          `UPDATE bc_rooms SET status='active', started_at=NOW() WHERE id=$1`,
          [room_id]
        );
        for (const invitee of cancelledInvites) {
          await ablyPublish(LOBBY_CHANNEL, "invite-cancelled", {
            room_id,
            invitee,
            reason: "game_started",
          });
        }
        const updated = await getRoomWithPlayers(client, room_id);
        await ablyPublish(roomChannel(room_id), "game-start", { players: updated.players });
        return res.status(200).json({ ok: true, players: updated.players, cancelled_invites: cancelledInvites });
      }

      // A single player leaving an already-active room (others keep going).
      if (action === "leave") {
        const { room, players } = await getRoomWithPlayers(client, room_id);
        if (!room) return res.status(404).json({ error: "room not found" });
        await client.query(
          `UPDATE bc_room_players SET status='left' WHERE room_id=$1 AND username=$2`,
          [room_id, user]
        );
        const remaining = players.filter(
          (p) => p.username !== user && (p.status === "accepted" || p.role === "host")
        );
        if (remaining.length < MIN_PLAYERS) {
          await client.query(
            `UPDATE bc_rooms SET status='abandoned', ended_at=NOW() WHERE id=$1`,
            [room_id]
          );
          await ablyPublish(roomChannel(room_id), "room-abandoned", { room_id, abandoned_by: user });
          return res.status(200).json({ ok: true, ended: true });
        }
        const updated = await getRoomWithPlayers(client, room_id);
        await ablyPublish(roomChannel(room_id), "player-status", { players: updated.players });
        return res.status(200).json({ ok: true, players: updated.players });
      }

      if (action === "abandon") {
        await client.query(
          `UPDATE bc_rooms SET status='abandoned', ended_at=NOW() WHERE id=$1`,
          [room_id]
        );
        await client.query(
          `UPDATE bc_room_players SET status='left' WHERE room_id=$1 AND status IN ('playing','accepted','invited')`,
          [room_id]
        );
        const payload = { room_id, abandoned_by: user };
        await ablyPublish(roomChannel(room_id), "room-abandoned", payload);
        await ablyPublish(LOBBY_CHANNEL, "room-abandoned", payload);
        return res.status(200).json({ ok: true });
      }

      return res.status(400).json({ error: `Unknown action: ${action}` });
    }

    return res.status(405).json({ error: "Method not allowed" });
  } finally {
    client.release();
  }
}
