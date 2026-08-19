"""Minimal PostgREST client.

The worker talks to Supabase with the service role key, which bypasses RLS.
That key never reaches the browser: it lives in GitHub Actions secrets and is
read from the environment here. See docs/SETUP.md.
"""

from __future__ import annotations

import os
from typing import Any

import httpx

DEFAULT_TIMEOUT = 30.0


class SupabaseError(RuntimeError):
    pass


class Supabase:
    def __init__(self, url: str | None = None, key: str | None = None) -> None:
        self.url = (url or os.environ.get("SUPABASE_URL", "")).rstrip("/")
        self.key = key or os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
        if not self.url or not self.key:
            raise SupabaseError(
                "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must both be set. "
                "See docs/SETUP.md for where these go."
            )
        self._client = httpx.Client(
            base_url=f"{self.url}/rest/v1",
            headers={
                "apikey": self.key,
                "Authorization": f"Bearer {self.key}",
                "Content-Type": "application/json",
            },
            timeout=DEFAULT_TIMEOUT,
        )

    def __enter__(self) -> "Supabase":
        return self

    def __exit__(self, *_exc: object) -> None:
        self._client.close()

    def _check(self, response: httpx.Response) -> Any:
        if response.status_code >= 400:
            raise SupabaseError(
                f"{response.request.method} {response.request.url.path} "
                f"failed with {response.status_code}: {response.text[:500]}"
            )
        if not response.content or response.status_code == 204:
            return None
        return response.json()

    def select(self, table: str, columns: str = "*", **filters: str) -> list[dict[str, Any]]:
        params = {"select": columns, **filters}
        return self._check(self._client.get(f"/{table}", params=params)) or []

    def insert(self, table: str, rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
        if not rows:
            return []
        out: list[dict[str, Any]] = []
        # PostgREST payloads are capped in practice; a week of assignments is
        # small but chunking keeps a bigger horizon from failing silently.
        for start in range(0, len(rows), 500):
            chunk = rows[start:start + 500]
            response = self._client.post(
                f"/{table}", json=chunk, headers={"Prefer": "return=representation"}
            )
            out.extend(self._check(response) or [])
        return out

    def update(self, table: str, values: dict[str, Any], **filters: str) -> list[dict[str, Any]]:
        response = self._client.patch(
            f"/{table}", params=filters, json=values,
            headers={"Prefer": "return=representation"},
        )
        return self._check(response) or []

    def rpc(self, name: str, payload: dict[str, Any] | None = None) -> Any:
        response = self._client.post(f"/rpc/{name}", json=payload or {})
        return self._check(response)
