---
name: verify
description: Build/launch/drive recipe for verifying Relay web UI changes end-to-end in a browser.
---

# Verifying the Relay web app

## Launch

```bash
cd apps/web && bun run dev        # vite; picks 5174 if 5173 busy — read the port from output
```

`apps/web/.env.local` already sets `VITE_CONVEX_URL` (dev deployment).

## Drive

- Open `http://localhost:<port>/` in a browser (chrome-devtools MCP works headed).
- Auth wall: dev deployment accepts password sign-up. A disposable account
  (`verify-bot@example.com`) exists from prior verification — sign in with
  `verify-bot-password-1234`, or create another; it lands on the Pair-daemon
  state (no machines).
- Without a paired daemon you can verify: auth panel, sidebar shell, ⌘K/Ctrl+K
  command palette, Ctrl+B/J/I toggles (persisted in localStorage key
  `relay.shell.panels`), `/settings` and `/settings/<section>` deep links.
- Run-level surfaces (composer pickers, terminal drawer, inspector content,
  attention inbox rows) need a paired machine with projects/threads — pair a
  daemon via `bun run daemon:connect` or accept that those stay component-test
  covered.

## Gotchas

- React inputs need native-setter + `input` event to fill via script (controlled).
- `?view=<legacy>` params must not crash; they fall back to Session.
