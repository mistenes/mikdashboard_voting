import hashlib
import os
from typing import Tuple


def hash_password(password: str, *, salt: str | None = None) -> Tuple[str, str]:
    if salt is None:
        salt = os.urandom(16).hex()
    digest = hashlib.sha256(f"{salt}:{password}".encode()).hexdigest()
    return salt, digest


def verify_password(password: str, salt: str, stored_hash: str) -> bool:
    _, digest = hash_password(password, salt=salt)
    return digest == stored_hash
