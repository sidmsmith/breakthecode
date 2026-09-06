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

// ── Question card catalog (21 cards; 2 are dropped in 4-player games) ─────
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

function countCard(id, text, predicate, hint) {
  return {
    id,
    text,
    hint,
    compute: (hand) => hand.filter(predicate).length,
    format: (n) => `${n}`,
  };
}

// Where cards. `nums` is what this card can ask about: one number = a plain
// "where are your Ns", two = the asker picks which at ask time (choices).
function whereCard(id, nums, hint) {
  const choose = nums.length > 1;
  return {
    id,
    text: choose
      ? `Where is your ${nums.join(" or ")}? (you pick which)`
      : `Where are your ${nums[0]}s (if any)?`,
    hint: hint || (choose ? "You choose which number to ask about." : undefined),
    choices: choose ? nums.slice() : undefined,
    resolvedText: (choice) => `Where are your ${choose ? choice : nums[0]}s?`,
    compute: (hand, choice) => {
      const n = choose ? choice : nums[0];
      return positionsWhere(hand, (t) => t.num === n);
    },
    format: formatLetters,
  };
}

const sumWhere = (hand, pred) => hand.filter(pred).reduce((s, t) => s + t.num, 0);
const sumAt = (hand, idxs) => idxs.reduce((s, i) => s + (hand[i] ? hand[i].num : 0), 0);

