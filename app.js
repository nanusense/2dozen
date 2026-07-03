// 2Dozen — game engine, storage, and leaderboard wiring.
// No build step: this is a native ES module loaded directly by index.html.

import { firebaseConfig } from './firebase-config.js';

const EPOCH = '2026-07-03';
const STORAGE_KEY = 'game_state_v1';
const FIREBASE_SDK_VERSION = '10.13.0';
const PROFANITY = ['fuck', 'shit', 'bitch', 'cunt', 'nigger', 'faggot', 'rape', 'cock', 'dick', 'pussy', 'nazi'];

// ---------- exact rational arithmetic ----------

function gcd(a, b) {
  a = Math.abs(a);
  b = Math.abs(b);
  while (b) [a, b] = [b, a % b];
  return a || 1;
}

class Fraction {
  constructor(n, d = 1) {
    if (d === 0) throw new Error('zero denominator');
    if (d < 0) { n = -n; d = -d; }
    const g = gcd(n, d);
    this.n = n / g;
    this.d = d / g;
  }
  add(o) { return new Fraction(this.n * o.d + o.n * this.d, this.d * o.d); }
  sub(o) { return new Fraction(this.n * o.d - o.n * this.d, this.d * o.d); }
  mul(o) { return new Fraction(this.n * o.n, this.d * o.d); }
  div(o) { return o.n === 0 ? null : new Fraction(this.n * o.d, this.d * o.n); }
  equalsInt(k) { return this.d === 1 && this.n === k; }
}

// Every tile remembers the expression that produced it (leaves are just
// their own number), so the board can show *how* a result was derived, not
// just the number. Merge order is the only way to express parenthesization
// in this UI, so this doubles as the visible proof of what got grouped.
const PRECEDENCE = { '+': 1, '-': 1, '*': 2, '/': 2 };
const OPSYM = { '+': '+', '-': '−', '*': '×', '/': '÷' };

function wrapExpr(tile, parentPrec, isRightChild, parentOp) {
  if (tile.isLeaf) return tile.expr;
  const needParens =
    tile.opPrec < parentPrec ||
    (tile.opPrec === parentPrec && isRightChild && (parentOp === '-' || parentOp === '/'));
  return needParens ? `(${tile.expr})` : tile.expr;
}

function combine(a, b, op) {
  let value;
  if (op === '+') value = a.value.add(b.value);
  else if (op === '-') value = a.value.sub(b.value);
  else if (op === '*') value = a.value.mul(b.value);
  else {
    value = a.value.div(b.value);
    if (value === null) return null;
  }
  const opPrec = PRECEDENCE[op];
  const leftStr = wrapExpr(a, opPrec, false, op);
  const rightStr = wrapExpr(b, opPrec, true, op);
  return { value, expr: `${leftStr} ${OPSYM[op]} ${rightStr}`, isLeaf: false, opPrec };
}

function formatFraction(f) {
  if (f.d === 1) return { plain: true, text: `${f.n}` };
  const neg = f.n < 0;
  return { plain: false, sign: neg ? '−' : '', num: Math.abs(f.n), den: f.d };
}

function formatTime(ms) {
  const totalSec = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function prefersReducedMotion() {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ---------- daily puzzle selection ----------

function localMidnight(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }

// `?asOf=YYYY-MM-DD` lets us simulate another date while testing; unused in production.
function now() {
  const override = new URLSearchParams(location.search).get('asOf');
  return override ? new Date(`${override}T12:00:00`) : new Date();
}

function daysSinceEpoch() {
  const epoch = localMidnight(new Date(`${EPOCH}T00:00:00`));
  const today = localMidnight(now());
  return Math.round((today - epoch) / 86400000);
}

// ---------- storage ----------

function testStorage() {
  try {
    const k = '__2dozen_test__';
    localStorage.setItem(k, '1');
    localStorage.removeItem(k);
    return true;
  } catch {
    return false;
  }
}

const storageAvailable = testStorage();

function randomId() {
  if (window.crypto?.randomUUID) return crypto.randomUUID();
  return `p-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

function defaultState() {
  return {
    version: 1,
    playerId: randomId(),
    handle: null,
    streak: { current: 0, max: 0, lastSolvedPuzzleNumber: null },
    totalSolved: 0,
    gaveUpCount: 0,
    starHistogram: { 1: 0, 2: 0, 3: 0 },
    history: {},
    pendingScoreWrites: [],
    seenHelp: false,
  };
}

function migrateState(parsed) {
  const base = defaultState();
  return {
    ...base,
    ...parsed,
    streak: { ...base.streak, ...(parsed.streak || {}) },
    starHistogram: { ...base.starHistogram, ...(parsed.starHistogram || {}) },
    history: parsed.history || {},
    pendingScoreWrites: parsed.pendingScoreWrites || [],
  };
}

function loadState() {
  if (!storageAvailable) {
    document.getElementById('storage-notice').hidden = false;
    return defaultState();
  }
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultState();
    return migrateState(JSON.parse(raw));
  } catch {
    return defaultState();
  }
}

function saveState() {
  if (!storageAvailable) return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // ignore quota errors etc, game stays playable in-memory
  }
}

// ---------- firestore (lazy) ----------

function firebaseReady() {
  return !!(firebaseConfig && firebaseConfig.projectId);
}

let firestoreApiPromise = null;
async function getFirestoreApi() {
  if (!firestoreApiPromise) {
    firestoreApiPromise = (async () => {
      const [{ initializeApp }, fs] = await Promise.all([
        import(`https://www.gstatic.com/firebasejs/${FIREBASE_SDK_VERSION}/firebase-app.js`),
        import(`https://www.gstatic.com/firebasejs/${FIREBASE_SDK_VERSION}/firebase-firestore.js`),
      ]);
      const app = initializeApp(firebaseConfig);
      const db = fs.getFirestore(app);
      return { db, ...fs };
    })();
  }
  return firestoreApiPromise;
}

