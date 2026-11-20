"""Shared core of the source-builder connectors: clean-up, column typing, place matching, output.

Runs as a single file in the python runtime image (pandas, numpy, geopandas, requests, openpyxl,
xlrd and the standard library only). Connectors start with `from _core import *  # core-import`; the
build drops that line and prepends this file, so nothing here may rely on the module name.
"""
import io
import json
import os
import re
from urllib.parse import urlparse
import unicodedata

import pandas as pd
import requests

__all__ = [
    "normalise", "apply_cleanup", "apply_columns", "match_places", "read_places", "finish",
    "recipe_config", "UNMATCHED_LIMIT", "PREVIEW_ROWS", "http_get", "read_tabular", "fetch_table",
    "cap_rows", "process", "unpivot_columns", "table_kind", "http_json", "row_limit", "same_origin",
]

UNMATCHED_LIMIT = 50
PREVIEW_ROWS = 5000
HTTP_TIMEOUT = 60
DROPPED_WORDS = {"region", "district", "province", "county", "state", "gobolka", "degmada"}


def normalise(name):
    """Place-name key shared with the TypeScript matcher (see normalise_cases.json)."""
    text = unicodedata.normalize("NFKD", "" if name is None else str(name))
    text = "".join(ch for ch in text if not unicodedata.category(ch).startswith("M")).lower()
    text = re.sub(r"[^a-z0-9]+", " ", text)
    return " ".join(w for w in text.split() if w not in DROPPED_WORDS)


def recipe_config(ctx):
    return ((ctx.definition or {}).get("recipe") or {}).get("config") or {}


def _blank(value):
    return value is None or (not isinstance(value, str) and pd.isna(value)) or str(value).strip() == ""


def _as_text(series):
    return series.map(lambda v: "" if _blank(v) else str(v).strip())


def apply_cleanup(df, cleanup):
    """skipRows drops that many leading rows. headerRow (1-based, counted after skipRows) makes
    that row the column names and drops it and everything above; when it is set, `df` must be a
    raw grid read without a header. Then filters, then unpivot."""
    cleanup = cleanup or {}
    df = df.copy()
    skip = int(cleanup.get("skipRows") or 0)
    if skip:
        df = df.iloc[skip:]
    header_row = cleanup.get("headerRow")
    if header_row:
        index = int(header_row) - 1
        if index >= len(df):
            raise ValueError(f"Header row {header_row} is beyond the {len(df)} rows available")
        names = ["" if _blank(v) else str(v).strip() for v in df.iloc[index]]
        df = df.iloc[index + 1:]
        df.columns = names
    df = df.reset_index(drop=True)

    for f in cleanup.get("filters") or []:
        column = f["column"]
        if column not in df.columns:
            raise ValueError(f"Filter column not found: {column}")
        cells = _as_text(df[column]).str.lower()
        wanted = str(f.get("value", "")).strip().lower()
        if f["op"] == "equals":
            mask = cells == wanted
        elif f["op"] == "contains":
            mask = cells.str.contains(wanted, regex=False)
        else:
            raise ValueError(f"Unknown filter operation: {f['op']}")
        df = df[mask]
    df = df.reset_index(drop=True)

    unpivot = cleanup.get("unpivot")
    if unpivot:
        wide = [c for c in unpivot["columns"] if c in df.columns]
        if not wide:
            raise ValueError("None of the unpivot columns were found")
        keep = [c for c in df.columns if c not in wide]
        df = df.melt(id_vars=keep, value_vars=wide,
                     var_name=unpivot["dateColumnId"], value_name=unpivot["valueColumnId"])
        df = df.reset_index(drop=True)
    return df


def unpivot_columns(cleanup):
    """The two columns an unpivot creates, as column specs (already named, so from == id)."""
    unpivot = (cleanup or {}).get("unpivot")
    if not unpivot:
        return []
    return [{"from": unpivot["dateColumnId"], "id": unpivot["dateColumnId"], "type": "date"},
            {"from": unpivot["valueColumnId"], "id": unpivot["valueColumnId"], "type": "number"}]


def apply_columns(df, columns, extra=()):
    """Keep and rename the mapped columns and cast them. Values that fail a cast become empty and
    are reported (one message each) rather than dropping the row. `extra` are further specs
    appended after `columns` (the date and value columns an unpivot creates)."""
    errors = []
    out = pd.DataFrame(index=df.index)
    for spec in list(columns) + list(extra):
        source, target, kind = spec["from"], spec["id"], spec.get("type", "text")
        if source not in df.columns:
            raise ValueError(f"Column not found in the source: {source}")
        series = df[source]
        blank = series.map(_blank)
        if kind == "number":
            cleaned = series.map(lambda v: v if not isinstance(v, str) else v.strip().replace(",", ""))
            values = pd.to_numeric(cleaned.where(~blank), errors="coerce")
            if len(values) and values.dropna().map(lambda x: float(x).is_integer()).all() and values.notna().any():
                values = values.astype("Int64")
            bad = values.isna() & ~blank
        elif kind == "date":
            parsed = pd.to_datetime(series.where(~blank), errors="coerce")
            values = parsed.dt.strftime("%Y-%m-%d").where(parsed.notna(), "")
            bad = parsed.isna() & ~blank
        else:
            values = _as_text(series)
            bad = pd.Series(False, index=series.index)
        for pos in series.index[bad]:
            errors.append(f"{target}: '{series[pos]}' is not a valid {kind} (row {int(pos) + 1})")
        out[target] = values
    return out.reset_index(drop=True), errors


