import importlib
import io
import json
import os
import subprocess
import sys
import tempfile
import types
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
CONNECTORS = os.path.dirname(HERE)
sys.path.insert(0, CONNECTORS)

import pandas as pd


def fixture(name):
    with open(os.path.join(HERE, "fixtures", name), "rb") as f:
        return f.read()


def read_text(path):
    with open(path, encoding="utf-8") as f:
        return f.read()


class Resp:
    def __init__(self, content=b"", status=200, content_type="text/csv"):
        self.content, self.status_code = content, status
        self.headers = {"Content-Type": content_type}

    def json(self):
        return json.loads(self.content)


def xlsx_bytes(sheets):
    buf = io.BytesIO()
    with pd.ExcelWriter(buf, engine="openpyxl") as w:
        for name, frame in sheets.items():
            frame.to_excel(w, sheet_name=name, index=False)
    return buf.getvalue()


COLS = [{"from": "Region", "id": "region", "type": "text"}, {"from": "Cases", "id": "cases", "type": "number"}]


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)

    def ctx(self, config, secrets=None, webhook_data=None):
        d = self.tmp.name
        for sub in ("in", "out", "tmp"):
            os.makedirs(os.path.join(d, sub), exist_ok=True)
        return types.SimpleNamespace(
            definition={"id": "my_table", "recipe": {"config": config}},
            secrets=secrets or {}, webhook_data=webhook_data, params={},
            in_dir=os.path.join(d, "in"), out_dir=os.path.join(d, "out"), tmp_dir=os.path.join(d, "tmp"))

    def connector(self, name):
        return importlib.import_module(name)

    def out_rows(self, ctx):
        return pd.read_csv(os.path.join(ctx.out_dir, "my_table.csv"), dtype=str, keep_default_na=False)

    def inspect(self, ctx):
        with open(os.path.join(ctx.out_dir, "inspect.json")) as f:
            return json.load(f)


class SheetLinkTests(Base):
    def test_sheet_link_csv_and_xlsx_sheet(self):
        cfg = {"source": {"url": "https://x.org/a.csv"}, "columns": COLS}
        ctx = self.ctx(cfg)
        with mock.patch("requests.get", return_value=Resp(fixture("sheet.csv"))) as g:
            result = self.connector("sheet_link").run(ctx)
        self.assertEqual(g.call_args.kwargs["timeout"], 60)
        self.assertEqual(result["tables"][0]["tableId"], "my_table")
        self.assertEqual(self.out_rows(ctx)["cases"].tolist(), ["10", "5"])

        data = xlsx_bytes({"Other": pd.DataFrame({"Region": ["Z"], "Cases": [1]}),
                           "Data": pd.DataFrame({"Region": ["A", "B"], "Cases": [3, 4]})})
        cfg = {"source": {"url": "https://x.org/a.xlsx", "sheet": "Data"}, "columns": COLS}
        ctx = self.ctx(cfg)
        with mock.patch("requests.get", return_value=Resp(data, content_type="application/octet-stream")):
            self.connector("sheet_link").run(ctx)
        self.assertEqual(self.out_rows(ctx)["region"].tolist(), ["A", "B"])

    def test_header_row_keeps_grid(self):
        csv = b"Report title,\n,\nRegion,Cases\nA,1\n"
        cfg = {"source": {"url": "https://x.org/a.csv"}, "cleanup": {"headerRow": 3}, "columns": COLS}
        ctx = self.ctx(cfg)
        with mock.patch("requests.get", return_value=Resp(csv)):
            self.connector("sheet_link").run(ctx)
        self.assertEqual(self.out_rows(ctx)["region"].tolist(), ["A"])

    def test_http_error_names_status_not_secrets(self):
        ctx = self.ctx({"source": {"url": "https://x.org/a.csv"}, "columns": COLS})
        with mock.patch("requests.get", return_value=Resp(b"", status=404)):
            with self.assertRaisesRegex(RuntimeError, "404"):
                self.connector("sheet_link").run(ctx)

    def test_preview_caps_rows(self):
        body = "Region,Cases\n" + "".join(f"R{i},{i}\n" for i in range(6000))
        ctx = self.ctx({"mode": "preview", "source": {"url": "https://x.org/a.csv"}, "columns": COLS})
        with mock.patch("requests.get", return_value=Resp(body.encode())):
            self.connector("sheet_link").run(ctx)
        self.assertEqual(len(self.out_rows(ctx)), 5000)

    def test_places_matched(self):
        with open(os.path.join(self.tmp.name, "places.csv"), "w") as f:
            f.write("name,code\nBanaadir,SO22\n")
        cfg = {"source": {"url": "https://x.org/a.csv"}, "columns": COLS,
               "places": {"column": "region", "table": "places", "nameColumn": "name", "codeColumn": "code", "matches": {}}}
        ctx = self.ctx(cfg)
        with open(os.path.join(ctx.in_dir, "manifest.json"), "w") as f:
            json.dump({"inputs": {"places": {"kind": "table", "format": "csv", "path": "../places.csv"}}}, f)
        with mock.patch("requests.get", return_value=Resp(fixture("sheet.csv"))):
            result = self.connector("sheet_link").run(ctx)
        self.assertEqual(self.out_rows(ctx)["region_code"].tolist(), ["SO22", ""])
        self.assertEqual(result["state"]["unmatchedCount"], 1)

    def test_inspect_returns_columns_and_samples(self):
        ctx = self.ctx({"mode": "inspect", "source": {"url": "https://x.org/a.csv"}, "columns": []})
        with mock.patch("requests.get", return_value=Resp(fixture("sheet.csv"))):
            result = self.connector("sheet_link").run(ctx)
        self.assertEqual(result, {"tables": [], "state": {}})
        info = self.inspect(ctx)
        self.assertEqual(info["rows"], 2)
        self.assertEqual(info["columns"][0], {"name": "Region", "sample": ["Banaadir", "Bari"]})
        self.assertFalse(os.path.exists(os.path.join(ctx.out_dir, "my_table.csv")))