function queuePendingWrite(puzzleNumber, timeMs, stars) {
  state.pendingScoreWrites = state.pendingScoreWrites.filter((w) => w.puzzleNumber !== puzzleNumber);
  state.pendingScoreWrites.push({ puzzleNumber, timeMs, stars });
  saveState();
}

async function submitScore(puzzleNumber, timeMs, stars) {
  if (!state.handle) return;
  if (!firebaseReady()) {
    queuePendingWrite(puzzleNumber, timeMs, stars);
    return;
  }
  try {
    const { db, doc, setDoc, serverTimestamp } = await getFirestoreApi();
    const docId = `${puzzleNumber}_${state.playerId}`;
    await setDoc(doc(db, 'scores', docId), {
      puzzle_number: puzzleNumber,
      player_id: state.playerId,
      handle: state.handle,
      time_ms: Math.round(timeMs),
      stars,
      created_at: serverTimestamp(),
    });
    state.pendingScoreWrites = state.pendingScoreWrites.filter((w) => w.puzzleNumber !== puzzleNumber);
    saveState();
  } catch (err) {
    if (err?.code !== 'permission-denied') queuePendingWrite(puzzleNumber, timeMs, stars);
  }
}

function pruneStalePendingWrites(puzzleNumber) {
  state.pendingScoreWrites = state.pendingScoreWrites.filter((w) => w.puzzleNumber === puzzleNumber);
  saveState();
}

async function retryPendingWrites(puzzleNumber) {
  if (!firebaseReady() || !state.handle) return;
  for (const item of state.pendingScoreWrites.filter((w) => w.puzzleNumber === puzzleNumber)) {
    await submitScore(item.puzzleNumber, item.timeMs, item.stars);
  }
}

// Leaderboards only open up once a player has finished today's puzzle
// (solved or given up) *and* set a display name, so nobody sees who's on
// the board without having played today, and nobody appears on it
// without a name attached.
function showLeaderboard(puzzleNumber, listEl, ownRankEl) {
  const entry = state.history[puzzleNumber];
  const completedToday = entry && (entry.status === 'solved' || entry.status === 'gaveup');

  if (!completedToday) {
    listEl.innerHTML = '<li class="leaderboard-locked"><span>Finish today\'s puzzle to see the leaderboard.</span></li>';
    ownRankEl.textContent = '';
    return;
  }
  if (!state.handle) {
    listEl.innerHTML = `<li class="leaderboard-locked">
      <span>Add a name to see today's leaderboard.</span>
      <button type="button" class="leaderboard-cta-btn" data-open-handle-modal>Add name</button>
    </li>`;
    ownRankEl.textContent = '';
    return;
  }
  loadLeaderboard(puzzleNumber, listEl, ownRankEl);
}

