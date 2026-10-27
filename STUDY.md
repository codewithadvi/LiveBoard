# LiveBoard Study Guide

Every concept in the project, in plain language, in the order it was built.
Each section ends with a line you could say out loud in an interview.
This file grows with every phase.

**How to read it:** start at Phase 0 and go down. Each phase builds on the one
before it.

---

## Phase 0: The shape of the system

**Client / server.** The *client* is the web page running in each person's
browser. The *server* is one program that every browser connects to. In
LiveBoard the server is a post office with a filing cabinet: it receives
messages, puts them in one agreed order, saves them, and forwards them.

**WebSocket.** Normal web requests are letters: you ask, you get one answer, the
conversation is over. A WebSocket is a phone call that stays open, so the
server can speak to you *whenever something changes*. That is why nobody
refreshes the page.

**Monorepo / npm workspaces.** One folder, three packages: `client`, `server`,
`shared`. The `shared` package holds the code that must behave *identically* on
both sides (the merge rules). If the browser and the server ran two slightly
different copies of the merge rules, screens would disagree. One copy = no
disagreement.

> *"The merge logic lives in a shared package with no DOM and no network, so the
> same code runs in the browser, on the server, and in my test suite."*

---

## Phase 1: Drawing on a canvas

**Canvas vs SVG.** SVG makes every shape a page element, so 1,000 shapes means
1,000 things the browser tracks. A canvas is one flat picture you repaint
yourself, which is faster for many shapes. The cost: you must work out *which
shape the mouse is on* yourself.

**Render loop (`requestAnimationFrame`).** Like a flip-book: about 60 times a
second, erase everything and redraw every shape. The browser calls you right
before it paints, so you stay in step with the screen.

**World vs screen coordinates.** The board is infinite, so a shape's position is
in *world* space and never changes when you scroll. What you see is a *screen*
window onto the world. A mouse click arrives in screen space, so you convert:
`world = (screen - pan) / zoom`. Think of a city map: the city's coordinates
don't change when you zoom the map.

**Zooming at the cursor.** If you scale around the corner, the thing under your
mouse slides away. So after zooming, adjust the pan so the *world point under
the cursor stays under the cursor*. The same trick Google Maps uses.

**Bounding box and hit testing.** A bounding box is the smallest rectangle around
a shape. Hit testing answers "what is under the mouse?" by checking shapes from
the top layer down. Rectangles use the box; lines and pen strokes use the
*distance to the actual path*, so empty space inside a diagonal line's box
doesn't count as a hit. Rotated shapes first rotate the mouse point into the
shape's own un-rotated frame, then test.

**Relative points.** A line stores its points *relative to its own x, y*. Moving
it changes only `x` and `y`, never the points. This matters later: "move" is
then two tiny independent numbers, which merge cleanly.

**Catmull-Rom spline.** Your mouse reports a point every few pixels; straight
lines between them look jagged. A *spline* is a smooth curve through a set of
points, like a flexible wire pinned at each one. The canvas can only draw
*Bézier curves*, each defined by a start, an end and two **control points** that
pull the curve like magnets. Catmull-Rom is a recipe that picks those control
points automatically: at each point the curve should head in the direction from
the *previous* point to the *next* one. For the segment `p1 → p2`:

```
control 1 = p1 + (p2 - p0) / 6
control 2 = p2 - (p3 - p1) / 6
```

> *"Catmull-Rom is an interpolating spline: it passes through every sample and
> derives each tangent from the neighbouring points. I convert each segment to a
> cubic Bézier because that's what the canvas draws."*

**Rotating and resizing.** Rotation spins around the shape's centre. To resize
a *rotated* shape correctly: un-rotate the mouse into the shape's own frame, do
the box maths there, then rotate back, while keeping the **opposite corner
pinned** on screen (like stretching a poster by one corner).

**Operations (the "command" idea).** Every user action becomes a small object
describing what changed: add, set, remove. It can be *applied*, *sent*,
*logged* and *reversed*. Undo, networking and saving all share this one idea.

**Optimistic update.** Apply your own change on screen *immediately*, and tell
the server afterwards. You never wait for permission, which is why dragging
feels instant. If the server later says otherwise, you fix it up.

**Per-user undo, with inverse operations.** A shared undo stack would undo
whoever acted last, maybe someone else's work. Instead each person keeps their
own stack of *their own* actions. Undo doesn't rewind history, it sends a *new*
operation that cancels the old one (the inverse):

