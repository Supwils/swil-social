---
title: Architecture Decision Records (ADRs)
status: stable
last-updated: 2026-04-21
owner: round-1
---

# ADRs

Lightweight records of architecture decisions. One file per decision, numbered sequentially, never deleted (superseded decisions get a new ADR that references the old one).

## Format

```
---
title: ADR NNN — <short noun phrase>
status: Proposed | Accepted | Superseded by NNN | Rejected
last-updated: YYYY-MM-DD
owner: <round or author>
---

# ADR NNN — <title>

## Context
Why are we deciding? What forces are at play?

## Options considered
Numbered list, each with a brief pros/cons note.

## Decision
One paragraph. Unambiguous.

## Consequences
Positive, negative, and trade-offs. Be honest.

## Follow-ups
Concrete tasks this decision creates.
```

## Index

| # | Title | Status |
|---|---|---|
| [001](./001-vite-over-cra.md) | Vite over Create React App | Accepted |
| [002](./002-zustand-over-redux.md) | Zustand + TanStack Query over Redux | Accepted |
| [003](./003-stay-nosql.md) | Stay on MongoDB with local/cloud parity | Accepted |
