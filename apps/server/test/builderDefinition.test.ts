import { test } from "node:test"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { Recipe } from "@data-integrator/definitions"
import { normalise } from "../src/builder/normalise.js"
import { buildDefinition } from "../src/builder/buildDefinition.js"
import { validateDefinition } from "../src/install.js"

const LIBRARY = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "library")

function recipe(over: Partial<Recipe["config"]> = {}, connector: Recipe["connector"] = "sheet_link"): Recipe {
  return {
    connector,
    connectorVersion: 1,
    config: {
      source: connector === "sheet_link" ? { url: "https://example.org/a.csv" } : {},
      columns: [
        { from: "Region", id: "region", type: "place" },
        { from: "Cases", id: "cases", type: "number" },
      ],
      cleanup: {},
      writeMode: "replace",
      ...over,
    },
  }
}

function input(r: Recipe, extra: object = {}) {
  return { id: "cases_x", name: { _base: "en", en: "Cases" }, source: { name: { _base: "en", en: "S" } } as any, trigger: {}, recipe: r, ...extra }
}

test("normalise_matches_python_cases", async () => {
  const cases = JSON.parse(await readFile(path.join(LIBRARY, "connectors", "normalise_cases.json"), "utf8"))
  assert.ok(cases.length > 5)
  for (const c of cases) assert.equal(normalise(c.input), c.expected, JSON.stringify(c.input))
})

test("sheet_link_definition_shape", async () => {
  const def = await buildDefinition(input(recipe()), LIBRARY)
  assert.equal(def.runtime, "python")
  assert.equal(def.recipe?.connector, "sheet_link")
  const d = def.destinations[0] as any
  assert.equal(d.tableId, "cases_x")
  assert.equal(d.action, "replace")
  assert.deepEqual(d.columns.map((c: any) => c.id), ["region", "region_code", "cases"])
  assert.ok(def.code.includes("def run(ctx)"))
  assert.ok(!def.code.split("\n").some((l) => l.startsWith("from _core import")))
  validateDefinition(def)
})

test("place_code_column_follows_place_column", async () => {
  const r = recipe({ places: { column: "region", table: "somalia_regions", nameColumn: "name", codeColumn: "code", matches: {} } })
  const def = await buildDefinition(input(r, { places: { inputId: "places", tableId: "somalia_regions" } }), LIBRARY)
  const cols = (def.destinations[0] as any).columns
  assert.deepEqual(cols.map((c: any) => [c.id, c.type]), [["region", "text"], ["region_code", "text"], ["cases", "number"]])
  assert.deepEqual(def.inputs?.places, { kind: "table", tableId: "somalia_regions", format: "csv" })
})

test("unpivot_adds_date_and_value_columns", async () => {
  const r = recipe({
    columns: [{ from: "r", id: "region", type: "place" }],
    cleanup: { unpivot: { columns: ["w1", "w2"], dateColumnId: "period_date", valueColumnId: "value" } },
  })
  const def = await buildDefinition(input(r), LIBRARY)
  assert.deepEqual((def.destinations[0] as any).columns.map((c: any) => [c.id, c.type]),
    [["region", "text"], ["region_code", "text"], ["period_date", "date"], ["value", "number"]])
  validateDefinition(def)
})

test("unpivot_validation", async () => {
  const base = { columns: [{ from: "r", id: "region", type: "text" as const }] }
  const un = (u: object) => recipe({ ...base, cleanup: { unpivot: { columns: ["w1"], dateColumnId: "d", valueColumnId: "v", ...u } as any } })
  await assert.rejects(buildDefinition(input(un({ columns: [] })), LIBRARY), /unpivot/i)
  await assert.rejects(buildDefinition(input(un({ dateColumnId: "Bad" })), LIBRARY), /Bad/)
  await assert.rejects(buildDefinition(input(un({ dateColumnId: "region" })), LIBRARY), /region/)
  await assert.rejects(buildDefinition(input(un({ valueColumnId: "d" })), LIBRARY), /different/)
})