def match_places(df, places, place_rows):
    """Add `<column>_code`. Saved matches (exact original name) win, then a normalised-exact match
    against the places table, else an empty code. Unmatched rows are kept. Returns the frame and
    the distinct unmatched names in order of first appearance."""
    column = places["column"]
    saved = places.get("matches") or {}
    index, ambiguous = {}, set()
    for row in place_rows:
        key = normalise(row["name"])
        if not key:
            continue
        if key in index and index[key] != row["code"]:
            ambiguous.add(key)
        index.setdefault(key, row["code"])
    unmatched = []

    def lookup(name):
        if _blank(name):
            return ""
        name = str(name)
        if name in saved:
            return saved[name]
        key = normalise(name)
        if key in index and key not in ambiguous:
            return index[key]
        if name not in unmatched:
            unmatched.append(name)
        return ""

    df = df.copy()
    df[f"{column}_code"] = [lookup(v) for v in df[column]]
    return df, unmatched


def read_places(ctx, places):
    """Rows of the declared `places` table input, as [{"name", "code"}]."""
    with open(os.path.join(ctx.in_dir, "manifest.json"), encoding="utf-8") as f:
        manifest = json.load(f)
    entry = (manifest.get("inputs") or {}).get("places")
    if not entry or entry.get("kind") != "table":
        raise ValueError("The places table input is missing from the run inputs")
    path = os.path.join(ctx.in_dir, entry["path"])
    fmt = entry.get("format")
    if fmt == "csv":
        frame = pd.read_csv(path, dtype=str, keep_default_na=False)
    elif fmt == "json":
        with open(path, encoding="utf-8") as f:
            frame = pd.DataFrame(json.load(f)).astype(str)
    elif fmt == "gpkg":
        import geopandas  # in the runtime image; the extract's layer is named after the input id
        frame = pd.DataFrame(geopandas.read_file(path, layer="places")).astype(str)
    else:
        raise ValueError(f"Unsupported places format: {fmt}")
    name_col, code_col = places["nameColumn"], places["codeColumn"]
    for needed in (name_col, code_col):
        if needed not in frame.columns:
            raise ValueError(f"Places table has no column {needed}")
    return [{"name": n, "code": c} for n, c in zip(frame[name_col], frame[code_col])]


def finish(ctx, df, table_id, unmatched, type_errors):
    """Write <table_id>.csv and return the run result with counts in state."""
    os.makedirs(ctx.out_dir, exist_ok=True)
    path = f"{table_id}.csv"
    df.to_csv(os.path.join(ctx.out_dir, path), index=False)
    first = list(unmatched[:UNMATCHED_LIMIT])
    print(f"Wrote {len(df)} rows to {path}")
    print(f"Unmatched places: {len(unmatched)}" + (f" (first {len(first)}: {first})" if first else ""))
    print(f"Type errors: {len(type_errors)}")
    for message in type_errors[:UNMATCHED_LIMIT]:
        print(f"  {message}")
    return {
        "tables": [{"tableId": table_id, "path": path, "format": "csv"}],
        "state": {
            "rows": int(len(df)),
            "unmatchedCount": len(unmatched),
            "unmatchedPlaces": first,
            "typeErrorCount": len(type_errors),
        },
    }


def _safe_url(url):
    """The URL without its query string or fragment, for messages (they may carry keys)."""
    parts = urlparse(str(url))
    return f"{parts.scheme}://{parts.netloc}{parts.path}"


def _origin(url):
    """(scheme, host:port) of a URL: a key goes only to the exact origin it was meant for."""
    parts = urlparse(str(url))
    return (parts.scheme.lower(), parts.netloc.lower())


def same_origin(a, b):
    """True when two URLs share scheme, host and port."""
    return _origin(a) == _origin(b)


