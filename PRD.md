# LiveBoard — Product Requirements Document

**Author:** Advithiya Duddu  
**Version:** 1.0  
**Status:** Draft  
**Last Updated:** 2026-10-25

---

## 1. Product Vision

LiveBoard is a real-time collaborative whiteboard where multiple users simultaneously draw, annotate, and design — and every change appears on every screen within 100ms with zero conflicts, zero data loss, and zero need to "refresh to sync."

The core technical thesis: **concurrent distributed state is a solved problem in academia but rarely implemented from scratch by engineers**. LiveBoard exists to prove you understand how Google Docs, Figma, and Notion's multiplayer actually work — not just that you used them.

---

## 2. Problem Statement

Existing collaborative tools (Figma, Miro, FigJam) hide the hardest distributed systems problem behind product polish: **what happens when two users edit the same object at the exact same time?**

Naive solutions fail:
- **Last write wins** → one user's work silently disappears
- **Lock-based** → one user is blocked while the other edits
- **Snapshot sync** → stale state, jarring jumps, data races

The correct solution requires **Operational Transformation (OT)** for text and **Conflict-free Replicated Data Types (CRDTs)** for spatial objects — both of which LiveBoard implements explicitly and visibly.

---

## 3. Target Users

| User | Need |
|---|---|
| Technical interviewers / evaluators | See explicit, named, correct implementation of distributed CS fundamentals |
| Demo observers | Visually understand what conflict resolution looks like in real time |
| Collaborators in a session | Draw, annotate, and see others' cursors with no friction |

---

## 4. Core Features

### 4.1 Canvas & Drawing Tools
- **Freehand pen** — smooth polyline paths (Catmull-Rom spline interpolation for smoothness)
- **Shapes** — Rectangle, Circle, Arrow, Line; each with position, dimensions, fill, stroke, opacity
- **Text boxes** — multi-character text with full OT-based conflict resolution (the hard case)
- **Select & Transform** — click to select, drag to move, corner handles to resize, rotate handle
- **Eraser** — deletes shapes or path segments on contact
- **Undo / Redo** — per-user local undo stack; does not undo other users' operations (intentional, correct behavior)
- **Pan & Zoom** — infinite canvas; zoom 10%–500% with pinch/scroll

### 4.2 Collaboration
- **Presence** — every connected user's cursor visible to all others in real time (labeled with name + color)
- **Session rooms** — each whiteboard is a "room"; join by URL (e.g., `/board/abc123`)
- **User list** — live sidebar showing who is in the session, with colored dot per user
- **Conflict-free sync** — no two users can produce an irreconcilable state; the algorithm guarantees convergence
- **Reconnection** — if a user disconnects and reconnects, they receive the full operational history and converge to current state
- **Offline queue** — operations performed while offline are queued and replayed on reconnect

### 4.3 Persistence
- Every board state is persisted to PostgreSQL as a log of operations (not snapshots)
- Boards can be opened from a fresh tab and reconstructed by replaying the operation log
- **Snapshots** are taken every 100 operations to bound replay time (checkpoint + delta)

### 4.4 Export
- Export board as PNG (html canvas `toDataURL`)
- Export board as SVG (reconstruct shapes as SVG elements)

### 4.5 Sessions & Auth
- **No account required** for MVP — join a room by URL, provide a display name
- Optional: persist boards to a user account (email + password, JWT)
- Room creator can set a room password or make it public

---

## 5. Non-Functional Requirements

### 5.1 Performance
| Metric | Target |
|---|---|
| Operation propagation latency (p50) | < 80ms end-to-end |
| Operation propagation latency (p99) | < 200ms |
| Canvas render at 60 FPS | With up to 1,000 shapes on screen |
| Concurrent users per room | Up to 50 |
| Max shapes per board | 10,000 |

### 5.2 Correctness (the hard requirement)
- **Convergence**: any two clients that receive the same set of operations (in any order) must reach identical final state
- **Intent preservation**: a "move shape" operation should move the shape, even if another user has concurrently resized it
- **No data loss**: no operation is silently dropped; all are persisted before acknowledgment

### 5.3 Reliability
- The server can crash and restart; clients reconnect and continue with no data loss
- Redis failure falls back to in-process pub/sub (single-node degraded mode)
- Operation log in PostgreSQL is the source of truth; in-memory state is a cache

### 5.4 Scalability
- Horizontally scalable: multiple Node.js server instances coordinate via Redis pub/sub
- A room's operations are partitioned to a primary server; Redis fans out to other instances with connected clients in the same room

---

## 6. Out of Scope (MVP)

- Video / voice calling
- Comments / reactions on shapes
- Version history UI (the data exists, but no UI to browse it)
- Mobile-native app (responsive web only)
- Real-time cursor for > 50 users (degrades gracefully to batched updates)
- Conflict resolution for **nested groups** of shapes (groups are out of scope)

---

## 7. User Stories

```
As a user, I want to:
- Open a board URL and start drawing immediately, with no account required
- See other users' cursors moving in real time so I know where they're working
- Draw a shape and see it appear on my collaborators' screens within 100ms
- Move a shape simultaneously with another user and have the final position be sensible (not a data race)
- Type in a text box while another user edits the same text box and not lose either person's characters
- Undo my own last action without undoing my collaborator's work
- Disconnect, close my laptop, reopen the board, and see everything I and others drew
- Export the board as a PNG to share in a document
```

---

## 8. Success Metrics

| Metric | Goal |
|---|---|
| Convergence correctness | 100% — verified by automated test suite that simulates concurrent ops |
| Sync latency p50 | < 80ms on LAN, < 150ms cross-region |
| Zero silent data loss | Verified by operation log replay tests |
| Reconnection correctness | Full state restored in < 500ms for boards up to 500 ops |
| Demo impressiveness | A live demo where two browser tabs draw simultaneously, visibly conflict, and visibly resolve — this is the KPI |

---

## 9. Milestones

| Phase | Deliverable | Target |
|---|---|---|
| Phase 1 | Single-user canvas — draw, move, resize, undo | Week 1 |
| Phase 2 | WebSocket sync — two users, no OT yet (last-write-wins to expose the bug) | Week 2 |
| Phase 3 | CRDT for shapes — spatial operations converge correctly | Week 3 |
| Phase 4 | OT for text boxes — character-level conflict resolution | Week 4 |
| Phase 5 | Persistence, reconnection, snapshots | Week 5 |
| Phase 6 | Multi-server coordination via Redis | Week 6 |
| Phase 7 | Polish: cursors, export, auth, load testing | Week 7 |
