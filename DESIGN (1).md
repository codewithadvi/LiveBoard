# LiveBoard — Technical Design Document

**Author:** Advithiya Duddu  
**Version:** 1.0  
**Status:** Draft

---

## 1. System Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                          CLIENT (Browser)                           │
│                                                                     │
│  ┌──────────────┐    ┌──────────────────┐    ┌──────────────────┐  │
│  │  Canvas UI   │◄──►│  Operation       │◄──►│  CRDT / OT       │  │
│  │  (React +    │    │  Manager         │    │  Engine          │  │
│  │  Canvas API) │    │  (local queue,   │    │  (transform,     │  │
│  └──────────────┘    │   ack tracking)  │    │   apply, invert) │  │
│                      └────────┬─────────┘    └──────────────────┘  │
│                               │ WebSocket                           │
└───────────────────────────────┼─────────────────────────────────────┘
                                │
┌───────────────────────────────┼─────────────────────────────────────┐
│                    NODE.JS WS SERVER (Instance A)                   │
│                                                                     │
│  ┌─────────────────┐    ┌──────────────────┐    ┌───────────────┐  │
│  │  WS Connection  │    │  Room Manager    │    │  Op Processor │  │
│  │  Pool           │───►│  (in-memory      │───►│  (validate,   │  │
│  │                 │    │   room state)    │    │   transform,  │  │
│  └─────────────────┘    └──────────────────┘    │   broadcast)  │  │
│                                                  └───────┬───────┘  │
└──────────────────────────────────────────────────────────┼──────────┘
                                                           │
              ┌────────────────────────────────────────────┤
              │                                            │
    ┌─────────▼──────────┐                    ┌───────────▼──────────┐
    │   Redis Pub/Sub     │                    │   PostgreSQL          │
    │                     │                    │                       │
    │  channel: room:{id} │                    │  operations (log)    │
    │  fan-out to all     │                    │  snapshots           │
    │  server instances   │                    │  rooms, users        │
    └─────────┬───────────┘                    └──────────────────────┘
              │
    ┌─────────▼──────────┐
    │  NODE.JS WS SERVER  │
    │  (Instance B)       │
    │  (same structure)   │
    └─────────────────────┘
```

**Data flow for a single operation (e.g., User A moves Shape X):**

1. User A drags shape → client generates `MoveOp{shapeId, dx, dy, clientSeq: 5, clientId: "A"}`
2. Client sends op over WebSocket; adds to local "in-flight" queue
3. Server receives op, assigns `serverSeq: 42`, runs OT transform against concurrent ops since client's last ack
4. Server persists to PostgreSQL, broadcasts transformed op to all room members
5. Server publishes to Redis so other server instances (with other room members) receive it
6. All clients receive `{op, serverSeq: 42}`, apply to local canvas
7. Server acks User A's client: `{clientSeq: 5, serverSeq: 42}` → client removes from in-flight queue

---

## 2. The Core Algorithm: OT for Text + CRDT for Shapes

This is the heart of the project. Two different algorithms for two different data types.

### 2.1 Why Two Algorithms?

| Data type | Algorithm | Why |
|---|---|---|
| Text content in text boxes | **Operational Transformation (OT)** | Characters have an index-based position; inserting a char shifts all subsequent indices |
| Shapes (position, size, color) | **LWW-CRDT (Last Write Wins Register)** | Shape properties are independent scalars; concurrent moves of the same shape use logical clock to pick a winner |
| Shape set (which shapes exist) | **OR-Set CRDT (Observed-Remove Set)** | Handles concurrent "add shape" + "delete shape" gracefully |

---

### 2.2 OT for Text Boxes

**The problem:** User A types "H" at index 0 of an empty text box → `Insert(0, "H")`.
Simultaneously, User B types "W" at index 0 → `Insert(0, "W")`.
Server receives A's op first (seq 1), then B's op (seq 2).

Without transformation, B's op `Insert(0, "W")` applied after A's inserts "W" at position 0 of "H" → "WH". But B intended to insert at the beginning of the empty box → result should be "HW" or "WH" depending on tie-break, but never garbled.

**The transform function:**

```
transform(op1, op2) → op1'
```

Transforms `op1` as if `op2` had already been applied, so applying `op1'` after `op2` gives the same result as applying `op2'` after `op1` (the **TP1 property** — this is the formal correctness requirement).

```
Rules for Insert vs Insert:
  transform(Insert(i, c), Insert(j, _)):
    if j < i:  return Insert(i + 1, c)   // op2 shifted everything right of j
    if j >= i: return Insert(i, c)        // no shift needed
    if j == i: use clientId tie-break (alphabetical) to be deterministic

