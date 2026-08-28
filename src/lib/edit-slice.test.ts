// Landmark slicing for edit turns (experiment 2026-08-27, owner ask): send the
// model only the sections of the game an ask touches, keep the rest as a
// collapsed placeholder. Hunks still apply to the full file (shown text is
// verbatim); a miss falls back to the full-source strict retry. Pure + tested.
import { describe, it, expect } from "vitest";
import { parseLandmarkSections, sliceEditSource, pickSections } from "./edit-slice";

const GAME = `<!doctype html><html><head><style>body{margin:0}</style></head><body>
<div id="score">0</div>
<script>
// --- GAME STATE ---
let score = 0; let speed = 4; let hearts = 3; const player = { x: 10, color: "blue" };
// --- PLAYER MOVEMENT ---
function movePlayer(dt) { player.x += speed * dt; }
window.addEventListener("keydown", (e) => { if (e.key === "ArrowUp") player.y -= 1; });
// --- ENEMY SPAWNING ---
const enemies = []; function spawnEnemy() { enemies.push({ x: 100, y: 0, vx: -2, vy: 0, w: 20, h: 20, alive: true, kind: 'rock' }); }
function updateEnemies(dt) { for (const e of enemies) { e.x += e.vx * dt; e.y += e.vy * dt; if (e.x < -50) e.alive = false; } }
function pruneEnemies() { for (let i = enemies.length - 1; i >= 0; i--) if (!enemies[i].alive) enemies.splice(i, 1); }
setInterval(spawnEnemy, 1500);
// --- SCORING ---
function addScore(n) { score += n; document.getElementById("score").textContent = score; }
function bestScore() { const b = Number(localStorage.getItem('best') || 0); if (score > b) localStorage.setItem('best', String(score)); return Math.max(b, score); }
function resetScore() { score = 0; document.getElementById("score").textContent = '0'; }
// --- RENDERING ---
function draw() { ctx.fillStyle = player.color; ctx.fillRect(player.x, player.y, 20, 20); }
// --- GAME OVER SCREEN ---
function gameOver() { hearts = 0; alert("Game over"); }
</script></body></html>`;

describe("parseLandmarkSections", () => {
  it("L.1 splits on landmark comment lines and keeps everything before the first as the preamble", () => {
    const s = parseLandmarkSections(GAME);
    expect(s.preamble).toContain("<!doctype html>");
    expect(s.sections.map((x) => x.title)).toEqual(["GAME STATE", "PLAYER MOVEMENT", "ENEMY SPAWNING", "SCORING", "RENDERING", "GAME OVER SCREEN"]);
  });
  it("L.2 re-joining preamble + sections reproduces the source byte-for-byte", () => {
    const s = parseLandmarkSections(GAME);
    expect(s.preamble + s.sections.map((x) => x.text).join("")).toBe(GAME);
  });
});

describe("sliceEditSource", () => {
  it("S.1 a colour ask shows the sections that mention colour/player, hides the rest as placeholders", () => {
    const r = sliceEditSource(GAME, "make the player red");
    expect(r.sliced).toBe(true);
    expect(r.shown).toContain("RENDERING");
    expect(r.shown).toContain("GAME STATE"); // always: variables live here
    expect(r.hidden).toContain("ENEMY SPAWNING");
    expect(r.source).toContain("// --- ENEMY SPAWNING ---"); // landmark stays so the model knows it exists
    expect(r.source).toContain("hidden");
    expect(r.source).not.toContain("spawnEnemy"); // the hidden body is gone
    expect(r.source.length).toBeLessThan(GAME.length);
  });
  it("S.2 every SHOWN section is verbatim — a hunk copied from the slice matches the full file", () => {
    const r = sliceEditSource(GAME, "make the player red");
    for (const t of r.shown) {
      const body = parseLandmarkSections(GAME).sections.find((s) => s.title === t)!.text;
      expect(r.source).toContain(body);
    }
  });
  it("S.3 an ask that touches nothing recognisable is NOT sliced (send everything, never guess)", () => {
    const r = sliceEditSource(GAME, "zorblax the quibble");
    expect(r.sliced).toBe(false);
    expect(r.source).toBe(GAME);
  });
  it("S.4 a game with too few landmarks is not sliced", () => {
    const r = sliceEditSource("<html><script>// --- ALL ---\nlet a=1;</script></html>", "make it red");
    expect(r.sliced).toBe(false);
  });
  it("S.5 a broad ask (hearts + game over) pulls in every matching section", () => {
    const picked = pickSections(GAME, "lose a heart when an enemy hits you and show game over at zero hearts");
    expect(picked).toEqual(expect.arrayContaining(["GAME STATE", "ENEMY SPAWNING", "GAME OVER SCREEN"]));
  });
  it("S.6 reports the saving so the experiment can measure it", () => {
    const r = sliceEditSource(GAME, "make the player red");
    expect(r.fullChars).toBe(GAME.length);
    expect(r.slicedChars).toBe(r.source.length);
  });
});

