import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { AddressInfo } from "node:net"
import { Server } from "node:http"
import path from "node:path"
import { fileURLToPath } from "node:url"
import pg from "pg"
import { IntegrationDefinition, Recipe } from "@data-integrator/definitions"
import { migrate } from "../src/migrations.js"
import { createApiToken, createUser } from "../src/auth.js"
import { createApiServer } from "../src/server.js"
import { TileRenderer } from "../src/tiles.js"
import { RasterStore } from "../src/rasterStore.js"
import { deleteIntegration, installIntegration } from "../src/install.js"
import { buildDefinition } from "../src/builder/buildDefinition.js"
import { connectorCode } from "../src/builder/connectors.js"
import { startTestDb, TestDb } from "./helpers/pg.js"

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "migrations")
const LIBRARY = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "library")

/** A shipped entry in the test library, to clash with. */
const SHIPPED = {
  id: "lib_shipped",
  name: { _base: "en", en: "Shipped" },
  runtime: "node",
  destinations: [{ kind: "table", tableId: "lib_shipped_rows", action: "replace", columns: [{ id: "name", type: "text" }] }],
  code: "",
  contract: 2
}

let db: TestDb
let pool: pg.Pool
let server: Server
let base: string
let libraryPath: string
let adminId: string
let editorId: string
let admin: string
let editor: string
let viewer: string

