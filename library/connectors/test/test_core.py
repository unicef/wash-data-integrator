import json
import os
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

import pandas as pd

from _core import (apply_cleanup, apply_columns, finish, match_places,
                   normalise, read_places)


class Ctx:
    def __init__(self, in_dir="", out_dir=""):
        self.in_dir = in_dir
        self.out_dir = out_dir


PLACES = {"column": "region", "table": "places", "nameColumn": "name",
          "codeColumn": "code", "matches": {}}
ROWS = [{"name": "Banaadir", "code": "SO22"}, {"name": "Bari Region", "code": "SO12"}]


class CoreTests(unittest.TestCase):
    def test_number_cast_accepts_native_integers(self):
        out, errors = apply_columns(pd.DataFrame({"n": [1, 2]}), [{"from": "n", "id": "n", "type": "number"}])
        self.assertEqual(out["n"].tolist(), [1, 2])
        self.assertEqual(errors, [])

    def test_normalise_cases(self):
        with open(os.path.join(os.path.dirname(HERE), "normalise_cases.json")) as f:
            cases = json.load(f)
        self.assertGreaterEqual(len(cases), 5)
        for c in cases:
            self.assertEqual(normalise(c["input"]), c["expected"], c["input"])

    def test_header_row_skips_title_rows(self):
        raw = pd.DataFrame([["Report", None], ["", None], ["region", "value"], ["A", 1], ["B", 2]])
        out = apply_cleanup(raw, {"headerRow": 3})
        self.assertEqual(list(out.columns), ["region", "value"])
        self.assertEqual(len(out), 2)
        self.assertEqual(out.iloc[0]["region"], "A")

    def test_skip_rows(self):
        raw = pd.DataFrame([["x", "y"], ["junk", "junk"], ["a", "b"]])
        out = apply_cleanup(raw, {"skipRows": 1, "headerRow": 2})
        self.assertEqual(list(out.columns), ["a", "b"])
        self.assertEqual(len(out), 0)

    def test_filters_equals_and_contains(self):
        df = pd.DataFrame({"kind": ["Well", "well pump", "Tap"], "n": [1, 2, 3]})
        eq = apply_cleanup(df, {"filters": [{"column": "kind", "op": "equals", "value": "well"}]})
        self.assertEqual(list(eq["n"]), [1])
        co = apply_cleanup(df, {"filters": [{"column": "kind", "op": "contains", "value": "well"}]})
        self.assertEqual(list(co["n"]), [1, 2])

    def test_unpivot_dates_across_columns(self):
        df = pd.DataFrame({"region": ["A", "B"], "2024-01": [1, 2], "2024-02": [3, 4]})
        out = apply_cleanup(df, {"unpivot": {"columns": ["2024-01", "2024-02"],
                                              "dateColumnId": "month", "valueColumnId": "cases"}})
        self.assertEqual(list(out.columns), ["region", "month", "cases"])
        self.assertEqual(len(out), 4)
        self.assertEqual(list(out["month"][:2]), ["2024-01", "2024-01"])

    def test_type_failures_reported_not_dropped(self):
        df = pd.DataFrame({"R": ["A", "B", "C"], "V": ["1", "oops", ""]})
        out, errors = apply_columns(df, [{"from": "R", "id": "region", "type": "text"},
                                         {"from": "V", "id": "value", "type": "number"}])
        self.assertEqual(len(out), 3)
        self.assertEqual(len(errors), 1)
        self.assertIn("oops", errors[0])
        self.assertTrue(pd.isna(out["value"][1]))
        self.assertEqual(out["value"][0], 1)

    def test_date_column(self):
        df = pd.DataFrame({"D": ["2024-03-05", "nope"]})
        out, errors = apply_columns(df, [{"from": "D", "id": "d", "type": "date"}])
        self.assertEqual(out["d"][0], "2024-03-05")
        self.assertEqual(len(errors), 1)

    def test_saved_match_wins_over_exact(self):
        places = dict(PLACES, matches={"Banaadir": "CUSTOM"})
        df = pd.DataFrame({"region": ["Banaadir", "Bari"]})
        out, unmatched = match_places(df, places, ROWS)
        self.assertEqual(list(out["region_code"]), ["CUSTOM", "SO12"])
        self.assertEqual(unmatched, [])
        self.assertEqual(list(out["region"]), ["Banaadir", "Bari"])

    def test_new_name_later_run_kept_unmatched(self):
        df = pd.DataFrame({"region": ["Banaadir", "Newtown", "Newtown"]})
        out, unmatched = match_places(df, PLACES, ROWS)
        self.assertEqual(len(out), 3)
        self.assertEqual(list(out["region_code"]), ["SO22", "", ""])
        self.assertEqual(unmatched, ["Newtown"])

    def test_read_places_and_finish(self):
        with tempfile.TemporaryDirectory() as d:
            os.makedirs(os.path.join(d, "in"))
            with open(os.path.join(d, "in", "manifest.json"), "w") as f:
                json.dump({"inputs": {"places": {"kind": "table", "tableId": "p", "path": "p.csv",
                                                  "format": "csv", "rowCount": 2}}}, f)
            pd.DataFrame({"name": ["Banaadir", "Bari"], "code": ["SO22", "SO12"]}).to_csv(
                os.path.join(d, "in", "p.csv"), index=False)
            out_dir = os.path.join(d, "out")
            ctx = Ctx(os.path.join(d, "in"), out_dir)
            rows = read_places(ctx, PLACES)
            self.assertEqual(rows[0], {"name": "Banaadir", "code": "SO22"})
            df = pd.DataFrame({"region": ["Banaadir"], "region_code": ["SO22"]})
            res = finish(ctx, df, "cases", ["X"], ["bad"])
            self.assertEqual(res["tables"], [{"tableId": "cases", "path": "cases.csv", "format": "csv"}])
            self.assertEqual(res["state"]["unmatchedPlaces"], ["X"])
            self.assertEqual(res["state"]["rows"], 1)
            self.assertTrue(os.path.exists(os.path.join(out_dir, "cases.csv")))

    def test_read_places_reads_gpkg(self):
        try:
            import geopandas
        except ImportError:
            self.skipTest("geopandas is not installed")
        with tempfile.TemporaryDirectory() as d:
            geopandas.GeoDataFrame({"name": ["Banaadir"], "code": ["SO22"]}, geometry=geopandas.points_from_xy([45.3], [2.0]),
                                   crs="EPSG:4326").to_file(os.path.join(d, "places.gpkg"), layer="places", driver="GPKG")
            with open(os.path.join(d, "manifest.json"), "w") as f:
                json.dump({"inputs": {"places": {"kind": "table", "tableId": "p", "path": "places.gpkg",
                                                  "format": "gpkg", "rowCount": 1}}}, f)
            self.assertEqual(read_places(Ctx(d, d), PLACES), [{"name": "Banaadir", "code": "SO22"}])


