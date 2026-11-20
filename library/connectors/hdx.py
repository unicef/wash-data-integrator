from _core import *  # core-import
from urllib.parse import parse_qs, urlparse


def _dataset_name(url):
    parsed = urlparse(url)
    query = parse_qs(parsed.query)
    if query.get("id"):
        return query["id"][0]
    parts = [p for p in parsed.path.split("/") if p]
    if "dataset" in parts and parts.index("dataset") + 1 < len(parts):
        return parts[parts.index("dataset") + 1]
    raise ValueError("Could not find the dataset name in the HDX address")


def run(ctx):
    cfg = recipe_config(ctx)
    source = cfg["source"]
    name = _dataset_name(source["url"])
    meta = http_get("https://data.humdata.org/api/3/action/package_show", params={"id": name}).json()
    resources = (meta.get("result") or {}).get("resources") or []
    match = [r for r in resources if r.get("id") == source.get("resourceId")]
    if not match:
        raise ValueError(f"Resource {source.get('resourceId')} was not found in HDX dataset {name}")
    return process(ctx, fetch_table(match[0]["url"], {**cfg, "source": {**source, "url": match[0]["url"]}}))