async function loadLeaderboard(puzzleNumber, listEl, ownRankEl) {
  listEl.innerHTML = '<li class="leaderboard-loading">Loading&hellip;</li>';
  ownRankEl.textContent = '';
  if (!firebaseReady()) {
    listEl.innerHTML = '<li class="leaderboard-empty">Leaderboard isn\'t set up yet.</li>';
    return;
  }
  try {
    const { db, collection, query, where, orderBy, limit, getDocs, getCountFromServer } = await getFirestoreApi();
    const q = query(
      collection(db, 'scores'),
      where('puzzle_number', '==', puzzleNumber),
      orderBy('time_ms', 'asc'),
      limit(25)
    );
    const snap = await getDocs(q);
    const rows = snap.docs.map((d) => d.data());
    renderLeaderboardRows(rows, listEl);

    const inTop = rows.some((r) => r.player_id === state.playerId);
    const entry = state.history[puzzleNumber];
    if (!inTop && entry && entry.status === 'solved') {
      const cq = query(
        collection(db, 'scores'),
        where('puzzle_number', '==', puzzleNumber),
        where('time_ms', '<', entry.timeMs)
      );
      const countSnap = await getCountFromServer(cq);
      const rank = countSnap.data().count + 1;
      ownRankEl.textContent = `You: #${rank} · ${formatTime(entry.timeMs)}${state.handle ? ` · ${state.handle}` : ''}`;
    }
  } catch {
    listEl.innerHTML = '<li class="leaderboard-empty">Couldn\'t load the leaderboard.</li>';
  }
}

function renderLeaderboardRows(rows, listEl) {
  if (rows.length === 0) {
    listEl.innerHTML = '<li class="leaderboard-empty">Nobody\'s solved today\'s puzzle yet.</li>';
    return;
  }
  listEl.innerHTML = rows
    .map((r, i) => {
      const isYou = r.player_id === state.playerId;
      return `<li class="${isYou ? 'is-you' : ''}">
        <span class="lb-rank">${i + 1}</span>
        <span class="lb-handle">${escapeHtml(r.handle)}</span>
        <span class="lb-time">${formatTime(r.time_ms)}</span>
        <span class="lb-stars">${'★'.repeat(r.stars)}</span>
      </li>`;
    })
    .join('');
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------- DOM refs ----------

const $ = (id) => document.getElementById(id);

const el = {
  storageNotice: $('storage-notice'),
  btnStreak: $('btn-streak'),
  streakCount: $('streak-count'),
  btnLeaderboard: $('btn-leaderboard'),
  btnStats: $('btn-stats'),
  btnHelp: $('btn-help'),
  practiceBanner: $('practice-banner'),
  practiceBack: $('practice-back'),
  puzzleLabel: $('puzzle-label'),
  difficultyBadge: $('puzzle-difficulty'),
  timer: $('timer'),
  practiceBadge: $('practice-badge'),
  hint: $('hint'),
  board: $('board'),
  tiles: $('tiles'),
  operators: $('operators'),
  btnUndo: $('btn-undo'),
  btnReset: $('btn-reset'),
  btnGiveup: $('btn-giveup'),
  controls: document.querySelector('.controls'),
  results: $('results'),
  resultsStars: $('results-stars'),
  resultsSummary: $('results-summary'),
  resultsSolution: $('results-solution'),
  btnShare: $('btn-share'),
  shareMenu: $('share-menu'),
  shareWhatsapp: $('share-whatsapp'),
  shareEmail: $('share-email'),
  shareX: $('share-x'),
  shareCopy: $('share-copy'),
  countdown: $('countdown'),
  leaderboardList: $('leaderboard-list'),
  leaderboardOwnRank: $('leaderboard-own-rank'),
  practiceLink: $('practice-link'),
  practiceResults: $('practice-results'),
  practiceResultsSummary: $('practice-results-summary'),
  practiceResultsSolution: $('practice-results-solution'),
  btnPracticeNext: $('btn-practice-next'),
  modalHandle: $('modal-handle'),
  handleInput: $('handle-input'),
  handleError: $('handle-error'),
  handleSkip: $('handle-skip'),
  modalStats: $('modal-stats'),
  statPlayed: $('stat-played'),
  statCurrentStreak: $('stat-current-streak'),
  statMaxStreak: $('stat-max-streak'),
  starHistogram: $('star-histogram'),
  statsEditHandle: $('stats-edit-handle'),
  statsClose: $('stats-close'),
  modalLeaderboard: $('modal-leaderboard'),
  leaderboardListModal: $('leaderboard-list-modal'),
  leaderboardOwnRankModal: $('leaderboard-own-rank-modal'),
  leaderboardClose: $('leaderboard-close'),
  modalHelp: $('modal-help'),
  helpClose: $('help-close'),
  toast: $('toast'),
};

// ---------- state ----------

let state = null;
let puzzles = [];
let dailyContext = null; // { puzzleNumber, puzzleData }
let game = null;
let selection = { first: null, op: null, second: null };
let nextTileId = 1;
let pendingHandleSubmission = null;
let showStatsAfterHandleClose = false;
let toastTimeout = null;

// ---------- rendering ----------

function render() {
  renderTiles();
  renderOperators();
  renderHint();
  el.btnUndo.disabled = game.locked || game.undoStack.length === 0;
  el.btnReset.disabled = game.locked;
  el.btnGiveup.disabled = game.locked;
}

// Plain (unparenthesized) text for a tile's value, for the hint line, e.g. "7" or "8/3".
function tileValueText(tile) {
  const f = formatFraction(tile.value);
  return f.plain ? f.text : `${f.sign}${f.num}/${f.den}`;
}

function renderHint() {
  if (!el.hint || game.locked) {
    if (el.hint) el.hint.textContent = '';
    return;
  }
  el.hint.classList.remove('hint-stuck');
  const { first, op, second } = selection;

  if (first === null) {
    if (game.tiles.length === 1 && !game.tiles[0].value.equalsInt(24)) {
      el.hint.classList.add('hint-stuck');
      el.hint.textContent = 'Not 24 yet. Undo or Reset to try again.';
    } else if (game.tiles.length > 1) {
      el.hint.textContent = 'Tap a number to start';
    } else {
      el.hint.textContent = '';
    }
    return;
  }

  const firstTile = game.tiles.find((t) => t.id === first);
  if (!firstTile) { el.hint.textContent = ''; return; }

  if (op === null) {
    el.hint.innerHTML = `${tileValueText(firstTile)} &mdash; choose an operator`;
    return;
  }

  if (second === null) {
    el.hint.innerHTML = `${tileValueText(firstTile)} <span class="hint-op">${OPSYM[op]}</span> &mdash; tap another number`;
    return;
  }

  const secondTile = game.tiles.find((t) => t.id === second);
  el.hint.innerHTML = `${tileValueText(firstTile)} <span class="hint-op">${OPSYM[op]}</span> ${tileValueText(secondTile)} &mdash; press Enter to confirm`;
}

function renderTiles() {
  el.tiles.innerHTML = '';
  for (const tile of game.tiles) {
    const wrap = document.createElement('div');
    wrap.className = 'tile-wrap';

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'tile';
    btn.dataset.tileId = tile.id;
    const f = formatFraction(tile.value);
    if (f.plain) {
      btn.textContent = f.text;
    } else {
      btn.classList.add('frac');
      btn.innerHTML = `<span class="frac-num"><span class="frac-sign">${f.sign}</span>${f.num}</span><span class="frac-den">${f.den}</span>`;
    }
    if (selection.first === tile.id) btn.classList.add('selected');
    if (tile.justFormed) {
      btn.classList.add('newly-formed');
      tile.justFormed = false;
    }
    btn.addEventListener('click', () => onTileTap(tile.id, false));
    wrap.appendChild(btn);

    const derivation = document.createElement('div');
    derivation.className = 'tile-derivation';
    if (!tile.isLeaf) derivation.textContent = tile.expr;
    wrap.appendChild(derivation);

    el.tiles.appendChild(wrap);
  }
}

function renderOperators() {
  el.operators.querySelectorAll('.op-btn').forEach((b) => {
    b.classList.toggle('selected', selection.op === b.dataset.op);
    b.disabled = game.locked || selection.first === null;
  });
}

function renderHeaderStreak() {
  el.streakCount.textContent = state.streak.current;
  el.btnStreak.classList.toggle('has-streak', state.streak.current > 0);
}

function toast(msg) {
  el.toast.textContent = msg;
  el.toast.hidden = false;
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => { el.toast.hidden = true; }, 2400);
}

