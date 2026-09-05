/**
 * End-to-end lobby / invite scenario simulations against Neon.
 * Ably is mocked (BC_ABLY_MOCK=1) so we assert published events without a live Ably account.
 *
 * Setup: copy `.env.example` → `.env.local` and set NEON_DATABASE_URL.
 * Run from the breakthecode/ folder: npm run test:lobby
 */
import "./load-env.js";
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { getPool, ensureBcTables } from "../api/db.js";
import { clearAblyMockMessages, getAblyMockMessages, LOBBY_CHANNEL } from "../api/ably.js";
import roomHandler from "../api/bc-room.js";
import gameHandler from "../api/bc-game.js";
import heartbeatHandler from "../api/bc-heartbeat.js";

process.env.BC_ABLY_MOCK = "1";

const hasDb = !!process.env.NEON_DATABASE_URL;
const describeLobby = hasDb ? describe : describe.skip;

function mockRes() {
  const out = { statusCode: 200, body: null, headers: {} };
  const res = {
    setHeader(k, v) {
      out.headers[k] = v;
    },
    status(code) {
      out.statusCode = code;
      return res;
    },
    json(body) {
      out.body = body;
      return res;
    },
    end() {
      return res;
    },
  };
  res._out = out;
  return res;
}

async function call(handler, { method, body, query } = {}) {
  const req = {
    method: method || "GET",
    body: body || {},
    query: query || {},
  };
  const res = mockRes();
  await handler(req, res);
  return res._out;
}

async function heartbeat(username) {
  return call(heartbeatHandler, {
    method: "POST",
    body: { username },
  });
}

async function leaveLobby(username) {
  return call(heartbeatHandler, {
    method: "POST",
    body: { username, leave: true },
  });
}

async function presence() {
  return call(heartbeatHandler, { method: "GET" });
}

async function wipeBcTables() {
  const client = await getPool().connect();
  try {
    await ensureBcTables(client);
    await client.query(
      `TRUNCATE bc_lobby, bc_room_players, bc_rooms RESTART IDENTITY CASCADE`
    );
  } finally {
    client.release();
  }
}

function statusByUser(players) {
  const m = {};
  for (const p of players || []) m[p.username] = p.status;
  return m;
}

