# 2Dozen

A daily arithmetic puzzle. Everyone gets the same four numbers (1 to 13); combine
all four, using each exactly once with `+ − × ÷`, to make exactly 24.

Static site, no build step, no framework. Vanilla HTML/CSS/JS, deployed to
GitHub Pages. The daily leaderboard is the only server-side piece, backed by
a dedicated Firebase (Firestore) project.

## Project layout

```
index.html            the whole app shell
style.css              styling
app.js                   game engine, storage, Firestore calls (ES module)
firebase-config.js        Firebase web app config (public, see note below)
puzzles.json                precomputed daily puzzle list, generated
generate-puzzles.js           build-time generator, not shipped to the client
firestore.rules                 security rules for the `scores` collection
firestore.indexes.json           composite index definition
firebase.json                     deploy target for rules/indexes
```

## Running locally

No build step. Serve the directory with any static file server, e.g.:

```
python3 -m http.server 8642
```

then open `http://localhost:8642`. For testing dates other than today, append
`?asOf=YYYY-MM-DD` to the URL, this overrides "today" for puzzle selection and
streak logic only, client-side (it does not affect what a Firestore write
considers a plausible puzzle number, that's judged from the server's real
clock, see Security rules below).

## How the daily puzzle is chosen

- Launch day `2026-07-03` is puzzle #1 (`EPOCH` in `app.js` / `generate-puzzles.js`).
- Each player's `daysSinceEpoch` is computed from *their own local calendar date*,
  never UTC, so the puzzle rolls over at each player's own midnight.
- `puzzleContentIndex = daysSinceEpoch % puzzles.length` picks which entry of
  `puzzles.json` to render. Because `puzzles.json`'s length is always an exact
  multiple of 7 (see generator below), this stays aligned with the Mon/Tue
  EASY, Wed-Fri MEDIUM, Sat/Sun HARD weekly pattern forever, even after the
  list wraps around.
- `puzzleNumber = daysSinceEpoch + 1` is a separate, ever-increasing value
  used for the leaderboard, streaks, and share text ("2Dozen #37"). It is
  *not* wrapped, so leaderboards never collide across cycles of the puzzle list.

## Regenerating puzzles

```
node generate-puzzles.js
```

This brute-forces every multiset of 4 numbers from 1-13 (1,820 combinations),
using exact rational (fraction) arithmetic so there's no floating-point
rounding near 24. It prints a sanity check against two known cases from the
classic "24 game" (`3,3,8,8` has very few solutions, `2,3,4,6` has many) and
the resulting weekday/difficulty alignment, then overwrites `puzzles.json`.
The list is deterministic (fixed PRNG seed), so regenerating without changing
the generator produces an identical file.

Changing `EPOCH` or the difficulty thresholds requires regenerating and
re-deploying `puzzles.json`.

## Deploying to GitHub Pages

1. Push this repository to GitHub.
2. Repo Settings → Pages → Source: "Deploy from a branch", branch `main`, folder `/ (root)`.
3. For the custom domain `2d.snanu.com`: Settings → Pages → Custom domain, enter
   `2d.snanu.com` (this writes the `CNAME` file in the repo, already present here).
   At your DNS provider, add:
   ```
   2d   CNAME   <your-github-username>.github.io.
   ```
   Wait for DNS to propagate, then enable "Enforce HTTPS" in the same Pages settings page.

No build step runs on GitHub Pages, it serves the static files directly.

## Firebase setup (leaderboard)

The leaderboard lives in its **own** Firebase project, kept separate from any
other project, since it's the only place this app touches a server.

1. Create the project and enable Firestore (native mode, any region):
   ```
   firebase projects:create <project-id> --display-name "2Dozen"
   firebase firestore:databases:create "(default)" --location=nam5 --project <project-id>
   ```
   The Firestore CLI may ask you to first enable the Cloud Firestore API for
   the project in the Cloud Console (a one-click "Enable" link it prints);
   that's a one-time manual step for a brand new Google Cloud project.

2. Register a web app and print its config:
   ```
   firebase apps:create web "2Dozen Web" --project <project-id>
   firebase apps:sdkconfig WEB <app-id> --project <project-id>
   ```
   Paste the resulting values into `firebase-config.js`. This config is a
   public client identifier, not a secret, it's safe to commit; access
   control happens entirely in `firestore.rules`, never by hiding this file.

3. Deploy the security rules and composite index:
   ```
   firebase use --add <project-id> --alias default
   firebase deploy --only firestore:rules,firestore:indexes --project <project-id>
   ```
   `firestore.indexes.json` defines the one composite index the app's
   leaderboard query needs (`puzzle_number` ascending, `time_ms` ascending).
   If you ever change that query, Firestore will print a console link to
   create the matching index the first time it runs against an un-indexed
   query, click it as a fallback.

### Security rules, in plain terms

`firestore.rules` allows public reads of `scores`, and only `create` writes
(never `update` or `delete`), on documents that:

- have exactly the five expected fields with the right types,
- have a `handle` matching `^[A-Za-z0-9 '-]{1,16}$`,
- have `time_ms >= 3000` (nobody solves in under 3 seconds),
- have `created_at == request.time` (server-stamped, not client-supplied),
- have a `puzzle_number` within one day of what the server's clock expects
  (accounting for every timezone from UTC-12 to UTC+14),
- have a document ID of exactly `${puzzle_number}_${player_id}`.

That last rule is what enforces "one submission per player per puzzle": a
second `create` attempt at the same document ID is, from the rules engine's
point of view, an *update*, which is always denied.

### Honesty note

This is a client-side game. There is no server that verifies a player
actually spent `time_ms` solving the puzzle, only that the number is
*plausible*. A determined player can lie about their own time. These rules
stop casual tampering (malformed writes, resubmission, obviously-fake
instant times), not a motivated cheater. Treat the daily leaderboard as
social, not as competitive infrastructure. If a time looks absurd, it
probably is.

Past puzzles' scores are never deleted, they just stop being "today's"
leaderboard once the puzzle number moves on. That costs nothing to keep and
leaves room for a "hall of fame" later.

## Stats and streaks

Stored client-side only, under the localStorage key `game_state_v1`
(versioned so a future schema change can migrate old saves instead of
wiping them). If localStorage is unavailable (e.g. private browsing), the
game is still fully playable, it just shows a one-line notice and doesn't
persist streaks or stats for that session.