// ---------- selection & merge ----------

function onTileTap(tileId, viaKeyboard) {
  if (game.locked) return;
  const { first, op } = selection;
  if (first === tileId && op === null) {
    selection.first = null;
  } else if (first === null || op === null) {
    selection.first = tileId;
    selection.op = null;
    selection.second = null;
  } else if (tileId === first) {
    selection = { first: null, op: null, second: null };
  } else {
    selection.second = tileId;
    if (!viaKeyboard) {
      commitMerge();
      return;
    }
  }
  render();
}

function onOpTap(op) {
  if (game.locked) return;
  if (selection.first === null) return;
  selection.op = selection.op === op ? null : op;
  selection.second = null;
  render();
}

function shakeTileEl(tileId) {
  const elm = el.tiles.querySelector(`[data-tile-id="${tileId}"]`);
  if (!elm) return;
  elm.classList.remove('shake');
  void elm.offsetWidth;
  elm.classList.add('shake');
}

function ensureTimerStarted() {
  if (game.startTime) return;
  game.startTime = Date.now();
  game.timerInterval = setInterval(() => {
    el.timer.textContent = formatTime(Date.now() - game.startTime);
  }, 250);
}

function commitMerge() {
  const { first, op, second } = selection;
  if (first == null || op == null || second == null) return;
  const idxA = game.tiles.findIndex((t) => t.id === first);
  const idxB = game.tiles.findIndex((t) => t.id === second);
  const a = game.tiles[idxA];
  const b = game.tiles[idxB];
  const merged = combine(a, b, op);

  if (merged === null) {
    shakeTileEl(second);
    selection.second = null;
    return;
  }

  ensureTimerStarted();
  game.undoStack.push(game.tiles);

  const rest = game.tiles.filter((_, i) => i !== idxA && i !== idxB);
  const insertAt = Math.min(idxA, idxB);
  const newTile = { id: nextTileId++, ...merged, justFormed: true };
  game.tiles = [...rest.slice(0, insertAt), newTile, ...rest.slice(insertAt)];

  selection = { first: null, op: null, second: null };
  render();

  if (game.tiles.length === 1) checkWin();
}

