"""Proves the package is importable and the toolchain is wired."""

from swil_agent import __version__


def test_version_is_a_semver_string() -> None:
    assert isinstance(__version__, str)
    parts = __version__.split(".")
    assert len(parts) == 3
    assert all(p.isdigit() for p in parts)
