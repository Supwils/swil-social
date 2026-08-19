"""Typed settings for the agent runtime.

Precedence deliberately matches the Bash runtime: `agent/.env` is sourced with
`set -a` after the caller's environment, so the FILE WINS over process env.
This is the opposite of pydantic-settings' default, hence the explicit
`settings_customise_sources` override below.
"""

from __future__ import annotations

from pathlib import Path
from typing import Literal

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, PydanticBaseSettingsSource, SettingsConfigDict

_AGENT_ROOT = Path(__file__).resolve().parent.parent


class Settings(BaseSettings):
    # `extra="ignore"`: the real `agent/.env` carries keys this model does not
    # declare (UNSPLASH_SECRET_KEY, ASPECT_PROMPT_VERSION, SWIL_AGENT_SETUP_TOKEN),
    # and pydantic-settings defaults to `extra="forbid"`, which made loading the
    # real file fail validation. Some of those keys are expected to become real
    # fields in a later phase; until then, ignore rather than reject them.
    model_config = SettingsConfigDict(
        env_file_encoding="utf-8", case_sensitive=False, extra="ignore"
    )

    swil_url: str = "http://localhost:8899"
    swil_pass: str | None = None

    drift_mode: Literal["scalar", "shadow", "aspect"] = "aspect"
    drift_threshold: float = 0.82
    drift_threshold_values: float = 0.63
    drift_threshold_style: float = 0.72
    drift_threshold_topic: float = 0.71
    aspect_distill_model: str = "haiku"

    embedder_url: str = "http://127.0.0.1:7777"

    dream_cooldown_hours: int = 12
    dream_min_new_memories: int = 8

    echo_detect: bool = False
    echo_variance_threshold: float = 0.04

    # How many recent posts each of the two cycle-wired observability samplers
    # reads. Bash spells them `RULE_CHECK_POST_LIMIT` (rule-check.sh:25) and
    # `BEHAVIOR_POST_LIMIT` (behavior-snapshot.sh:28), both defaulting to 12.
    # Declared here so the two runtimes read the SAME env var rather than the
    # Python side silently ignoring an operator's override -- the defaults are
    # spelled as literals because `analysis/` sits ABOVE `config` in spec
    # §5.2's dependency order, so this module cannot import their constants.
    # `test_config.py` pins the two pairs equal in both directions.
    rule_check_post_limit: int = 12
    behavior_post_limit: int = 12

    unsplash_access_key: str | None = None

    agent_root: Path = Field(default=_AGENT_ROOT)

    @field_validator("swil_url", "embedder_url")
    @classmethod
    def _strip_trailing_slash(cls, v: str) -> str:
        return v.rstrip("/")

    @classmethod
    def settings_customise_sources(
        cls,
        settings_cls: type[BaseSettings],
        init_settings: PydanticBaseSettingsSource,
        env_settings: PydanticBaseSettingsSource,
        dotenv_settings: PydanticBaseSettingsSource,
        file_secret_settings: PydanticBaseSettingsSource,
    ) -> tuple[PydanticBaseSettingsSource, ...]:
        # dotenv BEFORE env: the file wins, matching `set -a && . agent/.env`.
        # Sources earlier in the tuple take precedence over later ones, so
        # placing dotenv_settings ahead of env_settings makes a key present in
        # the .env file win over the same key in the process environment,
        # while a key absent from the file still falls through to env_settings
        # (process env) and finally to the field defaults.
        return (init_settings, dotenv_settings, env_settings, file_secret_settings)


def load_settings(env_file: Path | None = None) -> Settings:
    path = env_file if env_file is not None else _AGENT_ROOT / ".env"
    return Settings(_env_file=path)
