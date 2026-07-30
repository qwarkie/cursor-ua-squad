# store_router.py — POST/GET/DELETE /api/items over one table with a JSON payload column,
# so a team gets server-side persistence without designing a schema.
# COPY: into backend/ next to db.py, then `app.include_router(store_router)` in main.py.
# CHANGE: MAX_PAYLOAD_BYTES, and the default page size on GET /api/items.

from __future__ import annotations

import sqlite3
import time
from uuid import uuid4

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field, JsonValue

try:  # works whether backend/ is imported as a package or run flat by uvicorn
    from . import db
    from .db import StoreDBError, init_db
except ImportError:  # pragma: no cover - depends on how the team launches uvicorn
    import db  # type: ignore[no-redef]
    from db import StoreDBError, init_db  # type: ignore[no-redef]

# 256 KB of JSON per row. Bigger than that is a file, and a file belongs on disk or in the model call.
MAX_PAYLOAD_BYTES = 256 * 1024

NAME = r"^[A-Za-z0-9_.:-]+$"

router = APIRouter(prefix="/api", tags=["store"])

# Creating the table is idempotent and takes a millisecond, so it happens at import: the team's
# single `app.include_router(store_router)` is genuinely all the wiring there is.
init_db()


class Item(BaseModel):
    id: str
    collection: str
    payload: JsonValue
    created_at: float = Field(description="Unix seconds, set on first insert and never touched again.")
    updated_at: float


class ItemCreate(BaseModel):
    collection: str = Field(min_length=1, max_length=64, pattern=NAME, description="Namespace, e.g. 'notes'.")
    payload: JsonValue = Field(description="Any JSON value. Stored verbatim, returned verbatim.")
    id: str | None = Field(default=None, min_length=1, max_length=64, pattern=NAME, description="Pass an existing id to overwrite that row.")


class ItemList(BaseModel):
    collection: str
    count: int
    items: list[Item]


class DeleteResult(BaseModel):
    deleted: int


def _row_to_item(row: sqlite3.Row) -> Item:
    return Item(
        id=row["id"],
        collection=row["collection"],
        payload=db.load_payload(row["payload"], row["id"]),
        created_at=row["created_at"],
        updated_at=row["updated_at"],
    )


def _http(exc: StoreDBError) -> HTTPException:
    """Every database failure reaches the client as {error, message, hint} — never as an empty list."""
    return HTTPException(status_code=exc.http_status, detail=exc.as_detail())


def _encode(payload: JsonValue) -> str:
    try:
        raw = db.dump_payload(payload)
    except StoreDBError as exc:
        raise _http(exc) from exc
    size = len(raw.encode("utf-8"))
    if size > MAX_PAYLOAD_BYTES:
        raise HTTPException(
            status_code=413,
            detail={
                "error": "payload_too_large",
                "message": f"The payload is {size} bytes, the limit is {MAX_PAYLOAD_BYTES}.",
                "hint": "Split it across rows, or raise MAX_PAYLOAD_BYTES in store_router.py.",
            },
        )
    return raw


@router.post("/items", response_model=Item)
def create_item(body: ItemCreate) -> Item:
    """Create a row, or overwrite one when `id` is supplied. `created_at` survives an overwrite."""
    raw = _encode(body.payload)
    now = time.time()
    item_id = body.id or uuid4().hex
    try:
        db.execute(
            "INSERT INTO items (id, collection, payload, created_at, updated_at) VALUES (?, ?, ?, ?, ?) "
            "ON CONFLICT(id) DO UPDATE SET collection = excluded.collection, "
            "payload = excluded.payload, updated_at = excluded.updated_at",
            (item_id, body.collection, raw, now, now),
        )
        stored = db.query_one("SELECT * FROM items WHERE id = ?", (item_id,), _row_to_item)
    except StoreDBError as exc:
        raise _http(exc) from exc
    if stored is None:
        # The insert reported success and the row is not there. Say so instead of echoing the request back.
        raise HTTPException(
            status_code=500,
            detail={
                "error": "write_not_visible",
                "message": f"Item {item_id} was written but could not be read back.",
                "hint": "The database file was replaced or deleted while the server was running. Restart the backend.",
            },
        )
    return stored


@router.get("/items", response_model=ItemList)
def list_items(
    collection: str = Query(min_length=1, max_length=64, pattern=NAME),
    limit: int = Query(default=100, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
) -> ItemList:
    """Newest first. `collection` is required on purpose — nothing here dumps the whole table."""
    try:
        items = db.query(
            "SELECT * FROM items WHERE collection = ? ORDER BY created_at DESC LIMIT ? OFFSET ?",
            (collection, limit, offset),
            _row_to_item,
        )
    except StoreDBError as exc:
        raise _http(exc) from exc
    return ItemList(collection=collection, count=len(items), items=items)


@router.get("/items/{item_id}", response_model=Item)
def get_item(item_id: str) -> Item:
    try:
        item = db.query_one("SELECT * FROM items WHERE id = ?", (item_id,), _row_to_item)
    except StoreDBError as exc:
        raise _http(exc) from exc
    if item is None:
        raise HTTPException(
            status_code=404,
            detail={"error": "not_found", "message": f"No item with id {item_id}.", "hint": "List the collection first; ids are returned by POST /api/items."},
        )
    return item


@router.delete("/items/{item_id}", response_model=DeleteResult)
def delete_item(item_id: str) -> DeleteResult:
    """404 when the row was already gone — a delete that did nothing must not report success."""
    try:
        deleted = db.execute("DELETE FROM items WHERE id = ?", (item_id,))
    except StoreDBError as exc:
        raise _http(exc) from exc
    if deleted == 0:
        raise HTTPException(
            status_code=404,
            detail={"error": "not_found", "message": f"No item with id {item_id}.", "hint": "It was already deleted, or the id came from a different database file."},
        )
    return DeleteResult(deleted=deleted)


@router.delete("/items", response_model=DeleteResult)
def clear_collection(collection: str = Query(min_length=1, max_length=64, pattern=NAME)) -> DeleteResult:
    """Empties one collection. `collection` is required, so there is no request that wipes everything."""
    try:
        return DeleteResult(deleted=db.execute("DELETE FROM items WHERE collection = ?", (collection,)))
    except StoreDBError as exc:
        raise _http(exc) from exc
