import { getPool, cors, ensureBcTables } from "./db.js";
import { ablyPublish, LOBBY_CHANNEL, roomChannel } from "./ably.js";
import { MIN_PLAYERS } from "../lib/bc-constants.js";
import {
  buildInitialState,
  askQuestion,
  guessTiles,
  markPlayerLeft,
  redactStateForViewer,
} from "../lib/bc-engine.js";

async function loadRoom(client, roomId) {
  const { rows: roomRows } = await client.query(`SELECT * FROM bc_rooms WHERE id = $1`, [roomId]);
  const { rows: players } = await client.query(
    `SELECT username, role, status, seat_index
     FROM bc_room_players WHERE room_id = $1 ORDER BY seat_index ASC NULLS LAST, role DESC`,
    [roomId]
  );
  return { room: roomRows[0] || null, players };
}

async function saveState(client, roomId, state) {
  await client.query(`UPDATE bc_rooms SET game_state = $2 WHERE id = $1`, [
    roomId,
    JSON.stringify(state),
  ]);
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(200).end();

  const client = await getPool().connect();
  try {
    await ensureBcTables(client);

    if (req.method === "GET") {
      const { room_id, username } = req.query;
      if (!room_id || !username) {
        return res.status(400).json({ error: "room_id and username required" });
      }
      const { room } = await loadRoom(client, room_id);
      if (!room) return res.status(404).json({ error: "room not found" });
      if (room.status !== "active" && room.status !== "finished") {
        return res.status(200).json({ room: { status: room.status }, state: null });
      }
      const state = room.game_state;
      if (!state || !state.players.includes(String(username).toLowerCase())) {
        return res.status(403).json({ error: "You are not part of this game." });
      }
      return res.status(200).json({
        room: { status: room.status, hostUsername: room.host_username },
        state: redactStateForViewer(state, String(username).toLowerCase()),
      });
    }

    if (req.method === "PATCH") {
      const { action, room_id, username } = req.body || {};
      const user = username ? String(username).toLowerCase() : null;
      if (!action || !room_id || !user) {
        return res.status(400).json({ error: "action, room_id and username required" });
      }

      if (action === "start") {
        const { room, players } = await loadRoom(client, room_id);
        if (!room) return res.status(404).json({ error: "room not found" });
        if (room.status !== "lobby") {
          return res.status(400).json({ error: "That lobby is no longer open." });
        }
        if (String(room.host_username).toLowerCase() !== user) {
          return res.status(403).json({ error: "Only the host can start the game" });
        }
        const roster = players.filter((p) => p.role === "host" || p.status === "accepted");
        if (roster.length < MIN_PLAYERS) {
          return res.status(400).json({ error: `Need at least ${MIN_PLAYERS} players to start.` });
        }

        const cancelledInvites = players.filter((p) => p.status === "invited").map((p) => p.username);
        await client.query(
          `UPDATE bc_room_players SET status='left' WHERE room_id=$1 AND status='invited'`,
          [room_id]
        );

        const orderedPlayers = roster.map((p) => p.username);
        const state = buildInitialState({ players: orderedPlayers, hostUsername: user });

        await client.query(
          `UPDATE bc_rooms SET status='active', started_at=NOW(), game_state=$2 WHERE id=$1`,
          [room_id, JSON.stringify(state)]
        );
        for (const invitee of cancelledInvites) {
          await ablyPublish(LOBBY_CHANNEL, "invite-cancelled", { room_id, invitee, reason: "game_started" });
        }
        await ablyPublish(roomChannel(room_id), "game-start", {});
        return res.status(200).json({ ok: true, cancelled_invites: cancelledInvites });
      }

      const { room } = await loadRoom(client, room_id);
      if (!room) return res.status(404).json({ error: "room not found" });
      if (room.status !== "active") {
        return res.status(400).json({ error: "This game is not active." });
      }
      const state = room.game_state;
      if (!state || !state.players.includes(user)) {
        return res.status(403).json({ error: "You are not part of this game." });
      }

      if (action === "ask") {
        const { cardId } = req.body || {};
        try {
          askQuestion(state, { username: user, cardId });
        } catch (err) {
          return res.status(400).json({ error: err.message });
        }
        await saveState(client, room_id, state);
        await ablyPublish(roomChannel(room_id), "state-update", {});
        if (state.phase === "game_over") {
          await client.query(`UPDATE bc_rooms SET status='finished', ended_at=NOW() WHERE id=$1`, [room_id]);
        }
        return res.status(200).json({ ok: true, state: redactStateForViewer(state, user) });
      }

      if (action === "guess") {
        const { guess } = req.body || {};
        try {
          guessTiles(state, { username: user, guess });
        } catch (err) {
          return res.status(400).json({ error: err.message });
        }
        await saveState(client, room_id, state);
        await ablyPublish(roomChannel(room_id), "state-update", {});
        if (state.phase === "game_over") {
          await client.query(`UPDATE bc_rooms SET status='finished', ended_at=NOW() WHERE id=$1`, [room_id]);
        }
        return res.status(200).json({ ok: true, state: redactStateForViewer(state, user) });
      }

      if (action === "leave") {
        const remaining = state.players.filter((p) => p !== user && !state.left[p]);
        markPlayerLeft(state, user);
        await client.query(
          `UPDATE bc_room_players SET status='left' WHERE room_id=$1 AND username=$2`,
          [room_id, user]
        );

        if (remaining.length < MIN_PLAYERS) {
          await client.query(
            `UPDATE bc_rooms SET status='abandoned', ended_at=NOW(), game_state=$2 WHERE id=$1`,
            [room_id, JSON.stringify(state)]
          );
          await ablyPublish(roomChannel(room_id), "room-abandoned", { room_id, abandoned_by: user });
          return res.status(200).json({ ok: true, ended: true });
        }

        const finished = state.phase === "game_over";
        await client.query(
          `UPDATE bc_rooms SET game_state=$2${finished ? ", status='finished', ended_at=NOW()" : ""} WHERE id=$1`,
          [room_id, JSON.stringify(state)]
        );
        await ablyPublish(roomChannel(room_id), "state-update", { left_by: user });
        return res.status(200).json({ ok: true });
      }

      return res.status(400).json({ error: `Unknown action: ${action}` });
    }

    return res.status(405).json({ error: "Method not allowed" });
  } finally {
    client.release();
  }
}
