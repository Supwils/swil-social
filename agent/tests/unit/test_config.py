from pathlib import Path

from swil_agent.config import load_settings


def test_defaults_match_documented_values(tmp_path: Path) -> None:
    env = tmp_path / ".env"
    env.write_text("SWIL_URL=https://example.test\n", encoding="utf-8")
    s = load_settings(env)
    assert s.swil_url == "https://example.test"
    assert s.drift_mode == "aspect"
    assert s.drift_threshold == 0.82
    assert s.drift_threshold_values == 0.63
    assert s.drift_threshold_style == 0.72
    assert s.drift_threshold_topic == 0.71
    assert s.aspect_distill_model == "haiku"
    assert s.embedder_url == "http://127.0.0.1:7777"
    assert s.dream_cooldown_hours == 12
    assert s.dream_min_new_memories == 8
    assert s.echo_detect is False
    assert s.echo_variance_threshold == 0.04


def test_env_file_wins_over_process_env(tmp_path: Path, monkeypatch) -> None:
    """The Bash runtime sources agent/.env with `set -a` AFTER the caller's env,
    so the file wins. Preserve that precedence or operators will be surprised."""
    env = tmp_path / ".env"
    env.write_text("SWIL_URL=https://from-file.test\nDRIFT_MODE=shadow\n", encoding="utf-8")
    monkeypatch.setenv("SWIL_URL", "https://from-process.test")
    monkeypatch.setenv("DRIFT_MODE", "scalar")
    s = load_settings(env)
    assert s.swil_url == "https://from-file.test"
    assert s.drift_mode == "shadow"


def test_trailing_slash_is_stripped_from_swil_url(tmp_path: Path) -> None:
    env = tmp_path / ".env"
    env.write_text("SWIL_URL=https://example.test/\n", encoding="utf-8")
    assert load_settings(env).swil_url == "https://example.test"


def test_process_env_used_when_key_absent_from_file(tmp_path: Path, monkeypatch) -> None:
    """Regression guard for `set -a && . agent/.env` semantics: a key absent from
    the file must still come from the process environment, not silently fall
    through to the field default. DRIFT_MODE's field default is "aspect", so a
    pass here genuinely proves process-env won over the default rather than the
    two happening to agree."""
    env = tmp_path / ".env"
    env.write_text("SWIL_URL=https://example.test\n", encoding="utf-8")
    monkeypatch.setenv("DRIFT_MODE", "shadow")
    assert load_settings(env).drift_mode == "shadow"