function checkWin() {
  if (game.tiles[0].value.equalsInt(24)) onSolved();
}

function onUndo() {
  if (game.locked || game.undoStack.length === 0) return;
  game.tiles = game.undoStack.pop();
  selection = { first: null, op: null, second: null };
  render();
}

function onReset() {
  if (game.locked) return;
  const hadProgress = game.tiles.length < game.originalTiles.length;
  game.tiles = game.originalTiles;
  game.undoStack = [];
  selection = { first: null, op: null, second: null };
  if (hadProgress) game.resets += 1;
  render();
}

// ---------- give up (two-tap confirm, no native dialog) ----------

let confirmingGiveUp = false;
let giveUpTimeout = null;

function onGiveUpClick() {
  if (game.locked) return;
  if (!confirmingGiveUp) {
    confirmingGiveUp = true;
    el.btnGiveup.textContent = 'Are you sure?';
    giveUpTimeout = setTimeout(resetGiveUpButton, 3000);
  } else {
    resetGiveUpButton();
    doGiveUp();
  }
}

function resetGiveUpButton() {
  confirmingGiveUp = false;
  clearTimeout(giveUpTimeout);
  el.btnGiveup.textContent = 'Give up';
}

function doGiveUp() {
  clearInterval(game.timerInterval);
  game.timeMs = game.startTime ? Date.now() - game.startTime : 0;
  game.locked = true;
  game.gaveUp = true;
  game.stars = 0;

  if (game.mode === 'practice') {
    showPracticeSolution();
    return;
  }
  recordDailyResult({ status: 'gaveup', stars: 0, timeMs: game.timeMs, resets: game.resets });
  showResults({ status: 'gaveup', stars: 0, timeMs: game.timeMs });
}

// ---------- solve ----------

async function onSolved() {
  clearInterval(game.timerInterval);
  game.timeMs = game.startTime ? Date.now() - game.startTime : 0;
  game.solved = true;
  game.locked = true;

  el.board.classList.add('solving');
  el.tiles.querySelectorAll('.tile').forEach((e) => e.classList.add('solved-glow'));
  await sleep(prefersReducedMotion() ? 0 : 650);
  el.board.classList.remove('solving');

  if (game.mode === 'practice') {
    showPracticeResults();
    return;
  }

  const stars = game.resets === 0 ? 3 : game.resets <= 2 ? 2 : 1;
  game.stars = stars;
  recordDailyResult({ status: 'solved', stars, timeMs: game.timeMs, resets: game.resets });
  showResults({ status: 'solved', stars, timeMs: game.timeMs });

  if (state.handle) {
    submitScore(game.puzzleNumber, game.timeMs, stars).then(refreshVisibleLeaderboards);
    renderStatsModal();
    el.modalStats.showModal();
  } else {
    pendingHandleSubmission = { puzzleNumber: game.puzzleNumber, timeMs: game.timeMs, stars };
    showStatsAfterHandleClose = true;
    openHandleModal();
  }
}

function updateStreakOnSolve(puzzleNumber) {
  const s = state.streak;
  if (s.lastSolvedPuzzleNumber === puzzleNumber - 1) {
    s.current += 1;
  } else if (s.lastSolvedPuzzleNumber !== puzzleNumber) {
    s.current = 1;
  }
  s.lastSolvedPuzzleNumber = puzzleNumber;
  s.max = Math.max(s.max, s.current);
}

function recordDailyResult({ status, stars, timeMs, resets }) {
  const dateISO = new Date().toISOString().slice(0, 10);
  state.history[game.puzzleNumber] = { status, stars, timeMs: Math.round(timeMs), resets, dateISO };
  if (status === 'solved') {
    state.totalSolved += 1;
    state.starHistogram[stars] = (state.starHistogram[stars] || 0) + 1;
    updateStreakOnSolve(game.puzzleNumber);
  } else {
    state.gaveUpCount += 1;
    state.streak.current = 0;
  }
  saveState();
  renderHeaderStreak();
}