Rules for Insert vs Delete:
  transform(Insert(i, c), Delete(j)):
    if j < i:  return Insert(i - 1, c)   // deletion shifted indices left
    if j >= i: return Insert(i, c)

Rules for Delete vs Insert:
  transform(Delete(i), Insert(j, _)):
    if j <= i: return Delete(i + 1)
    if j > i:  return Delete(i)

Rules for Delete vs Delete:
  transform(Delete(i), Delete(j)):
    if j < i:  return Delete(i - 1)
    if j == i: return NoOp               // already deleted
    if j > i:  return Delete(i)
```

**Server-side OT (Jupiter algorithm variant):**

The server maintains an **operation history buffer** per room. When op from client arrives with `clientSeq: n`:
1. Find all server ops with `serverSeq > n` (concurrent ops the client hasn't seen)
2. Transform the incoming op against each concurrent op in order
3. Apply the transformed op and assign it the next `serverSeq`
4. Broadcast transformed op to all clients

Clients maintain a **local pending queue** of ops sent but not yet acked. When receiving a remote op:
1. Transform the remote op against every op in the pending queue
2. Apply the transformed remote op to the canvas

This is the **Jupiter/dOPT algorithm** — the same family used by Google Wave.

---

### 2.3 CRDT for Shapes

#### OR-Set for shape existence

The set of shapes on the canvas is an **Observed-Remove Set (OR-Set)**:

- Each shape has a unique ID (UUID)
- To add a shape: `{type: "add", shapeId: uuid, timestamp: hlc, clientId}`
- To remove a shape: `{type: "remove", shapeId: uuid, addTimestamp: hlc}` — the remove carries the timestamp of the specific add it's observing

**Why OR-Set?** If User A removes a shape and User B adds the same shape ID concurrently:
- OR-Set: the add wins (because remove only removes observed adds; the concurrent add was not yet observed)
- This is the correct behavior — you don't want a remove to silently eat a concurrent add

#### LWW-Register for shape properties

Each property of a shape (x, y, width, height, color, strokeWidth) is a **Last-Write-Wins Register**:

```
LWWRegister {
  value: any,
  timestamp: HybridLogicalClock,  // HLC, not wall clock
  clientId: string                // tie-break
}

merge(r1, r2):
  if r1.timestamp > r2.timestamp: return r1
  if r2.timestamp > r1.timestamp: return r2
  if equal: return clientId with higher alphabetical order  // deterministic tie-break
```

**Hybrid Logical Clock (HLC):**

Wall clocks drift. Pure Lamport clocks don't capture real time. HLC solves both:

```
HLC = (physicalTime_ms, logicalCounter)

On send:
  l = max(l, now_ms)
  c += 1
  send (l, c)

On receive (l', c') from remote:
  l_old = l
  l = max(l, l', now_ms)
  if l == l_old == l': c = max(c, c') + 1
  elif l == l_old:     c += 1
  elif l == l':        c = c' + 1
  else:                c = 0
```

HLC guarantees: if event A caused event B, then HLC(A) < HLC(B). Concurrent events get comparable HLCs that break ties deterministically.

---

## 3. Data Models

### 3.1 Operation Schema (the canonical log)

```typescript
type OperationType =
  | "shape:add"
  | "shape:remove"
  | "shape:move"
  | "shape:resize"
  | "shape:recolor"
  | "text:insert"
  | "text:delete"
  | "cursor:move"   // ephemeral, not persisted
  | "session:join"
  | "session:leave"

interface Operation {
  id: string            // UUID
  roomId: string
  clientId: string
  clientSeq: number     // client's local sequence number
  serverSeq?: number    // assigned by server after acceptance
  timestamp: HLC        // hybrid logical clock value
  type: OperationType
  payload: OperationPayload
}

interface ShapeAddPayload {
  shapeId: string
  shapeType: "rect" | "circle" | "arrow" | "line" | "path" | "text"
  x: number; y: number
  width?: number; height?: number
  points?: [number, number][]   // for freehand paths
  fill: string; stroke: string; strokeWidth: number; opacity: number
  text?: string                 // for text boxes
  rotation: number
  zIndex: number
}

