from _core import *  # core-import
import pandas as pd


MAX_PAGES = 200


def _dig(value, path):
    for key in [k for k in (path or "").split(".") if k]:
        value = value.get(key) if isinstance(value, dict) else None
    return value


def run(ctx):
    cfg = recipe_config(ctx)
    source = cfg["source"]
    headers = {}
    if source.get("auth") == "key":
        header = source.get("keyHeader") or "Authorization"
        key = ctx.secrets["api_key"]
        headers[header] = f"Bearer {key}" if header.lower() == "authorization" else key
    paging = source.get("paging") or {"type": "none"}
    url, params = source["url"], {}
    if paging["type"] == "page":
        page = int(paging.get("start", 1))
        params[paging.get("param", "page")] = page
    limit = PREVIEW_ROWS if cfg.get("mode") == "preview" else None
    records = []
    for _ in range(MAX_PAGES):
        body = http_get(url, headers=headers, params=params or None).json()
        items = _dig(body, source.get("recordsPath")) if source.get("recordsPath") else body
        if isinstance(items, dict):
            items = [items]
        if not items:
            break
        records.extend(items)
        if paging["type"] == "page":
            page += 1
            params = {paging.get("param", "page"): page}
        elif paging["type"] == "next":
            url, params = _dig(body, paging.get("path", "links.next")), {}
            if not url:
                break
        else:
            break
        if limit and len(records) >= limit:
            break
    return process(ctx, pd.json_normalize(records).astype(object))
