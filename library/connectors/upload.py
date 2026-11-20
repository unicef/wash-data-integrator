from _core import *  # core-import
import json
import os


def run(ctx):
    cfg = recipe_config(ctx)
    with open(os.path.join(ctx.in_dir, "manifest.json"), encoding="utf-8") as f:
        manifest = json.load(f)
    entry = (manifest.get("files") or {}).get("data")
    if not entry:
        raise ValueError("No file has been uploaded for this source yet")
    path = os.path.join(ctx.in_dir, entry["path"])
    kind = "xlsx" if path.lower().endswith((".xlsx", ".xlsm")) else "csv"
    grid = bool((cfg.get("cleanup") or {}).get("headerRow"))
    with open(path, "rb") as f:
        raw = read_tabular(f.read(), kind, (cfg.get("source") or {}).get("sheet"), grid)
    return process(ctx, raw)