| You did | Undo sends |
|---|---|
| added a shape | remove that shape |
| removed a shape | bring it back |
| moved x: 100 → 340 | set x back to 100 |

> *"History is append-only and shared; undo is a new operation authored by the
> user, so it goes through the same conflict resolution as every other edit."*

---

## Phase 2: Syncing naively (the bug on purpose)

**Last-write-wins by arrival.** Send every change; the receiver applies
whatever arrives, in the order it arrives. Simple, and wrong.

**Race condition.** The result depends on timing. If Alice's and Bob's messages
cross in transit, Alice's screen applies them in one order and Bob's in the
other.

**Divergence.** The two screens permanently disagree. The rest of the project
exists to guarantee the opposite, **convergence**.

> *"I built the broken version first so I could demonstrate the failure, then
> fixed it, and I can explain why each fix works."*

---

## Phase 3: CRDT for shapes (conflict-free by construction)

**The big idea.** Don't resolve conflicts after they happen. Design the data so
that *any order of arrival produces the same result*. No referee needed.

**Convergence.** Any two replicas that have received the same *set* of
operations are identical, regardless of order or duplicates. This is the one
property the whole project is judged on.

**The three laws.** If your merge is all three of these, convergence is
guaranteed:

| Law | Plain meaning | Why it matters |
|---|---|---|
| Commutative | `A then B` = `B then A` | messages arrive in any order |
| Associative | grouping doesn't matter | batches and relays are fine |
| Idempotent | applying twice = applying once | networks retry |

"Take the maximum" has all three, which is why the building block below works.

**Hybrid Logical Clock (HLC).** Computer clocks disagree, so "whoever was
faster" is meaningless across machines. An HLC is a timestamp of three parts:
`(milliseconds, counter, client id)`.

- It uses real time when it can, so it roughly tracks the wall clock.
- The counter breaks ties when two events share a millisecond.
- When you *receive* a timestamp from someone else, you pull your own clock
  forward past it, so anything you do next is ordered *after* what you saw.
  That gives the key guarantee: **if A caused B, then A's stamp < B's stamp.**
- The client id makes any two stamps comparable, so ties never happen.

Compare `(ms, counter, id)` left to right. Done.

**LWW-Register (Last-Write-Wins Register).** One value + one HLC stamp. A new
write replaces it only if its stamp is *higher*. Every property of every shape
(`x`, `y`, `width`, `fill`...) is its own register.

*Worked example.* Alice drags a box's `x`; Bob, at the same moment, drags its
`y`. They wrote **different registers**, so there is no conflict and **both
changes survive**. The box ends at Alice's x and Bob's y. Only when they write
the *same* property does the higher stamp win, and every machine computes the
same winner.

**Why we send only what changed.** A resize that also re-sent `x` and `y`
would fight with a concurrent move. So an update carries only the properties
that actually differ. This is how "move" and "resize" both survive each other.

**OR-Set (Observed-Remove Set).** Decides whether a shape *exists*. Every add
gets a unique tag. A remove carries the tags **it actually saw**, and cancels
only those. Why: Alice deletes a shape while Bob re-adds it. Alice's remove never
saw Bob's new tag, so Bob's add survives. A plain "remove wins" set would
silently eat his work.

**Tombstones.** Removed shapes aren't erased; their tags and registers stay. If
a late operation arrives for a removed shape, it still lands somewhere sensible
and every replica still agrees. Also what makes **undo-delete** trivial: add a
fresh tag and the shape reappears with the values it had.

**Intent preservation.** "Move the box" should still move it even if someone
resized it at the same time. Absolute values in separate registers give this
for free as long as the two edits touch different properties.

**Why absolute values, not deltas.** "Set x to 340" is safe to repeat.
"Move x by +20" is not: a retry would move it 40. Your design doc mixed both;
the registers need absolute values, so that's what the code uses.

**Undo with a CRDT.** Undo sends a new write restoring the old value, with a
*newer* stamp, so it wins. Policy: undo only reverts a property if nobody else has
changed it since, so it never overwrites a collaborator's later work.

**How we prove it (and how to say it in an interview).**

1. *Property-based test*: generate random edits from several simulated users,
   deliver them in random order with duplicates mixed in, and assert every
   replica ends identical. 200 seeds x 8 shuffles.
2. *Law tests*: assert `merge(a,b) == merge(b,a)`, associativity and
   idempotence directly, on random states.
