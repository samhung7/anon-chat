/* The three mini-games' boards, each drawn into one element and played by tapping (One Line by dragging). A board
   keeps its progress in a plain object (st), which games.js saves on this device after every move, so a game left
   for the meeting carries on where it was. Each board calls on.change() after a move and on.done() once it's over;
   hint() gives one step of the answer, and tells the player what it cost. */
import { t } from "./text.js?v=dev";
import { el } from "./dom.js?v=dev";
import { MM, mmMark, qnClash } from "./puzzles.js?v=dev";

// the colours of Code Lock, each with its own shape, so they tell apart without colour too
export const PEGS = [["#c8553d", "●"], ["#e59a3c", "▲"], ["#d9b93a", "■"], ["#5a9a5e", "◆"], ["#4a78b5", "★"], ["#8c64b0", "♥"]];
const peg = (k, cls = "peg") => el("span", { class: cls, style: k == null ? null : `--c:${PEGS[k][0]}`, "data-k": k ?? null, text: k == null ? "" : PEGS[k][1] });
// the marks after a try, as the share card shows them: exact first, then right colour in the wrong place
export const markDots = ([exact, near]) => Array.from({ length: MM.pegs }, (_, i) => (i < exact ? 2 : i < exact + near ? 1 : 0));

/* ---------- 密碼鎖 Code Lock ----------
   st: { tries: ["0123", ...], cur: "01" } */
export function mmBoard(p, st, on) {
  st.tries ||= []; st.cur ||= "";
  const rows = el("div", { class: "mmrows" });
  const keys = el("div", { class: "mmkeys" });
  const over = () => st.tries.includes(p.code) || st.tries.length >= MM.tries;
  const draw = () => {
    rows.replaceChildren(...Array.from({ length: MM.tries }, (_, r) => {
      const tried = st.tries[r], now = r === st.tries.length && !over();
      const code = tried ?? (now ? st.cur : "");
      const marks = tried ? markDots(mmMark(tried, p.code)) : [];
      return el("div", { class: "mmrow" + (now ? " now" : "") + (tried ? " done" : ""), "aria-label": tried ? t("gmMmRow", { n: r + 1, a: mmMark(tried, p.code)[0], b: mmMark(tried, p.code)[1] }) : null },
        el("span", { class: "mmn", text: r + 1 }),
        el("span", { class: "mmpegs" }, Array.from({ length: MM.pegs }, (_, i) => peg(code[i] != null ? +code[i] : null))),
        el("span", { class: "mmmarks", "aria-hidden": "true" }, Array.from({ length: MM.pegs }, (_, i) => el("i", { class: "d" + (marks[i] || 0) }))));
    }));
    keys.querySelectorAll("button").forEach((b) => (b.disabled = over() || (b.dataset.a === "ok" ? st.cur.length < MM.pegs : b.dataset.a === "del" ? !st.cur : st.cur.length >= MM.pegs)));
  };
  keys.append(el("div", { class: "mmpal" }, PEGS.map((_, k) => el("button", { type: "button", class: "mmkey", "data-k": k, "aria-label": t("gmColour", { n: k + 1 }) }, peg(k)))),
    el("div", { class: "mmact" },
      el("button", { type: "button", class: "btn", "data-a": "del", text: t("gmDel") }),
      el("button", { type: "button", class: "btn primary", "data-a": "ok", text: t("gmTry") })));
  keys.addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b || b.disabled) return;
    if (b.dataset.k != null) st.cur += b.dataset.k;
    else if (b.dataset.a === "del") st.cur = st.cur.slice(0, -1);
    else if (b.dataset.a === "ok") { st.tries.push(st.cur); st.cur = ""; }
    draw(); on.change();
    if (over()) on.done();
  });
  draw();
  return { el: el("div", { class: "mmboard" }, rows, keys), over };
}

/* ---------- 皇后格 Crowns ----------
   st: { c: [0 empty | 1 crossed out | 2 crown] per square, h: hints, m: mistakes }. A tap goes empty → ✕ → crown →
   empty; a crown that clashes with another one counts as a mistake and shows red. */
