import logging
import os
from contextlib import contextmanager
from typing import Dict, Iterator

from sqlalchemy import create_engine
from sqlalchemy.orm import declarative_base, sessionmaker, Session


logger = logging.getLogger(__name__)


def _database_url() -> str:
    url = os.getenv("DATABASE_URL")
    if not url:
        url = "sqlite:///./app.db"
        logger.warning(
            "DATABASE_URL nem volt beállítva, a fejlesztői SQLite adatbázist használjuk (%s)",
            url,
        )
    if url.startswith("postgres://"):
        url = url.replace("postgres://", "postgresql+psycopg://", 1)
    elif url.startswith("postgresql://"):
        url = url.replace("postgresql://", "postgresql+psycopg://", 1)
    return url


DATABASE_URL = _database_url()


def _engine_kwargs() -> Dict[str, object]:
    kwargs: Dict[str, object] = {"future": True, "echo": False}
    if DATABASE_URL.startswith("sqlite"):
        kwargs["connect_args"] = {"check_same_thread": False}
    return kwargs


engine = create_engine(DATABASE_URL, **_engine_kwargs())
SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False, future=True)

Base = declarative_base()


@contextmanager
def session_scope() -> Iterator[Session]:
    session = SessionLocal()
    try:
        yield session
        session.commit()
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()
