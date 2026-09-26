// Chess skill. The generic agent loop can't play chess: moves aren't buttons, the
// game is ongoing (never "done" after one click) and Jev can't search a game tree.
// So, as everywhere else, code stays in control:
//   - read the position from the page (a chess.js instance if the page has one,
//     otherwise the board's squares and pieces in the DOM);
//   - generate every legal move and annotate each one in code (captures, checks,
//     mates, material it wins or hangs, whether it allows mate next move);
//   - play a mate if there is one; drop moves that allow mate or lose material
//     when better moves exist;
//   - ask Jev one Choice over the remaining moves: which is strongest here;
//   - make the move by clicking (or dragging) squares, then wait for the reply.

import { Chess } from "./vendor/chess.mjs";
import { choice } from "./jev.js";

const NAME = { p: "pawn", n: "knight", b: "bishop", r: "rook", q: "queen", k: "king" };
const VAL = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
const MAX_PLIES = 400;
const REPLY_TIMEOUT_MS = 120_000;

export const isChessGoal = (goal) => /\bchess\b/i.test(goal);
export const colorFromGoal = (goal) =>
  /\b(as|play(ing)?|with|be)\s+(the\s+)?white\b/i.test(goal) ? "w" : /\b(as|play(ing)?|with|be)\s+(the\s+)?black\b/i.test(goal) ? "b" : null;

// ---------- page functions (run in the page's MAIN world) ----------

export function readChessState() {
  const isChess = (v) => v && typeof v.fen === "function" && typeof v.moves === "function" && typeof v.turn === "function";
  let inst = null;
  try { if (typeof game !== "undefined" && isChess(game)) inst = game; } catch (_) {}
  try { if (!inst && typeof chess !== "undefined" && isChess(chess)) inst = chess; } catch (_) {}
  if (!inst) {
    for (const k of Object.keys(window)) {
      try { if (isChess(window[k])) { inst = window[k]; break; } } catch (_) {}
    }
  }
  // Squares: chessboard.js and similar boards mark them with data-square="e4".
  const squares = [...document.querySelectorAll("[data-square]")].filter((el) => /^[a-h][1-8]$/.test(el.getAttribute("data-square")));
  if (squares.length < 64 && !inst) return null;
  const centers = {}, placement = {};
  for (const el of squares) {
    const sq = el.getAttribute("data-square");
    const r = el.getBoundingClientRect();
    centers[sq] = [r.left + r.width / 2, r.top + r.height / 2];
    const pc = el.querySelector("[data-piece]");
    const code = pc && pc.getAttribute("data-piece"); // e.g. "wN"
    if (code && /^[wb][PNBRQK]$/.test(code)) placement[sq] = code;
  }
  let orientation = null;
  if (centers.a1 && centers.a8) orientation = centers.a1[1] > centers.a8[1] ? "w" : "b";
  let busy = false;
  try { if (typeof thinking !== "undefined") busy = !!thinking; } catch (_) {}
  return {
    engine: !!inst,
    fen: inst ? inst.fen() : null,
    history: inst && typeof inst.history === "function" ? inst.history() : [],
    placement,
    centers,
    orientation,
    busy,
    url: location.href,
  };
}

// Make a move by clicking the two squares; if the position doesn't change, drag instead.
export async function performChessMove(from, to, how) {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const sqEl = (sq) => document.querySelector(`[data-square="${sq}"]`);
  const a = sqEl(from), b = sqEl(to);
  if (!a || !b) return { ok: false, note: "squares not found" };
  a.scrollIntoView({ block: "center", behavior: "instant" });
  await wait(50);
  const center = (el) => { const r = el.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; };
  const fire = (type, x, y, Ctor = MouseEvent) => {
    const target = document.elementFromPoint(x, y) || document.body;
    target.dispatchEvent(new Ctor(type, { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, button: 0, buttons: type.endsWith("down") || type.endsWith("move") ? 1 : 0, view: window, pointerId: 1, isPrimary: true }));
  };
  const [x1, y1] = center(a), [x2, y2] = center(b);
  if (how === "drag") {
    fire("pointerdown", x1, y1, PointerEvent); fire("mousedown", x1, y1);
    for (let i = 1; i <= 8; i++) {
      const x = x1 + ((x2 - x1) * i) / 8, y = y1 + ((y2 - y1) * i) / 8;
      fire("pointermove", x, y, PointerEvent); fire("mousemove", x, y);
      await wait(16);
    }
    fire("pointerup", x2, y2, PointerEvent); fire("mouseup", x2, y2);
  } else {
    fire("click", x1, y1);
    await wait(120);
    fire("click", x2, y2);
  }
  return { ok: true };
}

// ---------- analysis (runs in the extension) ----------

const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR";