3. *A bug the fuzzer found*: two clients concurrently adding the same id with
   different types made replicas disagree (the first arrival won). Fix: make
   the type a deterministic function of the add tags (highest tag wins).

> *"I didn't just assert convergence. I fuzzed it: random concurrent edits,
> shuffled and duplicated delivery, and I checked every replica matched. The
> fuzzer found a real bug in my type handling that I'd never have caught by
> reading the code."*

---

## Phase 4: OT for text

**Why text is different.** Shapes have names (`x`, `y`). Text has *positions*:
"insert at index 3". And positions shift whenever anyone else types.

*The CAT example.* Text is `CAT`. Alice inserts `R` at index 2 (`CART`). At the
same moment Bob inserts `!` at index 3 (`CAT!`). If Alice applies Bob's raw
"insert at 3" after her own edit, she gets `CAR!T`. Wrong: Bob meant the end.

**Operational Transformation (OT).** Keep describing edits by position, but
**rewrite each edit** so it still means what its author intended after other
edits happened. Bob's "insert at 3" becomes "insert at 4" once Alice's `R` lands
before it. The rewriting function is `transform(a, b)`.

**The rules (single characters).**

| Concurrent pair | Rewrite |
|---|---|
| insert vs insert | if the other insert is before you, shift right; **same position = tie-break by client id** so both sides pick the same order |
| insert vs delete | delete before you, shift left; delete at/after you, the delete shifts right |
| delete vs delete | other deleted earlier, shift left; **same character**: both become no-ops (it's only gone once) |

**TP1 (the correctness rule).** `transform` must satisfy: applying `A` then
`B'` gives the same text as applying `B` then `A'`. Our test checks *every* pair
of operations on every small string, exhaustively. That is a real proof for
small cases, and the fuzz test covers the rest.

**The Jupiter protocol (how the client and server cooperate).**

- The **server** keeps each text box's full history of applied operations. When
  an op arrives made against an older revision, the server transforms it through
  every op it missed, then applies and records it.
- The **client** may have only **one op in flight** (`outstanding`). Everything
  else waits in a local `buffer`. This single restriction is what lets plain
  pairwise TP1 be enough, with no scarier algebra.
- When another user's op arrives, the client transforms it against its own
  outstanding op *and* its buffer, applies the result to the screen, and
  rewrites its own pending ops to match.
- The server's reply to your own op doubles as the **ack**.

**Revision numbers.** Each side counts how many ops it has folded in for that
text box. They must always agree; a mismatch means a bug, and the engine reports
it (the tests fail if it ever happens).

**Why shapes use a CRDT but text uses OT.** For a map of named properties, a
per-property register *is* a CRDT and it's trivial. For an ordered sequence, the
choice is real:

| | OT | CRDT |
|---|---|---|
| Where the complexity lives | transform functions (hard to prove) | data structure (IDs and tombstones) |
| Needs a central server | yes, for the order | no |
| Memory overhead | small | larger |
| Offline / peer-to-peer | awkward | natural |

We already have a central server for persistence, so OT's overhead advantage
wins. Honest caveat for interviews: modern tools (Yjs, Automerge) lean CRDT even
for text, because it removes the server from the correctness story.

**Caret preservation.** When someone types before your cursor, your cursor
should shift with it. The same transform logic moves the caret through each
remote op.

> *"Text is a sequence, where position is part of an operation's meaning, so I
> used OT with a server that defines the order and a client that keeps one op in
> flight. I verified the transform function satisfies TP1 exhaustively on small
> strings and fuzzed the whole protocol with random network interleavings."*

---

## Phase 5: Saving everything, and surviving disconnects

**The operation log (event sourcing).** Instead of saving "the board as it is
now", save **every operation ever made**, in order. The current board is just
the result of replaying that list. Think of a bank statement versus a balance:
the statement can always rebuild the balance, but a balance can't rebuild the
statement.

Why this is good here: nothing is ever lost, crashes are harmless (replay),
and a client that was away can ask "what happened since #4812?"

**Source of truth vs cache.** The log in the database is the truth. The copy the
server keeps in memory is a *cache* that can be thrown away and rebuilt.
This is what makes restarting the server safe.

**Persist before you announce.** The server saves an operation, *then* tells
everyone. If it crashed in between, the operation was never announced, so the
client simply sends it again. If it did it the other way round, people could see
an edit that then vanishes. ("All are persisted before acknowledgment.")

**Sequencing.** The database hands every saved operation a number
(`serverSeq`) going up forever. That number is the one agreed order of events
for the whole room. Because one process at a time sequences a room (see Phase 6),
the order is unambiguous.

**Snapshots (checkpoints).** Replaying a million operations to open a board
would be slow. Every 100 operations the server also saves a full copy of the
board (the *snapshot*). Opening a board = newest snapshot + the (at most ~100)
operations after it. This is "checkpoint + delta".

> *Analogy: a video game save. You don't replay the whole game, you load the last
> save and replay the last few minutes.*

**Reconnection.** A client remembers the last `serverSeq` it saw. On reconnect it
says "I have everything up to 4812". The server replies with only what is newer.
If the client is brand new (or far behind) it gets the whole board instead.

**The offline queue.** While disconnected, the app keeps working. Edits are applied
to your screen immediately and kept in a *pending* list. On reconnect they are
sent. The status badge shows "Offline · 3 changes waiting".

**Idempotency and deduplication.** Retrying must be safe. Every operation has a
`(clientId, clientSeq)` pair, like a receipt number. If the server sees a number
it has already handled, it ignores the repeat. Without this, a flaky connection
would apply "insert A" twice and you'd see "AA".

**The server's reply is the acknowledgement.** When the server broadcasts your own
operation back to you, that *echo* is the confirmation. It is how a client
knows an op was saved, and why the same mechanism works after a reconnect.

**A retry timer.** If an operation was sent but never echoed (the server crashed
before saving it), the client resends it every few seconds. Safe because of
deduplication.

**Rooms.** A board is a "room", reached at `/board/abc123`. Anyone with the link
can join; an optional password (stored as a bcrypt hash, never plain text)
protects it.

**Storage behind an interface.** The server talks to a `Store` with methods like
`appendOp` and `opsSince`. There are two implementations: SQLite (a file, zero
setup, the default) and PostgreSQL. This is how "runs with no Docker" and "scales
with Postgres" both hold. *Interview angle: "I put storage behind an interface so
the same code runs on SQLite for development and Postgres in production."*

> *"The server stores an append-only operation log and periodic snapshots.
> Clients resume from the last sequence number they saw, so reconnecting costs
> only what was missed, and deduplication by client sequence number makes
> retries safe."*

---

## Phase 6: More than one server

**Why.** One server can only hold so many connections. Run several, and people in
the same room may be connected to *different* servers. They still must see one
consistent board.

**The danger: two sequencers.** If two servers both numbered operations for the
same room, they would give out conflicting orders. So: **exactly one primary
server per room** decides the order. All the others just pass things along.

**A lock with an expiry (lease).** The primary is whoever holds a Redis key
`primary:<room>`. The key is set with "only if nobody has it" (`SET NX`) and a
time limit (say 6 seconds). The primary must **renew** it every couple of
seconds (a *heartbeat*). If the primary dies, it stops renewing, the key
expires, and another server grabs it. No human is involved.

Renewing and releasing use a tiny Lua script so "check I still own it, then act"
happens atomically; otherwise you could extend or delete *someone else's* lock.

**Publish / subscribe (pub/sub).** Redis can carry messages on named channels.
Servers subscribe to the rooms they have people in:

- `in:<room>`: operations forwarded to the primary
- `out:<room>`: the primary announces each saved operation; every server relays
  it to its own connected browsers
- `cur:<room>`, `pres:<room>`: cursors and who's online

**Failover, step by step.** The primary crashes. Its lock expires. A server that
has people in that room notices (it keeps trying to claim), wins the lock,
rebuilds the room from the database (snapshot + log), and carries on. Anything
sent into the void during the gap is simply retried by the clients' timers.
Nothing is lost because nothing was ever acknowledged until it was saved.

**Degraded mode.** If Redis itself is unreachable, a server stops depending on
it: it treats itself as primary for its own rooms and keeps its own people
working. Rooms only split across servers while Redis is down.

**Why not just use the database as the lock?** You could, but a Redis lease with
expiry gives fast failure detection and fits pub/sub, which we need anyway.

*Interview angle: "I picked a leader per room using an expiring lock in Redis,
the same idea as leader election in Kafka or Raft, but much simpler. It is not
a consensus protocol: if the lock service lies, two servers could briefly both
think they are primary. The database's global sequence number and idempotent
operations limit the damage."* (Being honest about the limits is the senior answer.)

---

## Phase 7: Making it a product

**Presence.** Who is here? The server tracks connections and shares a list, so
the sidebar shows coloured dots with names. With several servers, each server
broadcasts its own people every few seconds and everyone merges the lists.

**Ephemeral vs durable state.** Cursor positions are **never saved**. They are
sent to everyone and forgotten, because a cursor from 5 minutes ago is
worthless and 30 updates a second would swamp the log. The rule: *only things
you'd want after a restart go in the log.*

**Throttling.** Cursors send at most ~30 times a second, and pen strokes about
every 33 ms, so a fast mouse doesn't flood the network. The final position is
always sent when you let go.

**Export.** PNG: draw every shape onto an off-screen canvas sized to the
content and save it. SVG: write each shape as an XML element (the pen's
Catmull-Rom curve becomes SVG Bézier commands). SVG is resolution-independent,
and we test it as plain text.

**Accounts and JWT.** Signing in is optional. A password is stored only as a
**bcrypt hash** (slow on purpose, salted, so a stolen database can't be reversed
cheaply). Logging in returns a **JWT**: a signed note saying "this is user X,
valid for 30 days". The server can check the signature without a database
lookup. Wrong-email and wrong-password give the *same* error so attackers can't
tell which emails exist.

**Security habits worth naming.**
- The server never trusts the client's claimed identity: an operation whose
  `clientId` doesn't match the connection is rejected.
- Operations are validated (known shape types, timestamps not absurdly far in the
  future) before anything is saved; a "clock far in the future" would otherwise
  win every conflict forever.
- Request sizes are capped; cursor traffic is rate limited.

**Load testing.** `npm run loadtest` simulates 50 people editing at once and
measures how long each update takes to reach everyone else. **Percentiles** matter
more than averages: *p50* is the typical experience, *p99* is "1 in 100 updates
was at least this slow". Measured: p50 ≈ 54 ms, p99 ≈ 110 ms with 50 users and
about 240 updates per second, meeting the targets of 80 ms and 200 ms.

**A lesson from measuring.** The first run looked terrible (p50 = 200 ms). Two
causes: the test program and the server shared one process, so the *test* was
the bottleneck; and the server was converting the same message to text once per
recipient. Fix the harness, serialize once. *Always check that you're measuring
the system, not your measuring tool.*

---

## Phase 8: Hardening, speed, and the editing toolbox

**Never trust the client.** The browser is code running on the user's machine; anyone can
open the console and send anything. So the server checks every operation before saving it:
numbers must be finite and in range, colours must look like colours (not
`url(javascript:...)`), unknown properties are refused, a stroke can't have a million
points, a board can't exceed 10,000 shapes. Why so strict? Because **the log is replayed
into every other person's screen, forever.** One bad value saved once would crash every
viewer, including after a restart. *Validate at the boundary, once, where it is cheap.*

**Defence in depth.** Several independent layers: identity check (an operation can't claim
another client's id), clock check (a far-future timestamp would win every conflict
forever), size limits, and a rate limit (a flood of operations is cut off with a warning).
Any single layer can have a hole; together they are hard to get through.

**Measure, then optimise.** The PRD says "60 FPS with 1,000 shapes". I didn't assume;
I timed one frame in the real browser. A frame has 16.7 ms to finish for 60 FPS.
1,000 shapes took 3.4 ms (fine), but 10,000 took 54 ms (a slideshow). Three fixes, each
measured:

| Technique | The idea | Plain example |
|---|---|---|
| **Culling** | skip what can't be seen | don't paint the 9,700 shapes that are off-screen |
| **Caching with a version stamp** | don't redo work if nothing changed | sort the shapes only when the board changed, not 60 times a second. A counter ("version") bumps on every change; if it hasn't moved, reuse the last answer |
| **Level of detail (LOD)** | draw less when it can't be noticed | zoomed far out, a 4-pixel shape is a coloured block, not a traced outline |

Result: 4 to 10 ms per frame at every zoom, even with 10,000 shapes.
*"Premature optimisation" means optimising without measuring; the fix is to measure.*

**Marquee selection and rotation.** Drag a rectangle over empty space and everything
touching it is selected. A rotated shape's true outline isn't its original box, so
the code rotates the four corners first and tests that. (My first version used a circle
around the shape, which selected a thin rotated bar from far away. The test caught it.)

**One gesture = one undo step.** Moving 5 shapes sends many tiny updates, but history
records a single entry containing all five edits, so one Ctrl+Z puts them all back.

**Layer order without renumbering (the CRDT-friendly way).** To "bring forward", you
could renumber every shape 1, 2, 3, ... But that rewrites everyone's `zIndex` registers,
and two people reordering at once would trample each other. Instead the moved shape gets
a number *between its new neighbours* (e.g. between 3 and 4 gives 3.5). Only the moved
shape changes. Same idea as **fractional indexing** in Figma. Tie case: shapes with the
exact same z can't be separated by number alone, so a step forward jumps past the whole tie.

**Erasing part of a stroke.** A stroke is a list of points. The eraser removes the
points near it and what's left splits into pieces; each piece becomes its own stroke.
In the log that is: delete the old stroke + add the pieces. Undo reverses it in order.
Nothing special is needed in the sync layer, which is the payoff of building editing
out of simple operations.

**Copy / paste.** Pasting creates *new* shapes with *new ids* (never reuse an id, or two
shapes would be the same object to the CRDT), shifted a little, stacked above everything.
Text content is added through OT like normal typing. The clipboard lives in
`localStorage`, so you can paste into a different board.

**Pinch zoom.** Two fingers define a distance and a midpoint. New zoom = old zoom x
(new distance / old distance). Then move the view so the world point that was under the
midpoint stays under it, the same trick as "zoom at the cursor", with the midpoint
standing in for the cursor.

## Phase 9: Finishing touches that needed real design

**Undo inside a text box (the hardest undo).** The browser's built-in Ctrl+Z can't work
here: it assumes only *you* change the text. Undoing "I typed hello" by deleting "at
index 0" is wrong if someone has since typed "X" before it.

The fix reuses the OT idea you already know. For each edit you make, store its *inverse*
(typing "a" at index 3 stores "delete index 3"; deleting a letter stores "re-insert that
letter"). Then whenever *another person's* edit arrives, run the stored inverses through
`transform`, exactly as pending operations are, so they still point at the right letters.
Undo is then just a normal edit that goes through the normal pipeline.

*Example.* You type "abc". Bob types "X" in front: text is "Xabc". Your stored undo was
"delete 0,1,2"; after transforming it becomes "delete 1,2,3". Undo leaves "X". Redo puts
"abc" back after Bob's X.

Two details worth remembering. *Fast typing merges into one undo step* (letters within
0.7 s), otherwise you'd undo one letter at a time. *Stacks are chains:* each stored step
is defined on the text left by the step above it, so an incoming edit has to be carried
down through the whole stack, not just applied to the top.

**Why layers can no longer tie.** Two people adding a shape at the same instant both
ask for "highest layer + 1" and used to get the same number. Now each client adds a tiny
fraction derived from its own id (like 0.4821), so the answers always differ. This is the
same trick as the HLC's client-id tie-break: *make collisions impossible instead of
handling them afterwards.*

**Resizing and rotating a group.** One box surrounds the group.
- *Resize:* pick the opposite corner as an **anchor**. Every shape's position is scaled
  away from that anchor by the same factors (new size / old size), and rectangles and
  circles scale their width and height too. A line's points scale as well.
- *Rotate:* swing each shape's centre around the group's centre by the same angle
  (a rotation matrix), and turn the shape itself by that angle.
Scale is clamped to at least 5%, so a drag can't flip or collapse the group.

**A panel that tells the truth.** The style controls always show what they would change:
the selected shapes, or "new shapes" if nothing is selected. If the selected shapes
disagree on a property, it is marked **mixed** (dashed outline, blank value) rather
than showing one shape's value as if it were everyone's. It also refreshes when the
selection changes remotely or through undo.

**Testing the Dockerfile for real.** Building the image found a bug just by reading the
file: without a `.dockerignore`, `COPY . .` would overwrite the image's freshly-installed
`node_modules` with the Windows ones from the host. Then the image was run and two clients
synced through it. *"It should work" is not the same as "I ran it."*

## Phase 10: The look (design, and how a hand-drawn style is made)

**Why a hand-drawn style at all.** Perfectly straight lines make a diagram look *finished*,
which discourages people from changing it. A slightly wobbly one looks like a draft, so
people feel free to edit. That is why whiteboard tools like Excalidraw use it. It is a
design decision with a reason, not decoration.

**Procedural wobble.** Nothing is a picture. Each shape's outline is computed:
- A **line** gets scattered endpoints, a gentle bow, a little overshoot, and tiny hand
  shake, then is drawn twice with slightly different wobble, like going over a pencil line.
- A **rectangle** is four lines (or, with rounded corners, a loop that ends a little past where
  it began). A **circle** is points around an ellipse with a smooth wobble in the radius,
  and a pen-like overlap where it closes.
- A **fill** is parallel lines at an angle ("hachure"), clipped to the shape. Cross-hatch
  adds the other direction.

**Seeded randomness (the key idea).** If the wobble were truly random, the same shape would
look different on your screen, your friend's screen, and in the exported file, and would
jitter on every redraw. Instead the random numbers come from a generator **seeded with the
shape's id**. Same id, same sequence, same wobble, everywhere, forever. Interview line:
"deterministic pseudo-randomness, so a hand-drawn look is still reproducible and
syncs without sending any extra data".

**Cache by object identity.** Computing a wobbly outline costs time, so it is stored against
the shape object. Whenever a shape changes, a *new* object replaces it, so the cache is
automatically out of date exactly when it should be, with no invalidation logic.
(Measured: 1,000 shapes outlined in about 70 ms the first time, almost nothing after.)

**One geometry, two outputs.** The same list of points is drawn on the canvas and written
as SVG, so exports match the screen. The smoothing step (quadratic curves through midpoints)
is one function used by both.

**Design system choices, and the reason for each.**
- *Paper, ink, accent.* A cool off-white paper (not cream), a deep blue-black ink, and
  an accent that is **your own cursor colour**. The interface belongs to you; other people
  see the same colour on your cursor, so it also means "this is me".
- *One memorable thing.* The tool tray: the selected tool lifts and fills with your colour.
  Everything else stays quiet (white panels, one soft shadow, sentence-case labels).
- *Fonts that are bundled.* A friendly variable sans for the interface and a handwriting
  face for the canvas. They are served with the app, so it works offline and never
  flashes unstyled text from a font CDN.
- *Dark mode by inversion.* The canvas is inverted and hue-rotated by CSS, so dark ink
  turns light and colours keep their hue. One rule instead of a second colour system.
- *Panels tell the truth.* "(mixed)" with a dashed outline when selected shapes disagree.

**Ephemeral features.** The laser pointer and emoji reactions are sent like cursors: relayed
live, never saved. The server only forwards emoji from a fixed list of six, and
rate-limits them, so a client cannot use reactions to send arbitrary content.

**Test with real input.** Synthetic events (code that *pretends* to click) hid a real bug:
a click on the canvas moves keyboard focus *after* your handler runs, which silently closed
the text box the instant it opened. Only a real mouse in a real browser caught it. The
end-to-end check now drives two real browsers with real mouse and keyboard input.

## Bugs the tests found (good interview stories)

1. **Same id, different type.** Two clients adding the same shape id with different
   types made replicas disagree, because "first arrival wins" depends on order.
   Fixed by making the type depend on the highest add tag, an order-independent rule.
2. **Parallel test runners crashing on Windows** (`spawn UNKNOWN`). Not a code bug:
   several esbuild processes starting at once. Fixed by running test files one at a time.
3. **A test race, not a code race.** A test moved a shape before the shape had
   arrived at that user, so the edit silently did nothing. Lesson: wait for the
   state your next step depends on.
4. **Redis down made startup and tests hang for 9 seconds.** A "subscribe" command
   waited for Redis to come back. Fixed so degraded mode is instant.
5. **The server accepted any value.** `x: "oops"` would have been saved and replayed into
   every screen. Found by asking "what if the client lies?", not by a failing test. Fixed
   with validation plus tests that try 17 kinds of bad value.
6. **10,000 shapes rendered at 18 FPS.** Found by timing a real frame, fixed with culling,
   caching and level of detail (now 4 to 10 ms).
7. **A rotated-shape selection bug.** A circle around a shape was too generous. Fixed
   by testing the true rotated outline.
8. **A 30-second timeout in my browser test** was not an app bug: background tabs
   throttle timers to about one per second, and the test waited between 40 events.
   *Know what your test environment does to timing.*

## Running it and testing it

```
npm install
npm run dev          # server + app, no Docker
npm test             # 85 tests (83 run by default, 2 need real Postgres/Redis)
npm run typecheck
npm run loadtest     # latency with 50 simulated users
```

See `README.md` for configuration (Postgres, Redis) and the full feature list.
