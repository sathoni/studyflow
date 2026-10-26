# StudyFlow app

Mathieu's study PWA: Leitner review cards and mini-quizzes for his six courses.
TypeScript + esbuild, no framework, no runtime dependencies. Source of truth:
`../docs/SPEC-v3.md` and `../docs/SCHEMA.md`.

## Commands (run from `app\`)

| Command | What it does |
|---|---|
| `npm run deps` | Installs the dev dependencies **through the junction** (never plain `npm install`, see below). |
| `npm test` | All `src/**/*.test.ts` with `node --test` (Node 24 strips the types). |
| `npm run typecheck` | `tsc` over `src/` (the service worker is left out). |
| `npm run build` | Builds into `dist/` for https://sathoni.github.io/studyflow/ (relative URLs). |
| `npm run serve` | Serves `dist/` on http://localhost:4173/ — open `/#demo`. |
| `npm run icons` | Regenerates `src/ui/icons.ts` from Phosphor. |
| `npm run icons:png` | Redraws the app icons and the demo placeholder with Pillow. |

## Layout

```
src/app.ts            start: access → store → sync → screens
src/context.ts        AppContext every screen receives; theme helpers
src/sw.ts, updates.ts service worker + self-update recipe (from the Andrea app)
src/lib/
  model.ts            row types, table registry (keys, cursors, insert columns)
  dates.ts            Brussels study day (04:00 rollover), calendar maths
  leitner.ts          the box fold, labels, button previews, review rows
  queue.ts            today's queue, estimates, ReviewSession (herhaling loop)
  quiz.ts             session / chapter / course quizzes, grading, lists
  instruments.ts      overhoor-instrumenten schedule (1 → 3 → 7 → 14 days)
  data.ts             loadSnapshot() + Actions: the one door the screens use
  store.ts            local tables + outbox (parked after 3 refusals)
  indexeddb.ts, db.ts IndexedDB driver, opening the store (memory for #demo)
  sync.ts             REST (apikey + x-sf-key), pull by cursors, prune, rhythm
  images.ts           signed URLs via `media`, blob cache, CSS crops
  access.ts           the personal link (?k=…), no login
src/demo/data.ts      fake data for #demo (never touches the network)
  stats.ts            the numbers on Home, Voortgang, Profiel (bars, streak, goals)
  text.ts             **bold** key terms as text segments (never HTML)
src/screens/
  shell.ts            tab bar, #-addresses (#/vak/SCM, #demo/quiz), redraws
                      that keep the scroll; pages vs full-screen modes
  derive.ts           what every screen works out from the snapshot
  home.ts             greeting + ring + week bars, new quiz, hero, Overdag
  courses.ts          Vakken, course page (4 tabs), chapter page
  session.ts          the review session (hints, swipes, undo, herhaling, end)
  quiz.ts, quizrun.ts the Quiz tab and a quiz run (A–D, typed, feedback, end)
  progress.ts         Voortgang
  profile.ts          Profiel (streak, goals, theme, back-up, version)
  preview.ts          read-only flip preview with "Opnieuw leren"
  common.ts           course row, banner, score sheet, card menu (Meld/Kopieer)
  nokey.ts            the "open via your link" screen
src/ui/               dom.ts, icons.ts, parts.ts (tiles, bars, ring, badges),
                      overlay.ts (sheet, toast), visual.ts (CSS crop), viewer.ts
                      (full-screen pinch-zoom)
public/app.css        the whole look, light and dark (tokens on :root)
```

## Access

No accounts. Mathieu opens `https://sathoni.github.io/studyflow/?k=<KEY>` and
adds it to his Home Screen. The manifest has **no `start_url`**, so the icon
keeps the key. The app stores the key in localStorage and never strips it from
the address. Every request sends `apikey: <publishable key>` and `x-sf-key`.
The key itself lives only in `C:\Users\User\.studyflow\tokens.json` and in his
link — never in this repo.

## Pitfalls

- **Never `npm install` in `app\`.** `node_modules` and `dist` are junctions to
  `C:\Users\User\AppData\Local\StudyFlow\`; npm replaces the junction with a
  real folder inside OneDrive. Use `npm run deps`.
- `build.mjs` writes into the junction's target (Node's `cp` refuses a junction
  as destination) and empties `dist` without deleting it.
- A wrong or revoked key gives **empty results, not errors** (row-level
  security). `sync.ts` therefore checks `courses` first and never prunes local
  data when that comes back empty.
- Supabase returns at most 1000 rows per request: every pull pages.
- Node runs the tests by stripping types: no enums, no parameter properties,
  explicit `.ts` imports.
- The Browser pane in Claude Code refuses service workers; test the update
  recipe in a real Chromium (Playwright) or on the phone.
- **Looking at the screens:** `npm run build`, serve `dist` (e.g. `python -m http.server`
  in the folder the junction points to) and open `/#demo`. A session or quiz address
  (`#demo/sessie`) opened cold lands on Home on purpose; start it from there. For
  screenshots use a Playwright *script* with the installed Chrome
  (`channel: 'chrome'`): the Playwright connector writes snapshot files into the folder
  Claude Code was started in, which may be one of Mathieu's course folders.