function placementKey(st) {
  if (st.fen) return st.fen.split(" ")[0];
  const rows = [];
  for (let rank = 8; rank >= 1; rank--) {
    let row = "", empty = 0;
    for (const file of "abcdefgh") {
      const code = st.placement[file + rank];
      if (!code) { empty++; continue; }
      if (empty) { row += empty; empty = 0; }
      row += code[0] === "w" ? code[1] : code[1].toLowerCase();
    }
    rows.push(row + (empty || ""));
  }
  return rows.join("/");
}

// FEN for a board read from the DOM (no engine on the page): side to move is
// supplied by the caller; castling rights inferred from kings/rooks on home squares.
function domFen(st, turn) {
  const p = st.placement;
  let c = "";
  if (p.e1 === "wK" && p.h1 === "wR") c += "K";
  if (p.e1 === "wK" && p.a1 === "wR") c += "Q";
  if (p.e8 === "bK" && p.h8 === "bR") c += "k";
  if (p.e8 === "bK" && p.a8 === "bR") c += "q";
  return `${placementKey(st)} ${turn} ${c || "-"} - 0 1`;
}

// Estimated material the opponent can win right now (best single capture,
// minus our recapture if the square is defended).
function opponentThreat(g) {
  let worst = 0;
  for (const rp of g.moves({ verbose: true })) {
    if (!rp.captured) continue;
    g.move(rp);
    const defended = g.moves({ verbose: true }).some((x) => x.to === rp.to);
    g.undo();
    const loss = VAL[rp.captured] - (defended ? VAL[rp.promotion || rp.piece] : 0);
    if (loss > worst) worst = loss;
  }
  return worst;
}

export function analyseMoves(fen, historyLen) {
  const g = new Chess(fen);
  const out = [];
  for (const m of g.moves({ verbose: true })) {
    const gain = (m.captured ? VAL[m.captured] : 0) + (m.promotion ? VAL[m.promotion] - 1 : 0);
    g.move(m);
    const mate = g.in_checkmate();
    const check = g.in_check();
    const draw = !mate && (g.in_stalemate() || g.in_threefold_repetition() || g.insufficient_material());
    let allowsMate = false;
    if (!mate) {
      for (const rp of g.moves({ verbose: true })) {
        g.move(rp);
        const x = g.in_checkmate();
        g.undo();
        if (x) { allowsMate = true; break; }
      }
    }
    const threat = mate ? 0 : opponentThreat(g);
    g.undo();
    const net = gain - threat;

    const bits = [`${NAME[m.piece]} ${m.from} to ${m.to}`];
    if (m.flags.includes("k")) bits.push("castles kingside");
    if (m.flags.includes("q")) bits.push("castles queenside");
    if (m.captured) bits.push(`captures a ${NAME[m.captured]}`);
    if (m.promotion) bits.push(`promotes to ${NAME[m.promotion]}`);
    if (mate) bits.push("CHECKMATE");
    else if (check) bits.push("gives check");
    if (draw) bits.push("leads to a draw");
    if (allowsMate) bits.push("allows checkmate next move");
    if (net > 0) bits.push(`wins about ${net} point${net === 1 ? "" : "s"} of material`);
    else if (net < 0) bits.push(`loses about ${-net} point${net === -1 ? "" : "s"} of material`);
    else bits.push("material stays even");
    const home = m.color === "w" ? "1" : "8";
    if (historyLen < 20 && "nb".includes(m.piece) && m.from[1] === home) bits.push("develops a piece");
    if (m.piece === "p" && ["d4", "e4", "d5", "e5", "c4", "c5"].includes(m.to)) bits.push("fights for the center");
    if (m.piece === "k" && !m.flags.includes("k") && !m.flags.includes("q") && historyLen < 40) bits.push("moves the king early");
    out.push({ ...m, mate, check, draw, allowsMate, net, desc: bits.join(", ") });
  }
  return out;
}

function pieceList(fen) {
  const g = new Chess(fen);
  const side = { w: [], b: [] };
  for (const sq of g.SQUARES) {
    const p = g.get(sq);
    if (p) side[p.color].push(`${p.type === "p" ? "" : p.type.toUpperCase()}${sq}`);
  }
  return { white: side.w.join(" "), black: side.b.join(" ") };
}

function resultText(g, us) {
  if (g.in_checkmate()) return g.turn() === us ? "Checkmate: we lost." : "Checkmate: we won!";
  if (g.in_stalemate()) return "Draw by stalemate.";
  if (g.in_threefold_repetition()) return "Draw by threefold repetition.";
  if (g.insufficient_material()) return "Draw: insufficient material.";
  return "Draw.";
}

