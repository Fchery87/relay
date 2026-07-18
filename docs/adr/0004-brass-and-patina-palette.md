# 0004 — Brass & patina palette on a neutral near-black canvas

## Status

Accepted (2026-07-17)

## Context

The original Relay Switchboard palette used a green-warm graphite canvas with brass (`#C7A95D`) as the primary interactive color. During the 2026-07 UI overhaul (T3Code-inspired decongestion), we wanted the calm, neutral near-black feel of modern agent IDEs — but their signature saturated blue accent (Tailwind blue-500 territory, hue ~217) has become the default look of AI-generated dashboards. Adopting it would erase Relay's only visual signature while making it look like everything else.

## Decision

Split color semantics across two states of the same metal:

- **Patina** (`--color-primary: #6FBFB4`, verdigris) means *interactive*: focus, links, selection, primary buttons, send. It reads cool and calm like blue without being blue.
- **Brass** (`--color-brass: #C7A95D`, kept from the original identity) means *the agent needs you*: pending approvals, the handoff trace, checkpoint markers, the attention inbox, and brand marks. It never decorates ordinary chrome.
- The canvas ladder becomes neutral near-black (`#0A0A0B → #1D1F21`), dropping the green tint.

The pairing is deliberate: brass is the metal polished, patina is the metal aged. `CONTEXT.md` (Design language) forbids any other element from borrowing either meaning.

## Alternatives considered

1. **T3-style saturated blue everywhere** — clean but generic; deletes the brass identity.
2. **Keep brass as primary, only cool the canvas** — preserves identity but ignores the goal of a cooler, quieter interactive layer, and brass-as-everything dilutes its attention meaning.
3. **Desaturated steel blue** — quieter than T3 but still "a blue dev tool".

## Consequences

- All color flows through CSS variables in `apps/web/src/app.css`; the swap is a token-layer change plus explicit re-pointing of needs-you surfaces from `--color-primary`/`--color-warning` to `--color-brass`.
- `--color-warning` is reserved for genuine risk messaging (e.g. full-access network warnings, git impact), no longer for approvals.
- Any new "waiting on the operator" surface must use brass; any new interactive control must use patina. Reviews should reject mixed usage.
- `docs/design.md` frontmatter and prose are the mirror of this decision; `design-system.test.tsx` pins the token values.
