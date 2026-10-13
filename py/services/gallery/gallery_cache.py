"""SQLite cache for the gallery: image facts, artists, LoRAs, and ratings.

The gallery is a *user-facing* dataset, not a derived index: a like/dislike is
irreplaceable and must survive a rescan, so it lives in its own database next to
the other caches rather than inside the model cache. Artists and LoRAs are
normalized into child tables so the preference statistics are a plain
``GROUP BY`` instead of a JSON scan over every row.
"""

from __future__ import annotations

import json
import logging
import os
import sqlite3
import threading
import time
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

from ...utils.cache_db import connect_cache_db
from ...utils.cache_paths import get_cache_base_dir

logger = logging.getLogger(__name__)

# A rating is one of these; anything else is rejected rather than coerced.
RATING_DISLIKED = -1
RATING_NONE = 0
RATING_LIKED = 1
VALID_RATINGS = (RATING_DISLIKED, RATING_NONE, RATING_LIKED)

_SCHEMA_STATEMENTS: Tuple[str, ...] = (
    """
    CREATE TABLE IF NOT EXISTS gallery_images (
        image_path TEXT PRIMARY KEY,
        file_name TEXT NOT NULL,
        mtime REAL NOT NULL,
        size INTEGER NOT NULL,
        width INTEGER,
        height INTEGER,
        prompt TEXT,
        negative_prompt TEXT,
        parser TEXT,
        gen_params_json TEXT,
        rating INTEGER NOT NULL DEFAULT 0,
        rated_at REAL,
        indexed_at REAL NOT NULL,
        has_metadata INTEGER NOT NULL DEFAULT 0
    )
    """,
    "CREATE INDEX IF NOT EXISTS idx_gallery_images_mtime ON gallery_images(mtime DESC)",
    "CREATE INDEX IF NOT EXISTS idx_gallery_images_rating ON gallery_images(rating)",
    """
    CREATE TABLE IF NOT EXISTS gallery_image_artists (
        image_path TEXT NOT NULL,
        artist_name TEXT NOT NULL,
        canonical_name TEXT NOT NULL,
        known INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (image_path, artist_name)
    )
    """,
    "CREATE INDEX IF NOT EXISTS idx_gallery_artists_canonical ON gallery_image_artists(canonical_name)",
    """
    CREATE TABLE IF NOT EXISTS gallery_image_loras (
        image_path TEXT NOT NULL,
        lora_name TEXT NOT NULL,
        lora_hash TEXT,
        weight REAL,
        exists_locally INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (image_path, lora_name)
    )
    """,
    "CREATE INDEX IF NOT EXISTS idx_gallery_loras_name ON gallery_image_loras(lora_name)",
    "CREATE TABLE IF NOT EXISTS gallery_meta (key TEXT PRIMARY KEY, value TEXT)",
)

# Statements that touch a column added by a migration must run *after* it.
# Creating them up front fails with "no such column" on a database that already
# exists in the older shape, which is exactly the upgrade case.
_SCHEMA_STATEMENTS_AFTER_MIGRATION: Tuple[str, ...] = (
    "CREATE INDEX IF NOT EXISTS idx_gallery_loras_hash ON gallery_image_loras(lora_hash)",
)

# Sort orders exposed to the page. The SQL fragment is fixed per key, never built
# from user input.
_SORT_SQL: Dict[str, str] = {
    "newest": "i.mtime DESC, i.image_path ASC",
    "oldest": "i.mtime ASC, i.image_path ASC",
    "rating_desc": "i.rating DESC, i.mtime DESC",
    "rating_asc": "i.rating ASC, i.mtime DESC",
    "name": "i.file_name COLLATE NOCASE ASC",
}

_RATING_FILTERS: Dict[str, str] = {
    "all": "",
    "liked": "i.rating > 0",
    "disliked": "i.rating < 0",
    "unrated": "i.rating = 0",
}

# Whether an image carries readable generation metadata. An image without any
# cannot contribute artists or a LoRA, so hiding those is how a user keeps the
# noise that upscalers and other tools drop into the output folder out of view.
_METADATA_FILTERS: Dict[str, str] = {
    "all": "",
    "with": "i.has_metadata = 1",
    "without": "i.has_metadata = 0",
}