describeLobby("breakthecode lobby invite scenarios", () => {
  before(async () => {
    await wipeBcTables();
  });

  after(async () => {
    await wipeBcTables();
    await getPool().end();
  });

  beforeEach(async () => {
    await wipeBcTables();
    clearAblyMockMessages();
  });

  it("Sidney invites Parker; Parker accepts; presence shows Host/Ready/Available for Caroline", async () => {
    await heartbeat("sidney");
    await heartbeat("parker");
    await heartbeat("caroline");

    const created = await call(roomHandler, {
      method: "POST",
      body: { username: "sidney", invitees: ["parker"] },
    });
    assert.equal(created.statusCode, 200);
    assert.ok(created.body.room_id);
    const roomId = created.body.room_id;

    const invites = getAblyMockMessages().filter(
      (m) => m.name === "invite" && m.data.invitee === "parker"
    );
    assert.equal(invites.length, 1);

    const accepted = await call(roomHandler, {
      method: "PATCH",
      body: { action: "accept", room_id: roomId, username: "parker" },
    });
    assert.equal(accepted.statusCode, 200);

    const room = await call(roomHandler, {
      method: "GET",
      query: { room_id: roomId },
    });
    const by = statusByUser(room.body.players);
    assert.equal(by.sidney, "accepted");
    assert.equal(by.parker, "accepted");

    const list = await presence();
    const map = Object.fromEntries(
      (list.body.players || []).map((p) => [p.username, p.status])
    );
    assert.equal(map.sidney, "host");
    assert.equal(map.parker, "ready");
    assert.equal(map.caroline, "available");
  });

  it("rejects a room outside the 2-4 player range", async () => {
    await heartbeat("sidney");
    const tooMany = await call(roomHandler, {
      method: "POST",
      body: { username: "sidney", invitees: ["a", "b", "c", "d"] },
    });
    assert.equal(tooMany.statusCode, 400);
    assert.match(tooMany.body.error, /2-4 players/);
  });

  it("decline returns host to empty lobby room that can re-invite after abandon path", async () => {
    await heartbeat("sidney");
    await heartbeat("parker");

    const created = await call(roomHandler, {
      method: "POST",
      body: { username: "sidney", invitees: ["parker"] },
    });
    const roomId = created.body.room_id;

    const declined = await call(roomHandler, {
      method: "PATCH",
      body: { action: "decline", room_id: roomId, username: "parker" },
    });
    assert.equal(declined.statusCode, 200);

    const room = await call(roomHandler, {
      method: "GET",
      query: { room_id: roomId },
    });
    const by = statusByUser(room.body.players);
    assert.equal(by.parker, "declined");

    // No pending invites / accepted guests → UI would abandon; simulate abandon.
    const abandoned = await call(roomHandler, {
      method: "PATCH",
      body: { action: "abandon", room_id: roomId, username: "sidney" },
    });
    assert.equal(abandoned.statusCode, 200);
    assert.ok(
      getAblyMockMessages().some(
        (m) => m.channel === LOBBY_CHANNEL && m.name === "room-abandoned"
      )
    );

    // Parker is available again and can be invited into a new room.
    await heartbeat("parker");
    const again = await call(roomHandler, {
      method: "POST",
      body: { username: "sidney", invitees: ["parker"] },
    });
    assert.equal(again.statusCode, 200);
    assert.notEqual(again.body.room_id, roomId);
  });

  it("re-invite declined player into same open lobby via invite action", async () => {
    await heartbeat("sidney");
    await heartbeat("parker");
    await heartbeat("caroline");

    const created = await call(roomHandler, {
      method: "POST",
      body: { username: "sidney", invitees: ["parker"] },
    });
    const roomId = created.body.room_id;
    await call(roomHandler, {
      method: "PATCH",
      body: { action: "accept", room_id: roomId, username: "parker" },
    });

    await call(roomHandler, {
      method: "PATCH",
      body: { action: "invite", room_id: roomId, username: "sidney", invitees: ["caroline"] },
    });
    await call(roomHandler, {
      method: "PATCH",
      body: { action: "decline", room_id: roomId, username: "caroline" },
    });

    clearAblyMockMessages();
    const reinv = await call(roomHandler, {
      method: "PATCH",
      body: { action: "invite", room_id: roomId, username: "sidney", invitees: ["caroline"] },
    });
    assert.equal(reinv.statusCode, 200);
    const by = statusByUser(reinv.body.players);
    assert.equal(by.caroline, "invited");
    assert.ok(
      getAblyMockMessages().some(
        (m) => m.name === "invite" && m.data.invitee === "caroline"
      )
    );
  });

  it("cannot invite a 5th player (max 4)", async () => {
    await heartbeat("sidney");
    await heartbeat("parker");
    await heartbeat("caroline");
    await heartbeat("dana");
    await heartbeat("eve");

    const created = await call(roomHandler, {
      method: "POST",
      body: { username: "sidney", invitees: ["parker", "caroline", "dana"] },
    });
    const roomId = created.body.room_id;

    const over = await call(roomHandler, {
      method: "PATCH",
      body: { action: "invite", room_id: roomId, username: "sidney", invitees: ["eve"] },
    });
    assert.equal(over.statusCode, 400);
    assert.match(over.body.error, /at most 4 players/);
  });

  it("starting the game withdraws pending invites and publishes invite-cancelled", async () => {
    await heartbeat("sidney");
    await heartbeat("parker");
    await heartbeat("caroline");

    const created = await call(roomHandler, {
      method: "POST",
      body: { username: "sidney", invitees: ["parker"] },
    });
    const roomId = created.body.room_id;
    await call(roomHandler, {
      method: "PATCH",
      body: { action: "accept", room_id: roomId, username: "parker" },
    });
    await call(roomHandler, {
      method: "PATCH",
      body: { action: "invite", room_id: roomId, username: "sidney", invitees: ["caroline"] },
    });

    clearAblyMockMessages();
    const started = await call(gameHandler, {
      method: "PATCH",
      body: { action: "start", room_id: roomId, username: "sidney" },
    });
    assert.equal(started.statusCode, 200);
    assert.deepEqual(started.body.cancelled_invites, ["caroline"]);
    assert.ok(
      getAblyMockMessages().some(
        (m) =>
          m.channel === LOBBY_CHANNEL &&
          m.name === "invite-cancelled" &&
          m.data.reason === "game_started"
      )
    );

    const room = await call(roomHandler, {
      method: "GET",
      query: { room_id: roomId },
    });
    assert.equal(room.body.room.status, "active");
    const by = statusByUser(room.body.players);
    assert.equal(by.sidney, "accepted");
    assert.equal(by.parker, "accepted");
    assert.equal(by.caroline, "left");

    // Accept after start must fail.
    const lateAccept = await call(roomHandler, {
      method: "PATCH",
      body: { action: "accept", room_id: roomId, username: "caroline" },
    });
    assert.equal(lateAccept.statusCode, 400);

    // Active-game players are hidden from lobby presence.
    await leaveLobby("sidney");
    await leaveLobby("parker");
    await heartbeat("caroline");
    const list = await presence();
    const names = (list.body.players || []).map((p) => p.username);
    assert.ok(!names.includes("sidney"));
    assert.ok(!names.includes("parker"));
    assert.ok(names.includes("caroline"));
  });

  it("a single player leaving an active game does not end it for the rest", async () => {
    await heartbeat("sidney");
    await heartbeat("parker");
    await heartbeat("caroline");

    const created = await call(roomHandler, {
      method: "POST",
      body: { username: "sidney", invitees: ["parker", "caroline"] },
    });
    const roomId = created.body.room_id;
    await call(roomHandler, {
      method: "PATCH",
      body: { action: "accept", room_id: roomId, username: "parker" },
    });
    await call(roomHandler, {
      method: "PATCH",
      body: { action: "accept", room_id: roomId, username: "caroline" },
    });
    await call(gameHandler, {
      method: "PATCH",
      body: { action: "start", room_id: roomId, username: "sidney" },
    });

    const left = await call(gameHandler, {
      method: "PATCH",
      body: { action: "leave", room_id: roomId, username: "caroline" },
    });
    assert.equal(left.statusCode, 200);
    assert.ok(!left.body.ended);

    const room = await call(roomHandler, {
      method: "GET",
      query: { room_id: roomId },
    });
    assert.equal(room.body.room.status, "active");
    const by = statusByUser(room.body.players);
    assert.equal(by.caroline, "left");
    assert.equal(by.sidney, "accepted");
    assert.equal(by.parker, "accepted");
  });

  it("leaving an active 2-player game ends it (below MIN_PLAYERS)", async () => {
    await heartbeat("sidney");
    await heartbeat("parker");

    const created = await call(roomHandler, {
      method: "POST",
      body: { username: "sidney", invitees: ["parker"] },
    });
    const roomId = created.body.room_id;
    await call(roomHandler, {
      method: "PATCH",
      body: { action: "accept", room_id: roomId, username: "parker" },
    });
    await call(gameHandler, {
      method: "PATCH",
      body: { action: "start", room_id: roomId, username: "sidney" },
    });

    const left = await call(gameHandler, {
      method: "PATCH",
      body: { action: "leave", room_id: roomId, username: "parker" },
    });
    assert.equal(left.statusCode, 200);
    assert.ok(left.body.ended);

    const room = await call(roomHandler, {
      method: "GET",
      query: { room_id: roomId },
    });
    assert.equal(room.body.room.status, "abandoned");
  });

  it("cannot invite someone who is already in another lobby room", async () => {
    await heartbeat("sidney");
    await heartbeat("parker");
    await heartbeat("caroline");

    const a = await call(roomHandler, {
      method: "POST",
      body: { username: "sidney", invitees: ["parker"] },
    });
    assert.equal(a.statusCode, 200);
    await call(roomHandler, {
      method: "PATCH",
      body: { action: "accept", room_id: a.body.room_id, username: "parker" },
    });

    const b = await call(roomHandler, {
      method: "POST",
      body: { username: "caroline", invitees: ["parker"] },
    });
    assert.equal(b.statusCode, 400);
    assert.match(b.body.error || "", /not available/i);
  });

  it("pending invites list only while room is still lobby + invited", async () => {
    await heartbeat("sidney");
    await heartbeat("parker");

    const created = await call(roomHandler, {
      method: "POST",
      body: { username: "sidney", invitees: ["parker"] },
    });
    const roomId = created.body.room_id;

    const pending = await call(roomHandler, {
      method: "GET",
      query: { username: "parker" },
    });
    assert.equal(pending.body.room_id, null);
    assert.equal(pending.body.pending_invites.length, 1);
    assert.equal(pending.body.pending_invites[0].room_id, roomId);

    await call(roomHandler, {
      method: "PATCH",
      body: { action: "accept", room_id: roomId, username: "parker" },
    });
    await call(gameHandler, {
      method: "PATCH",
      body: { action: "start", room_id: roomId, username: "sidney" },
    });

    const after = await call(roomHandler, {
      method: "GET",
      query: { username: "parker" },
    });
    assert.equal(after.body.pending_invites.length, 0);
    assert.equal(after.body.room?.status, "active");
  });

  /** Simulate a finished game without playing it out turn-by-turn. */
  async function forceGameOver(roomId, winners) {
    const client = await getPool().connect();
    try {
      const { rows } = await client.query(`SELECT game_state FROM bc_rooms WHERE id=$1`, [roomId]);
      const state = rows[0].game_state;
      state.phase = "game_over";
      state.winners = winners;
      await client.query(
        `UPDATE bc_rooms SET status='finished', ended_at=NOW(), game_state=$2 WHERE id=$1`,
        [roomId, JSON.stringify(state)]
      );
      return state;
    } finally {
      client.release();
    }
  }

  it("host can restart a finished game; starting player rotates", async () => {
    await heartbeat("sidney");
    await heartbeat("parker");
    const created = await call(roomHandler, {
      method: "POST",
      body: { username: "sidney", invitees: ["parker"] },
    });
    const roomId = created.body.room_id;
    await call(roomHandler, {
      method: "PATCH",
      body: { action: "accept", room_id: roomId, username: "parker" },
    });
    await call(gameHandler, {
      method: "PATCH",
      body: { action: "start", room_id: roomId, username: "sidney" },
    });
    await forceGameOver(roomId, ["sidney"]);

    const deniedNonHost = await call(gameHandler, {
      method: "PATCH",
      body: { action: "restart", room_id: roomId, username: "parker" },
    });
    assert.equal(deniedNonHost.statusCode, 403);

    const restarted = await call(gameHandler, {
      method: "PATCH",
      body: { action: "restart", room_id: roomId, username: "sidney" },
    });
    assert.equal(restarted.statusCode, 200);

    const room = await call(roomHandler, { method: "GET", query: { room_id: roomId } });
    assert.equal(room.body.room.status, "active");

    const view = await call(gameHandler, {
      method: "GET",
      query: { room_id: roomId, username: "sidney" },
    });
    assert.equal(view.body.state.phase, "playing");
    assert.deepEqual(view.body.state.winners, []);
    // Sidney started the first game; parker should start the rematch.
    assert.equal(view.body.state.startingPlayer, "parker");
  });

  it("leaving a finished game removes the player without abandoning the room", async () => {
    await heartbeat("sidney");
    await heartbeat("parker");
    const created = await call(roomHandler, {
      method: "POST",
      body: { username: "sidney", invitees: ["parker"] },
    });
    const roomId = created.body.room_id;
    await call(roomHandler, {
      method: "PATCH",
      body: { action: "accept", room_id: roomId, username: "parker" },
    });
    await call(gameHandler, {
      method: "PATCH",
      body: { action: "start", room_id: roomId, username: "sidney" },
    });
    await forceGameOver(roomId, ["sidney"]);

    clearAblyMockMessages();
    const left = await call(gameHandler, {
      method: "PATCH",
      body: { action: "leave", room_id: roomId, username: "parker" },
    });
    assert.equal(left.statusCode, 200);
    assert.ok(!left.body.ended);
    assert.ok(
      !getAblyMockMessages().some((m) => m.name === "room-abandoned"),
      "a finished game should not be reported as abandoned"
    );

    const room = await call(roomHandler, { method: "GET", query: { room_id: roomId } });
    assert.equal(room.body.room.status, "finished");
    const by = statusByUser(room.body.players);
    assert.equal(by.parker, "left");
  });
});
