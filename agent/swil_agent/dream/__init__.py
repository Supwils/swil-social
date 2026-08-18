"""Dream-path: drift math and (later) candidate generation / gating.

`drift.py` carries the similarity math ported out of `dream.sh`'s Python
heredocs -- cosine similarity, per-aspect breach detection, pairwise
variance, and anchor resolution -- with no I/O beyond one file read, which
is what makes it independently testable.
"""