class HdxTests(Base):
    def cfg(self, mode=None):
        c = {"source": {"url": "https://data.humdata.org/dataset/som-cases", "resourceId": "r2"}, "columns": COLS}
        if mode:
            c["mode"] = mode
        return c

    def fake_get(self, url, **kw):
        if "package_show" in url:
            self.assertEqual(kw["params"], {"id": "som-cases"})
            return Resp(fixture("hdx_dataset.json"), content_type="application/json")
        self.assertTrue(url.endswith("cases.csv"), url)
        return Resp(fixture("hdx_r2.csv"))

    def test_hdx_picks_resource_by_id(self):
        ctx = self.ctx(self.cfg())
        with mock.patch("requests.get", side_effect=self.fake_get):
            self.connector("hdx").run(ctx)
        self.assertEqual(self.out_rows(ctx)["cases"].tolist(), ["7"])

    def test_inspect_returns_columns_and_samples(self):
        ctx = self.ctx(self.cfg("inspect"))
        with mock.patch("requests.get", side_effect=self.fake_get):
            self.connector("hdx").run(ctx)
        self.assertEqual([c["name"] for c in self.inspect(ctx)["columns"]], ["Region", "Cases"])

    def test_unknown_resource(self):
        c = self.cfg()
        c["source"]["resourceId"] = "nope"
        with mock.patch("requests.get", side_effect=self.fake_get):
            with self.assertRaisesRegex(ValueError, "nope"):
                self.connector("hdx").run(self.ctx(c))


class ArcgisTests(Base):
    def cfg(self, mode=None):
        c = {"source": {"layerUrl": "https://gis.org/arcgis/rest/services/s/FeatureServer/0"},
             "columns": [{"from": "NAME", "id": "name", "type": "text"}, {"from": "N", "id": "n", "type": "number"},
                         {"from": "lon", "id": "lon", "type": "number"}, {"from": "lat", "id": "lat", "type": "number"}]}
        if mode:
            c["mode"] = mode
        return c

    def test_arcgis_pages_with_resultOffset_and_points_to_lon_lat(self):
        calls = []

        def fake(url, **kw):
            calls.append((url, kw["params"]))
            return Resp(fixture("arcgis_p1.json" if kw["params"]["resultOffset"] == 0 else "arcgis_p2.json"),
                        content_type="application/json")
        ctx = self.ctx(self.cfg())
        with mock.patch("requests.get", side_effect=fake):
            self.connector("arcgis").run(ctx)
        self.assertEqual([c[1]["resultOffset"] for c in calls], [0, 2])
        self.assertTrue(calls[0][0].endswith("/FeatureServer/0/query"))
        self.assertEqual(calls[0][1]["resultRecordCount"], 2000)
        out = self.out_rows(ctx)
        self.assertEqual(out["name"].tolist(), ["A", "B", "C"])
        self.assertEqual(out["lon"].tolist(), ["45.3", "44.0", "43.0"])

    def test_inspect_returns_columns_and_samples(self):
        ctx = self.ctx(self.cfg("inspect"))
        with mock.patch("requests.get", return_value=Resp(fixture("arcgis_p2.json"))):
            self.connector("arcgis").run(ctx)
        names = [c["name"] for c in self.inspect(ctx)["columns"]]
        self.assertEqual(names, ["NAME", "N", "lon", "lat"])


