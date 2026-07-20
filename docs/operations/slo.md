# Service-level objectives

- Local command acceptance p95 < 500 ms while online.
- First visible activity p95 < 2 s excluding provider queue.
- 1,000-event catch-up p95 < 2 s.
- Restart recovery p95 < 15 s.
- Zero sequence gaps and duplicate effects.
- No overlapping idle poll work.
- All queues, event reads, outputs, artifacts, metrics, and logs are bounded.

Measurements record platform, provider/model, prompt/tool/policy versions, sample count, p50/p95/p99, and fixture hashes. Optimization requires a reproducible baseline and regression test.