// ---------- results / countdown / leaderboard panel ----------

function startCountdownTo(targetDate, elm, onReached) {
  let interval;
  function tick() {
    const diff = Math.max(0, targetDate - new Date());
    const h = String(Math.floor(diff / 3600000)).padStart(2, '0');
    const m = String(Math.floor(diff / 60000) % 60).padStart(2, '0');
    const s = String(Math.floor(diff / 1000) % 60).padStart(2, '0');
    elm.textContent = `${h}:${m}:${s}`;
    if (diff <= 0 && onReached) {
      clearInterval(interval);
      onReached();
    }
  }
  tick();
  interval = setInterval(tick, 1000);
  return interval;
}

function startCountdown(elm) {
  const now = new Date();
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0);
  return startCountdownTo(next, elm);
}

function showResults({ status, stars, timeMs }) {
  el.board.hidden = true;
  el.controls.hidden = true;
  el.practiceBanner.hidden = true;
  el.practiceResults.hidden = true;
  el.results.hidden = false;

  const filled = '★'.repeat(stars);
  const empty = '☆'.repeat(3 - stars);
  el.resultsStars.innerHTML = `<span class="lit">${filled}</span>${empty}`;
  el.resultsSummary.textContent = status === 'gaveup' ? `Gave up after ${formatTime(timeMs)}` : `Solved in ${formatTime(timeMs)}`;

  if (status === 'gaveup') {
    el.resultsSolution.hidden = false;
    el.resultsSolution.textContent = `One solution: ${game.sampleSolution}`;
  } else {
    el.resultsSolution.hidden = true;
  }

  if (game.countdownInterval) clearInterval(game.countdownInterval);
  game.countdownInterval = startCountdown(el.countdown);

  showLeaderboard(game.puzzleNumber, el.leaderboardList, el.leaderboardOwnRank);
}

function refreshVisibleLeaderboards() {
  if (game.mode === 'daily' && !el.results.hidden) {
    showLeaderboard(game.puzzleNumber, el.leaderboardList, el.leaderboardOwnRank);
  }
  if (el.modalLeaderboard.open) {
    showLeaderboard(dailyContext.puzzleNumber, el.leaderboardListModal, el.leaderboardOwnRankModal);
  }
}

// Reached from the "Add name" CTA shown in place of a locked leaderboard.
// If today's puzzle is already solved, saving a name here also submits it.
function promptAddName() {
  const entry = state.history[dailyContext?.puzzleNumber];
  if (entry && entry.status === 'solved' && !state.handle) {
    pendingHandleSubmission = { puzzleNumber: dailyContext.puzzleNumber, timeMs: entry.timeMs, stars: entry.stars };
  }
  openHandleModal();
}

function showPracticeResults() {
  el.board.hidden = true;
  el.controls.hidden = true;
  el.results.hidden = true;
  el.practiceResults.hidden = false;
  el.practiceResultsSummary.textContent = `Solved in ${formatTime(game.timeMs)}`;
  el.practiceResultsSolution.hidden = true;
}

function showPracticeSolution() {
  el.board.hidden = true;
  el.controls.hidden = true;
  el.results.hidden = true;
  el.practiceResults.hidden = false;
  el.practiceResultsSummary.textContent = 'Gave up';
  el.practiceResultsSolution.hidden = false;
  el.practiceResultsSolution.textContent = `One solution: ${game.sampleSolution}`;
}

// ---------- handle / leaderboard submission flow ----------