class UnpivotAndInspectTests(unittest.TestCase):
    def _ctx(self, cfg):
        class C:
            pass
        c = C()
        c.out_dir = tempfile.mkdtemp()
        c.in_dir = ""
        c.definition = {"id": "t", "recipe": {"config": cfg}}
        return c

    def test_unpivot_end_to_end(self):
        from _core import process
        raw = pd.DataFrame({"region": ["A", "B"], "2024-01-01": ["1", "2"], "2024-02-01": ["3", "4"]})
        cfg = {"columns": [{"from": "region", "id": "region", "type": "text"}],
               "cleanup": {"unpivot": {"columns": ["2024-01-01", "2024-02-01"], "dateColumnId": "period_date", "valueColumnId": "value"}}}
        ctx = self._ctx(cfg)
        result = process(ctx, raw)
        out = pd.read_csv(os.path.join(ctx.out_dir, "t.csv"))
        self.assertEqual(list(out.columns), ["region", "period_date", "value"])
        self.assertEqual(len(out), 4)
        self.assertEqual(out[out.region == "A"]["period_date"].tolist(), ["2024-01-01", "2024-02-01"])
        self.assertEqual(out[out.region == "B"]["value"].tolist(), [2, 4])
        self.assertEqual(result["state"]["rows"], 4)

    def test_inspect_with_no_columns_writes_inspect_json(self):
        from _core import process
        ctx = self._ctx({"columns": [], "mode": "inspect", "cleanup": {}})
        process(ctx, pd.DataFrame({"a": ["x", "y"]}))
        with open(os.path.join(ctx.out_dir, "inspect.json")) as f:
            data = json.load(f)
        self.assertEqual(data["rows"], 2)
        self.assertEqual(data["columns"][0]["name"], "a")


if __name__ == "__main__":
    unittest.main()
