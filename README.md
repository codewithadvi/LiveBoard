# LiveBoard

A real-time collaborative whiteboard. Many people draw, annotate and type on the
same board at once; every change appears on every screen, with no conflicts, no
lost edits and no refreshing. The merge logic is written from scratch (no Yjs, no
ShareDB): a CRDT for shapes and Operational Transformation for text.

## Run it (no Docker needed)

Requires Node.js 22.13 or newer.

```
npm install
npm run dev
```

Open <http://localhost:5173>, create a board, and open the same link in a second
window. That is the whole setup: data is saved in a SQLite file under `data/`.

To run it as a single process (the server also serves the web app):

```
npm run build
npm start          # http://localhost:8080
```

## What it does

| Area | Features |
|---|---|
| Look | Hand-drawn style: wobbly double-stroke lines, hatched and cross-hatched fills, dashed and dotted lines, rounded or sharp corners, three fonts (handwritten, clean, code). Each shape has its own look; "Sketchiness" runs from clean to wild |
| Interface | Floating tool tray, a style panel that shows only what applies to the selection, light and dark themes, dot grid with optional snapping, your cursor colour becomes the interface accent |
| Fun | Laser pointer with a fading trail, emoji reactions that float up from the sender's cursor |
| Drawing | Pen (smoothed with Catmull-Rom splines), rectangle, circle, line, arrow, text boxes, eraser |
| Editing | Select (click, Shift-click, or drag a box), move, resize and rotate (one shape or a whole group), delete, copy / cut / paste / duplicate, layer order, pan, zoom (10% to 500%), pinch on touch screens |
| Text | Several people can type in one box at once; Ctrl+Z / Ctrl+Y inside a box undo only your own typing, even after others edit around it |
| Eraser | Removes whole shapes; cuts freehand strokes where it touches them |
| Style | Fill colour (or none), stroke / text colour, stroke width, opacity. The panel shows what it will change ("3 selected" or "new shapes") and marks properties where the selected shapes differ as "mixed" |
| Collaboration | Live cursors with names, people list, board links (`/board/abc123`), optional board passwords |
| Sync | Shapes merge as a CRDT; text merges with OT, so two people typing in one box keep every character |
| Undo / redo | Per user: undoing never touches anyone else's work |
| Offline | Edits made while disconnected are kept and sent on reconnect |
| Saving | Every operation is stored in a log, with a snapshot every 100 operations |
| Export | PNG and SVG |
| Accounts | Optional sign-in (JWT); signed-in users can list the boards they created |
| Scale | Optional Redis lets several servers share a room; one primary per room, automatic failover |

## Keyboard shortcuts

| Keys | Action |
|---|---|
| V, H, P, R, O, L, A, T, E, K | Select, Hand, Pen, Rectangle, Circle (O), Line, Arrow, Text, Eraser, Laser pointer |
| G / Shift+G | Show the grid / snap to the grid |
| ? | Show all shortcuts |
| Ctrl+Z / Ctrl+Y (or Ctrl+Shift+Z) | Undo / redo (yours only) |
| Ctrl+A | Select everything |
| Ctrl+C / Ctrl+X / Ctrl+V | Copy / cut / paste (works between boards and tabs) |
| Ctrl+D | Duplicate the selection |
| Delete or Backspace | Delete the selection |
| Arrow keys (Shift for 10x) | Nudge the selection |
| Ctrl+] / Ctrl+[ | Bring to front / send to back |
| ] / [ | Move forward / backward one step |
| Space + drag, middle mouse, or Hand tool | Pan |
| Mouse wheel, or pinch | Zoom around the pointer |
| Esc | Clear the selection or close a text box |

## Limits and safety

A board holds up to 10,000 shapes; a freehand stroke up to 5,000 points; a text box
up to 20,000 characters. The server checks every value it receives (numbers must be
finite and in range, colours must look like colours, unknown properties are refused)
and rate-limits each connection, so one broken or hostile client cannot corrupt a
board or flood a room. It also refuses operations that claim to come from someone else.

## Configuration

Everything is optional. With no settings you get SQLite and a single server.

| Variable | Effect |
|---|---|
| `PORT` | Server port (default 8080) |
| `DATABASE_URL` | Use PostgreSQL instead of SQLite, e.g. `postgres://user:pw@localhost:5432/liveboard` |
| `REDIS_URL` | Coordinate several servers through Redis, e.g. `redis://localhost:6379` |
| `SQLITE_FILE`, `DATA_DIR` | Where the SQLite file and the generated JWT secret live |
| `JWT_SECRET` | Fixed token-signing secret (otherwise one is generated and kept in `DATA_DIR`) |
| `SERVER_ID` | Name shown in logs and used for the room lock |

For Postgres and Redis during development: `docker compose up -d` (see
`docker-compose.yml`), then for example

```
DATABASE_URL=postgres://postgres:liveboard@localhost:5433/liveboard REDIS_URL=redis://localhost:6380 npm run dev
```

If Redis is configured but unreachable, a server keeps working on its own
("degraded single-node mode") and rejoins the cluster when Redis returns.

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Server (auto-restart) plus web app with hot reload |
| `npm run build` / `npm start` | Production build, then serve everything from one port |
| `npm test` | All tests: CRDT/OT proofs, fuzzing, server integration, undo, export |
| `npm run typecheck` | Type-check all three packages |
| `npm run loadtest` | 50 simulated users editing at once; reports latency percentiles |

Tests against real Postgres and Redis run when you set `TEST_DATABASE_URL` and
`TEST_REDIS_URL`; otherwise they are skipped. CI sets both (see
`.github/workflows/ci.yml`); all 70 tests pass with them.

## Docker (optional)

```
docker build -t liveboard .
docker run -p 8080:8080 -v liveboard-data:/app/data liveboard
```

Then open <http://localhost:8080>. The image was built and run as part of testing:
it serves the app and the health check, and two clients synced through it.

Add `?debug` to a board URL to expose `window.__lb` (the sync engine and
connection) in the browser console.

## How it is organised

```
shared/   the merge logic: HLC, CRDT, OT, sync engine, room rules (no DOM, no network)
server/   WebSocket + HTTP server, storage (SQLite/Postgres), Redis bus, accounts
client/   the browser app: canvas renderer, tools, text editing, history, UI
scripts/  dev launcher and load test
STUDY.md  every concept in the project, explained simply (read this first)
```

Measured on one machine:

- Network (`npm run loadtest`, server in its own process): 50 users, about 240 updates/s,
  p50 about 54 ms, p99 about 110 ms.
- Rendering (real browser): 1,000 shapes in about 2 ms per frame; a full 10,000-shape board in
  4 to 10 ms per frame at any zoom (the budget for 60 FPS is 16.7 ms).
- Restoring a 500-operation board: about 12 ms for a new tab, 4 ms for a returning one.