// Kept in sync with the handle regex in firestore.rules.
const HANDLE_REGEX = /^[A-Za-z0-9 '-]{1,16}$/;

function validateHandle(v) {
  if (v.length === 0) return 'Enter a name.';
  if (!HANDLE_REGEX.test(v)) return 'Up to 16 characters: letters, numbers, spaces, apostrophes, hyphens.';
  const lower = v.toLowerCase();
  if (PROFANITY.some((w) => lower.includes(w))) return 'Please choose a different name.';
  return null;
}

function openHandleModal() {
  el.handleInput.value = state.handle || '';
  el.handleError.hidden = true;
  el.modalHandle.showModal();
  el.handleInput.focus();
}


// ---------- stats modal ----------

function renderStatsModal() {
  el.statPlayed.textContent = state.totalSolved;
  el.statCurrentStreak.textContent = state.streak.current;
  el.statMaxStreak.textContent = state.streak.max;
  const hist = state.starHistogram;
  const max = Math.max(1, hist[1], hist[2], hist[3]);
  el.starHistogram.innerHTML = [3, 2, 1]
    .map(
      (k) => `<div class="hist-row">
        <span class="hist-label">${'★'.repeat(k)}</span>
        <span class="hist-bar-track"><span class="hist-bar-fill" style="width:${((hist[k] || 0) / max) * 100}%"></span></span>
        <span class="hist-count">${hist[k] || 0}</span>
      </div>`
    )
    .join('');
}

// ---------- share ----------

function buildShareParts() {
  const stars = '★'.repeat(game.stars) + '☆'.repeat(3 - game.stars);
  return {
    text: `2Dozen #${game.puzzleNumber} · ${game.difficulty}\n${stars} in ${formatTime(game.timeMs)}`,
    url: `${location.origin}${location.pathname}`,
  };
}

async function onShare() {
  const { text, url } = buildShareParts();
  if (navigator.share) {
    try {
      await navigator.share({ title: '2Dozen', text, url });
      return;
    } catch (err) {
      if (err?.name === 'AbortError') return; // user backed out of the native sheet
      // otherwise fall through to the menu below
    }
  }
  openShareMenu(text, url);
}

function openShareMenu(text, url) {
  const full = `${text}\n${url}`;
  el.shareWhatsapp.href = `https://wa.me/?text=${encodeURIComponent(full)}`;
  el.shareEmail.href = `mailto:?subject=${encodeURIComponent('2Dozen')}&body=${encodeURIComponent(full)}`;
  el.shareX.href = `https://twitter.com/intent/tweet?text=${encodeURIComponent(full)}`;
  el.shareMenu.hidden = false;
}

function closeShareMenu() {
  el.shareMenu.hidden = true;
}

async function onShareCopy() {
  const { text, url } = buildShareParts();
  try {
    await navigator.clipboard.writeText(`${text}\n${url}`);
    toast('Copied to clipboard');
  } catch {
    toast('Could not copy. Long-press to select the text instead.');
  }
  closeShareMenu();
}

// ---------- practice mode ----------

function startPractice() {
  const p = puzzles[Math.floor(Math.random() * puzzles.length)];
  initGame({ mode: 'practice', numbers: p.numbers, difficulty: p.difficulty, sampleSolution: p.sampleSolution });
  el.practiceBanner.hidden = false;
}

function returnToDaily() {
  el.practiceBanner.hidden = true;
  loadDailyView();
}

// ---------- init ----------

function initGame(opts) {
  if (game?.timerInterval) clearInterval(game.timerInterval);
  if (game?.countdownInterval) clearInterval(game.countdownInterval);
  resetGiveUpButton();

  const originalTiles = opts.numbers.map((n) => ({ id: nextTileId++, value: new Fraction(n), expr: `${n}`, isLeaf: true }));
  game = {
    mode: opts.mode,
    puzzleNumber: opts.puzzleNumber ?? null,
    difficulty: opts.difficulty,
    sampleSolution: opts.sampleSolution,
    originalTiles,
    tiles: originalTiles,
    undoStack: [],
    resets: 0,
    startTime: null,
    timerInterval: null,
    solved: false,
    gaveUp: false,
    locked: false,
    stars: null,
    timeMs: null,
    countdownInterval: null,
  };
  selection = { first: null, op: null, second: null };
  el.timer.textContent = '0:00';
  el.puzzleLabel.textContent = opts.mode === 'practice' ? 'Practice' : `Puzzle #${opts.puzzleNumber}`;
  el.difficultyBadge.textContent = opts.difficulty;
  el.difficultyBadge.dataset.diff = opts.difficulty;
  el.practiceBadge.hidden = opts.mode !== 'practice';

  el.board.hidden = false;
  el.controls.hidden = false;
  el.results.hidden = true;
  el.practiceResults.hidden = true;

  render();
}

function loadDailyView() {
  const { puzzleNumber, puzzleData } = dailyContext;
  const existing = state.history[puzzleNumber];
  initGame({
    mode: 'daily',
    numbers: puzzleData.numbers,
    difficulty: puzzleData.difficulty,
    sampleSolution: puzzleData.sampleSolution,
    puzzleNumber,
  });
  if (existing) {
    game.locked = true;
    game.stars = existing.stars;
    game.timeMs = existing.timeMs;
    render();
    showResults({ status: existing.status, stars: existing.stars, timeMs: existing.timeMs });
  }
}

function checkStreakBreak(puzzleNumber) {
  const s = state.streak;
  if (s.lastSolvedPuzzleNumber !== null && s.lastSolvedPuzzleNumber < puzzleNumber - 1 && s.current !== 0) {
    s.current = 0;
    saveState();
  }
}

function wireEvents() {
  el.operators.querySelectorAll('.op-btn').forEach((b) => b.addEventListener('click', () => onOpTap(b.dataset.op)));
  el.btnUndo.addEventListener('click', onUndo);
  el.btnReset.addEventListener('click', onReset);
  el.btnGiveup.addEventListener('click', onGiveUpClick);
  el.btnShare.addEventListener('click', onShare);
  el.shareCopy.addEventListener('click', onShareCopy);
  el.shareWhatsapp.addEventListener('click', closeShareMenu);
  el.shareEmail.addEventListener('click', closeShareMenu);
  el.shareX.addEventListener('click', closeShareMenu);
  document.addEventListener('click', (e) => {
    if (!el.shareMenu.hidden && !e.target.closest('.share-wrap')) closeShareMenu();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !el.shareMenu.hidden) closeShareMenu();
  });
  el.practiceLink.addEventListener('click', (e) => { e.preventDefault(); startPractice(); });
  el.practiceBack.addEventListener('click', (e) => { e.preventDefault(); returnToDaily(); });
  el.btnPracticeNext.addEventListener('click', startPractice);

  el.btnStats.addEventListener('click', () => { renderStatsModal(); el.modalStats.showModal(); });
  el.statsClose.addEventListener('click', () => el.modalStats.close());
  el.statsEditHandle.addEventListener('click', () => { el.modalStats.close(); openHandleModal(); });

  el.btnHelp.addEventListener('click', () => el.modalHelp.showModal());
  el.helpClose.addEventListener('click', () => el.modalHelp.close());

  el.btnLeaderboard.addEventListener('click', () => {
    el.modalLeaderboard.showModal();
    showLeaderboard(dailyContext.puzzleNumber, el.leaderboardListModal, el.leaderboardOwnRankModal);
  });
  el.leaderboardClose.addEventListener('click', () => el.modalLeaderboard.close());

  el.modalHandle.addEventListener('submit', (e) => {
    e.preventDefault();
    const val = el.handleInput.value.trim();
    const err = validateHandle(val);
    if (err) {
      el.handleError.textContent = err;
      el.handleError.hidden = false;
      return;
    }
    state.handle = val;
    saveState();
    el.modalHandle.close();
    if (pendingHandleSubmission) {
      submitScore(pendingHandleSubmission.puzzleNumber, pendingHandleSubmission.timeMs, pendingHandleSubmission.stars).then(refreshVisibleLeaderboards);
      pendingHandleSubmission = null;
    } else {
      refreshVisibleLeaderboards();
    }
  });
  el.handleSkip.addEventListener('click', () => {
    el.modalHandle.close();
    pendingHandleSubmission = null;
  });
  el.leaderboardList.addEventListener('click', (e) => {
    if (e.target.closest('[data-open-handle-modal]')) promptAddName();
  });
  el.leaderboardListModal.addEventListener('click', (e) => {
    if (e.target.closest('[data-open-handle-modal]')) promptAddName();
  });
  el.modalHandle.addEventListener('close', () => {
    if (showStatsAfterHandleClose) {
      showStatsAfterHandleClose = false;
      renderStatsModal();
      el.modalStats.showModal();
    }
  });

  window.addEventListener('keydown', (e) => {
    const active = document.activeElement;
    if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')) return;
    if (document.querySelector('dialog[open]')) return;
    if (!game || game.locked) return;

    if (['1', '2', '3', '4'].includes(e.key)) {
      const tile = game.tiles[Number(e.key) - 1];
      if (tile) onTileTap(tile.id, true);
    } else if (['+', '-', '*', '/'].includes(e.key)) {
      onOpTap(e.key);
    } else if (e.key === 'u' || e.key === 'U') {
      onUndo();
    } else if (e.key === 'r' || e.key === 'R') {
      onReset();
    } else if (e.key === 'Enter') {
      commitMerge();
    }
  });
}

async function boot() {
  state = loadState();
  renderHeaderStreak();

  puzzles = await fetch('puzzles.json').then((r) => r.json());

  const dse = daysSinceEpoch();
  const puzzleNumber = dse + 1;
  const contentIndex = ((dse % puzzles.length) + puzzles.length) % puzzles.length;
  dailyContext = { puzzleNumber, puzzleData: puzzles[contentIndex] };

  checkStreakBreak(puzzleNumber);
  renderHeaderStreak();
  pruneStalePendingWrites(puzzleNumber);
  retryPendingWrites(puzzleNumber);

  loadDailyView();
  wireEvents();

  if (!state.seenHelp) {
    state.seenHelp = true;
    saveState();
    el.modalHelp.showModal();
  }
}

boot();
