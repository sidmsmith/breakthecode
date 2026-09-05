/**
 * Break the Code (Tagiron-style deduction game) — pure game engine.
 *
 * No DB / network here — this module is deterministic given an `rng` and is
 * unit tested directly (see bc-engine.test.js). api/bc-game.js is the only
 * caller: it loads/saves the JSON this produces from bc_rooms.game_state.
 *
 * Digital-adaptation choice: instead of a human answering questions "honestly",
 * the server computes the true answer from the target's real hand. This turns
 * the game from an honesty-based tabletop game into a fully mechanical one —
 * no separate "answer" step, no risk of a misspoken answer.
 */

const LETTERS = ["a", "b", "c", "d", "e"];
const COLOR_RANK = { black: 0, green: 1, white: 2 };

export function buildMasterDeck() {
  const tiles = [];
  for (let num = 0; num <= 9; num++) {
    if (num === 5) {
      tiles.push({ num, color: "green" });
      tiles.push({ num, color: "green" });
    } else {
      tiles.push({ num, color: "black" });
      tiles.push({ num, color: "white" });
    }
  }
  return tiles;
}

export const MASTER_DECK = buildMasterDeck();

/** Deal counts per player count, per the rulebook's setup chart. */
export function dealCounts(playerCount) {
  if (playerCount === 2) return { perPlayer: 5, central: 0 };
  if (playerCount === 3) return { perPlayer: 5, central: 5 };
  if (playerCount === 4) return { perPlayer: 4, central: 4 };
  throw new Error(`Break the Code supports 2-4 players, got ${playerCount}`);
}

