"""The durable cycle layer.

This is the ONLY package permitted to import `langgraph` (spec §5.2). The
one-way dependency rule -- `graph -> act, dream -> api, llm, persona,
embedder -> config, models` -- is what keeps the entire core unit-testable
without a graph runtime, and keeps the framework replaceable.
"""