def http_get(url, same_host_only=False, **kwargs):
    """GET with a timeout; a non-2xx answer raises a clear error. Headers (which may hold secrets)
    are never printed. With same_host_only (keyed requests) redirects are followed by hand and one
    to another host or scheme (https to http) fails, so a key is never sent elsewhere or in clear."""
    def fetch(target):
        try:
            if same_host_only:
                return requests.get(target, timeout=HTTP_TIMEOUT, allow_redirects=False, **kwargs)
            return requests.get(target, timeout=HTTP_TIMEOUT, **kwargs)
        except requests.RequestException as exc:
            raise RuntimeError(f"Could not reach {_safe_url(target)}: {type(exc).__name__}") from None

    current = url
    response = fetch(current)
    hops = 0
    while same_host_only and response.status_code in (301, 302, 303, 307, 308):
        location = response.headers.get("Location")
        if not location or hops >= 5:
            raise RuntimeError(f"Too many redirects from {_safe_url(url)}")
        target = requests.compat.urljoin(current, location)
        if _origin(target) != _origin(url):
            raise RuntimeError(
                f"{_safe_url(url)} redirected to another host or scheme "
                f"({urlparse(target).scheme}://{urlparse(target).netloc}); the API key was not sent there")
        current, hops = target, hops + 1
        response = fetch(current)
    if not 200 <= response.status_code < 300:
        raise RuntimeError(f"Request to {_safe_url(current)} failed with status {response.status_code}")
    return response


def http_json(response):
    """The JSON body, or a clear error when the source did not return JSON."""
    try:
        return response.json()
    except ValueError:
        kind = response.headers.get("Content-Type", "unknown")
        raise RuntimeError(f"The source did not return JSON (status {response.status_code}, content type {kind})") from None


def row_limit(cfg):
    """Preview and inspect runs read at most PREVIEW_ROWS rows; a normal run is unlimited."""
    return PREVIEW_ROWS if cfg.get("mode") in ("preview", "inspect") else None


def read_tabular(data, kind, sheet=None, grid=False):
    """Read CSV or XLSX bytes as text. grid=True reads without a header row (see apply_cleanup)."""
    header = None if grid else 0
    if kind in ("xlsx", "xls"):
        return pd.read_excel(io.BytesIO(data), sheet_name=sheet or 0, header=header, dtype=str).fillna("")
    text = data.decode("utf-8-sig", errors="replace")
    return pd.read_csv(io.StringIO(text), header=header, dtype=str, keep_default_na=False)


def table_kind(name, content_type="", fmt=""):
    """csv, xlsx or xls: the declared format first, then the Content-Type, then the extension."""
    fmt = (fmt or "").lower().strip(". ")
    if fmt in ("csv", "xlsx", "xls"):
        return fmt
    content_type = (content_type or "").lower()
    name = (name or "").lower().split("?")[0]
    if "spreadsheetml" in content_type:
        return "xlsx"
    if "ms-excel" in content_type:
        return "xls"
    if name.endswith((".xlsx", ".xlsm")):
        return "xlsx"
    if name.endswith(".xls"):
        return "xls"
    return "csv"


def fetch_table(url, cfg, headers=None, fmt=""):
    """Download a CSV or Excel file and read it per the recipe config."""
    response = http_get(url, headers=headers)
    kind = table_kind(url, response.headers.get("Content-Type", ""), fmt)
    grid = bool((cfg.get("cleanup") or {}).get("headerRow"))
    return read_tabular(response.content, kind, (cfg.get("source") or {}).get("sheet"), grid)


def cap_rows(df, cfg):
    """Preview runs read at most PREVIEW_ROWS rows."""
    limit = row_limit(cfg)
    return df.head(limit) if limit else df


def process(ctx, raw):
    """Everything after reading: inspect output, clean-up, typing, places, output."""
    cfg = recipe_config(ctx)
    extra = unpivot_columns(cfg.get("cleanup"))
    wanted = [c["from"] for c in (cfg.get("columns") or []) + extra]
    if len(raw) == 0:
        # An empty source gives an empty table with every declared column, not a failure
        print("No rows in the source")
        df = pd.DataFrame(columns=list(dict.fromkeys(list(raw.columns) + wanted)))
    else:
        df = apply_cleanup(cap_rows(raw, cfg), cfg.get("cleanup"))
    if cfg.get("mode") == "inspect":
        os.makedirs(ctx.out_dir, exist_ok=True)
        columns = []
        for name in df.columns:
            sample = [v for v in df[name].tolist() if not _blank(v)][:5]
            columns.append({"name": str(name), "sample": [v if isinstance(v, (int, float, bool)) else str(v) for v in sample]})
        with open(os.path.join(ctx.out_dir, "inspect.json"), "w", encoding="utf-8") as f:
            json.dump({"columns": columns, "rows": int(len(df))}, f)
        return {"tables": [], "state": {}}
    df, type_errors = apply_columns(df, cfg.get("columns") or [], extra)
    unmatched = []
    places = cfg.get("places")
    if places:
        df, unmatched = match_places(df, places, read_places(ctx, places))
    return finish(ctx, df, ctx.definition["id"], unmatched, type_errors)
