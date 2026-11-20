from _core import *  # core-import
import pandas as pd
from datetime import datetime, timezone


def run(ctx):
    cfg = recipe_config(ctx)
    if cfg.get("mode") in ("preview", "inspect"):
        messages = [(cfg.get("source") or {}).get("sampleMessage") or {}]
    else:
        messages = ctx.webhook_data or []
    records = []
    for message in messages:
        records.extend(message if isinstance(message, list) else [message])
    # The platform hands over payloads only, so the receipt time is the time of this run.
    received_at = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    raw = pd.json_normalize(records).astype(object)
    raw["received_at"] = received_at
    return process(ctx, raw)