class WebApiTests(Base):
    def cfg(self, **source):
        src = {"url": "https://api.example.org/v1", "recordsPath": "data.items",
               "paging": {"type": "next", "path": "links.next"}}
        src.update(source)
        return {"source": src, "columns": [{"from": "region", "id": "region", "type": "text"},
                                           {"from": "meta.cases", "id": "cases", "type": "number"}]}

    def test_web_api_records_path_and_next_link_paging(self):
        seen = []

        def fake(url, **kw):
            seen.append(url)
            return Resp(fixture("api_p2.json" if "page=2" in url else "api_p1.json"), content_type="application/json")
        ctx = self.ctx(self.cfg())
        with mock.patch("requests.get", side_effect=fake):
            self.connector("web_api").run(ctx)
        self.assertEqual(seen, ["https://api.example.org/v1", "https://api.example.org/v1?page=2"])
        out = self.out_rows(ctx)
        self.assertEqual(out["cases"].tolist(), ["1", "2", "3"])

    def test_page_param_stops_on_empty_page(self):
        pages = {1: [{"region": "A", "meta": {"cases": 1}}], 2: [{"region": "B", "meta": {"cases": 2}}], 3: []}

        def fake(url, **kw):
            return Resp(json.dumps(pages[kw["params"]["page"]]).encode())
        ctx = self.ctx(self.cfg(recordsPath="", paging={"type": "page", "param": "page", "start": 1}))
        with mock.patch("requests.get", side_effect=fake):
            self.connector("web_api").run(ctx)
        self.assertEqual(self.out_rows(ctx)["region"].tolist(), ["A", "B"])

    def test_web_api_sends_key_from_ctx_secrets_header(self):
        for header, expected in ((None, "Bearer s3cret"), ("X-Api-Key", "s3cret")):
            extra = {"auth": "key", "paging": {"type": "none"}}
            if header:
                extra["keyHeader"] = header
            ctx = self.ctx(self.cfg(**extra), secrets={"api_key": "s3cret"})
            with mock.patch("requests.get", return_value=Resp(fixture("api_p2.json"))) as g:
                self.connector("web_api").run(ctx)
            self.assertEqual(g.call_args.kwargs["headers"][header or "Authorization"], expected)

    def test_error_does_not_leak_key(self):
        ctx = self.ctx(self.cfg(auth="key", paging={"type": "none"}), secrets={"api_key": "s3cret"})
        with mock.patch("requests.get", return_value=Resp(b"", status=401)):
            with self.assertRaises(RuntimeError) as cm:
                self.connector("web_api").run(ctx)
        self.assertIn("401", str(cm.exception))
        self.assertNotIn("s3cret", str(cm.exception))

    def test_inspect_returns_columns_and_samples(self):
        c = self.cfg(paging={"type": "none"})
        c["mode"] = "inspect"
        ctx = self.ctx(c)
        with mock.patch("requests.get", return_value=Resp(fixture("api_p1.json"))):
            self.connector("web_api").run(ctx)
        info = self.inspect(ctx)
        self.assertEqual([c["name"] for c in info["columns"]], ["region", "meta.cases"])
        self.assertEqual(info["rows"], 2)


