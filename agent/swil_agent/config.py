"""Typed settings for the agent runtime.

Precedence deliberately matches the Bash runtime: `agent/.env` is sourced with
`set -a` after the caller's environment, so the FILE WINS over process env.
This is the opposite of pydantic-settings' default, hence the explicit
`settings_customise_sources` override below.
"""

from __future__ import annotations

from pathlib import Path
from typing import Literal

from pydantic import Field, SecretStr, field_validator
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

    # How many of the account's OWN recent posts the act path's self-similarity
    # sampler compares a candidate post against (Phase B task 2). 12 because
    # that is the window `behavior_post_limit` above already uses: both read the
    # same `/users/{u}/posts` endpoint about the same account, so a shared
    # window is what lets "how repetitive was this round's post" and "what does
    # this account's recent voice look like" be read against each other rather
    # than against two different slices of history. Spelled as a literal for the
    # same reason as the pair above -- `act/` sits above `config` in spec §5.2's
    # dependency order, so this module cannot import
    # `act.round.DEFAULT_ACT_SIMILARITY_WINDOW`; `test_act_similarity.py` pins
    # the two equal in both directions.
    #
    # There is deliberately NO `act_similarity_threshold` beside it. This
    # measurement is SHADOW ONLY -- computed, recorded, acting on nothing --
    # and the threshold that will eventually gate on it has to be calibrated
    # from the series this task starts collecting. A threshold sitting here
    # unused is an invitation to set one before there is any data to set it
    # from.
    act_similarity_window: int = 12

    # Probability that one round reads a board OUTSIDE the account's assigned
    # niche (Phase B task 3, spec §8.3). Spelled as a literal for the same
    # reason as the three windows above -- `act/` sits above `config` in spec
    # §5.2's dependency order, so this module cannot import
    # `act.context.DEFAULT_CROSS_READ_PROB`; `test_act_context.py` pins the two
    # equal in both directions.
    #
    # Bounded to [0, 1] at load time rather than trusted. It is read straight
    # into a `rng.random() < prob` comparison, where both out-of-range spellings
    # an operator can plausibly type are SILENT: `CROSS_READ_PROB=15` (meaning
    # "15%") makes every round a cross-read, and a negative value makes none --
    # the second being indistinguishable from the intended off switch, and the
    # first from a deliberate all-cross-reads arm. `0` is the documented off
    # switch and the revert path, so it stays legal.
    cross_read_prob: float = Field(default=0.15, ge=0.0, le=1.0)

    # ── LLM backend selection ────────────────────────────────────────────
    #
    # All five are GLOBAL DEFAULTS, not overrides: `llm/selection.py` ranks the
    # personality.md bullets above them, because each account's backend is the
    # drift experiment's independent variable and an env var that outranked the
    # roster would silently re-assign every arm at once. Only an explicit CLI
    # flag outranks the file. See that module's docstring for the full ladder.
    #
    # `None` (not `"claude"`) is the default for `swil_llm_backend` on purpose:
    # it means "the file decides", which is what every account does today, so
    # adding these fields changes no round's behaviour until one is set.
    swil_llm_backend: str | None = None
    swil_llm_model: str | None = None

    # Only read when the resolved backend is `api`.
    #
    # `swil_llm_base_url` is the base URL AS THE VENDOR DOCUMENTS IT: the
    # OpenAI-shaped providers publish a base that already ends in `/v1` (the
    # call is `POST {base}/chat/completions`), Anthropic publishes one that does
    # not (`POST {base}/v1/messages`). Normalising the two here would mean
    # rewriting a URL the operator copied from the vendor's own docs, which is a
    # worse surprise than the asymmetry.
    swil_llm_provider: str | None = None
    swil_llm_base_url: str | None = None
    # SecretStr so a stray `repr(settings)` in a log line or a traceback frame
    # prints `**********` instead of the key. It is never written to
    # personality.md, memory.md, or a lab event -- `BackendChoice.describe()`
    # carries the provider and the model and nothing else.
    swil_llm_api_key: SecretStr | None = None
    # Anthropic's Messages API requires `max_tokens`; the OpenAI-shaped one
    # treats it as optional. Sent on both so the two protocols cannot diverge
    # in output length for the same persona, which would confound a
    # cross-provider comparison for a reason that is not the model.
    swil_llm_max_tokens: int = Field(default=4096, gt=0)

    unsplash_access_key: str | None = None

    agent_root: Path = Field(default=_AGENT_ROOT)

    @field_validator(
        "swil_llm_backend",
        "swil_llm_model",
        "swil_llm_provider",
        "swil_llm_base_url",
        "swil_llm_api_key",
        mode="before",
    )
    @classmethod
    def _blank_is_unset(cls, v: object) -> object:
        """`FOO=` in a .env file is how a shell spells "off", not "the empty
        string". Left as `""` these are falsy in some checks and truthy as a
        declared-source in others, so an operator commenting a value out by
        emptying it would get a different resolution than deleting the line."""
        if isinstance(v, str) and not v.strip():
            return None
        return v

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
