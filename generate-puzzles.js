#!/usr/bin/env node
// Build-time puzzle generator for 2Dozen. Not shipped to the client.
//
// Enumerates every multiset of 4 numbers from 1-13, brute-forces every way to
// combine them (mirroring the tap-to-combine UI: repeatedly pick any two
// remaining tiles and apply an operator) using exact rational arithmetic, and
// counts distinct solutions that reach exactly 24. Distinct = not a trivial
// commutative reordering (a+b counts the same as b+a) at any node.
//
// Output: puzzles.json, ordered so a rolling weekday pattern (Mon/Tue EASY,
// Wed-Fri MEDIUM, Sat/Sun HARD) aligns with real weekdays starting from the
// EPOCH date, and whose length is an exact multiple of 7 so the pattern stays
// aligned forever once the client wraps the index with `% list.length`.

const fs = require('fs');
const path = require('path');

const EPOCH = '2026-07-05';
const SEED = 20260706;

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
  toString() { return this.d === 1 ? `${this.n}` : `${this.n}/${this.d}`; }
}

// ---------- solver ----------

const PRECEDENCE = { '+': 1, '-': 1, '*': 2, '/': 2 };
const OPSYM = { '+': '+', '-': '−', '*': '×', '/': '÷' };

function wrap(tile, parentPrec, isRightChild, parentOp) {
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
  const prec = PRECEDENCE[op];
  const leftStr = wrap(a, prec, false, op);
  const rightStr = wrap(b, prec, true, op);
  const expr = `${leftStr} ${OPSYM[op]} ${rightStr}`;
  const key =
    op === '+' || op === '*'
      ? `${op}(${[a.key, b.key].sort().join(',')})`
      : `${op}(${a.key},${b.key})`;
  return { value, expr, isLeaf: false, opPrec: prec, key };
}

// Returns { solutionCount, sampleSolution } for a quad of 4 integers.
function solveQuad(numbers) {
  const initial = numbers.map((n) => ({
    value: new Fraction(n),
    expr: `${n}`,
    isLeaf: true,
    key: `${n}`,
  }));

  const solutionKeys = new Set();
  let sample = null;

  function recurse(tiles) {
    if (tiles.length === 1) {
      if (tiles[0].value.equalsInt(24)) {
        solutionKeys.add(tiles[0].key);
        if (sample === null) sample = tiles[0].expr;
      }
      return;
    }
    for (let i = 0; i < tiles.length; i++) {
      for (let j = i + 1; j < tiles.length; j++) {
        const rest = tiles.filter((_, idx) => idx !== i && idx !== j);
        const a = tiles[i];
        const b = tiles[j];

        const add = combine(a, b, '+');
        const mul = combine(a, b, '*');
        const subAB = combine(a, b, '-');
        const subBA = combine(b, a, '-');
        const divAB = combine(a, b, '/');
        const divBA = combine(b, a, '/');

        for (const merged of [add, mul, subAB, subBA, divAB, divBA]) {
          if (merged === null) continue;
          recurse([...rest, merged]);
        }
      }
    }
  }

  recurse(initial);
  return { solutionCount: solutionKeys.size, sampleSolution: sample };
}

// ---------- deterministic PRNG ----------

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(arr, rng) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ---------- enumerate all quads ----------

function difficultyFor(count) {
  if (count >= 10) return 'EASY';
  if (count >= 4) return 'MEDIUM';
  if (count >= 1) return 'HARD';
  return null;
}

function main() {
  const rng = mulberry32(SEED);
  const all = [];

  for (let a = 1; a <= 13; a++) {
    for (let b = a; b <= 13; b++) {
      for (let c = b; c <= 13; c++) {
        for (let d = c; d <= 13; d++) {
          const { solutionCount, sampleSolution } = solveQuad([a, b, c, d]);
          const difficulty = difficultyFor(solutionCount);
          if (!difficulty) continue;
          all.push({ numbers: [a, b, c, d], difficulty, solutionCount, sampleSolution });
        }
      }
    }
  }

  console.log(`Enumerated ${13 * 14 * 15 * 16 / 24} quads total (expect 1820).`);
  console.log(`Solvable quads: ${all.length}`);

  // Verification against known cases from the spec.
  const known3388 = all.find((p) => p.numbers.join(',') === '3,3,8,8');
  const known2346 = all.find((p) => p.numbers.join(',') === '2,3,4,6');
  console.log('3,3,8,8 ->', known3388 ? `${known3388.solutionCount} solutions (${known3388.difficulty}), e.g. ${known3388.sampleSolution}` : 'UNSOLVED');
  console.log('2,3,4,6 ->', known2346 ? `${known2346.solutionCount} solutions (${known2346.difficulty}), e.g. ${known2346.sampleSolution}` : 'UNSOLVED');

  const easyBucket = all.filter((p) => p.difficulty === 'EASY');
  const mediumBucket = all.filter((p) => p.difficulty === 'MEDIUM');
  const hardBucket = all.filter((p) => p.difficulty === 'HARD');
  console.log(`EASY: ${easyBucket.length}, MEDIUM: ${mediumBucket.length}, HARD: ${hardBucket.length}`);

  const easyShuffled = shuffle(easyBucket, rng);
  const mediumShuffled = shuffle(mediumBucket, rng);
  const hardShuffled = shuffle(hardBucket, rng);

  // Randomize each puzzle's displayed number order too (deterministic, same rng chain).
  for (const bucket of [easyShuffled, mediumShuffled, hardShuffled]) {
    for (const p of bucket) p.numbers = shuffle(p.numbers, rng);
  }

  const W = Math.min(
    Math.floor(easyShuffled.length / 2),
    Math.floor(mediumShuffled.length / 3),
    Math.floor(hardShuffled.length / 2)
  );
  const totalDays = W * 7;

  const epochWeekday = new Date(`${EPOCH}T00:00:00`).getDay(); // 0 = Sunday
  const PATTERN = ['HARD', 'EASY', 'EASY', 'MEDIUM', 'MEDIUM', 'MEDIUM', 'HARD']; // index by getDay()

  let ei = 0, mi = 0, hi = 0;
  const list = [];
  for (let i = 0; i < totalDays; i++) {
    const weekday = (epochWeekday + i) % 7;
    const difficulty = PATTERN[weekday];
    let puzzle;
    if (difficulty === 'EASY') puzzle = easyShuffled[ei++];
    else if (difficulty === 'MEDIUM') puzzle = mediumShuffled[mi++];
    else puzzle = hardShuffled[hi++];
    list.push(puzzle);
  }

  console.log(`Weeks: ${W}, total puzzles: ${totalDays} (multiple of 7: ${totalDays % 7 === 0})`);
  console.log(`Epoch ${EPOCH} is weekday index ${epochWeekday} (0=Sun), first puzzle difficulty: ${PATTERN[epochWeekday]}`);

  const outPath = path.join(__dirname, 'puzzles.json');
  const lines = list.map(
    (p) =>
      `  {"numbers":[${p.numbers.join(',')}],"difficulty":"${p.difficulty}","solutionCount":${p.solutionCount},"sampleSolution":${JSON.stringify(p.sampleSolution)}}`
  );
  fs.writeFileSync(outPath, `[\n${lines.join(',\n')}\n]\n`);
  console.log(`Wrote ${list.length} puzzles to ${outPath}`);
}

main();
