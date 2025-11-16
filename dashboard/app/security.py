from __future__ import annotations

import hashlib
import hmac
import os
from dataclasses import dataclass


PBKDF2_ITERATIONS = 200_000
PBKDF2_SALT_BYTES = 16
PBKDF2_SCHEME = "pbkdf2_sha256"


@dataclass(frozen=True)
class PasswordCheckResult:
    is_valid: bool
    needs_rehash: bool
    scheme: str


def _hash_pbkdf2(password: str, *, salt_hex: str, iterations: int) -> str:
    derived = hashlib.pbkdf2_hmac(
        "sha256", password.encode("utf-8"), bytes.fromhex(salt_hex), iterations
    )
    return derived.hex()


def _format_pbkdf2_salt(salt_hex: str, iterations: int) -> str:
    return f"{PBKDF2_SCHEME}${iterations}${salt_hex}"


def _parse_pbkdf2_salt(salt: str) -> tuple[str, int] | None:
    if not salt.startswith(f"{PBKDF2_SCHEME}$"):
        return None
    try:
        _, iteration_text, salt_hex = salt.split("$", 2)
        iterations = int(iteration_text)
        # Validate hex input defensively
        bytes.fromhex(salt_hex)
        return salt_hex, iterations
    except Exception:
        return None


def hash_password(password: str, *, salt: str | None = None) -> tuple[str, str]:
    parsed = _parse_pbkdf2_salt(salt) if salt else None
    if parsed is None:
        salt_hex = os.urandom(PBKDF2_SALT_BYTES).hex()
        iterations = PBKDF2_ITERATIONS
    else:
        salt_hex, iterations = parsed
    digest = _hash_pbkdf2(password, salt_hex=salt_hex, iterations=iterations)
    formatted_salt = _format_pbkdf2_salt(salt_hex, iterations)
    return formatted_salt, digest


def verify_password(password: str, salt: str, stored_hash: str) -> PasswordCheckResult:
    parsed = _parse_pbkdf2_salt(salt)
    if parsed is not None:
        salt_hex, iterations = parsed
        digest = _hash_pbkdf2(password, salt_hex=salt_hex, iterations=iterations)
        return PasswordCheckResult(
            is_valid=hmac.compare_digest(digest, stored_hash),
            needs_rehash=iterations < PBKDF2_ITERATIONS,
            scheme=PBKDF2_SCHEME,
        )

    legacy_digest = hashlib.sha256(f"{salt}:{password}".encode()).hexdigest()
    is_valid = hmac.compare_digest(legacy_digest, stored_hash)
    return PasswordCheckResult(
        is_valid=is_valid,
        needs_rehash=is_valid,
        scheme="legacy_sha256",
    )
