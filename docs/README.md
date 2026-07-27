# Synapse documentation

Reorganised 2026-07-27. Everything below used to sit as ~20 loose `SHOUTING_CASE.md`
files at the repo root; nothing was rewritten in the move, only relocated and renamed.

Docs are point-in-time. Where one cites `file:line`, verify against current code
before relying on it.

## Start here

| I want to… | Read |
|---|---|
| Understand what Synapse is and how data moves | [`architecture/overview.md`](architecture/overview.md) |
| Trace the source → bus → destination path in detail | [`architecture/data-flow.md`](architecture/data-flow.md) |
| Set up, build, or extend the codebase | [`architecture/developer-guide.md`](architecture/developer-guide.md) |
| Run the product end to end for a demo | [`guides/demo.md`](guides/demo.md) |
| Know what is actually built vs pending | [`status/product-status.md`](status/product-status.md) |

## `architecture/` — how the system works
- **`overview.md`** — the master reference: BRD + code traces in one place.
- **`data-flow.md`** — intended wiring vs actual build, the bus decision, plain-English primer.
- **`developer-guide.md`** — the long-form engineering guide (setup, modules, API surface).

## `guides/` — task-oriented walkthroughs
- **`demo.md`** — copy-paste demo script, written for someone who has never used Synapse.
- **`connectors.md`** — all 12 connector categories: how to author each, and whether it transfers data.
- **`pulse-connector.md`** — building the Pulse connector specifically.
- **`testing.md`** — end-to-end test plan, verified against live backend contracts.
- **`test-guide.md`** — manual QA test guide.
- **`share-with-qa.md`** — runbook for exposing a local instance to in-office QA.

## `upgrades/` — delivered feature specs
Each is a design doc for a feature that **has shipped**; they carry as-built notes and
are the best explanation of *why* each subsystem looks the way it does.

`entity-join.md` · `file-share.md` · `fk-lookup.md` · `qc-safe-features.md` ·
`sharepoint-feasibility.md`

## `history/` — completed plans and audits
Kept as a record, **not** as a to-do list. All three are finished.

- **`bus-upgrade-plan.md`** — the 16-day plan that turned on the distributed bus.
- **`ui-audit-2026-07-23.md`** — the enterprise UI/UX audit; all severity tiers now closed.
- **`ui-system-plan.md`** — the button/card/motion system; all phases applied.

## `status/`
- **`product-status.md`** — plain-English, code-verified snapshot of built vs pending.

## `reference/` — source material
The original BRD and FSD (`.docx`), plus `brd-extracted.txt` / `fsd-extracted.txt`, which
are plain-text forms of the same documents kept **because you cannot grep a `.docx`**.
Also `diagrams/` and `active-brand.md`.

## Not here
- **`CLAUDE.md`** stays at the repo root — the agent tooling expects it there.
- **`planning/`** (repo root) holds project-management artifacts — schedules, status
  reports, the QC plan — rather than engineering documentation.
