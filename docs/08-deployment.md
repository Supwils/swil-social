---
title: Deployment
status: stub
last-updated: 2026-04-21
owner: round-1
---

# Deployment

> **Stub.** Deployment is deferred to Phase P8. This file exists so that future agents know where the doc will live and do not create duplicate deployment notes elsewhere.

## Planned shape

- `Dockerfile` (multi-stage: build client, build server, runtime image).
- `docker-compose.yml` for local parity (app + mongo + redis).
- Managed hosting recommendation (Railway or Render) with a step-by-step checklist.
- Environment variable cheatsheet (prod vs. dev).
- Backup procedure for Mongo.
- Monitoring / alerting setup (Sentry + UptimeRobot).
- Secret rotation runbook.
- Rollback procedure.

Until P8 ships, the owner runs the app locally per `07-setup.md`.