def default_db_path() -> str:
    """Return the gallery database path, creating its directory."""
    base = get_cache_base_dir(create=True)
    directory = os.path.join(base, "gallery")
    os.makedirs(directory, exist_ok=True)
    return os.path.join(directory, "gallery.sqlite")


class GalleryCache:
    """Persistence for gallery images and their like/dislike ratings."""

    _instance: Optional["GalleryCache"] = None
    _instance_lock = threading.Lock()

    def __init__(self, db_path: Optional[str] = None) -> None:
        self.db_path = db_path or default_db_path()
        self._db_lock = threading.RLock()
        self._schema_ready = False

    @classmethod
    def get_instance(cls) -> "GalleryCache":
        if cls._instance is None:
            with cls._instance_lock:
                if cls._instance is None:
                    cls._instance = cls()
        return cls._instance

    @classmethod
    def reset_instance(cls) -> None:
        """Drop the process-wide instance. Used by tests."""
        with cls._instance_lock:
            cls._instance = None

    # ------------------------------------------------------------------ schema

    def _connect(self, readonly: bool = False) -> sqlite3.Connection:
        return connect_cache_db(
            self.db_path, readonly=readonly, row_factory=sqlite3.Row
        )

    def _ensure_schema(self) -> None:
        if self._schema_ready:
            return
        with self._db_lock:
            if self._schema_ready:
                return
            os.makedirs(os.path.dirname(self.db_path), exist_ok=True)
            with self._connect() as conn:
                for statement in _SCHEMA_STATEMENTS:
                    conn.execute(statement)
                # A gallery database created before LoRA hashes were recorded has
                # the table without that column. Add it in place rather than
                # rebuilding, and let the next rescan fill the values in: the
                # existing rows keep their ratings either way.
                columns = {
                    row["name"]
                    for row in conn.execute("PRAGMA table_info(gallery_image_loras)")
                }
                if "lora_hash" not in columns:
                    conn.execute("ALTER TABLE gallery_image_loras ADD COLUMN lora_hash TEXT")
                for statement in _SCHEMA_STATEMENTS_AFTER_MIGRATION:
                    conn.execute(statement)
                conn.commit()
            self._schema_ready = True

    # --------------------------------------------------------------- meta

    def get_meta(self, key: str, default: Optional[str] = None) -> Optional[str]:
        self._ensure_schema()
        with self._db_lock:
            conn = self._connect(readonly=True)
            try:
                row = conn.execute(
                    "SELECT value FROM gallery_meta WHERE key = ?", (key,)
                ).fetchone()
            finally:
                conn.close()
        return row["value"] if row is not None else default

    def set_meta(self, key: str, value: str) -> None:
        self._ensure_schema()
        with self._db_lock:
            with self._connect() as conn:
                conn.execute(
                    "INSERT INTO gallery_meta (key, value) VALUES (?, ?) "
                    "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                    (key, str(value)),
                )
                conn.commit()

    # ------------------------------------------------------------- indexing

    def get_indexed_facts(self) -> Dict[str, Tuple[float, int]]:
        """Return ``{image_path: (mtime, size)}`` for every indexed image."""
        self._ensure_schema()
        with self._db_lock:
            conn = self._connect(readonly=True)
            try:
                rows = conn.execute(
                    "SELECT image_path, mtime, size FROM gallery_images"
                ).fetchall()
            finally:
                conn.close()
        return {row["image_path"]: (row["mtime"], row["size"]) for row in rows}

    def count_images(self) -> int:
        self._ensure_schema()
        with self._db_lock:
            conn = self._connect(readonly=True)
            try:
                row = conn.execute("SELECT COUNT(*) AS n FROM gallery_images").fetchone()
            finally:
                conn.close()
        return int(row["n"]) if row is not None else 0

    def upsert_images(self, records: Sequence[Dict[str, Any]]) -> None:
        """Insert or refresh image rows together with their artists and LoRAs.

        A refresh keeps the existing rating: rescoring is the user's decision.
        """
        if not records:
            return
        self._ensure_schema()
        now = time.time()
        with self._db_lock:
            with self._connect() as conn:
                for record in records:
                    image_path = record["image_path"]
                    conn.execute(
                        """
                        INSERT INTO gallery_images (
                            image_path, file_name, mtime, size, width, height,
                            prompt, negative_prompt, parser, gen_params_json,
                            indexed_at, has_metadata
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                        ON CONFLICT(image_path) DO UPDATE SET
                            file_name = excluded.file_name,
                            mtime = excluded.mtime,
                            size = excluded.size,
                            width = excluded.width,
                            height = excluded.height,
                            prompt = excluded.prompt,
                            negative_prompt = excluded.negative_prompt,
                            parser = excluded.parser,
                            gen_params_json = excluded.gen_params_json,
                            indexed_at = excluded.indexed_at,
                            has_metadata = excluded.has_metadata
                        """,
                        (
                            image_path,
                            record.get("file_name") or os.path.basename(image_path),
                            float(record.get("mtime") or 0.0),
                            int(record.get("size") or 0),
                            record.get("width"),
                            record.get("height"),
                            record.get("prompt"),
                            record.get("negative_prompt"),
                            record.get("parser"),
                            json.dumps(record.get("gen_params") or {}, ensure_ascii=False),
                            now,
                            1 if record.get("has_metadata") else 0,
                        ),
                    )
                    # Replace the child rows so a re-parse cannot leave stale ones.
                    conn.execute(
                        "DELETE FROM gallery_image_artists WHERE image_path = ?",
                        (image_path,),
                    )
                    conn.execute(
                        "DELETE FROM gallery_image_loras WHERE image_path = ?",
                        (image_path,),
                    )
                    artists = record.get("artists") or []
                    if artists:
                        conn.executemany(
                            "INSERT OR REPLACE INTO gallery_image_artists "
                            "(image_path, artist_name, canonical_name, known) VALUES (?, ?, ?, ?)",
                            [
                                (
                                    image_path,
                                    artist.get("name") or artist.get("canonical") or "",
                                    artist.get("canonical") or artist.get("name") or "",
                                    1 if artist.get("known") else 0,
                                )
                                for artist in artists
                                if (artist.get("name") or artist.get("canonical"))
                            ],
                        )
                    loras = record.get("loras") or []
                    if loras:
                        conn.executemany(
                            "INSERT OR REPLACE INTO gallery_image_loras "
                            "(image_path, lora_name, lora_hash, weight, exists_locally) "
                            "VALUES (?, ?, ?, ?, ?)",
                            [
                                (
                                    image_path,
                                    lora.get("name") or "",
                                    lora.get("hash"),
                                    lora.get("weight"),
                                    1 if lora.get("exists_locally") else 0,
                                )
                                for lora in loras
                                if lora.get("name")
                            ],
                        )
                conn.commit()

    def prune_paths(self, paths: Iterable[str]) -> int:
        """Drop rows for specific images.

        Deliberately narrower than "anything this scan did not see": a scan that
        skipped subfolders (recursive off) or hit the image cap must never delete
        a rating for an image that is still on disk. Callers pass only paths they
        have confirmed are gone.
        """
        targets = [path for path in paths]
        if not targets:
            return 0
        self._ensure_schema()
        with self._db_lock:
            with self._connect() as conn:
                for path in targets:
                    conn.execute("DELETE FROM gallery_image_artists WHERE image_path = ?", (path,))
                    conn.execute("DELETE FROM gallery_image_loras WHERE image_path = ?", (path,))
                    conn.execute("DELETE FROM gallery_images WHERE image_path = ?", (path,))
                conn.commit()
        return len(targets)

    # -------------------------------------------------------------- querying

    def set_rating(self, image_path: str, rating: int) -> bool:
        """Store a rating. Returns False when the image is not indexed."""
        if rating not in VALID_RATINGS:
            raise ValueError(f"Unsupported rating: {rating}")
        self._ensure_schema()
        with self._db_lock:
            with self._connect() as conn:
                cursor = conn.execute(
                    "UPDATE gallery_images SET rating = ?, rated_at = ? WHERE image_path = ?",
                    (rating, time.time() if rating else None, image_path),
                )
                conn.commit()
                return cursor.rowcount > 0

    def _build_filters(
        self,
        rating: str,
        artist: Optional[str],
        lora: Optional[str],
        query: Optional[str],
        metadata: str = "all",
    ) -> Tuple[List[str], List[Any]]:
        clauses: List[str] = []
        params: List[Any] = []

        rating_clause = _RATING_FILTERS.get(rating, "")
        if rating_clause:
            clauses.append(rating_clause)
        metadata_clause = _METADATA_FILTERS.get(metadata, "")
        if metadata_clause:
            clauses.append(metadata_clause)
        if artist:
            clauses.append(
                "EXISTS (SELECT 1 FROM gallery_image_artists a "
                "WHERE a.image_path = i.image_path AND a.canonical_name = ?)"
            )
            params.append(artist)
        if lora:
            clauses.append(
                "EXISTS (SELECT 1 FROM gallery_image_loras l "
                "WHERE l.image_path = i.image_path AND l.lora_name = ?)"
            )
            params.append(lora)
        if query:
            like = f"%{query}%"
            clauses.append(
                "(i.file_name LIKE ? OR i.prompt LIKE ? OR i.negative_prompt LIKE ? "
                "OR EXISTS (SELECT 1 FROM gallery_image_artists a "
                "WHERE a.image_path = i.image_path AND a.canonical_name LIKE ?) "
                "OR EXISTS (SELECT 1 FROM gallery_image_loras l "
                "WHERE l.image_path = i.image_path AND l.lora_name LIKE ?))"
            )
            params.extend([like] * 5)
        return clauses, params

    def list_images(
        self,
        *,
        page: int = 1,
        page_size: int = 40,
        sort: str = "newest",
        rating: str = "all",
        artist: Optional[str] = None,
        lora: Optional[str] = None,
        query: Optional[str] = None,
        metadata: str = "all",
    ) -> Tuple[List[Dict[str, Any]], int]:
        self._ensure_schema()
        clauses, params = self._build_filters(rating, artist, lora, query, metadata)
        where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
        order = _SORT_SQL.get(sort, _SORT_SQL["newest"])
        offset = max(0, (max(1, page) - 1) * page_size)

        with self._db_lock:
            conn = self._connect(readonly=True)
            try:
                total = int(
                    conn.execute(
                        f"SELECT COUNT(*) AS n FROM gallery_images i {where}", params
                    ).fetchone()["n"]
                )
                rows = conn.execute(
                    f"SELECT i.* FROM gallery_images i {where} "
                    f"ORDER BY {order} LIMIT ? OFFSET ?",
                    (*params, page_size, offset),
                ).fetchall()
                paths = [row["image_path"] for row in rows]
                artists = self._children_by_path(
                    conn, "gallery_image_artists", paths, ("artist_name", "canonical_name", "known")
                )
                loras = self._children_by_path(
                    conn, "gallery_image_loras", paths, ("lora_name", "weight", "exists_locally", "lora_hash")
                )
            finally:
                conn.close()

        items = [
            self._row_to_image(row, artists.get(row["image_path"], []), loras.get(row["image_path"], []))
            for row in rows
        ]
        return items, total

    @staticmethod
    def _children_by_path(
        conn: sqlite3.Connection,
        table: str,
        paths: Sequence[str],
        columns: Sequence[str],
    ) -> Dict[str, List[sqlite3.Row]]:
        if not paths:
            return {}
        placeholders = ",".join("?" for _ in paths)
        selected = ", ".join(columns)
        rows = conn.execute(
            f"SELECT image_path, {selected} FROM {table} WHERE image_path IN ({placeholders})",
            list(paths),
        ).fetchall()
        grouped: Dict[str, List[sqlite3.Row]] = {}
        for row in rows:
            grouped.setdefault(row["image_path"], []).append(row)
        return grouped

    @staticmethod
    def _row_to_image(
        row: sqlite3.Row,
        artist_rows: Sequence[sqlite3.Row],
        lora_rows: Sequence[sqlite3.Row],
    ) -> Dict[str, Any]:
        try:
            gen_params = json.loads(row["gen_params_json"]) if row["gen_params_json"] else {}
        except (TypeError, ValueError):
            gen_params = {}
        return {
            "image_path": row["image_path"],
            "file_name": row["file_name"],
            "mtime": row["mtime"],
            "size": row["size"],
            "width": row["width"],
            "height": row["height"],
            "rating": row["rating"],
            "rated_at": row["rated_at"],
            "prompt": row["prompt"],
            "negative_prompt": row["negative_prompt"],
            "parser": row["parser"],
            "gen_params": gen_params,
            "has_metadata": bool(row["has_metadata"]),
            "artists": [
                {
                    "name": artist["artist_name"],
                    "canonical": artist["canonical_name"],
                    "known": bool(artist["known"]),
                }
                for artist in artist_rows
            ],
            "loras": [
                {
                    "name": lora["lora_name"],
                    "weight": lora["weight"],
                    "exists_locally": bool(lora["exists_locally"]),
                    # Resolved against the local library at scan time, so the UI
                    # can link a chip to the LoRA page. None = not resolvable.
                    "hash": lora["lora_hash"],
                }
                for lora in lora_rows
            ],
        }

    # ------------------------------------------------------------ statistics

    def _aggregate(
        self,
        table: str,
        name_column: str,
        extra_label: str = "",
        *,
        preview_limit: int = 3,
    ) -> List[Dict[str, Any]]:
        self._ensure_schema()
        label_sql = f", {extra_label}" if extra_label else ""
        group_extra = ", known" if extra_label else ""
        with self._db_lock:
            conn = self._connect(readonly=True)
            try:
                rows = conn.execute(
                    f"""
                    SELECT c.{name_column} AS key,
                           SUM(CASE WHEN i.rating > 0 THEN 1 ELSE 0 END) AS likes,
                           SUM(CASE WHEN i.rating < 0 THEN 1 ELSE 0 END) AS dislikes,
                           SUM(CASE WHEN i.rating = 0 THEN 1 ELSE 0 END) AS unrated,
                           COUNT(*) AS total
                           {label_sql}
                    FROM {table} c
                    JOIN gallery_images i ON i.image_path = c.image_path
                    GROUP BY c.{name_column}{group_extra}
                    """
                ).fetchall()
                previews = self._previews_by_key(
                    conn, table, name_column, [row["key"] for row in rows], preview_limit
                )
            finally:
                conn.close()

        items: List[Dict[str, Any]] = []
        for row in rows:
            likes = int(row["likes"] or 0)
            dislikes = int(row["dislikes"] or 0)
            rated = likes + dislikes
            entry: Dict[str, Any] = {
                "key": row["key"],
                "label": row["key"],
                "likes": likes,
                "dislikes": dislikes,
                "unrated": int(row["unrated"] or 0),
                "total": int(row["total"] or 0),
                "net": likes - dislikes,
                "like_ratio": (likes / rated) if rated else None,
                # A row without a thumbnail is hard to judge, so the ranking
                # carries the images behind the number.
                "images": previews.get(row["key"], []),
            }
            if extra_label:
                entry["known"] = bool(row["known"])
            items.append(entry)
        return items

    @staticmethod
    def _previews_by_key(
        conn: sqlite3.Connection,
        table: str,
        key_column: str,
        keys: Sequence[str],
        limit: int,
    ) -> Dict[str, List[Dict[str, Any]]]:
        """Up to *limit* representative images per ranking key.

        Liked images sort first and the newest breaks ties, so a ranking row
        shows the output the user actually approved of rather than an arbitrary
        frame. Paths are returned raw; the service turns them into URLs.
        """
        if not keys or limit <= 0:
            return {}
        placeholders = ",".join("?" for _ in keys)
        rows = conn.execute(
            f"""
            SELECT c.{key_column} AS key, i.image_path, i.rating
            FROM {table} c
            JOIN gallery_images i ON i.image_path = c.image_path
            WHERE c.{key_column} IN ({placeholders})
            ORDER BY c.{key_column}, i.rating DESC, i.mtime DESC
            """,
            list(keys),
        ).fetchall()
        grouped: Dict[str, List[Dict[str, Any]]] = {}
        for row in rows:
            bucket = grouped.setdefault(row["key"], [])
            if len(bucket) < limit:
                bucket.append({"image_path": row["image_path"], "rating": row["rating"]})
        return grouped

    @staticmethod
    def _lora_filter(
        lora_hash: Optional[str], lora_name: Optional[str]
    ) -> Tuple[str, List[Any]]:
        """``EXISTS`` clause matching a LoRA by resolved hash, raw name, or both.

        With neither, the clause is ``0`` so the query returns nothing rather
        than every image -- an empty request must not mean "all".
        """
        clauses: List[str] = []
        params: List[Any] = []
        if lora_hash:
            clauses.append("l.lora_hash = ?")
            params.append(lora_hash)
        if lora_name:
            clauses.append("l.lora_name = ?")
            params.append(lora_name)
        if not clauses:
            return ("0", [])
        joined = " OR ".join(clauses)
        return (
            "EXISTS (SELECT 1 FROM gallery_image_loras l "
            f"WHERE l.image_path = i.image_path AND ({joined}))",
            params,
        )

    def list_images_for_lora(
        self,
        *,
        lora_hash: Optional[str] = None,
        lora_name: Optional[str] = None,
        page: int = 1,
        page_size: int = 24,
    ) -> Tuple[List[Dict[str, Any]], int]:
        """Images that used one LoRA, best-rated first."""
        self._ensure_schema()
        clause, params = self._lora_filter(lora_hash, lora_name)
        offset = max(0, (max(1, page) - 1) * page_size)
        with self._db_lock:
            conn = self._connect(readonly=True)
            try:
                total = int(
                    conn.execute(
                        f"SELECT COUNT(*) AS n FROM gallery_images i WHERE {clause}", params
                    ).fetchone()["n"]
                )
                rows = conn.execute(
                    f"SELECT i.* FROM gallery_images i WHERE {clause} "
                    "ORDER BY i.rating DESC, i.mtime DESC, i.image_path ASC LIMIT ? OFFSET ?",
                    (*params, page_size, offset),
                ).fetchall()
                paths = [row["image_path"] for row in rows]
                artists = self._children_by_path(
                    conn, "gallery_image_artists", paths,
                    ("artist_name", "canonical_name", "known"),
                )
                loras = self._children_by_path(
                    conn, "gallery_image_loras", paths,
                    ("lora_name", "weight", "exists_locally", "lora_hash"),
                )
            finally:
                conn.close()
        items = [
            self._row_to_image(
                row, artists.get(row["image_path"], []), loras.get(row["image_path"], [])
            )
            for row in rows
        ]
        return items, total

    def lora_rating_summary(
        self, *, lora_hash: Optional[str] = None, lora_name: Optional[str] = None
    ) -> Dict[str, int]:
        """Like/dislike counts across the images that used one LoRA."""
        self._ensure_schema()
        clause, params = self._lora_filter(lora_hash, lora_name)
        with self._db_lock:
            conn = self._connect(readonly=True)
            try:
                row = conn.execute(
                    f"""
                    SELECT COUNT(*) AS total,
                           SUM(CASE WHEN i.rating > 0 THEN 1 ELSE 0 END) AS liked,
                           SUM(CASE WHEN i.rating < 0 THEN 1 ELSE 0 END) AS disliked
                    FROM gallery_images i WHERE {clause}
                    """,
                    params,
                ).fetchone()
            finally:
                conn.close()
        total = int(row["total"] or 0)
        liked = int(row["liked"] or 0)
        disliked = int(row["disliked"] or 0)
        return {
            "total": total,
            "liked": liked,
            "disliked": disliked,
            "unrated": total - liked - disliked,
            "net": liked - disliked,
        }

    def stats_by_artist(self) -> List[Dict[str, Any]]:
        """Per-artist like/dislike counts, grouped by canonical artist name."""
        return self._aggregate(
            "gallery_image_artists", "canonical_name", extra_label="MAX(c.known) AS known"
        )

    def stats_by_lora(self) -> List[Dict[str, Any]]:
        """Per-LoRA like/dislike counts."""
        return self._aggregate("gallery_image_loras", "lora_name")

    def rating_totals(self) -> Dict[str, int]:
        self._ensure_schema()
        with self._db_lock:
            conn = self._connect(readonly=True)
            try:
                row = conn.execute(
                    """
                    SELECT COUNT(*) AS images,
                           SUM(CASE WHEN rating > 0 THEN 1 ELSE 0 END) AS liked,
                           SUM(CASE WHEN rating < 0 THEN 1 ELSE 0 END) AS disliked
                    FROM gallery_images
                    """
                ).fetchone()
            finally:
                conn.close()
        liked = int(row["liked"] or 0)
        disliked = int(row["disliked"] or 0)
        return {
            "images": int(row["images"] or 0),
            "liked": liked,
            "disliked": disliked,
            "rated": liked + disliked,
        }