export function qnBoard(p, st, on) {
  const n = p.n, N = n * n;
  st.c ||= Array(N).fill(0); st.h ||= 0; st.m ||= 0;
  const crowns = () => st.c.flatMap((v, i) => (v === 2 ? [i] : []));
  const over = () => { const c = crowns(); return c.length === n && c.every((a) => c.every((b) => !qnClash(p, a, b))); };
  const grid = el("div", { class: "qngrid", style: `--n:${n}`, role: "grid" });
  const cells = Array.from({ length: N }, (_, i) => {
    const x = i % n, y = (i / n) | 0, a = p.areas[i], edge = (dx, dy) => { const j = (y + dy) * n + x + dx; return x + dx < 0 || x + dx >= n || y + dy < 0 || y + dy >= n || p.areas[j] !== a; };
    const b = el("button", { type: "button", class: `qncell a${a}` + (edge(0, -1) ? " bt" : "") + (edge(1, 0) ? " br" : "") + (edge(0, 1) ? " bb" : "") + (edge(-1, 0) ? " bl" : ""), "data-i": i });
    grid.append(b);
    return b;
  });
  const draw = () => {
    const c = crowns(), done = over();
    cells.forEach((b, i) => {
      const v = st.c[i], bad = v === 2 && c.some((j) => qnClash(p, i, j));
      b.textContent = v === 2 ? "👑" : v === 1 ? "✕" : "";
      b.className = b.className.replace(/ (on|x|bad)\b/g, "") + (v === 2 ? " on" : v === 1 ? " x" : "") + (bad ? " bad" : "");
      b.setAttribute("aria-label", t("gmCell", { r: ((i / n) | 0) + 1, c: (i % n) + 1 }) + (v === 2 ? " 👑" : v === 1 ? " ✕" : ""));
      b.disabled = done;
    });
  };
  grid.addEventListener("click", (e) => {
    const b = e.target.closest(".qncell"); if (!b || b.disabled) return;
    const i = +b.dataset.i, next = (st.c[i] + 1) % 3;
    if (next === 2 && crowns().some((j) => qnClash(p, i, j))) st.m++;
    st.c[i] = next;
    draw(); on.change();
    if (over()) on.done();
  });
  draw();
  return {
    el: el("div", { class: "qnboard" }, grid), over,
    // one crown where it belongs, in the first row without it; crowns in its way go
    hint() {
      const row = p.cols.findIndex((c, r) => st.c[r * n + c] !== 2);
      if (row < 0) return;
      const at = row * n + p.cols[row];
      crowns().forEach((j) => qnClash(p, at, j) && (st.c[j] = 0));
      st.c[at] = 2; st.h++;
      draw(); on.change();
      if (over()) on.done();
    },
  };
}

/* ---------- 一筆連 One Line ----------
   st: { path: [squares], h: hints }. Drag from 1 (or from the end of the line) to draw; dragging back over the
   line takes it back; tapping a square on the line cuts it there. Numbered squares must come in order. */
export function zpBoard(p, st, on) {
  const n = p.n, N = n * n, last = p.last;
  st.path ||= []; st.h ||= 0;
  const start = [...p.nums].find(([, k]) => k === 1)[0];
  const over = () => st.path.length === N && p.nums.get(st.path[N - 1]) === last;
  const grid = el("div", { class: "zpgrid", style: `--n:${n}` });
  const ns = "http://www.w3.org/2000/svg", svg = document.createElementNS(ns, "svg"), line = document.createElementNS(ns, "polyline");
  svg.setAttribute("viewBox", `0 0 ${n} ${n}`); svg.setAttribute("class", "zpline"); svg.setAttribute("aria-hidden", "true"); svg.append(line);
  const cells = Array.from({ length: N }, (_, i) => {
    const k = p.nums.get(i);
    const c = el("div", { class: "zpcell" + (k ? " num" : ""), "data-i": i, role: "gridcell" }, k ? el("b", { text: k }) : null);
    grid.append(c);
    return c;
  });
  grid.append(svg);
  const next = () => st.path.filter((i) => p.nums.has(i)).length + 1; // the number the line must reach next
  const draw = () => {
    const on_ = new Set(st.path), done = over();
    cells.forEach((c, i) => c.classList.toggle("on", on_.has(i)));
    line.setAttribute("points", st.path.map((i) => `${(i % n) + 0.5},${((i / n) | 0) + 0.5}`).join(" "));
    grid.classList.toggle("done", done);
    grid.setAttribute("aria-label", t("gmZpLeft", { n: N - st.path.length }));
  };
  const adj = (a, b) => (Math.abs(a - b) === 1 && ((a / n) | 0) === ((b / n) | 0)) || Math.abs(a - b) === n;
  // the line reaches square i, if it can: one step on, or one step back
  const reach = (i) => {
    const P = st.path, head = P[P.length - 1];
    if (i === head) return false;
    if (P.length > 1 && i === P[P.length - 2]) { P.pop(); return true; }
    if (!adj(head, i) || P.includes(i)) return false;
    const k = p.nums.get(i);
    if (k && k !== next()) return false;
    if (p.nums.get(head) === last) return false; // the line ends at the last number
    P.push(i); return true;
  };
  let dragging = false;
  const cellAt = (e) => {
    const r = grid.getBoundingClientRect(), x = Math.floor(((e.clientX - r.left) / r.width) * n), y = Math.floor(((e.clientY - r.top) / r.height) * n);
    return x >= 0 && y >= 0 && x < n && y < n ? y * n + x : -1;
  };
  grid.addEventListener("pointerdown", (e) => {
    if (over()) return;
    const i = cellAt(e); if (i < 0) return;
    const at = st.path.indexOf(i);
    if (!st.path.length) { if (i !== start) return; st.path = [i]; }
    else if (at >= 0) st.path.length = at + 1; // cut back to here
    else if (!reach(i)) return;
    dragging = true; grid.setPointerCapture?.(e.pointerId);
    draw(); on.change();
    e.preventDefault();
  });
  grid.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const i = cellAt(e);
    if (i >= 0 && reach(i)) { draw(); on.change(); }
  });
  const stop = () => { if (!dragging) return; dragging = false; if (over()) { draw(); on.done(); } };
  grid.addEventListener("pointerup", stop);
  grid.addEventListener("pointercancel", stop);
  draw();
  return {
    el: el("div", { class: "zpboard" }, grid), over,
    // the line, right as far as it goes, and a few more squares of the answer
    hint() {
      let k = 0;
      while (k < st.path.length && st.path[k] === p.line[k]) k++;
      st.path = p.line.slice(0, Math.min(N, Math.max(k, 1) + 4)); st.h++;
      draw(); on.change();
      if (over()) on.done();
    },
  };
}
