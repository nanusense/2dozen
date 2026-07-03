// 2Dozen admin dashboard.
//
// This is a light front door, not real access control: the password lives
// in this file in plain text, and the underlying data is already public
// per firestore.rules (`allow read: if true`). This page exists purely to
// make that public data readable as a dashboard instead of raw JSON.

import { firebaseConfig } from '../firebase-config.js';

const PASSWORD = '090621';
const UNLOCK_KEY = 'nimda_unlocked';
const EPOCH = '2026-07-06';
const FIREBASE_SDK_VERSION = '10.13.0';
const QUERY_LIMIT = 1000;

const $ = (id) => document.getElementById(id);
const el = {
  gate: $('gate'),
  gateForm: $('gate-form'),
  gatePassword: $('gate-password'),
  gateError: $('gate-error'),
  dashboard: $('dashboard'),
  btnLock: $('btn-lock'),
  statTotal: $('stat-total'),
  statPlayers: $('stat-players'),
  statAvgTime: $('stat-avgtime'),
  statToday: $('stat-today'),
  chartStars: $('chart-stars'),
  chartDifficulty: $('chart-difficulty'),
  chartPuzzles: $('chart-puzzles'),
  activityBody: $('activity-body'),
  dataNote: $('data-note'),
};

function formatTime(ms) {
  const totalSec = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function localMidnight(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }

function todaysPuzzleNumber() {
  const epoch = localMidnight(new Date(`${EPOCH}T00:00:00`));
  const today = localMidnight(new Date());
  return Math.round((today - epoch) / 86400000) + 1;
}

function difficultyForPuzzleNumber(puzzleNumber, puzzles) {
  if (!puzzles || puzzles.length === 0) return null;
  const idx = (((puzzleNumber - 1) % puzzles.length) + puzzles.length) % puzzles.length;
  return puzzles[idx].difficulty;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------- password gate ----------

function showDashboard() {
  el.gate.hidden = true;
  el.dashboard.hidden = false;
  loadDashboard();
}

function checkUnlocked() {
  if (sessionStorage.getItem(UNLOCK_KEY) === '1') showDashboard();
}

el.gateForm.addEventListener('submit', (e) => {
  e.preventDefault();
  if (el.gatePassword.value === PASSWORD) {
    sessionStorage.setItem(UNLOCK_KEY, '1');
    el.gateError.hidden = true;
    showDashboard();
  } else {
    el.gateError.hidden = false;
    el.gatePassword.value = '';
  }
});

el.btnLock.addEventListener('click', () => {
  sessionStorage.removeItem(UNLOCK_KEY);
  el.dashboard.hidden = true;
  el.gate.hidden = false;
  el.gatePassword.value = '';
  el.gatePassword.focus();
});

// ---------- data + rendering ----------

function renderBarChart(container, rows, { horizontal = false } = {}) {
  if (rows.length === 0) {
    container.innerHTML = '<div class="bar-chart-empty">No data yet.</div>';
    return;
  }
  const max = Math.max(...rows.map((r) => r.count), 1);
  container.innerHTML = rows
    .map(
      (r) => `<div class="bar-row">
        <span class="bar-label">${escapeHtml(r.label)}</span>
        <span class="bar-track"><span class="bar-fill" style="width:${(r.count / max) * 100}%"></span></span>
        <span class="bar-count">${r.count}</span>
      </div>`
    )
    .join('');
}

async function loadDashboard() {
  el.dataNote.textContent = 'Loading…';
  try {
    const [{ initializeApp }, fs, puzzles] = await Promise.all([
      import(`https://www.gstatic.com/firebasejs/${FIREBASE_SDK_VERSION}/firebase-app.js`),
      import(`https://www.gstatic.com/firebasejs/${FIREBASE_SDK_VERSION}/firebase-firestore.js`),
      fetch('../puzzles.json').then((r) => r.json()),
    ]);
    const app = initializeApp(firebaseConfig);
    const db = fs.getFirestore(app);

    const q = fs.query(fs.collection(db, 'scores'), fs.orderBy('created_at', 'desc'), fs.limit(QUERY_LIMIT));
    const snap = await fs.getDocs(q);
    const rows = snap.docs.map((d) => d.data());

    renderStats(rows);
    renderStars(rows);
    renderDifficulty(rows, puzzles);
    renderPuzzles(rows);
    renderActivity(rows);

    el.dataNote.textContent =
      rows.length >= QUERY_LIMIT
        ? `Showing the most recent ${QUERY_LIMIT} submissions.`
        : `Showing all ${rows.length} submission${rows.length === 1 ? '' : 's'}.`;
  } catch (err) {
    el.dataNote.textContent = `Couldn't load data: ${err?.message || err}`;
  }
}

function renderStats(rows) {
  el.statTotal.textContent = rows.length;
  el.statPlayers.textContent = new Set(rows.map((r) => r.player_id)).size;
  const avgMs = rows.length ? rows.reduce((sum, r) => sum + r.time_ms, 0) / rows.length : 0;
  el.statAvgTime.textContent = rows.length ? formatTime(avgMs) : '—';
  const today = todaysPuzzleNumber();
  el.statToday.textContent = rows.filter((r) => r.puzzle_number === today).length;
}

function renderStars(rows) {
  const counts = { 1: 0, 2: 0, 3: 0 };
  for (const r of rows) counts[r.stars] = (counts[r.stars] || 0) + 1;
  renderBarChart(
    el.chartStars,
    [3, 2, 1].map((k) => ({ label: '★'.repeat(k), count: counts[k] || 0 }))
  );
}

function renderDifficulty(rows, puzzles) {
  const counts = { EASY: 0, MEDIUM: 0, HARD: 0 };
  for (const r of rows) {
    const diff = difficultyForPuzzleNumber(r.puzzle_number, puzzles);
    if (diff) counts[diff] += 1;
  }
  renderBarChart(
    el.chartDifficulty,
    ['EASY', 'MEDIUM', 'HARD'].map((k) => ({ label: k, count: counts[k] }))
  );
}

function renderPuzzles(rows) {
  const counts = new Map();
  for (const r of rows) counts.set(r.puzzle_number, (counts.get(r.puzzle_number) || 0) + 1);
  const sorted = [...counts.entries()].sort((a, b) => b[0] - a[0]).slice(0, 14).reverse();
  renderBarChart(
    el.chartPuzzles,
    sorted.map(([puzzleNumber, count]) => ({ label: `#${puzzleNumber}`, count })),
    { horizontal: true }
  );
}

function renderActivity(rows) {
  const recent = rows.slice(0, 30);
  if (recent.length === 0) {
    el.activityBody.innerHTML = '<tr class="admin-table-empty"><td colspan="5">No submissions yet.</td></tr>';
    return;
  }
  el.activityBody.innerHTML = recent
    .map((r) => {
      const when = r.created_at?.seconds
        ? new Date(r.created_at.seconds * 1000).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
        : '—';
      return `<tr>
        <td>${when}</td>
        <td>#${r.puzzle_number}</td>
        <td class="name-cell">${escapeHtml(r.handle)}</td>
        <td>${formatTime(r.time_ms)}</td>
        <td class="stars-cell">${'★'.repeat(r.stars)}</td>
      </tr>`;
    })
    .join('');
}

checkUnlocked();
