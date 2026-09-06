import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildMasterDeck,
  dealCounts,
  dealGame,
  sortHand,
  buildInitialState,
  askQuestion,
  guessTiles,
  markPlayerLeft,
  redactStateForViewer,
  validateGuessShape,
  currentPlayer,
  CARD_DEFINITIONS,
} from "./bc-engine.js";

// Deterministic RNG (mulberry32) so setup tests are reproducible.
function seededRng(seed) {
  let a = seed;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function tile(num, color) {
  return { num, color };
}

describe("deck and deal setup", () => {
  it("master deck has 20 tiles: black+white 0-9 except two green 5s", () => {
    const deck = buildMasterDeck();
    assert.equal(deck.length, 20);
    const fives = deck.filter((t) => t.num === 5);
    assert.equal(fives.length, 2);
    assert.ok(fives.every((t) => t.color === "green"));
    for (let n = 0; n <= 9; n++) {
      if (n === 5) continue;
      const copies = deck.filter((t) => t.num === n);
      assert.equal(copies.length, 2);
      assert.deepEqual(copies.map((t) => t.color).sort(), ["black", "white"]);
    }
  });

  it("deal counts match the rulebook chart", () => {
    assert.deepEqual(dealCounts(2), { perPlayer: 5, central: 0 });
    assert.deepEqual(dealCounts(3), { perPlayer: 5, central: 5 });
    assert.deepEqual(dealCounts(4), { perPlayer: 4, central: 4 });
    assert.throws(() => dealCounts(5));
  });

  it("sortHand orders ascending, black before white on ties", () => {
    const hand = [tile(7, "white"), tile(2, "black"), tile(2, "white"), tile(9, "black")];
    const sorted = sortHand(hand);
    assert.deepEqual(sorted, [
      tile(2, "black"),
      tile(2, "white"),
      tile(7, "white"),
      tile(9, "black"),
    ]);
  });

  it("dealGame distributes tiles with no overlap, hands pre-sorted", () => {
    for (const players of [["a", "b"], ["a", "b", "c"], ["a", "b", "c", "d"]]) {
      const { perPlayer, central: centralCount } = dealCounts(players.length);
      const { hands, central } = dealGame(players, seededRng(42));
      const all = [...Object.values(hands).flat(), ...central];
      assert.equal(all.length, perPlayer * players.length + centralCount);
      // Every dealt tile must be a real tile from the master deck (count-checked via multiset).
      const deck = buildMasterDeck();
      const remaining = deck.map((t) => `${t.num}:${t.color}`);
      for (const t of all) {
        const key = `${t.num}:${t.color}`;
        const idx = remaining.indexOf(key);
        assert.ok(idx !== -1, `tile ${key} dealt more times than exists`);
        remaining.splice(idx, 1);
      }
      // 2p leaves 10 tiles undealt (back in the box); 3-4p deal out the full deck.
      assert.equal(remaining.length, 20 - all.length);
      for (const hand of Object.values(hands)) {
        assert.deepEqual(hand, sortHand(hand));
      }
    }
  });

  it("buildInitialState seeds a 6-card board and playing phase", () => {
    const state = buildInitialState({ players: ["a", "b"], hostUsername: "a", rng: seededRng(1) });
    assert.equal(state.phase, "playing");
    assert.equal(state.board.length, 6);
    assert.equal(state.drawPile.length, 21 - 6);
    assert.equal(currentPlayer(state), "a");
    assert.equal(state.startingPlayer, "a");
  });

  it("askerAnswers defaults to false and is settable / exposed to viewers", () => {
    const a = buildInitialState({ players: ["a", "b", "c", "d"], hostUsername: "a", rng: seededRng(1) });
    assert.equal(a.askerAnswers, false);
    const b = buildInitialState({ players: ["a", "b", "c", "d"], hostUsername: "a", rng: seededRng(1), askerAnswers: true });
    assert.equal(b.askerAnswers, true);
    assert.equal(redactStateForViewer(b, "a").askerAnswers, true);
  });

  it("each deal gets a distinct dealId (so clients can key private notes per game)", () => {
    const a = buildInitialState({ players: ["a", "b"], hostUsername: "a", rng: seededRng(1) });
    const b = buildInitialState({ players: ["a", "b"], hostUsername: "a", rng: seededRng(2) });
    assert.ok(a.dealId);
    assert.notEqual(a.dealId, b.dealId);
    assert.equal(redactStateForViewer(a, "a").dealId, a.dealId);
  });
});

function twoPlayerState(overrides = {}) {
  const state = {
    playerCount: 2,
    players: ["sidney", "parker"],
    hostUsername: "sidney",
    hands: {
      sidney: sortHand([tile(1, "black"), tile(3, "white"), tile(5, "green"), tile(7, "black"), tile(9, "white")]),
      parker: sortHand([tile(0, "black"), tile(2, "white"), tile(4, "black"), tile(6, "white"), tile(8, "black")]),
    },
    central: [],
    board: ["odd-count", "where-5", "same-color-neighbors"],
    drawPile: [],
    turnOrder: ["sidney", "parker"],
    turnIndex: 0,
    startingPlayer: "sidney",
    phase: "playing",
    finalChanceUsername: null,
    decided: {},
    left: {},
    winners: [],
    log: [],
    turnNumber: 0,
    closureCountdown: null,
  };
  return { ...state, ...overrides };
}

describe("askQuestion (2 player)", () => {
  it("computes the true answer from the opponent's hand and rotates the board", () => {
    const state = twoPlayerState();
    askQuestion(state, { username: "sidney", cardId: "odd-count" });
    assert.equal(state.log.length, 1);
    const entry = state.log[0];
    assert.equal(entry.askedBy, "sidney");
    // parker's hand: 0,2,4,6,8 -> zero odd tiles.
    assert.deepEqual(entry.answers, [{ username: "parker", answerText: "0" }]);
    assert.ok(!state.board.includes("odd-count"));
    assert.equal(state.board.length, 2); // no draw pile left to refill
    assert.equal(currentPlayer(state), "parker");
  });

  it("rejects a question asked out of turn", () => {
    const state = twoPlayerState();
    assert.throws(() => askQuestion(state, { username: "parker", cardId: "odd-count" }), /not your turn/);
  });

  it("rejects a card not currently on the board", () => {
    const state = twoPlayerState();
    assert.throws(
      () => askQuestion(state, { username: "sidney", cardId: "sum-all" }),
      /not available/
    );
  });

  it("ends the game with no winner once the board is exhausted", () => {
    const state = twoPlayerState({ board: ["odd-count"] });
    askQuestion(state, { username: "sidney", cardId: "odd-count" });
    assert.equal(state.phase, "game_over");
    assert.deepEqual(state.winners, []);
  });
});

describe("guessTiles (2 player)", () => {
  it("wrong guess keeps the game going and passes the turn", () => {
    const state = twoPlayerState();
    const wrong = [tile(0, "black"), tile(2, "white"), tile(4, "black"), tile(6, "white"), tile(8, "white")];
    guessTiles(state, { username: "sidney", guess: wrong });
    assert.equal(state.phase, "playing");
    assert.equal(currentPlayer(state), "parker");
  });

  it("starting player's correct guess opens a final chance for the opponent", () => {
    const state = twoPlayerState();
    guessTiles(state, { username: "sidney", guess: state.hands.parker });
    assert.equal(state.phase, "final_chance");
    assert.equal(state.finalChanceUsername, "parker");
    assert.equal(currentPlayer(state), "parker");
  });

  it("final chance: opponent guessing correctly ties the game", () => {
    const state = twoPlayerState();
    guessTiles(state, { username: "sidney", guess: state.hands.parker });
    guessTiles(state, { username: "parker", guess: state.hands.sidney });
    assert.equal(state.phase, "game_over");
    assert.deepEqual(state.winners.sort(), ["parker", "sidney"]);
  });

  it("final chance: opponent guessing wrong hands sidney the win", () => {
    const state = twoPlayerState();
    guessTiles(state, { username: "sidney", guess: state.hands.parker });
    const wrong = [tile(1, "black"), tile(3, "white"), tile(5, "green"), tile(7, "black"), tile(9, "black")];
    guessTiles(state, { username: "parker", guess: wrong });
    assert.equal(state.phase, "game_over");
    assert.deepEqual(state.winners, ["sidney"]);
  });

  it("non-starting player's correct guess wins immediately, no final chance", () => {
    const state = twoPlayerState({ turnIndex: 1 }); // parker's turn
    guessTiles(state, { username: "parker", guess: state.hands.sidney });
    assert.equal(state.phase, "game_over");
    assert.deepEqual(state.winners, ["parker"]);
  });

  it("rejects a malformed guess (wrong length, impossible color)", () => {
    const state = twoPlayerState();
    assert.throws(() => guessTiles(state, { username: "sidney", guess: [tile(1, "black")] }));
    const badFive = [tile(5, "black"), tile(2, "white"), tile(4, "black"), tile(6, "white"), tile(8, "black")];
    assert.throws(() => guessTiles(state, { username: "sidney", guess: badFive }));
  });
});

function groupState(playerCount, overrides = {}) {
  const players = ["a", "b", "c", "d"].slice(0, playerCount);
  const hands = {
    a: sortHand([tile(0, "black"), tile(1, "black"), tile(2, "black")]),
    b: sortHand([tile(3, "black"), tile(4, "black"), tile(5, "green")]),
    c: sortHand([tile(6, "black"), tile(7, "black"), tile(8, "black")]),
  };
  if (playerCount === 4) hands.d = sortHand([tile(0, "white"), tile(1, "white"), tile(2, "white")]);
  const central = [tile(9, "black"), tile(9, "white"), tile(5, "green")];
  const state = {
    playerCount,
    players,
    hostUsername: "a",
    hands,
    central,
    board: ["odd-count", "black-count"],
    drawPile: [],
    turnOrder: players,
    turnIndex: 0,
    startingPlayer: "a",
    phase: "playing",
    finalChanceUsername: null,
    decided: {},
    left: {},
    winners: [],
    log: [],
    turnNumber: 0,
    closureCountdown: null,
  };
  return { ...state, ...overrides };
}

describe("askQuestion (3-4 player)", () => {
  it("3 players: everyone except the asker answers", () => {
    const state = groupState(3);
    askQuestion(state, { username: "a", cardId: "odd-count" });
    const usernames = state.log[0].answers.map((a) => a.username).sort();
    assert.deepEqual(usernames, ["b", "c"]);
  });

  it("4 players (default): the asker does not answer their own question", () => {
    const state = groupState(4);
    askQuestion(state, { username: "a", cardId: "odd-count" });
    const usernames = state.log[0].answers.map((a) => a.username).sort();
    assert.deepEqual(usernames, ["b", "c", "d"]);
  });

  it("4 players (askerAnswers mode): everyone including the asker answers", () => {
    const state = groupState(4, { askerAnswers: true });
    askQuestion(state, { username: "a", cardId: "odd-count" });
    const usernames = state.log[0].answers.map((a) => a.username).sort();
    assert.deepEqual(usernames, ["a", "b", "c", "d"]);
  });

  it("askerAnswers only affects 4-player games", () => {
    const state = groupState(3, { askerAnswers: true });
    askQuestion(state, { username: "a", cardId: "odd-count" });
    const usernames = state.log[0].answers.map((a) => a.username).sort();
    assert.deepEqual(usernames, ["b", "c"]);
  });
});

describe("question card catalog", () => {
  const CARD = (id) => CARD_DEFINITIONS.find((c) => c.id === id);
  const H = (spec) => sortHand(spec.map(([n, c]) => tile(n, c)));

  it("has 21 cards; 4-player games drop the two 'middle tile' cards", () => {
    assert.equal(CARD_DEFINITIONS.length, 21);
    const s2 = buildInitialState({ players: ["a", "b"], hostUsername: "a", rng: seededRng(3) });
    const s4 = buildInitialState({ players: ["a", "b", "c", "d"], hostUsername: "a", rng: seededRng(3) });
    const pool2 = [...s2.board, ...s2.drawPile];
    const pool4 = [...s4.board, ...s4.drawPile];
    assert.equal(pool2.length, 21);
    assert.equal(pool4.length, 19);
    assert.ok(pool2.includes("sum-middle") && pool2.includes("middle-over-5"));
    assert.ok(!pool4.includes("sum-middle") && !pool4.includes("middle-over-5"));
  });

  it("sum / difference cards add the right tiles", () => {
    const hand = H([[1, "black"], [4, "white"], [5, "green"], [7, "black"], [8, "white"]]); // a..e
    assert.equal(CARD("sum-left").compute(hand), 1 + 4 + 5);
    assert.equal(CARD("sum-middle").compute(hand), 4 + 5 + 7);
    assert.equal(CARD("sum-right").compute(hand), 5 + 7 + 8);
    assert.equal(CARD("sum-black").compute(hand), 1 + 7);
    assert.equal(CARD("sum-white").compute(hand), 4 + 8);
    assert.equal(CARD("sum-all").compute(hand), 25);
    assert.equal(CARD("high-low-diff").compute(hand), 7);
    assert.equal(CARD("middle-over-5").compute(hand), "No");
  });

  it("even card counts 0 as even (and says so); pairs card counts matched numbers", () => {
    const hand = H([[0, "black"], [0, "white"], [3, "black"], [7, "black"], [7, "white"]]);
    assert.equal(CARD("even-count").compute(hand), 2);
    assert.equal(CARD("odd-count").compute(hand), 3);
    assert.equal(CARD("pairs-count").compute(hand), 2);
    assert.match(CARD("even-count").hint, /0/);
  });

  it("choose-cards require a valid choice and resolve to that number", () => {
    const state = twoPlayerState({ board: ["where-1-2", "odd-count"] });
    assert.throws(() => askQuestion(state, { username: "sidney", cardId: "where-1-2" }), /Choose which number/);
    assert.throws(() => askQuestion(state, { username: "sidney", cardId: "where-1-2", choice: 9 }), /Choose which number/);
    askQuestion(state, { username: "sidney", cardId: "where-1-2", choice: 2 });
    const entry = state.log[0];
    assert.equal(entry.choice, 2);
    assert.match(entry.cardText, /2s/);
    // parker holds a 2 at position b
    assert.deepEqual(entry.answers, [{ username: "parker", answerText: "b" }]);
  });
});

describe("guessTiles (3-4 player, central pile)", () => {
  it("correct central guess marks the guesser decided and starts the closing lap", () => {
    const state = groupState(3);
    guessTiles(state, { username: "a", guess: state.central });
    assert.equal(state.decided.a, "won");
    assert.deepEqual(state.winners, ["a"]);
    assert.equal(state.phase, "playing"); // b and c still owe their turn
    assert.equal(state.closureCountdown, 2);
    assert.equal(currentPlayer(state), "b");
  });

  it("game ends once every other active player has had one more turn", () => {
    const state = groupState(3);
    guessTiles(state, { username: "a", guess: state.central }); // a wins, countdown=2
    askQuestion(state, { username: "b", cardId: "odd-count" }); // countdown=1
    assert.equal(state.phase, "playing");
    askQuestion(state, { username: "c", cardId: "black-count" }); // countdown=0
    assert.equal(state.phase, "game_over");
    assert.deepEqual(state.winners, ["a"]);
  });

  it("a second correct guess during the closing lap adds another winner", () => {
    const state = groupState(3);
    guessTiles(state, { username: "a", guess: state.central }); // countdown=2, b's turn
    guessTiles(state, { username: "b", guess: state.central }); // also correct, countdown=1, c's turn
    assert.deepEqual(state.winners.sort(), ["a", "b"]);
    assert.equal(state.phase, "playing");
    guessTiles(state, { username: "c", guess: [tile(0, "white"), tile(1, "white"), tile(2, "white")] }); // wrong, countdown=0
    assert.equal(state.phase, "game_over");
    assert.deepEqual(state.winners.sort(), ["a", "b"]);
  });

  it("game ends immediately when the last player in the lap cracks the code (no wrap-around)", () => {
    const state = groupState(4, { turnIndex: 3 });
    assert.equal(currentPlayer(state), "d");
    guessTiles(state, { username: "d", guess: state.central });
    assert.equal(state.phase, "game_over");
    assert.deepEqual(state.winners, ["d"]);
  });

  it("a mid-lap correct guess only gives the players after the guesser a final turn", () => {
    const state = groupState(4, { turnIndex: 1, board: ["odd-count", "black-count", "sum-all"] });
    guessTiles(state, { username: "b", guess: state.central });
    assert.equal(state.phase, "playing");
    assert.equal(state.closureCountdown, 2); // c and d — not a, who already went this lap
    assert.equal(currentPlayer(state), "c");
    askQuestion(state, { username: "c", cardId: "odd-count" });
    assert.equal(state.phase, "playing");
    askQuestion(state, { username: "d", cardId: "black-count" });
    assert.equal(state.phase, "game_over");
  });

  it("wrong guess marks the player lost and out; turn moves on without them", () => {
    const state = groupState(3);
    const wrong = [tile(0, "white"), tile(1, "white"), tile(2, "white")];
    guessTiles(state, { username: "a", guess: wrong });
    assert.equal(state.decided.a, "lost");
    assert.deepEqual(state.winners, []);
    assert.equal(currentPlayer(state), "b");
  });

  it("rejects a second guess from an already-decided player (defensive check)", () => {
    const state = groupState(3);
    const wrong = [tile(0, "white"), tile(1, "white"), tile(2, "white")];
    guessTiles(state, { username: "a", guess: wrong });
    // The normal turn order never re-selects a decided player, but guard against
    // it directly in case a caller invokes the engine out of sequence.
    state.turnIndex = state.turnOrder.indexOf("a");
    assert.throws(
      () => guessTiles(state, { username: "a", guess: state.central }),
      /already made your one guess/
    );
  });

  it("game ends immediately once every player has decided", () => {
    const state = groupState(3);
    const wrong = [tile(0, "white"), tile(1, "white"), tile(2, "white")];
    guessTiles(state, { username: "a", guess: wrong });
    guessTiles(state, { username: "b", guess: wrong });
    assert.equal(state.phase, "playing");
    guessTiles(state, { username: "c", guess: wrong });
    assert.equal(state.phase, "game_over");
    assert.deepEqual(state.winners, []);
  });
});

describe("markPlayerLeft", () => {
  it("2 player final chance: departure of the pending guesser hands the win to the starting player", () => {
    const state = twoPlayerState();
    guessTiles(state, { username: "sidney", guess: state.hands.parker });
    markPlayerLeft(state, "parker");
    assert.equal(state.phase, "game_over");
    assert.deepEqual(state.winners, ["sidney"]);
  });

  it("3 player: a departure during the closing lap counts as that turn being used up", () => {
    const state = groupState(3);
    guessTiles(state, { username: "a", guess: state.central }); // countdown=2 (b,c owed)
    markPlayerLeft(state, "b"); // b will never take that owed turn
    assert.equal(state.closureCountdown, 1);
    assert.equal(state.phase, "playing");
    assert.equal(currentPlayer(state), "c");
    askQuestion(state, { username: "c", cardId: "odd-count" });
    assert.equal(state.phase, "game_over");
  });

  it("leaving mid-game (no prior winner) skips to the next active player", () => {
    const state = groupState(3);
    markPlayerLeft(state, "a");
    assert.equal(currentPlayer(state), "b");
  });
});

describe("redactStateForViewer", () => {
  it("hides the opponent's hand and reveals it only after game_over (2p)", () => {
    const state = twoPlayerState();
    const beforeView = redactStateForViewer(state, "sidney");
    assert.equal(beforeView.opponent.revealedHand, null);
    assert.equal(beforeView.myHand.length, 5);

    guessTiles(state, { username: "sidney", guess: state.hands.parker }); // correct -> final chance
    const wrong = [tile(1, "black"), tile(3, "white"), tile(5, "green"), tile(7, "black"), tile(9, "black")];
    guessTiles(state, { username: "parker", guess: wrong }); // final chance, wrong -> game over

    const afterView = redactStateForViewer(state, "parker");
    assert.equal(afterView.opponent.revealedHand.length, 5);
  });

  it("reveals central tiles to everyone once the game is over (3-4p)", () => {
    const state = groupState(3);
    guessTiles(state, { username: "a", guess: state.central });
    askQuestion(state, { username: "b", cardId: "odd-count" });
    askQuestion(state, { username: "c", cardId: "black-count" });
    assert.equal(state.phase, "game_over");
    const view = redactStateForViewer(state, "b");
    assert.deepEqual(view.revealedCentral.map(({ num, color }) => ({ num, color })), state.central);
    assert.equal(view.opponents.find((o) => o.username === "a").decided, "won");
  });

  it("never includes other players' hand contents pre-reveal", () => {
    const state = groupState(4);
    const view = redactStateForViewer(state, "a");
    assert.equal(JSON.stringify(view).includes('"hands"'), false);
    assert.ok(view.opponents.every((o) => !("hand" in o) && !("tiles" in o)));
  });
});

describe("validateGuessShape", () => {
  it("accepts a well-formed guess", () => {
    assert.equal(
      validateGuessShape([tile(0, "black"), tile(5, "green"), tile(9, "white")], 3),
      null
    );
  });
  it("rejects wrong length", () => {
    assert.match(validateGuessShape([tile(0, "black")], 3), /exactly 3/);
  });
  it("rejects using the same non-5 tile twice", () => {
    const guess = [tile(0, "black"), tile(0, "black"), tile(9, "white")];
    assert.match(validateGuessShape(guess, 3), /more times than exists/);
  });
  it("allows both green 5s at once", () => {
    assert.equal(validateGuessShape([tile(5, "green"), tile(5, "green")], 2), null);
  });
});