// 2026-08-28 (owner idea): the BUILD now writes a one-line summary into each
// landmark — `// --- ENEMY SPAWNING: drops rocks that speed up each level ---`.
// The slicer reads those summaries instead of guessing from the body, and every
// HIDDEN section still shows its landmark+summary, so the model always sees a
// table of contents of the whole game even when it only reads two sections.
const SUMMARISED = `<!doctype html><html><head><style>body{margin:0}</style></head><body>
<div id="score">0</div>
<script>
// --- GAME STATE: score, lives and the level list the game loops over ---
let score = 0; let lives = 3; let level = 0; const LEVELS = [{ speed: 4 }, { speed: 7 }];
// --- FROG CONTROLS: arrow keys and the big on-screen buttons hop the frog ---
function hop(dir) { frog.x += dir * 20; }
window.addEventListener("keydown", (e) => { if (e.key === "ArrowLeft") hop(-1); });
// --- LILY PADS: floating platforms drifting across the pond ---
const pads = []; function spawnPad() { pads.push({ x: 0, y: 40, w: 60, drift: 2, sunk: false }); }
function updatePads(dt) { for (const p of pads) { p.x += p.drift * dt; if (p.x > 400) p.x = -60; } }
function drawPads() { for (const p of pads) ctx.fillRect(p.x, p.y, p.w, 10); }
function padUnder(x, y) { return pads.find((p) => x > p.x && x < p.x + p.w && Math.abs(y - p.y) < 8); }
function sinkPad(p) { p.sunk = true; setTimeout(() => { p.sunk = false; }, 1200); }
function prunePads() { for (let i = pads.length - 1; i >= 0; i--) if (pads[i].x < -120) pads.splice(i, 1); }
function padCount() { return pads.filter((p) => !p.sunk).length; }
setInterval(spawnPad, 900);
for (let i = 0; i < 6; i++) spawnPad();
// --- SCORING: adds 10 points per pad crossed and updates the score box ---
function addScore() { score += 10; document.getElementById("score").textContent = score; }
// --- RENDERING: paints the pond, the frog and everything else each frame ---
function draw() { ctx.fillStyle = "#3b7"; ctx.fillRect(0, 0, 400, 300); drawPads(); drawFrog(); drawHud(); }
function drawFrog() { ctx.fillStyle = "#0a0"; ctx.fillRect(frog.x, frog.y, 18, 18); }
function drawHud() { ctx.fillStyle = "#fff"; ctx.fillText("Lives: " + lives, 8, 16); }
function resize() { canvas.width = canvas.clientWidth; canvas.height = canvas.clientHeight; }
window.addEventListener("resize", resize); resize();
function loop(t) { const dt = Math.min((t - last) / 16, 3); last = t; updatePads(dt); draw(); requestAnimationFrame(loop); }
requestAnimationFrame(loop);
// --- WIN AND GAME OVER: shows the win or game-over card and the play again button ---
function finish(won) { overlay.textContent = won ? "You win!" : "Game over"; }
</script></body></html>`;

/** Real games run 25–40k chars (measured on production: model view ~35k), and
 *  the slicer's fixed explanatory note only pays for itself at that scale — so
 *  the mechanics tests run against a realistically inflated copy, not the
 *  2k-char readable fixture. Padding goes INSIDE each section body. */
function inflate(src: string, linesPerSection = 40): string {
  const { preamble, sections } = parseLandmarkSections(src);
  return preamble + sections.map((sec, k) => {
    const nl = sec.text.indexOf("\n");
    const head = sec.text.slice(0, nl + 1);
    const body = sec.text.slice(nl + 1);
    const filler = Array.from({ length: linesPerSection }, (_, i) => `  const pad${k}_${i} = ${i}; // routine ${sec.title.toLowerCase()} bookkeeping line ${i}`).join("\n");
    return head + filler + "\n" + body;
  }).join("");
}

