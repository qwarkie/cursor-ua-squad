# db.py — SQLite through the standard library: one file on disk, no service to start, no ORM,
# no migrations. `sqlite3` ships with Python, so there is nothing to pip install.
# CHANGE: SCHEMA if the demo needs a second table; DB_PATH (or the STORE_DB_PATH env var) to move the file.

from __future__ import annotations

import json
import os
import sqlite3
from collections.abc import Callable, Iterator, Sequence
from contextlib import contextmanager
from pathlib import Path
from typing import Any, TypeVar

BACKEND_DIR = Path(__file__).resolve().parent
DB_PATH = Path(os.environ.get("STORE_DB_PATH") or BACKEND_DIR / "data" / "store.db")

T = TypeVar("T")

# One table, one JSON payload column. `collection` is the poor man's table name, so a team
# stores notes, players and settings without designing three schemas under the clock.
SCHEMA = """
CREATE TABLE IF NOT EXISTS items (
    id          TEXT PRIMARY KEY,
    collection  TEXT NOT NULL,
    payload     TEXT NOT NULL,
    created_at  REAL NOT NULL,
    updated_at  REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS items_collection_idx ON items (collection, created_at DESC);
"""


class StoreDBError(Exception):
    """The one named failure this layer raises. It is never swallowed and never returns [] instead."""

    code = "store_db_error"
    http_status = 500

    def __init__(self, message: str, hint: str) -> None:
        super().__init__(message)
        self.message = message
        self.hint = hint

    def as_detail(self) -> dict[str, str]:
        return {"error": self.code, "message": self.message, "hint": self.hint}


@contextmanager
def connect() -> Iterator[sqlite3.Connection]:
    """A fresh connection per call. FastAPI runs sync endpoints in a threadpool and a sqlite3
    connection belongs to the thread that opened it, so sharing one is how you get
    'SQLite objects created in a thread can only be used in that same thread'."""
    try:
        DB_PATH.parent.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(DB_PATH, timeout=5.0)
    except (OSError, sqlite3.Error) as exc:
        raise StoreDBError(
            f"Could not open the database at {DB_PATH}: {exc}",
            "Check that backend/ is writable, or point STORE_DB_PATH somewhere that is.",
        ) from exc

    conn.row_factory = sqlite3.Row
    try:
        # WAL lets a read run while a write is in flight — with several phones on the LAN
        # hitting the same endpoint, the default rollback journal serialises everything.
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA busy_timeout=5000")
        yield conn
        conn.commit()
    except sqlite3.Error as exc:
        conn.rollback()
        raise StoreDBError(
            f"SQLite rejected the statement: {exc}",
            "Read the message — it names the column or constraint. If the table shape changed, delete the .db file and let init_db() rebuild it.",
        ) from exc
    finally:
        conn.close()


def init_db() -> None:
    """Create the tables if they are absent. Safe to call on every boot; call it once at startup."""
    with connect() as conn:
        conn.executescript(SCHEMA)


def query(sql: str, params: Sequence[Any], row_to: Callable[[sqlite3.Row], T]) -> list[T]:
    """Rows in, your typed objects out. `row_to` is the only place a column name meets a field name."""
    with connect() as conn:
        return [row_to(row) for row in conn.execute(sql, params).fetchall()]


def query_one(sql: str, params: Sequence[Any], row_to: Callable[[sqlite3.Row], T]) -> T | None:
    """None means 'no such row' — the caller turns that into a 404. It never means 'something broke'."""
    with connect() as conn:
        row = conn.execute(sql, params).fetchone()
    return row_to(row) if row is not None else None


def execute(sql: str, params: Sequence[Any]) -> int:
    """INSERT / UPDATE / DELETE. Returns rowcount so the caller can tell a real delete from a no-op."""
    with connect() as conn:
        return conn.execute(sql, params).rowcount


def dump_payload(payload: Any) -> str:
    try:
        return json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    except (TypeError, ValueError) as exc:
        raise StoreDBError(
            f"The payload is not JSON-serialisable: {exc}",
            "Send plain JSON — objects, arrays, strings, numbers, booleans and null.",
        ) from exc


def load_payload(raw: str, item_id: str) -> Any:
    """A corrupt row raises. Returning {} here would hand the UI an empty object it would render as real."""
    try:
        return json.loads(raw)
    except json.JSONDecodeError as exc:
        raise StoreDBError(
            f"Row {item_id} holds a payload that is no longer valid JSON: {exc}",
            f"Something wrote to the table directly. Delete that row: DELETE FROM items WHERE id = '{item_id}';",
        ) from exc
