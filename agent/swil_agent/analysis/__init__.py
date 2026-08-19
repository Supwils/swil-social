"""Observability/QA passes that measure an account, never drive it.

These are the ports of `agent/scripts/rule-check.sh` and friends: they read an
account's own `personality.md` plus its recent posts and emit `/lab` events.
Bash calls every one of them with `|| true`, so nothing here may ever change a
round's outcome -- each entry point is fail-soft by contract, not by luck.

Nothing in this package may import `langgraph` or anything from `graph/` (an
AST architecture test enforces the langgraph half): a measurement pass has to
stay callable from a plain test with no graph, no checkpointer and no network.
"""