interface ShapeMovePayload {
  shapeId: string
  dx: number; dy: number       // delta, not absolute — important for OT
}

interface ShapeResizePayload {
  shapeId: string
  anchor: "nw"|"ne"|"sw"|"se"  // which corner is fixed
  dx: number; dy: number
}

interface TextInsertPayload {
  shapeId: string   // which text box
  index: number
  character: string
}

interface TextDeletePayload {
  shapeId: string
  index: number
}
```

### 3.2 PostgreSQL Schema

```sql
-- Rooms
CREATE TABLE rooms (
  id          TEXT PRIMARY KEY,          -- short slug, e.g. "abc123"
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  password_hash TEXT,
  snapshot_op_seq INT DEFAULT 0          -- last snapshot was taken at this serverSeq
);

-- Operations log (append-only, never update or delete)
CREATE TABLE operations (
  server_seq   BIGSERIAL PRIMARY KEY,
  room_id      TEXT NOT NULL REFERENCES rooms(id),
  client_id    TEXT NOT NULL,
  client_seq   INT NOT NULL,
  hlc_time     BIGINT NOT NULL,          -- HLC physical component (ms)
  hlc_counter  INT NOT NULL,             -- HLC logical counter
  op_type      TEXT NOT NULL,
  payload      JSONB NOT NULL,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX ops_room_seq ON operations(room_id, server_seq);
CREATE INDEX ops_room_client ON operations(room_id, client_id, client_seq);

-- Snapshots (periodically materialized canvas state)
CREATE TABLE snapshots (
  id          BIGSERIAL PRIMARY KEY,
  room_id     TEXT NOT NULL REFERENCES rooms(id),
  at_seq      BIGINT NOT NULL,           -- server_seq at time of snapshot
  state       JSONB NOT NULL,            -- full canvas state as JSON
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX snapshots_room ON snapshots(room_id, at_seq DESC);

-- Users (optional, for auth)
CREATE TABLE users (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email        TEXT UNIQUE NOT NULL,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

-- Sessions (tracks room membership, not auth sessions)
CREATE TABLE room_sessions (
  room_id     TEXT NOT NULL,
  client_id   TEXT NOT NULL,
  display_name TEXT NOT NULL,
  color       TEXT NOT NULL,            -- assigned cursor color
  joined_at   TIMESTAMPTZ DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (room_id, client_id)
);
```

### 3.3 In-Memory State (Server, per room)

```typescript
interface RoomState {
  roomId: string
  shapes: Map<string, Shape>           // shapeId → current shape state
  opHistory: Operation[]               // recent ops for OT (bounded buffer)
  lastServerSeq: number
  connectedClients: Map<string, ClientState>
}

interface ClientState {
  clientId: string
  displayName: string
  color: string
  lastAckedServerSeq: number           // for OT: which server ops has client seen
  pendingOps: Operation[]              // unacked client ops on server side
  ws: WebSocket
}
```

---

## 4. OOP Class Design

The OOP structure is intentional and interview-explainable. Describe it as "Strategy + Observer + Command patterns."

```
OperationProcessor (Strategy Pattern)
├── interface: process(op: Operation, room: RoomState): Operation
├── ShapeAddProcessor implements OperationProcessor
├── ShapeMoveProcessor implements OperationProcessor
├── ShapeResizeProcessor implements OperationProcessor
├── TextInsertProcessor implements OperationProcessor
├── TextDeleteProcessor implements OperationProcessor
└── ProcessorRegistry: Map<OperationType, OperationProcessor>

CanvasEntity (base class)
├── Shape (abstract)
│   ├── RectShape
│   ├── CircleShape
│   ├── ArrowShape
│   ├── PathShape (freehand)
│   └── TextShape
└── All shapes implement: serialize(), deserialize(), getBoundingBox(), applyOp(op)

CRDTState
├── OrSet<ShapeId>             (shape existence)
├── Map<ShapeId, LWWShape>     (shape properties)
└── methods: apply(op), merge(remote), toSnapshot(), fromSnapshot()

OTEngine
├── transform(op1, op2): Operation   (the core function)
├── transformAgainstHistory(op, history[]): Operation
└── invert(op): Operation            (for undo)

EventBus (Observer Pattern — client side)
├── emit(event, payload)
├── on(event, handler)
└── events: "op:local", "op:remote", "shape:selected", "cursor:moved"

SyncManager (client)
├── pendingQueue: Operation[]
├── send(op): void               (adds to queue, sends over WS)
├── onAck(clientSeq): void       (removes from queue)
├── onRemoteOp(op): void         (transforms against pending, applies)
└── reconnect(): void            (replays pending queue)
```

---

## 5. WebSocket Protocol

All messages are JSON. Message types:

```typescript
// Client → Server
{ type: "op", op: Operation }
{ type: "join", roomId: string, displayName: string, lastSeq: number }
{ type: "cursor", x: number, y: number }   // throttled to 30/sec

// Server → Client
{ type: "op", op: Operation }              // broadcast (includes ops from all clients)
{ type: "ack", clientSeq: number, serverSeq: number }
{ type: "sync", ops: Operation[], snapshotState?: CanvasSnapshot }  // on join/reconnect
{ type: "presence", clientId: string, displayName: string, color: string, online: boolean }
{ type: "cursor", clientId: string, x: number, y: number }
{ type: "error", code: string, message: string }
```

**Reconnection protocol:**

1. Client reconnects, sends `{ type: "join", lastSeq: 47 }` (last server seq it saw)
2. Server checks: is a snapshot available at seq ≤ 47?
   - If ops since seq 47 are few: send `{ type: "sync", ops: [48, 49, 50, ...] }`
   - If many ops: send latest snapshot + delta `{ type: "sync", snapshotState: {...}, ops: [snapshotSeq+1, ...] }`
3. Client applies snapshot (or no-op if state is fresh), then replays delta ops
4. Client replays its own pending queue against current server state

---

## 6. Frontend Architecture (React + Canvas API)

```
App
└── BoardPage
    ├── Toolbar (tool selector: pen, shapes, text, select, eraser)
    ├── Canvas (the main drawing surface)
    │   ├── uses useRef(canvasEl) — direct DOM, no React re-render on every draw
    │   ├── CanvasRenderer (imperative class, not React component)
    │   │   ├── renderShape(shape: Shape)
    │   │   ├── renderCursors(cursors: Map<clientId, Cursor>)
    │   │   ├── renderSelectionBox(shape: Shape)
    │   │   └── render() — called via requestAnimationFrame loop
    │   └── InputHandler (mouse/touch event → Operation)
    │       ├── onPointerDown → start draw/select
    │       ├── onPointerMove → update current op
    │       └── onPointerUp → finalize op, send to SyncManager
    ├── UserList (presence sidebar)
    └── ExportButton
```

**Why direct Canvas API (not SVG or a library like Konva)?**

SVG: too slow for 60fps with 1000+ shapes (DOM node per shape).  
Canvas API: single bitmap surface, batch render, `requestAnimationFrame`.  
This also lets you show the interviewer you understand browser rendering pipelines.

**Rendering loop:**

```javascript
function renderLoop() {
  ctx.clearRect(0, 0, width, height)
  applyViewTransform(ctx, pan, zoom)       // pan/zoom via matrix transform

  shapes.forEach(shape => shape.render(ctx))
  cursors.forEach(cursor => renderCursor(ctx, cursor))

  if (selectedShape) renderSelectionHandles(ctx, selectedShape)

  requestAnimationFrame(renderLoop)
}
```

**Coordinate system:**
- **World coordinates**: infinite canvas, shapes live here
- **Screen coordinates**: what the user sees, after pan/zoom transform
- All operations store world coordinates; all mouse events convert screen → world before creating ops

```javascript
function screenToWorld(sx, sy, pan, zoom) {
  return { x: (sx - pan.x) / zoom, y: (sy - pan.y) / zoom }
}
```

---

## 7. Undo / Redo

**Local undo only** — undoing your own operations without affecting others. This is the correct behavior for collaborative tools (Figma and Notion both do this).

**Per-user undo stack**: every client maintains a stack of operations it has sent. On Ctrl+Z:
1. Pop the latest operation from the local undo stack
2. Compute its **inverse operation**:
   - `Move(dx, dy)` → `Move(-dx, -dy)`
   - `Insert(i, c)` → `Delete(i)`
   - `Add(shape)` → `Remove(shape)`
3. Send the inverse as a new operation (it still goes through OT)

This is cleaner than "undo + redo as a stack" — the inverse op becomes a first-class operation, goes through the same OT pipeline, and is committed to the log. You cannot "lose" an undo.

**Redo**: keep a redo stack of operations that were undone. Redoing re-sends the original op.

---

## 8. Multi-Server Coordination via Redis

When 50 users are in a room, they might be connected to different server instances. Redis pub/sub propagates ops:

```
Client A (on Server 1) sends op
→ Server 1 assigns serverSeq, persists to PostgreSQL
→ Server 1 broadcasts to its own connected clients
→ Server 1 publishes to Redis channel `room:abc123`
→ Server 2 (subscribed to `room:abc123`) receives it
→ Server 2 broadcasts to its connected clients
```

**Room "ownership":** To prevent two servers from assigning the same serverSeq:
- Only one server is the "primary" for a room at a time (stored in Redis as `room:{id}:primary = server_id` with a TTL + heartbeat)
- If primary server dies, another claims ownership after TTL expires
- Non-primary servers forward ops to the primary via Redis message, receive back the sequenced op

This is a simplified version of how distributed systems like Kafka elect a partition leader.

---

## 9. Snapshot System

Every 100 operations, the server materializes the current canvas state as a snapshot:

```sql
INSERT INTO snapshots (room_id, at_seq, state)
VALUES ($1, $2, $3::jsonb);
```

The snapshot state is the full CRDT state — all shapes and their current LWW values — serialized to JSON.

On reconnect or fresh load:
1. Find the latest snapshot: `SELECT * FROM snapshots WHERE room_id = $1 ORDER BY at_seq DESC LIMIT 1`
2. Load ops since that snapshot: `SELECT * FROM operations WHERE room_id = $1 AND server_seq > $2`
3. Replay the delta onto the snapshot state

This bounds reconnect time to O(100) ops at most (since snapshots are every 100 ops).

---

## 10. Testing Strategy

### Unit Tests (Jest / pytest)
- OT `transform()` function — exhaustive table of all operation pair combinations
- CRDT merge — verify commutativity and idempotency: `merge(A, B) == merge(B, A)`, `merge(A, A) == A`
- HLC ordering — verify causality property holds under simulated clock drift

### Integration Tests
- Two clients send concurrent ops to test server → verify both end up with identical final state
- Client disconnects, ops continue, client reconnects → verify full convergence
- Server crashes and restarts → verify state restored from PostgreSQL + no ops lost

### Convergence Fuzzer (the impressive test)
```python
def fuzz_convergence(n_clients=5, n_ops=200):
    ops = [random_op() for _ in range(n_ops)]
    # Deliver ops in different orders to each simulated client
    # Verify all clients converge to the same final state
    for permutation in random_permutations(ops, n=1000):
        state = apply_ops(permutation)
        assert state == reference_state
```
This is the kind of test that shows you understand what "correct" actually means for distributed systems.

---

## 11. Tech Stack Summary

| Layer | Technology | Why |
|---|---|---|
| Frontend | React + Canvas API | No DOM overhead; 60fps rendering |
| State sync | Custom OT + CRDT | The whole point — no Yjs or ShareDB |
| WebSocket server | Node.js + `ws` library | Low-level enough to show understanding |
| Message broker | Redis Pub/Sub | Multi-instance fan-out |
| Database | PostgreSQL (JSONB + BIGSERIAL) | Append-only op log + JSONB snapshots |
| Auth (optional) | JWT + bcrypt | Stateless, standard |
| Containerization | Docker + Docker Compose | Single-command local setup |
| CI/CD | GitHub Actions | lint → test → build → Docker push |
| Deploy target | GCP Cloud Run | Serverless, auto-scale, free tier |

---

## 12. What to Say in Interviews

When asked about this project, the answer is the algorithm, not the features. Lead with:

> "The core problem is: two users edit the same object simultaneously. Their operations arrive at the server in an arbitrary order. How do you guarantee every client converges to the same final state without either user's intent being corrupted?"

Then explain:
1. **OT for text**: Transform incoming ops against the ops the client hasn't seen yet. Walk through the Insert/Insert transform rule.
2. **CRDT for shapes**: LWW-Register with Hybrid Logical Clocks for position. OR-Set for the shape collection.
3. **Why HLC not wall clock**: Wall clocks drift; two events at "the same millisecond" need a deterministic total order.
4. **The Jupiter algorithm**: How server-side transforms and client-side pending queue work together to guarantee TP1.

This is a 20-minute deep technical conversation that most interviewers cannot exhaust — which is exactly what you want.