export const CARD_DEFINITIONS = [
  // ── Position / specific number ───────────────────────────────────────────
  whereCard("where-5", [5]),
  whereCard("where-0", [0]),
  whereCard("where-1-2", [1, 2]),
  whereCard("where-3-4", [3, 4]),
  whereCard("where-6-7", [6, 7]),
  whereCard("where-8-9", [8, 9]),
  {
    id: "same-color-neighbors",
    text: "Where do you have neighbouring tiles of the same colour?",
    compute: (hand) => neighborGroups(hand, (a, b) => a.color === b.color),
    format: formatGroups,
  },
  {
    id: "consecutive-neighbors",
    text: "Where do you have neighbouring tiles in consecutive order?",
    compute: (hand) => neighborGroups(hand, (a, b) => Math.abs(a.num - b.num) === 1),
    format: formatGroups,
  },

  // ── Counts ───────────────────────────────────────────────────────────────
  countCard("odd-count", "How many ODD tiles do you have?", (t) => t.num % 2 === 1),
  countCard("even-count", "How many EVEN tiles do you have?", (t) => t.num % 2 === 0, "0 counts as even."),
  countCard("black-count", "How many BLACK tiles do you have?", (t) => t.color === "black"),
  countCard("white-count", "How many WHITE tiles do you have?", (t) => t.color === "white"),
  {
    id: "pairs-count",
    text: "How many pairs of matching numbers do you have?",
    hint: "A pair is two tiles showing the same number.",
    compute: (hand) => {
      const seen = {};
      for (const t of hand) seen[t.num] = (seen[t.num] || 0) + 1;
      return Object.values(seen).filter((c) => c >= 2).length;
    },
    format: (n) => `${n}`,
  },

  // ── Sum / difference / comparison ────────────────────────────────────────
  { id: "sum-left", text: "What is the sum of your three LEFTMOST tiles?", compute: (h) => sumAt(h, [0, 1, 2]), format: (n) => `${n}` },
  { id: "sum-middle", text: "What is the sum of your three MIDDLE tiles?", excludeAt4: true, compute: (h) => sumAt(h, [1, 2, 3]), format: (n) => `${n}` },
  { id: "sum-right", text: "What is the sum of your three RIGHTMOST tiles?", compute: (h) => sumAt(h, [h.length - 3, h.length - 2, h.length - 1]), format: (n) => `${n}` },
  { id: "sum-black", text: "What is the sum of your BLACK tiles?", compute: (h) => sumWhere(h, (t) => t.color === "black"), format: (n) => `${n}` },
  { id: "sum-white", text: "What is the sum of your WHITE tiles?", compute: (h) => sumWhere(h, (t) => t.color === "white"), format: (n) => `${n}` },
  { id: "sum-all", text: "What is the sum of ALL your tiles?", compute: (h) => sumWhere(h, () => true), format: (n) => `${n}` },
  {
    id: "high-low-diff",
    text: "What is the difference between your HIGHEST and LOWEST tile?",
    compute: (h) => Math.max(...h.map((t) => t.num)) - Math.min(...h.map((t) => t.num)),
    format: (n) => `${n}`,
  },
  {
    id: "middle-over-5",
    text: "Is your MIDDLE tile greater than 5?",
    excludeAt4: true,
    compute: (h) => (h[Math.floor(h.length / 2)].num > 5 ? "Yes" : "No"),
    format: (v) => v,
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

export function buildInitialState({ players, hostUsername, rng = Math.random, askerAnswers = false }) {
  if (!players.includes(hostUsername)) {
    throw new Error("hostUsername must be one of players");
  }
  const { hands, central } = dealGame(players, rng);
  // "middle tile" cards make no sense with a 4-tile (4-player) hand.
  const eligible = CARD_DEFINITIONS.filter((c) => !(c.excludeAt4 && players.length === 4));
  const cardDeck = shuffle(eligible.map((c) => c.id), rng);
  const board = cardDeck.slice(0, 6);
  const drawPile = cardDeck.slice(6);

  return {
    // Lets clients key their private scratch notes so a restart's fresh deal
    // doesn't inherit notes about the previous game's tiles.
    dealId: `${Date.now().toString(36)}-${Math.floor(rng() * 1e9).toString(36)}`,
    playerCount: players.length,
    players: players.slice(),
    hostUsername,
    // 4-player only: whether the asker also answers their own question.
    // Default false — the questioner sits out. See askQuestion().
    askerAnswers: !!askerAnswers,
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
    closureCountdown: null, // turns left in the round after the first correct group guess (3-4p); see tickClosureCountdown
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
 * Once the first player correctly guesses the central tiles (3-4p only), the
 * current round is finished out: each player still to act later in that lap
 * gets one final turn, then the game ends (it doesn't wrap to the start).
 * Call after every turn (ask or guess) once closureCountdown has been set.
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
export function askQuestion(state, { username, cardId, choice }) {
  if (state.phase !== "playing") throw new Error("Game is not accepting questions right now.");
  if (currentPlayer(state) !== username) throw new Error("It is not your turn.");
  if (!state.board.includes(cardId)) throw new Error("That question card is not available.");

  const def = CARD_BY_ID.get(cardId);
  if (!def) throw new Error("Unknown question card.");

  // Choose-cards (e.g. "where is your 1 or 2?") need the asker to pick a number.
  let pick = null;
  if (def.choices) {
    pick = Number(choice);
    if (!def.choices.includes(pick)) {
      throw new Error("Choose which number you want to ask about.");
    }
  }

  // 4p has no separate central hand to query, so by default every player —
  // asker included — answers, and you derive the central tiles by elimination.
  // The "questioner sits out" mode (askerAnswers === false, the default) drops
  // the asker's own answer, matching 2-3p.
  const includeAsker = state.playerCount === 4 && state.askerAnswers === true;
  const respondents = includeAsker
    ? state.turnOrder.slice()
    : state.turnOrder.filter((u) => u !== username);

  const answers = respondents.map((u) => {
    const value = def.compute(state.hands[u], pick);
    return { username: u, answerText: def.format(value) };
  });

  state.turnNumber += 1;
  state.log.push({
    turnNumber: state.turnNumber,
    type: "question",
    askedBy: username,
    cardId,
    cardText: def.choices ? def.resolvedText(pick) : def.text,
    choice: pick,
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

  // First correct guess: the current round finishes — every player who is still
  // to act LATER in this same lap gets one final turn, then the game ends. It
  // does NOT wrap back to the start, so if the last player in the lap cracks
  // the code the game ends immediately. This guess turn doesn't count against
  // the countdown — it's what started it.
  const justStartedClosure = correct && state.closureCountdown == null;
  if (justStartedClosure) {
    const guesserIdx = state.turnOrder.indexOf(username);
    state.closureCountdown = state.turnOrder
      .slice(guesserIdx + 1)
      .filter((u) => !isOut(state, u)).length;
  }

  if (activePlayers(state).length === 0 || state.closureCountdown === 0) {
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
    dealId: state.dealId,
    phase: state.phase,
    playerCount: state.playerCount,
    askerAnswers: !!state.askerAnswers,
    players: state.players,
    startingPlayer: state.startingPlayer,
    turnOrder: state.turnOrder,
    currentPlayer: currentPlayer(state),
    finalChanceUsername: state.finalChanceUsername,
    closingRound: state.closureCountdown != null, // 3-4p: code is cracked, final turns in progress
    winners: state.winners,
    decided: state.decided,
    left: state.left,
    board: state.board.map((id) => {
      const c = CARD_BY_ID.get(id);
      if (!c) return { cardId: id, text: id, hint: null, choices: null }; // stale card id
      return { cardId: id, text: c.text, hint: c.hint || null, choices: c.choices || null };
    }),
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