test("merge_key_may_be_unpivot_date_column", async () => {
  const r = recipe({
    source: { url: "https://x.org/api" }, writeMode: "merge", mergeKey: "period_date",
    columns: [{ from: "r", id: "region", type: "text" }],
    cleanup: { unpivot: { columns: ["w1"], dateColumnId: "period_date", valueColumnId: "value" } },
  }, "web_api")
  const def = await buildDefinition(input(r), LIBRARY)
  assert.deepEqual((def.destinations[0] as any).mergeColumns, ["period_date"])
  validateDefinition(def)
})

test("inspect_with_no_columns", async () => {
  const r = recipe({ columns: [], mode: "inspect" })
  const def = await buildDefinition(input(r), LIBRARY)
  assert.equal(def.recipe?.config.mode, "inspect")
  try { validateDefinition(def) } catch (e) { assert.fail(`inspect definition should validate: ${e}`) }
  await assert.rejects(buildDefinition(input(recipe({ columns: [] })), LIBRARY), /at least one column/)
  await assert.rejects(buildDefinition(input(recipe({ columns: [], mode: "preview" })), LIBRARY), /at least one column/)
})

test("upload_declares_file_slot", async () => {
  const def = await buildDefinition(input(recipe({}, "upload")), LIBRARY)
  assert.deepEqual(def.files, { data: { accept: [".csv", ".xlsx"] } })
  validateDefinition(def)
})

test("webhook_sets_trigger_and_append", async () => {
  const def = await buildDefinition(input(recipe({ writeMode: "append", source: { sampleMessage: { a: 1 } } }, "webhook")), LIBRARY)
  assert.equal(def.trigger.webhook, true)
  assert.equal((def.destinations[0] as any).action, "append")
  validateDefinition(def)
})

test("web_api_key_declares_secret_only", async () => {
  const def = await buildDefinition(input(recipe({ source: { url: "https://x.org/api", auth: "key" } }, "web_api")), LIBRARY)
  assert.deepEqual(def.secrets, ["api_key"])
  validateDefinition(def)
  assert.ok(!JSON.stringify(def.recipe).includes("secret"))
  const none = await buildDefinition(input(recipe({ source: { url: "https://x.org/api", auth: "none" } }, "web_api")), LIBRARY)
  assert.equal(none.secrets, undefined)
})

test("merge_requires_key", async () => {
  const r = recipe({ source: { url: "https://x.org/api" }, writeMode: "merge" }, "web_api")
  await assert.rejects(buildDefinition(input(r), LIBRARY), /key/i)
  r.config.mergeKey = "nope"
  await assert.rejects(buildDefinition(input(r), LIBRARY), /nope/)
  r.config.mergeKey = "region"
  const def = await buildDefinition(input(r), LIBRARY)
  assert.deepEqual((def.destinations[0] as any).mergeColumns, ["region"])
  assert.equal((def.destinations[0] as any).action, "merge")
  validateDefinition(def)
})

test("merge_key_removed_by_unpivot_is_rejected", async () => {
  const r = recipe({
    source: { url: "https://x.org/api" }, writeMode: "merge", mergeKey: "w1",
    columns: [{ from: "r", id: "region", type: "text" }],
    cleanup: { unpivot: { columns: ["w1"], dateColumnId: "period_date", valueColumnId: "value" } },
  }, "web_api")
  await assert.rejects(buildDefinition(input(r), LIBRARY), /merge key "w1"/)
})

test("missing_cleanup_is_treated_as_empty", async () => {
  const r = recipe(); delete (r.config as any).cleanup
  const def = await buildDefinition(input(r), LIBRARY)
  assert.equal((def.destinations[0] as any).columns.length, 3)
})

test("recipe_validation_rejects_bad_input", async () => {
  await assert.rejects(buildDefinition(input(recipe({ source: {} })), LIBRARY), /url/)
  await assert.rejects(buildDefinition(input(recipe({ writeMode: "append" })), LIBRARY), /write mode/i)
  await assert.rejects(buildDefinition(input(recipe({ columns: [] })), LIBRARY), /column/i)
  await assert.rejects(buildDefinition(input(recipe({ columns: [{ from: "a", id: "Bad Id", type: "text" }] })), LIBRARY), /Bad Id/)
  const r = recipe(); r.connectorVersion = 0
  await assert.rejects(buildDefinition(input(r), LIBRARY), /version/i)
})
