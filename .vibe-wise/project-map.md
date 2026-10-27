# Project Map

## Purpose
Real-time collaborative whiteboard where multiple users draw, annotate, and design simultaneously.

## Source documents
`PRD.md` (features, milestones: Phase 1 single-user canvas, Phase 2 WebSocket sync with last-write-wins to expose the bug, Phase 3 CRDT shapes, Phase 4 OT text, Phase 5 persistence, Phase 6 Redis, Phase 7 polish) and `DESIGN (1).md` (learner's design: OT for text, LWW-register + OR-Set CRDT for shapes, HLC, per-user inverse-op undo, React + Canvas API, Postgres op log, Redis). The learner authored these; the single draggable rectangle in `client/src/main.ts` is a throwaway test object, not the shape model.

## Requirements
- Every change appears on every connected screen within ~100ms.
- No conflicts between concurrent edits, no data loss, no manual refresh.
- Learning goal: understand how multiplayer state sync works by building it rather than only using a library.

## Components
Chosen (learner): TypeScript browser client, Node.js server, TypeScript shared between both.
Implemented (AI's proposals, approved): npm workspaces `shared/`, `server/`, `client/`; `ws` WebSocket relay in `server/src/index.ts` (forwards each message to all other clients, no ordering or merging; not yet used by the client).
Phase 1 (local only, approved): `shared/src/shapes.ts` (Shape model per DESIGN 3.1, points relative to x,y), `client/src/board.ts` (shape store, hit testing), `client/src/renderer.ts` (CanvasRenderer, rAF loop, world/screen transform), `client/src/input.ts` (select/move, pen, rect, circle, line, arrow), toolbar in `client/index.html`.
Phase 1 gaps closed (learner asked "fix all this"): Catmull-Rom pen smoothing, resize and rotate handles (`client/src/geometry.ts`), text boxes (`client/src/text.ts`, local text editing via textarea overlay), eraser, per-user undo/redo with inverse ops (`client/src/history.ts`), pan/zoom (wheel zoom at cursor, hand tool or space-drag).
Phase 2 naive sync implemented: `shared/src/ops.ts` (add/update/remove ops, absolute values), `client/src/net.ts` (send local ops, apply remote ops in arrival order, no conflict handling, no catch-up for late joiners, no offline queue). This is the deliberate "bug on purpose" from the PRD.
UPDATE (learner asked to build everything): the Phase 2 ops/net code above was REPLACED. Current state: `shared/` holds hlc.ts, crdt.ts (LWW registers + OR-Set), ot.ts (transform, Jupiter TextClient/server), engine.ts (SyncEngine), roomcore.ts, protocol.ts; `server/` holds store.ts (SQLite default via node:sqlite, Postgres optional), bus.ts (LocalBus, RedisBus, ResilientBus), hub.ts (rooms, primary lock, presence, sync), auth.ts (bcrypt+JWT), http.ts, app.ts, index.ts; `client/` holds connection.ts (reconnect, retry), board.ts, history.ts (per-user conditional undo), input.ts, text.ts (OT-backed editing), renderer.ts, drawing.ts, curve.ts, exportSvg.ts, exportPng.ts, dialog.ts, account.ts, main.ts. Phases 3-7 are all implemented. 37 tests (35 run by default; 2 need TEST_DATABASE_URL/TEST_REDIS_URL, verified once against real containers). Load test p50 ~54ms, p99 ~110ms at 50 users. Browser-verified (hidden tabs, so no screenshots): landing, board join, drawing, text, two-tab sync, offline/reconnect merge, undo. Dockerfile and CI workflow are written but untested. Docs: README.md, STUDY.md (concepts for every phase).
LATER ADDITIONS (learner asked "what else is left, continue building"): server-side validation and limits (shared/src/validate.ts, 10k shapes, rate limit), render culling + cached sort + level of detail (10k shapes 4-10ms/frame), multi-select with marquee, group move/delete/restyle, copy/cut/paste/duplicate, layer order (fractional z between neighbours), keyboard shortcuts, partial stroke erase, pinch zoom (client/src/edit.ts holds the pure logic). 53 tests (51 default). Verified in a real browser except screenshots.
FINAL ROUND (learner said "build the rest fully"): group resize/rotate (geometry.ts groupResize/groupRotate), style panel follows selection with mixed state, OT-aware text undo (shared/src/textundo.ts, engine.undoText/redoText, wired to Ctrl+Z/Y in the editor), per-client z fraction so layers never tie, .dockerignore + Dockerfile built and run (417MB, health + sync verified), CI steps replayed locally with real Postgres+Redis: 70/70 tests. Real-browser verified (with calibrated synthetic input): group resize ratios exact, group rotate = pi/2, mixed panel, text undo with a second tab typing concurrently.
DESIGN PASS (learner asked for a prettier, funnier, Excalidraw-class UI): hand-drawn renderer (client/src/rough.ts, seeded by shape id, cached by object identity), new synced shape props (roughness, fillStyle, strokeStyle, edges, fontFamily, fontSize; validated server-side), look model (client/src/look.ts), icon set, floating style panel (panel.ts), bottom tool tray, top bar with people/reactions/share, menu, dark mode (CSS inversion), dot grid + snap, laser pointer and emoji reactions (protocol: cursor.laser, react/reaction; server whitelist REACTIONS), landing page with a live scribble pad, bundled fonts (Bricolage Grotesque, Caveat). Verified with a screenshot rig (puppeteer-core driving the installed Chrome, outside the project) and a 27-check end-to-end run with real mouse/keyboard in two browsers. 85 unit/integration tests (83 default). Found and fixed a real bug via real input: text editor closed instantly because focus was taken before the click's default focus change.
Known gaps (older): no screenshot-level check of rendering (tabs in background, so synthetic input only); text ops pending across a full-state resync are dropped; unsynced text history on server is bounded (clients too far behind get a full resync); the GitHub Actions workflow itself has never run on GitHub (its steps were replayed locally); legacy tied z values (none created by current clients) jump past the tie; group resize of rotated shapes is approximate; no touch UI beyond pinch.
Open design points noticed: DESIGN uses delta ops for move (dx, dy) but also LWW registers on absolute x/y; the code uses absolute values. Undo of an update restores absolute old values and can overwrite another user's later change; the policy is undecided.

## Main Flow
Unknown.

## Data and Trust Boundaries
Unknown.

## Build and Deployment
Verified: `npm install`, `npm run typecheck`. Run `npm run dev:server` (ws://localhost:8080) and `npm run dev:client` (Vite).

## Unknowns
Stack, client/server structure, transport, data model for shapes, conflict-resolution approach, persistence, deployment.
