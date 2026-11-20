from _core import *  # core-import
import json
import pandas as pd

PAGE_SIZE = 2000
MAX_PAGES = 200


def run(ctx):
    cfg = recipe_config(ctx)
    layer = cfg["source"]["layerUrl"].rstrip("/")
    limit = row_limit(cfg)
    rows, offset, previous_first = [], 0, None
    for _ in range(MAX_PAGES):
        body = http_json(http_get(layer + "/query", params={
            "where": "1=1", "outFields": "*", "f": "json", "outSR": 4326,
            "resultOffset": offset, "resultRecordCount": PAGE_SIZE,
        }))
        if body.get("error"):
            raise RuntimeError(f"ArcGIS error: {body['error'].get('message', 'unknown')}")
        features = body.get("features") or []
        if not features:
            break
        first = json.dumps(features[0], sort_keys=True)
        if first == previous_first:
            break  # the service repeated the previous page; stop rather than loop
        previous_first = first
        for feature in features:
            row = dict(feature.get("attributes") or {})
            geometry = feature.get("geometry") or {}
            if "x" in geometry and "y" in geometry:
                row["lon"], row["lat"] = geometry["x"], geometry["y"]
            rows.append(row)
        offset += len(features)
        if not body.get("exceededTransferLimit") or (limit and len(rows) >= limit):
            break
    return process(ctx, pd.DataFrame(rows).astype(object))
