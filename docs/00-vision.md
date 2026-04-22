---
title: Vision & Positioning
status: stable
last-updated: 2026-04-21
owner: round-1
---

# Vision & Positioning

## Why this exists

Swil Social started as a student full-stack project. It works, but it carries the hallmarks of a first-pass build: scattered API calls, plaintext secrets, no validation, a README that describes a stack the code doesn't actually use. The owner wants to bring it back to life — not as a homework artifact, but as something they would be proud to show, use, and open-source.

The refactor is the point. Keeping the old code running would be easier; rebuilding it with the discipline of a senior team is the exercise.

## Triple positioning

This project simultaneously serves three audiences. Every design decision should still make sense in all three rooms.

### 1. Personal portfolio

For anyone evaluating the owner's engineering work. The code, the docs, and the commit history should all read as deliberate. The `/docs` folder is as much a deliverable as the app itself.

**Implication:** Architecture decisions are documented (ADRs). Code has consistent patterns. Tests exist where they matter. README and setup guide are correct and copy-pasteable.

### 2. Niche community platform

For a small group — a dorm, a hobby circle, a few friends — who want their own quiet space without the algorithms and ads of big social. Single-tenant, self-hosted or solo-hosted, a few dozen users.

**Implication:** Features favor intimacy over scale. Small defaults: pagination of 20, not 1000. No anonymous public firehose. Trust-based moderation. The UI should feel like a shared notebook, not a broadcast tower.

### 3. Deployable template

For someone else who wants to fork and stand up their own small social space. They should be able to clone, read `07-setup.md`, and be running locally in under 10 minutes.

**Implication:** Setup friction is a first-class bug. `.env.example` is complete. Seed data exists. Local Mongo and cloud Mongo are both supported via one env var. No hardcoded URLs, domains, or credentials.

## Differentiation

The category (small social apps) is crowded. The wedge is **aesthetic restraint**.

- No dopamine patterns. No streaks, no notification badges demanding return visits, no pull-to-refresh haptics.
- No brand-blue. The palette is warm off-white, ink, and one muted tea-brown accent.
- Writing is first-class. Markdown, draft autosave, Cmd+K, a reading width that's comfortable (680px feed column). Photos support the text, not the other way around.
- Quiet realtime. Notifications and DMs exist, but the UI does not scream when they arrive.

See [`02-design-system.md`](./02-design-system.md) for the visual expression of this.

## Non-goals

Explicitly **not** in scope, to keep the project tractable:

- **Massive scale.** Target: up to ~10k users per deployment. If it needs sharding, we've taken a wrong turn.
- **Algorithmic feed.** Reverse-chronological from people you follow. No "for you" tab.
- **Ads, monetization, analytics SDKs.** None. Ever.
- **Mobile apps.** The web app must work well on phones, but we are not shipping iOS/Android binaries.
- **Federation (ActivityPub).** Interesting, but out of scope for v1. Revisit post-launch.
- **Enterprise features.** No SSO, no audit logs, no admin console beyond what a single owner needs.

## What "done" looks like for v1

A single-owner deployment with:

- Register / login / OAuth working and secure.
- Feed, posts, comments, likes, tags, follows, notifications, DMs — all functional.
- `/docs` that a stranger can read and follow.
- One-command local setup. One-env-var switch to cloud Mongo.
- A seed script populating ~15 dummy users, ~50 posts, a few conversations, using random stock images.
- Dark mode. Cmd+K. Markdown. The aesthetic intact.

After v1 we'll consider: federation, native mobile wrappers, public directory of instances, plugin hooks. Not before.
