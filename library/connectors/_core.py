"""Shared core of the source-builder connectors: clean-up, column typing, place matching, output.

Runs as a single file in the python runtime image (pandas, numpy, requests, openpyxl, xlrd and
the standard library only). Connectors start with `from _core import *  # core-import`; the
build drops that line and prepends this file, so nothing here may rely on the module name.
"""
import io
import json
import os
import re
import unicodedata

import pandas as pd
import requests

__all__ = [
    "normalise", "apply_cleanup", "apply_columns", "match_places", "read_places", "finish",
    "recipe_config", "UNMATCHED_LIMIT", "PREVIEW_ROWS", "http_get", "read_tabular", "fetch_table",
    "cap_rows", "process",
]

UNMATCHED_LIMIT = 50
PREVIEW_ROWS = 5000
HTTP_TIMEOUT = 60
DROPPED_WORDS = {"region", "district", "province", "county", "state", "gobolka", "degmada"}


def normalise(name):
    """Place-name key shared with the TypeScript matcher (see normalise_cases.json)."""
    text = unicodedata.normalize("NFKD", "" if name is None else str(name))
    text = "".join(ch for ch in text if not unicodedata.combining(ch)).lower()
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


def apply_columns(df, columns):
    """Keep and rename the mapped columns and cast them. Values that fail a cast become empty and
    are reported (one message each) rather than dropping the row."""
    errors = []
    out = pd.DataFrame(index=df.index)
    for spec in columns:
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


def http_get(url, **kwargs):
    """GET with a timeout; a non-2xx answer raises a clear error. Headers (which may hold secrets)
    are never printed."""
    try:
        response = requests.get(url, timeout=HTTP_TIMEOUT, **kwargs)
    except requests.RequestException as exc:
        raise RuntimeError(f"Could not reach {url}: {type(exc).__name__}") from None
    if not 200 <= response.status_code < 300:
        raise RuntimeError(f"Request to {url} failed with status {response.status_code}")
    return response


def read_tabular(data, kind, sheet=None, grid=False):
    """Read CSV or XLSX bytes as text. grid=True reads without a header row (see apply_cleanup)."""
    header = None if grid else 0
    if kind == "xlsx":
        return pd.read_excel(io.BytesIO(data), sheet_name=sheet or 0, header=header, dtype=str).fillna("")
    text = data.decode("utf-8-sig", errors="replace")
    return pd.read_csv(io.StringIO(text), header=header, dtype=str, keep_default_na=False)


def _kind_of(name, content_type=""):
    name = (name or "").lower().split("?")[0]
    content_type = (content_type or "").lower()
    if name.endswith((".xlsx", ".xlsm")) or "spreadsheetml" in content_type:
        return "xlsx"
    return "csv"


def fetch_table(url, cfg, headers=None):
    """Download a CSV or XLSX (by Content-Type or extension) and read it per the recipe config."""
    response = http_get(url, headers=headers)
    kind = _kind_of(url, response.headers.get("Content-Type", ""))
    grid = bool((cfg.get("cleanup") or {}).get("headerRow"))
    return read_tabular(response.content, kind, (cfg.get("source") or {}).get("sheet"), grid)


def cap_rows(df, cfg):
    """Preview runs read at most PREVIEW_ROWS rows."""
    return df.head(PREVIEW_ROWS) if cfg.get("mode") == "preview" else df


def process(ctx, raw):
    """Everything after reading: inspect output, clean-up, typing, places, output."""
    cfg = recipe_config(ctx)
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
    df, type_errors = apply_columns(df, cfg.get("columns") or [])
    unmatched = []
    places = cfg.get("places")
    if places:
        df, unmatched = match_places(df, places, read_places(ctx, places))
    return finish(ctx, df, ctx.definition["id"], unmatched, type_errors)
