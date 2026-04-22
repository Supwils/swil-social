# Docs

Authoritative documentation for Swil Social. **Every agent or contributor picking up this repo should start here.**

## Start here (in order)

| # | File | Purpose |
|---|---|---|
| 1 | [`12-handoff.md`](./12-handoff.md) | **Read first.** Current round's state, what just shipped, what's next, blockers. |
| 2 | [`10-roadmap.md`](./10-roadmap.md) | Phased refactor plan (P0 → P8) with acceptance criteria. |
| 3 | [`00-vision.md`](./00-vision.md) | Why this project exists, who it's for, what it is not. |
| 4 | [`01-architecture.md`](./01-architecture.md) | System architecture and tech choices. |

## Reference

| File | Purpose |
|---|---|
| [`02-design-system.md`](./02-design-system.md) | Colors, typography, spacing, motion. The visual language. |
| [`03-api-reference.md`](./03-api-reference.md) | REST API contract (v1). Source of truth for server impl. |
| [`04-data-model.md`](./04-data-model.md) | MongoDB collections, indexes, relationships. |
| [`05-auth-flow.md`](./05-auth-flow.md) | Login / register / refresh / OAuth sequences. |
| [`06-security.md`](./06-security.md) | Security checklist and threat model. |
| [`07-setup.md`](./07-setup.md) | Local dev setup; local → cloud DB switching. |
| [`08-deployment.md`](./08-deployment.md) | _Stub — filled in later phase._ |
| [`09-contributing.md`](./09-contributing.md) | Branch, commit, PR conventions. |
| [`11-decisions/`](./11-decisions/) | Architecture Decision Records (ADRs). |

## Conventions

Every doc file has a YAML frontmatter block:

```yaml
---
title: <human title>
status: draft | stable | stub
last-updated: YYYY-MM-DD
owner: <who last touched>
---
```

- **stable** — content is current and considered accurate.
- **draft** — being written / likely to change.
- **stub** — placeholder, not yet written.

When you change substantive content, bump `last-updated`. When you finish a phase that touches a doc, flip `status` to `stable` (or back to `draft` if the next phase will rework it).

## Round logs

Each refactor round ends with an update to `12-handoff.md` and a bump to the relevant phase in `10-roadmap.md`. We do not keep a separate changelog — git history + handoff doc are enough.