before(async () => {
  db = await startTestDb()
  pool = new pg.Pool({ connectionString: db.url })
  await migrate(pool, MIGRATIONS_DIR)
  libraryPath = await mkdtemp(path.join(tmpdir(), "built-library-"))
  await cp(path.join(LIBRARY, "connectors"), path.join(libraryPath, "connectors"), { recursive: true })
  await mkdir(path.join(libraryPath, "integrations", "lib_shipped"), { recursive: true })
  await writeFile(path.join(libraryPath, "integrations", "lib_shipped", "definition.json"), JSON.stringify(SHIPPED))
  await writeFile(path.join(libraryPath, "integrations", "lib_shipped", "code.mjs"), "export default async function run() { return {} }\n")

  adminId = (await createUser(pool, "admin@example.org", "hunter2hunter2", "admin")).id
  editorId = (await createUser(pool, "editor@example.org", "hunter2hunter2", "editor")).id
  admin = await createApiToken(pool, adminId, "a")
  editor = await createApiToken(pool, editorId, "e")
  viewer = await createApiToken(pool, (await createUser(pool, "viewer@example.org", "hunter2hunter2", "viewer")).id, "v")

  server = createApiServer(
    pool, new TileRenderer(new RasterStore("/nonexistent"), "/nonexistent"), null, null, null, null, null, null, libraryPath
  )
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

after(async () => {
  server?.close()
  await pool?.end()
  await db?.stop()
  await rm(libraryPath, { recursive: true, force: true })
})

function call(pathname: string, bearer: string, init?: RequestInit): Promise<Response> {
  return fetch(`${base}${pathname}`, {
    ...init,
    headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json", ...init?.headers }
  })
}

const post = (pathname: string, bearer: string, body: unknown = {}) =>
  call(pathname, bearer, { method: "POST", body: JSON.stringify(body) })

function recipe(url = "https://data.example.org/cases.csv"): Recipe {
  return {
    connector: "sheet_link",
    connectorVersion: 1,
    config: {
      source: { url },
      columns: [
        { from: "region", id: "region", type: "text" },
        { from: "cases", id: "cases", type: "number" }
      ],
      cleanup: {},
      writeMode: "replace"
    }
  } as Recipe
}

/** Installs a builder source directly, as Accept would. */
async function installBuilt(id: string, url?: string): Promise<IntegrationDefinition> {
  const definition = await buildDefinition(
    {
      id,
      name: { _base: "en", en: `Cases ${id}` },
      source: { name: { _base: "en", en: "Ministry of Health" } },
      trigger: { cron: "0 6 * * *" },
      recipe: recipe(url)
    },
    libraryPath
  )
  await installIntegration(pool, definition, "ready", editorId, false, true)
  return definition
}

async function installedDef(id: string): Promise<IntegrationDefinition> {
  return (await pool.query("SELECT definition FROM app.integrations WHERE id = $1", [id])).rows[0].definition
}

async function proposeAndApprove(id: string): Promise<void> {
  assert.equal((await post("/api/library/built", editor, { integrationId: id })).status, 200)
  assert.equal((await post(`/api/library/built/${id}/approve`, admin)).status, 200)
}


const importFile = (definition: unknown, extra: Record<string, unknown> = {}) => ({
  format: "wash-di-library-entry", version: 1, definition, ...extra
})

async function exported(id: string, bearer = editor): Promise<{ definition: Record<string, unknown> }> {
  const response = await call(`/api/library/built/${id}/export`, bearer)
  assert.equal(response.status, 200)
  return (await response.json()) as { definition: Record<string, unknown> }
}

test("export_strips_code_aoi_settings_secrets", async () => {
  await installBuilt("exp_cases")
  await proposeAndApprove("exp_cases")
  // Plant the fields a hand-edited row could carry, to prove export strips them
  await pool.query(
    `UPDATE app.built_library_entries
        SET definition = definition || '{"code":"secret()","aoi":{"bbox":[1,2,3,4]},"settingValues":{"token":"abc"},"trigger":{"cron":"0 6 * * *"},"limits":{"maxRows":10}}'::jsonb
      WHERE id = 'exp_cases'`
  )
  const response = await call("/api/library/built/exp_cases/export", editor)
  assert.equal(response.status, 200)
  assert.equal(response.headers.get("content-disposition"), 'attachment; filename="exp_cases.wash-di.json"')
  const file = (await response.json()) as { format: string; version: number; definition: Record<string, unknown> }
  assert.equal(file.format, "wash-di-library-entry")
  assert.equal(file.version, 1)
  for (const field of ["code", "aoi", "settingValues"]) assert.equal(field in file.definition, false, field)
  assert.deepEqual(file.definition.trigger, { cron: "0 6 * * *" })
  assert.deepEqual(file.definition.limits, { maxRows: 10 })
  assert.equal(file.definition.id, "exp_cases")
  assert.ok(file.definition.recipe)
  assert.equal((await call("/api/library/built/exp_cases/export", viewer)).status, 403)
  assert.equal((await call("/api/library/built/exp_cases/export", admin)).status, 200)
  assert.equal((await call("/api/library/built/nope_entry/export", editor)).status, 404)
})

test("export_only_approved", async () => {
  await installBuilt("exp_pending")
  assert.equal((await post("/api/library/built", editor, { integrationId: "exp_pending" })).status, 200)
  assert.equal((await call("/api/library/built/exp_pending/export", editor)).status, 404)
})

test("import_rejects_code_field", async () => {
  const base = await installedDef("exp_cases")
  const { code: _c, ...noCode } = base as unknown as Record<string, unknown>
  void _c
  const bad = await post("/api/library/built/import", admin, importFile({ ...noCode, id: "imp_code", code: "evil()" }))
  assert.equal(bad.status, 400)
  assert.match(((await bad.json()) as { error: string }).error, /contains code/)
  const wrong = await post("/api/library/built/import", admin, { format: "other", version: 1, definition: noCode })
  assert.equal(wrong.status, 400)
  const wrongVersion = await post("/api/library/built/import", admin, { format: "wash-di-library-entry", version: 2, definition: noCode })
  assert.equal(wrongVersion.status, 400)
  assert.equal((await pool.query("SELECT 1 FROM app.built_library_entries WHERE id = 'imp_code'")).rows.length, 0)
})

test("import_validates_recipe", async () => {
  const file = await exported("exp_cases")
  const noRecipe = { ...file.definition, id: "imp_norecipe" }
  delete noRecipe.recipe
  assert.equal((await post("/api/library/built/import", admin, importFile(noRecipe))).status, 400)
  const badRecipe = { ...file.definition, id: "imp_badrecipe", recipe: { ...(file.definition.recipe as object), connector: "nope" } }
  const r = await post("/api/library/built/import", admin, importFile(badRecipe))
  assert.equal(r.status, 400)
  assert.match(((await r.json()) as { error: string }).error, /Unknown connector/)
  assert.equal((await pool.query("SELECT 1 FROM app.built_library_entries WHERE id LIKE 'imp_%'")).rows.length, 0)
})

test("import_admin_only_size_limited_and_id_clashes", async () => {
  const file = await exported("exp_cases")
  assert.equal((await post("/api/library/built/import", editor, importFile({ ...file.definition, id: "imp_x" }))).status, 403)
  assert.equal((await post("/api/library/built/import", viewer, importFile({ ...file.definition, id: "imp_x" }))).status, 403)
  // shipped id
  assert.equal((await post("/api/library/built/import", admin, importFile({ ...file.definition, id: "lib_shipped" }))).status, 400)
  // installed non-builder integration
  await installIntegration(pool, {
    id: "hand_made", name: { _base: "en", en: "Hand made" }, trigger: {}, runtime: "node",
    destinations: [{ kind: "table", tableId: "hand_rows", action: "replace", columns: [{ id: "name", type: "text" }] }],
    code: "export default async function run() { return {} }", contract: 2
  } as IntegrationDefinition)
  assert.equal((await post("/api/library/built/import", admin, importFile({ ...file.definition, id: "hand_made" }))).status, 400)
  // over 1 MB
  const big = await post("/api/library/built/import", admin, importFile({ ...file.definition, id: "imp_big", pad: "x".repeat(1_100_000) }))
  assert.equal(big.status, 413)
})

test("import_clash_becomes_pending_version", async () => {
  const file = await exported("exp_cases")
  const changed = structuredClone(file.definition) as { recipe: { config: { source: { url: string } } } }
  changed.recipe.config.source.url = "https://data.example.org/other.csv"
  const response = await post("/api/library/built/import", admin, importFile(changed))
  assert.equal(response.status, 200, await response.clone().text())
  const row = (await pool.query(
    "SELECT status, version, definition, pending_definition, proposed_by FROM app.built_library_entries WHERE id = 'exp_cases'"
  )).rows[0]
  assert.equal(row.status, "approved")
  assert.equal(row.version, 1)
  assert.equal(row.definition.recipe.config.source.url, "https://data.example.org/cases.csv")
  assert.equal(row.pending_definition.recipe.config.source.url, "https://data.example.org/other.csv")
  assert.equal(row.proposed_by, adminId)
})

test("import_then_approve_then_install_reinlines_code", async () => {
  const file = await exported("exp_cases")
  // A new id needs its own destination table (the original's is owned by exp_cases)
  const destinations = (file.definition.destinations as Record<string, unknown>[]).map(d => ({ ...d, tableId: "imp_new" }))
  const response = await post("/api/library/built/import", admin, importFile({ ...file.definition, id: "imp_new", destinations }))
  assert.equal(response.status, 200, await response.clone().text())
  assert.deepEqual(await response.json(), { id: "imp_new", status: "proposed" })
  const row = (await pool.query("SELECT status, definition, proposed_by FROM app.built_library_entries WHERE id = 'imp_new'")).rows[0]
  assert.equal(row.status, "proposed")
  assert.equal(row.proposed_by, adminId)
  assert.equal("code" in row.definition, false)
  // not usable until approved, even for the admin who imported it
  assert.equal((await post("/api/library/imp_new/install", admin)).status, 404)
  assert.equal((await post("/api/library/built/imp_new/approve", admin)).status, 200)
  const install = await post("/api/library/imp_new/install", editor)
  assert.equal(install.status, 200, await install.clone().text())
  const def = await installedDef("imp_new")
  assert.equal(def.code, await connectorCode("sheet_link", libraryPath))
  assert.equal(def.recipe?.connectorVersion, 1)
})
