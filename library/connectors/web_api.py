from _core import *  # core-import
import pandas as pd

MAX_PAGES = 200


def _dig(value, path):
    for key in [k for k in (path or "").split(".") if k]:
        value = value.get(key) if isinstance(value, dict) else None
    return value


def _records(body, path):
    items = _dig(body, path) if path else body
    if items is None:
        raise ValueError(f"Records path '{path}' not found in the response")
    if not isinstance(items, list):
        where = f"at '{path}'" if path else "in the response"
        raise ValueError(f"Expected a list of records {where}, found {type(items).__name__}")
    return items


def run(ctx):
    cfg = recipe_config(ctx)
    source = cfg["source"]
    keyed = source.get("auth") == "key"
    headers = {}
    if keyed:
        header = source.get("keyHeader") or "Authorization"
        key = ctx.secrets["api_key"]
        headers[header] = f"Bearer {key}" if header.lower() == "authorization" else key
    paging = source.get("paging") or {"type": "none"}
    url, params = source["url"], {}
    home = url
    if paging["type"] == "page":
        page = int(paging.get("start", 1))
        params[paging.get("param", "page")] = page
    limit = row_limit(cfg)
    records = []
    for _ in range(MAX_PAGES):
        response = http_get(url, same_host_only=bool(headers) and same_origin(url, home),
                            headers=headers, params=params or None)
        body = http_json(response)
        items = _records(body, source.get("recordsPath"))
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
            if keyed and not same_origin(url, home):
                headers = {}  # never send the key to another host or over a different scheme
        else:
            break
        if limit and len(records) >= limit:
            break
    return process(ctx, pd.json_normalize(records).astype(object))
