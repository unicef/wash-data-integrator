from _core import *  # core-import
import pandas as pd

PAGE_SIZE = 2000


def run(ctx):
    cfg = recipe_config(ctx)
    layer = cfg["source"]["layerUrl"].rstrip("/")
    limit = PREVIEW_ROWS if cfg.get("mode") == "preview" else None
    rows, offset = [], 0
    while True:
        body = http_get(layer + "/query", params={
            "where": "1=1", "outFields": "*", "f": "json",
            "resultOffset": offset, "resultRecordCount": PAGE_SIZE,
        }).json()
        if body.get("error"):
            raise RuntimeError(f"ArcGIS error: {body['error'].get('message', 'unknown')}")
        features = body.get("features") or []
        for feature in features:
            row = dict(feature.get("attributes") or {})
            geometry = feature.get("geometry") or {}
            if "x" in geometry and "y" in geometry:
                row["lon"], row["lat"] = geometry["x"], geometry["y"]
            rows.append(row)
        offset += len(features)
        if not features or not body.get("exceededTransferLimit") or (limit and len(rows) >= limit):
            break
    return process(ctx, pd.DataFrame(rows).astype(object))
