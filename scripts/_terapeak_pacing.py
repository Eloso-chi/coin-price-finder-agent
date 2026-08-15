#!/usr/bin/env python3
"""Bounded pacing profiles for the #280H Terapeak A/B pilot."""

import os
import re

BASELINE = "baseline"
NORMAL_TUNED = "normal-tuned"
VALID_PROFILES = (BASELINE, NORMAL_TUNED)
NORMAL_TUNED_MULTIPLIER = 0.80
PILOT_ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")


def validate_profile(profile):
    normalized = str(profile or BASELINE).strip().lower()
    if normalized not in VALID_PROFILES:
        raise ValueError(
            f"invalid Terapeak pacing profile: {profile!r}; "
            f"expected one of {', '.join(VALID_PROFILES)}"
        )
    return normalized


def requested_profile(environ=None):
    source = environ if environ is not None else os.environ
    return validate_profile(source.get("TERAPEAK_PACING_PROFILE", BASELINE))


def effective_profile(requested, risk_state):
    requested = validate_profile(requested)
    if requested == NORMAL_TUNED and risk_state == "Normal":
        return NORMAL_TUNED
    return BASELINE


def valid_pilot_id(pilot_id):
    return isinstance(pilot_id, str) and bool(PILOT_ID_PATTERN.fullmatch(pilot_id))


def authorized_effective_profile(requested, candidate, risk_state, pilot_id):
    requested = validate_profile(requested)
    candidate = validate_profile(candidate)
    if (
        requested == NORMAL_TUNED
        and candidate == NORMAL_TUNED
        and risk_state == "Normal"
        and valid_pilot_id(pilot_id)
    ):
        return NORMAL_TUNED
    return BASELINE


def delay_multiplier(profile):
    profile = validate_profile(profile)
    return NORMAL_TUNED_MULTIPLIER if profile == NORMAL_TUNED else 1.0


def scale_seconds(seconds, profile):
    return float(seconds) * delay_multiplier(profile)


def scale_range(delay_range, profile):
    return tuple(scale_seconds(value, profile) for value in delay_range)