class UploadTests(Base):
    def setup_file(self, ctx, name, data):
        os.makedirs(os.path.join(ctx.in_dir, "files"), exist_ok=True)
        with open(os.path.join(ctx.in_dir, "files", name), "wb") as f:
            f.write(data)
        with open(os.path.join(ctx.in_dir, "manifest.json"), "w") as f:
            json.dump({"files": {"data": {"path": f"files/{name}"}}}, f)

    def test_upload_reads_in_files_data(self):
        ctx = self.ctx({"source": {}, "columns": COLS})
        self.setup_file(ctx, "data.csv", fixture("sheet.csv"))
        self.connector("upload").run(ctx)
        self.assertEqual(self.out_rows(ctx)["region"].tolist(), ["Banaadir", "Bari"])

    def test_upload_xlsx_sheet(self):
        data = xlsx_bytes({"A": pd.DataFrame({"Region": ["x"], "Cases": [1]}),
                           "B": pd.DataFrame({"Region": ["y"], "Cases": [2]})})
        ctx = self.ctx({"source": {"sheet": "B"}, "columns": COLS})
        self.setup_file(ctx, "data.xlsx", data)
        self.connector("upload").run(ctx)
        self.assertEqual(self.out_rows(ctx)["region"].tolist(), ["y"])

    def test_inspect_returns_columns_and_samples(self):
        ctx = self.ctx({"mode": "inspect", "source": {}, "columns": []})
        self.setup_file(ctx, "data.csv", fixture("sheet.csv"))
        self.connector("upload").run(ctx)
        self.assertEqual(self.inspect(ctx)["rows"], 2)


class WebhookTests(Base):
    COLS = [{"from": "station", "id": "station", "type": "text"},
            {"from": "reading.level", "id": "level", "type": "number"},
            {"from": "received_at", "id": "received_at", "type": "date"}]

    def test_webhook_flattens_messages_and_uses_timestamp_or_receipt_time(self):
        msgs = [{"station": "s1", "reading": {"level": 1.5}, "ts": "2026-05-01"},
                [{"station": "s2", "reading": {"level": 2.5}, "ts": "2026-05-02"}]]
        cols = self.COLS + [{"from": "ts", "id": "ts", "type": "date"}]
        ctx = self.ctx({"source": {"timestampField": "ts"}, "columns": cols}, webhook_data=msgs)
        self.connector("webhook").run(ctx)
        out = self.out_rows(ctx)
        self.assertEqual(out["level"].tolist(), ["1.5", "2.5"])
        self.assertEqual(out["ts"].tolist(), ["2026-05-01", "2026-05-02"])
        self.assertRegex(out["received_at"][0], r"^\d{4}-\d\d-\d\d$")

        ctx = self.ctx({"source": {}, "columns": self.COLS}, webhook_data=[{"station": "s3", "reading": {"level": 3}}])
        self.connector("webhook").run(ctx)
        self.assertRegex(self.out_rows(ctx)["received_at"][0], r"^\d{4}-\d\d-\d\d$")

    def test_inspect_returns_columns_and_samples(self):
        ctx = self.ctx({"mode": "inspect", "source": {"sampleMessage": {"station": "s1", "reading": {"level": 1}}},
                        "columns": []}, webhook_data=[{"ignored": 1}])
        self.connector("webhook").run(ctx)
        names = [c["name"] for c in self.inspect(ctx)["columns"]]
        self.assertEqual(names, ["station", "reading.level", "received_at"])


class JoinedTests(unittest.TestCase):
    def test_joined_files_compile(self):
        core = read_text(os.path.join(CONNECTORS, "_core.py")).rstrip()
        for cid in ("sheet_link", "hdx", "arcgis", "web_api", "upload", "webhook"):
            lines = read_text(os.path.join(CONNECTORS, f"{cid}.py")).split("\n")
            self.assertEqual(lines[0], "from _core import *  # core-import", cid)
            with tempfile.TemporaryDirectory() as d:
                path = os.path.join(d, f"{cid}.py")
                with open(path, "w", encoding="utf-8") as f:
                    f.write(core + "\n\n\n" + "\n".join(lines[1:]).lstrip("\n"))
                subprocess.run([sys.executable, "-m", "py_compile", path], check=True)
                # the joined file must define run() with no leftover core import
                ns = {}
                exec(compile(read_text(path), path, "exec"), ns)
                self.assertTrue(callable(ns["run"]), cid)


if __name__ == "__main__":
    unittest.main()