// ---------- the game loop ----------
// ctx: { tabId, goal, signal, ask(state, questions), log(kind, text, detail), injectMain(func, args) }
// Returns { status: "done"|"stopped"|"error", text }.
export async function playChess(ctx, us) {
  const COLOR = { w: "White", b: "Black" };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  ctx.log("info", `Playing chess as ${COLOR[us]}. Jev picks each move from the legal moves; code checks tactics.`);
  let lastKey = null;      // position after our last move
  let domTurnKnown = null; // for DOM-only boards: whose turn we believe it is
  let plies = 0;

  for (;;) {
    if (ctx.signal.aborted) return { status: "stopped", text: "Stopped." };
    const st = await ctx.injectMain(readChessState, []);
    if (!st) return { status: "error", text: "The chess board disappeared from the page." };
    const key = placementKey(st);

    // Whose turn is it?
    let fen;
    if (st.fen) {
      fen = st.fen;
    } else {
      if (domTurnKnown === null) domTurnKnown = key === START ? "w" : us;
      if (lastKey && key !== lastKey) domTurnKnown = us;
      fen = domFen(st, domTurnKnown);
    }
    const g = new Chess(fen);
    if (!g.validate_fen(fen).valid) return { status: "error", text: `Couldn't read a valid position from the page (${fen}).` };
    if (g.game_over()) return { status: "done", text: resultText(g, us) };

    if (g.turn() !== us || st.busy || (lastKey && key === lastKey)) {
      // Opponent's move: wait for the board to change.
      const t0 = Date.now();
      let changed = false;
      while (Date.now() - t0 < REPLY_TIMEOUT_MS) {
        if (ctx.signal.aborted) return { status: "stopped", text: "Stopped." };
        await sleep(500);
        const s2 = await ctx.injectMain(readChessState, []).catch(() => null);
        if (!s2) continue;
        const k2 = placementKey(s2);
        const turnNow = s2.fen ? s2.fen.split(" ")[1] : null;
        if ((k2 !== key || (turnNow && turnNow === us)) && !s2.busy) { changed = true; break; }
        if (s2.fen && new Chess(s2.fen).game_over()) { changed = true; break; }
      }
      if (!changed) return { status: "stopped", text: "The opponent hasn't moved for 2 minutes, so I stopped." };
      await sleep(250);
      continue;
    }

    if (++plies > MAX_PLIES) return { status: "stopped", text: "Move limit reached." };

    // Our move.
    // Click-to-move boards promote to a queen, so only offer queen promotions.
    const moves = analyseMoves(fen, st.history.length || plies * 2).filter((m) => !m.promotion || m.promotion === "q");
    let pick = moves.find((m) => m.mate);
    let conf = 1, why = "checkmate in one";
    if (!pick) {
      let cands = moves.filter((m) => !m.allowsMate);
      if (!cands.length) cands = moves;
      const best = Math.max(...cands.map((m) => m.net));
      // Keep moves within a pawn of the best material outcome, never ones that hang more.
      cands = cands.filter((m) => m.net >= best - 1 && m.net >= Math.min(0, best));
      cands.sort((a, b) => b.net - a.net);
      cands = cands.slice(0, 60);
      if (cands.length === 1) {
        pick = cands[0]; why = "only safe move";
      } else {
        const hist = st.history.length ? st.history : [];
        const res = await ctx.ask(
          {
            side_to_move: COLOR[us],
            position_fen: fen,
            pieces: pieceList(fen),
            recent_moves: hist.slice(-20).join(" ") || "(start of game)",
          },
          {
            move: choice(
              `Which is the strongest move for ${COLOR[us]} in this chess position? Prefer moves that win material, give strong checks, develop pieces, control the center, castle to keep the king safe, and create threats. Avoid moves that lose material or leave pieces undefended.`,
              Object.fromEntries(cands.map((m) => [m.san, m.desc]))
            ),
          }
        );
        const a = res.answers.move;
        pick = cands.find((m) => m.san === a.choice) || cands[0];
        conf = a.confidence;
        const alts = Object.entries(a.probabilities).filter(([k]) => k !== a.choice).sort((x, y) => y[1] - x[1]).slice(0, 2)
          .map(([k, p]) => `${k} ${Math.round(p * 100)}%`).join(", ");
        why = `${cands.length} candidate${cands.length === 1 ? "" : "s"}${alts ? `; also considered ${alts}` : ""}`;
      }
    }

    const moveNo = Number(fen.split(" ")[5]) || 1;
    ctx.log("step", `${moveNo}${us === "w" ? "." : "..."} ${pick.san}  (${pick.desc})`, `confidence ${Math.round(conf * 100)}% · ${why}`);

    // Make it: click the squares, check it landed, else drag.
    for (const how of ["click", "drag"]) {
      await ctx.injectMain(performChessMove, [pick.from, pick.to, how]);
      await sleep(500);
      const s3 = await ctx.injectMain(readChessState, []).catch(() => null);
      if (s3 && placementKey(s3) !== key) { lastKey = placementKey(s3); break; }
      if (how === "drag") return { status: "error", text: `The page didn't accept ${pick.san}. This board may need a different way of moving pieces.` };
    }
    if (!st.fen) domTurnKnown = us === "w" ? "b" : "w";
  }
}