export function shuffle(array, rng = Math.random) {
  const a = array.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Ascending by number; same number ties broken black-before-white (rule-specified). */
export function sortHand(tiles) {
  return tiles.slice().sort((a, b) => {
    if (a.num !== b.num) return a.num - b.num;
    return COLOR_RANK[a.color] - COLOR_RANK[b.color];
  });
}

function tileKey(t) {
  return `${t.num}:${t.color}`;
}

function lettersFor(handLength) {
  return LETTERS.slice(0, handLength);
}

// ── Question card catalog (21 cards, mirroring the box's 21-card count) ────
function positionsWhere(hand, predicate) {
  const letters = lettersFor(hand.length);
  const hits = [];
  hand.forEach((t, i) => {
    if (predicate(t)) hits.push(letters[i]);
  });
  return hits;
}

function neighborGroups(hand, matches) {
  const letters = lettersFor(hand.length);
  const groups = [];
  let current = null;
  for (let i = 0; i < hand.length - 1; i++) {
    if (matches(hand[i], hand[i + 1])) {
      if (!current) current = [letters[i]];
      current.push(letters[i + 1]);
    } else if (current) {
      groups.push(current);
      current = null;
    }
  }
  if (current) groups.push(current);
  return groups;
}

function formatLetters(letters) {
  return letters.length ? letters.join(", ") : "None";
}

function formatGroups(groups) {
  if (!groups.length) return "None";
  return groups.map((g) => g.join("-")).join("; ");
}

function countCard(id, text, predicate) {
  return {
    id,
    text,
    compute: (hand) => hand.filter(predicate).length,
    format: (n) => `${n}`,
  };
}

function whereCard(num) {
  return {
    id: `where-${num}`,
    text: `Where are your #${num} tiles (if any)?`,
    compute: (hand) => positionsWhere(hand, (t) => t.num === num),
    format: formatLetters,
  };
}

export const CARD_DEFINITIONS = [
  countCard("odd-count", "How many of your tiles show an ODD number?", (t) => t.num % 2 === 1),
  countCard("even-count", "How many of your tiles show an EVEN number?", (t) => t.num % 2 === 0),
  countCard("black-count", "How many of your tiles are BLACK?", (t) => t.color === "black"),
  countCard("white-count", "How many of your tiles are WHITE?", (t) => t.color === "white"),
  countCard("green-count", "How many of your tiles are GREEN (5s)?", (t) => t.color === "green"),
  countCard("low-count", "How many of your tiles are 0-4?", (t) => t.num <= 4),
  countCard("high-count", "How many of your tiles are 5-9?", (t) => t.num >= 5),
  {
    id: "lowest-position",
    text: "Which position holds your LOWEST numbered tile?",
    compute: (hand) => lettersFor(hand.length)[0],
    format: (v) => v,
  },
  {
    id: "highest-position",
    text: "Which position holds your HIGHEST numbered tile?",
    compute: (hand) => lettersFor(hand.length)[hand.length - 1],
    format: (v) => v,
  },
  ...[0, 1, 2, 3, 4, 6, 7, 8, 9].map(whereCard),
  whereCard(5),
  {
    id: "same-color-neighbors",
    text: "Which neighboring tiles share the same color?",
    compute: (hand) => neighborGroups(hand, (a, b) => a.color === b.color),
    format: formatGroups,
  },
  {
    id: "consecutive-neighbors",
    text: "Which neighboring tiles have consecutive numbers?",
    compute: (hand) => neighborGroups(hand, (a, b) => Math.abs(a.num - b.num) === 1),
    format: formatGroups,
  },
];

const CARD_BY_ID = new Map(CARD_DEFINITIONS.map((c) => [c.id, c]));

// ── Setup ───────────────────────────────────────────────────────────────────
export function dealGame(players, rng = Math.random) {
  const { perPlayer, central } = dealCounts(players.length);
  const deck = shuffle(MASTER_DECK, rng);
  const hands = {};
  let cursor = 0;
  for (const username of players) {
    hands[username] = sortHand(deck.slice(cursor, cursor + perPlayer));
    cursor += perPlayer;
  }
  const centralTiles = sortHand(deck.slice(cursor, cursor + central));
  return { hands, central: centralTiles };
}

export function buildInitialState({ players, hostUsername, rng = Math.random }) {
  if (!players.includes(hostUsername)) {
    throw new Error("hostUsername must be one of players");
  }
  const { hands, central } = dealGame(players, rng);
  const cardDeck = shuffle(CARD_DEFINITIONS.map((c) => c.id), rng);
  const board = cardDeck.slice(0, 6);
  const drawPile = cardDeck.slice(6);

  return {
    playerCount: players.length,
    players: players.slice(),
    hostUsername,
    hands,
    central,
    board,
    drawPile,
    turnOrder: players.slice(),
    turnIndex: 0,
    startingPlayer: players[0],
    phase: "playing",
    finalChanceUsername: null,
    decided: {}, // username -> 'won' | 'lost' (3-4p only)
    left: {}, // username -> true (left mid-game)
    winners: [],
    log: [],
    turnNumber: 0,
    closureCountdown: null, // set on first correct group guess (3-4p only); see tickClosureCountdown
  };
}

// ── Turn helpers ─────────────────────────────────────────────────────────────
function isOut(state, username) {
  return !!state.decided[username] || !!state.left[username];
}

function activePlayers(state) {
  return state.turnOrder.filter((u) => !isOut(state, u));
}

export function currentPlayer(state) {
  if (state.phase === "final_chance") return state.finalChanceUsername;
  if (state.phase !== "playing") return null;
  return state.turnOrder[state.turnIndex];
}

/** Advance turnIndex past any already-decided/left players. Ends the game if none remain. */
function advanceTurn(state) {
  const n = state.turnOrder.length;
  for (let step = 0; step < n; step++) {
    state.turnIndex = (state.turnIndex + 1) % n;
    const u = state.turnOrder[state.turnIndex];
    if (!isOut(state, u)) return;
  }
  // Everyone is decided/left — nothing left to do.
  if (state.phase === "playing") endGame(state);
}

function endGame(state) {
  state.phase = "game_over";
}

function checkDeckExhausted(state) {
  if (state.board.length === 0 && state.phase === "playing") {
    endGame(state);
  }
}

/**
 * Once the first player correctly guesses the central tiles (3-4p only), every
 * other still-active player gets exactly one more turn before the game ends —
 * "all players complete the current round" per the rulebook. Call after every
 * turn (ask or guess) once closureCountdown has been set.
 */
function tickClosureCountdown(state) {
  if (state.closureCountdown == null || state.phase !== "playing") return;
  state.closureCountdown -= 1;
  if (state.closureCountdown <= 0) endGame(state);
}

function replaceCard(state, cardId) {
  const idx = state.board.indexOf(cardId);
  state.board.splice(idx, 1);
  if (state.drawPile.length > 0) {
    state.board.push(state.drawPile.shift());
  }
}

// ── Actions ──────────────────────────────────────────────────────────────────
export function askQuestion(state, { username, cardId }) {
  if (state.phase !== "playing") throw new Error("Game is not accepting questions right now.");
  if (currentPlayer(state) !== username) throw new Error("It is not your turn.");
  if (!state.board.includes(cardId)) throw new Error("That question card is not available.");

  const def = CARD_BY_ID.get(cardId);
  if (!def) throw new Error("Unknown question card.");

  const respondents =
    state.playerCount === 4
      ? state.turnOrder.slice()
      : state.turnOrder.filter((u) => u !== username);

  const answers = respondents.map((u) => {
    const value = def.compute(state.hands[u]);
    return { username: u, answerText: def.format(value) };
  });

  state.turnNumber += 1;
  state.log.push({
    turnNumber: state.turnNumber,
    type: "question",
    askedBy: username,
    cardId,
    cardText: def.text,
    answers,
  });

  replaceCard(state, cardId);
  checkDeckExhausted(state);
  if (state.phase === "playing") {
    advanceTurn(state);
    tickClosureCountdown(state);
  }
  return state;
}

function canonicalTarget(state, username) {
  if (state.playerCount === 2) {
    const opponent = state.turnOrder.find((u) => u !== username);
    return { kind: "hand", owner: opponent, tiles: state.hands[opponent] };
  }
  return { kind: "central", owner: null, tiles: state.central };
}

function tilesEqual(guess, truth) {
  if (guess.length !== truth.length) return false;
  const sortedGuess = sortHand(guess);
  const sortedTruth = sortHand(truth);
  return sortedGuess.every(
    (t, i) => t.num === sortedTruth[i].num && t.color === sortedTruth[i].color
  );
}

/** Validate the guess is a feasible sub-multiset of the physical 20-tile deck. */
export function validateGuessShape(guess, requiredLength) {
  if (!Array.isArray(guess) || guess.length !== requiredLength) {
    return `Guess must have exactly ${requiredLength} tiles.`;
  }
  const counts = new Map();
  for (const t of guess) {
    if (typeof t?.num !== "number" || t.num < 0 || t.num > 9) {
      return "Every tile needs a number from 0-9.";
    }
    const validColor =
      t.num === 5 ? t.color === "green" : t.color === "black" || t.color === "white";
    if (!validColor) {
      return t.num === 5 ? "The 5 tile is always green." : "Tiles must be black or white (except 5).";
    }
    const key = tileKey(t);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const maxCounts = new Map();
  for (const t of MASTER_DECK) {
    const key = tileKey(t);
    maxCounts.set(key, (maxCounts.get(key) || 0) + 1);
  }
  for (const [key, count] of counts) {
    if (count > (maxCounts.get(key) || 0)) {
      return "That guess uses a tile more times than exists in the deck.";
    }
  }
  return null;
}

export function guessTiles(state, { username, guess }) {
  if (state.phase === "final_chance") {
    if (username !== state.finalChanceUsername) {
      throw new Error("Only the player with the final chance may guess right now.");
    }
  } else if (state.phase !== "playing") {
    throw new Error("Game is not accepting guesses right now.");
  } else if (currentPlayer(state) !== username) {
    throw new Error("It is not your turn.");
  }
  if (state.playerCount >= 3 && isOut(state, username)) {
    throw new Error("You already made your one guess.");
  }

  const target = canonicalTarget(state, username);
  const shapeError = validateGuessShape(guess, target.tiles.length);
  if (shapeError) throw new Error(shapeError);

  const correct = tilesEqual(guess, target.tiles);

  state.turnNumber += 1;
  state.log.push({
    turnNumber: state.turnNumber,
    type: "guess",
    username,
    correct,
  });

  if (state.playerCount === 2) {
    resolveTwoPlayerGuess(state, username, correct);
  } else {
    resolveGroupGuess(state, username, correct);
  }

  return state;
}

function resolveTwoPlayerGuess(state, username, correct) {
  if (state.phase === "final_chance") {
    // This IS the other player's one immediate reply-guess.
    state.winners = correct ? state.turnOrder.slice() : [state.startingPlayer];
    endGame(state);
    return;
  }

  if (!correct) {
    advanceTurn(state);
    return;
  }

  if (username === state.startingPlayer) {
    const opponent = state.turnOrder.find((u) => u !== username);
    state.phase = "final_chance";
    state.finalChanceUsername = opponent;
    return;
  }

  state.winners = [username];
  endGame(state);
}

function resolveGroupGuess(state, username, correct) {
  state.decided[username] = correct ? "won" : "lost";
  if (correct) state.winners.push(username);

  const stillActive = activePlayers(state); // already excludes username, just decided above

  // First correct guess: everyone else still active owes exactly one more turn.
  // This same turn does NOT count against that countdown — it's what started it.
  const justStartedClosure = correct && state.closureCountdown == null;
  if (justStartedClosure) {
    state.closureCountdown = stillActive.length;
  }

  if (stillActive.length === 0) {
    endGame(state);
    return;
  }

  advanceTurn(state);
  if (!justStartedClosure) tickClosureCountdown(state);
}

export function markPlayerLeft(state, username) {
  if (state.phase !== "playing" && state.phase !== "final_chance") return state;
  const wasActive = !isOut(state, username);
  state.left[username] = true;
  if (state.phase === "final_chance" && state.finalChanceUsername === username) {
    // The one player who owed a final guess is gone — no one can dispute the win.
    state.winners = [state.startingPlayer];
    endGame(state);
    return state;
  }
  // They were still owed a turn in the closing lap — that turn will now never
  // happen, so count it as done rather than stalling the countdown forever.
  if (wasActive && state.closureCountdown != null) {
    tickClosureCountdown(state);
  }
  if (state.phase === "playing" && activePlayers(state).length === 0) {
    endGame(state);
    return state;
  }
  if (state.phase === "playing" && currentPlayer(state) === username) {
    // Reassigning whose turn it is, not a turn being taken — already ticked above.
    advanceTurn(state);
  }
  return state;
}

// ── Redaction (hide everyone else's tiles from the viewer) ──────────────────
export function redactStateForViewer(state, viewerUsername) {
  const revealed = state.phase === "game_over";
  const myHand = state.hands[viewerUsername] || null;

  const base = {
    phase: state.phase,
    playerCount: state.playerCount,
    players: state.players,
    startingPlayer: state.startingPlayer,
    turnOrder: state.turnOrder,
    currentPlayer: currentPlayer(state),
    finalChanceUsername: state.finalChanceUsername,
    winners: state.winners,
    decided: state.decided,
    left: state.left,
    board: state.board.map((id) => ({ cardId: id, text: CARD_BY_ID.get(id).text })),
    deckRemaining: state.drawPile.length,
    log: state.log,
    myHand: myHand ? myHand.map((t, i) => ({ ...t, position: LETTERS[i] })) : null,
  };

  if (state.playerCount === 2) {
    const opponent = state.turnOrder.find((u) => u !== viewerUsername);
    base.opponent = {
      username: opponent,
      tileCount: state.hands[opponent]?.length ?? 0,
      revealedHand: revealed
        ? state.hands[opponent].map((t, i) => ({ ...t, position: LETTERS[i] }))
        : null,
    };
  } else {
    base.centralCount = state.central.length;
    base.revealedCentral = revealed
      ? state.central.map((t, i) => ({ ...t, position: LETTERS[i] }))
      : null;
    base.opponents = state.turnOrder
      .filter((u) => u !== viewerUsername)
      .map((u) => ({
        username: u,
        tileCount: state.hands[u]?.length ?? 0,
        decided: state.decided[u] || null,
        left: !!state.left[u],
      }));
  }

  return base;
}
