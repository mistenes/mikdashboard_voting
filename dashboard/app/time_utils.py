from __future__ import annotations

from datetime import datetime
from zoneinfo import ZoneInfo

# Centralized timezone handling to keep all date and time logic on Budapest time.
LOCAL_TIMEZONE = ZoneInfo("Europe/Budapest")


def now_in_local_timezone() -> datetime:
    """Return the current aware datetime in the Budapest timezone."""
    return datetime.now(LOCAL_TIMEZONE)


def naive_local_now() -> datetime:
    """Return the current Budapest time without timezone info for DB storage."""
    return now_in_local_timezone().replace(tzinfo=None)


def normalize_to_local_naive(value: datetime) -> datetime:
    """Convert any datetime to a naive Budapest datetime for consistent storage."""
    if value.tzinfo is None:
        return value
    return value.astimezone(LOCAL_TIMEZONE).replace(tzinfo=None)


def add_local_timezone(value: datetime) -> datetime:
    """Attach Budapest timezone info to naive datetimes or convert existing ones."""
    if value.tzinfo is None:
        return value.replace(tzinfo=LOCAL_TIMEZONE)
    return value.astimezone(LOCAL_TIMEZONE)
