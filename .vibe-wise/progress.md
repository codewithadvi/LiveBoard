# Learning Progress

## Concurrent edit conflicts
- Introduced (AI explained, at learner's request): conflict vs deadlock, clock skew and last-write-wins, Lamport clocks, per-property merging, optimistic local apply with ack/rebase, OT vs CRDT, tombstones, fractional indexing, presence vs durable state, op log + snapshots.
- Learner-proposed ideas: block edit with a "both editing" notice; resolve by timestamp (faster wins); unsure how to proceed. Learner used "deadlock" for what is a conflict.
- Demonstrated understanding: none yet.
- Needs reinforcement: why wall-clock timestamps can't order events across machines; what "convergence" requires.

## CRDT for shapes and OT for text (built at learner's request: "continue building everything")
- Introduced (AI built and explained in STUDY.md): HLC, LWW-register, OR-Set, tombstones, convergence and the three merge laws, intent preservation, OT transform rules, TP1, Jupiter client/server protocol with one op in flight.
- Verified by tests: exhaustive TP1 check, CRDT law tests, 150-seed fuzz of a full simulated network (13 tests passing).
- Learner has not yet predicted or reasoned about these designs themselves; they asked the AI to build. Demonstrated understanding: none yet.
- Learner decisions: wants runnable without Docker (AI recommends SQLite + in-process bus by default, Postgres/Redis optional via env vars); wants every phase's concepts added to STUDY.md.

## Persistence, multi-server, product features (Phases 5-7, built at learner's request)
- Introduced (AI built and explained in STUDY.md): event sourcing / operation log, snapshots, persist-before-announce, idempotent retries with clientSeq dedupe, echo-as-ack, reconnect from lastSeq, offline queue, expiring Redis lease for per-room primary, pub/sub, failover, degraded mode, presence vs durable state, throttling, JWT + bcrypt, percentiles and load testing.
- Verified: 37 tests (35 default), real Postgres + Redis run once, real-browser two-tab checks including offline merge, undo, style controls; load test p50 ~54ms / p99 ~110ms at 50 users.
- Learner has not yet restated or argued any of these designs in their own words. Demonstrated understanding: none yet.

## Pending decision
Decision: None blocking. All PRD phases are built. Next useful learning step (offered, not yet taken): the learner explains in their own words how a concurrent edit flows through the system, and the AI gives feedback. Remaining product gaps: see project-map.md "Known gaps".