describe("landmark summaries (2026-08-28)", () => {
  it("M.1 parses TITLE and the one-line summary, in both comment styles", () => {
    const { sections } = parseLandmarkSections(SUMMARISED);
    expect(sections.map((s) => s.title)).toEqual(["GAME STATE", "FROG CONTROLS", "LILY PADS", "SCORING", "RENDERING", "WIN AND GAME OVER"]);
    expect(sections[2]!.summary).toBe("floating platforms drifting across the pond");
    const html = parseLandmarkSections('<!-- SCORING: adds 10 points per coin -->\nlet a=1;');
    expect(html.sections[0]).toMatchObject({ title: "SCORING", summary: "adds 10 points per coin", style: "html" });
  });

  it("M.2 a bare landmark (every game built before today) still parses, with an empty summary", () => {
    const { sections } = parseLandmarkSections("// --- PLAYER MOVEMENT ---\nlet a=1;");
    expect(sections[0]).toMatchObject({ title: "PLAYER MOVEMENT", summary: "" });
  });

  it("M.3 re-joining still reproduces the source byte-for-byte (hunks must keep matching)", () => {
    const s = parseLandmarkSections(SUMMARISED);
    expect(s.preamble + s.sections.map((x) => x.text).join("")).toBe(SUMMARISED);
  });

  it("M.4 the SUMMARY is what finds the section — words that appear nowhere in the code still match", () => {
    // "platforms"/"drifting"/"pond" live ONLY in the LILY PADS summary; the
    // keyword scorer on the body alone could never have found this.
    expect(pickSections(SUMMARISED, "make the floating platforms drift slower")).toContain("LILY PADS");
    // "play again" lives only in the WIN AND GAME OVER summary.
    expect(pickSections(SUMMARISED, "make the play again button bigger")).toContain("WIN AND GAME OVER");
  });

  it("M.5 every hidden section keeps its landmark AND summary — the model sees the whole map", () => {
    const BIG = inflate(SUMMARISED);
    const r = sliceEditSource(BIG, "make the play again button bigger");
    expect(r.sliced).toBe(true);
    expect(r.hidden.length).toBeGreaterThan(0);
    for (const t of r.hidden) {
      const sec = parseLandmarkSections(BIG).sections.find((s) => s.title === t)!;
      expect(r.source, t).toContain(sec.summary); // summary survives
      expect(r.source, t).toContain(t); // title survives
    }
    expect(r.source).not.toContain("function updatePads"); // hidden BODY is gone
  });

  it("M.6 shown sections stay verbatim so a copied SEARCH block still matches the full file", () => {
    const BIG = inflate(SUMMARISED);
    const r = sliceEditSource(BIG, "make the play again button bigger");
    expect(r.sliced).toBe(true);
    for (const t of r.shown) {
      const sec = parseLandmarkSections(BIG).sections.find((s) => s.title === t)!;
      expect(r.source).toContain(sec.text);
    }
  });
});

// 2026-08-28 (owner decision, after the 3D run broke a game): slicing applies
// to 2D games ONLY. On a 3D game "change the sky to night" hid INITIALIZATION,
// the model rewrote init() from scratch and shipped a duplicate declaration
// that crashes — see docs/2026-08-28_EXPERIMENT_EditSlicing.md. 3D games are
// detected with game-edit.ts's gameUsesThree, the SAME predicate billing and
// the 2D→3D conversion use, so the three can never disagree.
describe("2D only (2026-08-28)", () => {
  const twoD = inflate(SUMMARISED);
  const ask = "make the play again button bigger";

  it("T.1 a plain 2D game still slices", () => {
    expect(sliceEditSource(twoD, ask).sliced).toBe(true);
  });

  it("T.2 a game carrying the USES_THREE marker is never sliced", () => {
    expect(sliceEditSource(twoD.replace("<body>", "<body><!--USES_THREE-->"), ask).sliced).toBe(false);
  });

  it("T.3 a game that imports three, or calls loadModel, is never sliced — marker or not", () => {
    expect(sliceEditSource(twoD.replace("<script>", '<script type="module">import { Scene } from "three";'), ask).sliced).toBe(false);
    expect(sliceEditSource(twoD.replace("let score = 0;", 'loadModel("frog"); let score = 0;'), ask).sliced).toBe(false);
  });

  it("T.4 the refusal returns the FULL source untouched, not a half-slice", () => {
    const three = twoD.replace("<body>", "<body><!--USES_THREE-->");
    const r = sliceEditSource(three, ask);
    expect(r.source).toBe(three);
    expect(r.shown).toEqual([]);
    expect(r.hidden).toEqual([]);
  });
});
