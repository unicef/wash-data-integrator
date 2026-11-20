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
import { installLibraryEntry, LibraryEntry, listLibrary } from "../src/library.js"
import { buildDefinition } from "../src/builder/buildDefinition.js"
import { CONNECTORS, connectorCode } from "../src/builder/connectors.js"
import { idTaken } from "../src/builder/drafts.js"
import { searchLibrary } from "../src/agent/libraryTool.js"
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

async function installed(id: string): Promise<IntegrationDefinition> {
  return (await pool.query("SELECT definition FROM app.integrations WHERE id = $1", [id])).rows[0].definition
}

async function entries(bearer: string): Promise<LibraryEntry[]> {
  const response = await call("/api/library", bearer)
  assert.equal(response.status, 200)
  return ((await response.json()) as { entries: LibraryEntry[] }).entries
}

async function proposeAndApprove(id: string): Promise<void> {
  assert.equal((await post("/api/library/built", editor, { integrationId: id })).status, 200)
  assert.equal((await post(`/api/library/built/${id}/approve`, admin)).status, 200)
}

/** A registry with the spreadsheet connector one version ahead. */
const BUMPED = { ...CONNECTORS, sheet_link: { ...CONNECTORS.sheet_link, version: 2 } }

test("editor_proposes_admin_approves", async () => {
  await installBuilt("built_cases")
  const proposed = await post("/api/library/built", editor, { integrationId: "built_cases" })
  assert.equal(proposed.status, 200, await proposed.clone().text())
  assert.deepEqual(await proposed.json(), { id: "built_cases", status: "proposed" })

  const row = (await pool.query("SELECT * FROM app.built_library_entries WHERE id = 'built_cases'")).rows[0]
  assert.equal(row.status, "proposed")
  assert.equal(row.version, 1)
  assert.equal(row.proposed_by, editorId)
  for (const field of ["aoi", "trigger", "limits", "settingValues", "code"]) assert.ok(!(field in row.definition), field)
  assert.equal(row.definition.recipe.connector, "sheet_link")

  const approved = await post("/api/library/built/built_cases/approve", admin)
  assert.equal(approved.status, 200, await approved.clone().text())
  const after = (await pool.query("SELECT * FROM app.built_library_entries WHERE id = 'built_cases'")).rows[0]
  assert.equal(after.status, "approved")
  assert.equal(after.approved_by, adminId)
  assert.ok(after.decided_at)

  const entry = (await entries(editor)).find(e => e.id === "built_cases")
  assert.ok(entry)
  assert.equal(entry.origin, "built")
  assert.equal(entry.builtStatus, "approved")
  assert.equal(entry.status, "installed")
  assert.equal(entry.changedHere, false)
  const shipped = (await entries(editor)).find(e => e.id === "lib_shipped")
  assert.equal(shipped?.origin, "shipped")

  // A new version waits beside the approved one until an admin approves it
  await installIntegration(pool, { ...(await installed("built_cases")), name: { _base: "en", en: "Cases v2" } }, "ready", editorId)
  assert.equal((await post("/api/library/built", editor, { integrationId: "built_cases" })).status, 200)
  const pending = (await pool.query("SELECT * FROM app.built_library_entries WHERE id = 'built_cases'")).rows[0]
  assert.equal(pending.status, "approved")
  assert.equal(pending.definition.name.en, "Cases built_cases")
  assert.equal(pending.pending_definition.name.en, "Cases v2")
  assert.equal((await post("/api/library/built/built_cases/approve", admin)).status, 200)
  const promoted = (await pool.query("SELECT * FROM app.built_library_entries WHERE id = 'built_cases'")).rows[0]
  assert.equal(promoted.version, 2)
  assert.equal(promoted.definition.name.en, "Cases v2")
  assert.equal(promoted.pending_definition, null)
})

test("editor_cannot_approve", async () => {
  await installBuilt("built_refused")
  assert.equal((await post("/api/library/built", viewer, { integrationId: "built_refused" })).status, 403)
  assert.equal((await post("/api/library/built", editor, { integrationId: "built_refused" })).status, 200)
  assert.equal((await post("/api/library/built/built_refused/approve", editor)).status, 403)
  assert.equal((await post("/api/library/built/built_refused/reject", editor)).status, 403)
  assert.equal((await post("/api/library/built/no_such_entry/approve", admin)).status, 404)
  const rejected = await post("/api/library/built/built_refused/reject", admin, { note: "Needs a licence" })
  assert.equal(rejected.status, 200, await rejected.clone().text())
  const row = (await pool.query("SELECT status, note FROM app.built_library_entries WHERE id = 'built_refused'")).rows[0]
  assert.deepEqual(row, { status: "rejected", note: "Needs a licence" })
  assert.ok(!(await entries(admin)).some(e => e.id === "built_refused"))
  // Only builder-made sources can be proposed
  await installIntegration(pool, { ...SHIPPED, id: "hand_made", destinations: [{ ...SHIPPED.destinations[0], tableId: "hand_rows" }] } as IntegrationDefinition)
  assert.equal((await post("/api/library/built", editor, { integrationId: "hand_made" })).status, 400)
  assert.equal((await post("/api/library/built", editor, { integrationId: "not_installed" })).status, 404)
})

test("proposed_hidden_from_editors_list", async () => {
  await installBuilt("built_hidden")
  assert.equal((await post("/api/library/built", editor, { integrationId: "built_hidden" })).status, 200)
  assert.ok(!(await entries(editor)).some(e => e.id === "built_hidden"))
  assert.ok(!(await entries(viewer)).some(e => e.id === "built_hidden"))
  const forAdmin = (await entries(admin)).find(e => e.id === "built_hidden")
  assert.equal(forAdmin?.builtStatus, "proposed")
  assert.equal(forAdmin?.origin, "built")
  // Not installable until approved
  assert.equal((await post("/api/library/built_hidden/install", editor)).status, 404)
})

test("approved_installs_like_shipped", async () => {
  await installBuilt("built_share")
  await proposeAndApprove("built_share")
  const removed = await deleteIntegration(pool, "built_share")
  assert.equal(removed.ok, true)
  assert.equal((await entries(editor)).find(e => e.id === "built_share")?.status, "not_installed")

  const shown = await call("/api/library/built_share", editor)
  assert.equal(shown.status, 200)
  const { definition: shownDefinition } = (await shown.json()) as { definition: IntegrationDefinition }
  assert.equal(shownDefinition.id, "built_share")
  assert.ok(!("code" in shownDefinition))

  const response = await post("/api/library/built_share/install", editor)
  assert.equal(response.status, 200, await response.clone().text())
  const definition = await installed("built_share")
  assert.equal(definition.code, await connectorCode("sheet_link", libraryPath))
  assert.equal(definition.recipe?.connectorVersion, 1)
  assert.deepEqual(definition.recipe?.config, recipe().config)
  assert.equal((await entries(editor)).find(e => e.id === "built_share")?.status, "installed")
})

test("connector_update_marks_not_changes", async () => {
  const connectorFile = path.join(libraryPath, "connectors", "sheet_link.py")
  const original = await readFile(connectorFile, "utf8")
  try {
    await installBuilt("built_conn")
    await proposeAndApprove("built_conn")
    const oldCode = (await installed("built_conn")).code
    // Deployment fields survive the update
    await installIntegration(pool, { ...(await installed("built_conn")), trigger: { cron: "0 9 * * 1" } }, "ready", editorId)

    await writeFile(connectorFile, `${original}\n# connector version 2\n`)
    const listed = (await listLibrary(pool, libraryPath, { role: "editor", connectors: BUMPED })).find(e => e.id === "built_conn")
    assert.equal(listed?.status, "update_available")
    assert.equal(listed?.changedHere, false)
    // Listing never applies anything
    assert.equal((await installed("built_conn")).code, oldCode)
    assert.equal((await installed("built_conn")).recipe?.connectorVersion, 1)

    await installLibraryEntry(pool, libraryPath, "built_conn", editorId, BUMPED)
    const updated = await installed("built_conn")
    assert.equal(updated.code, await connectorCode("sheet_link", libraryPath))
    assert.notEqual(updated.code, oldCode)
    assert.equal(updated.recipe?.connectorVersion, 2)
    assert.deepEqual(updated.recipe?.config, recipe().config)
    assert.deepEqual(updated.trigger, { cron: "0 9 * * 1" })
    assert.equal((await listLibrary(pool, libraryPath, { connectors: BUMPED })).find(e => e.id === "built_conn")?.status, "installed")

    // The explicit route answers 409 when the connector is current, and is not for viewers
    assert.equal((await post("/api/integrations/built_conn/apply-connector-update", viewer)).status, 403)
    assert.equal((await post("/api/integrations/lib_none/apply-connector-update", editor)).status, 404)
  } finally {
    await writeFile(connectorFile, original)
  }
  await installBuilt("built_current")
  assert.equal((await post("/api/integrations/built_current/apply-connector-update", editor)).status, 409)
})

test("edited_copy_is_changed_here_and_not_update", async () => {
  await installBuilt("built_edit")
  await proposeAndApprove("built_edit")
  const current = await installed("built_edit")
  const edited = {
    ...current,
    recipe: { ...current.recipe!, config: { ...current.recipe!.config, source: { url: "https://data.example.org/other.csv" } } }
  }
  await installIntegration(pool, edited, "ready", editorId)

  const entry = (await entries(editor)).find(e => e.id === "built_edit")
  assert.equal(entry?.status, "installed")
  assert.equal(entry?.changedHere, true)

  // A connector update applied to an edited copy keeps the local settings
  const bumped = (await listLibrary(pool, libraryPath, { connectors: BUMPED })).find(e => e.id === "built_edit")
  assert.equal(bumped?.status, "update_available")
  assert.equal(bumped?.changedHere, true)
  await installLibraryEntry(pool, libraryPath, "built_edit", editorId, BUMPED)
  const after = await installed("built_edit")
  assert.equal(after.recipe?.connectorVersion, 2)
  assert.deepEqual(after.recipe?.config.source, { url: "https://data.example.org/other.csv" })
})

test("id_clash_with_shipped_entry_refused", async () => {
  // A builder source under a shipped entry's id (possible only by hand) cannot be proposed
  const definition = await buildDefinition(
    { id: "lib_shipped", name: { _base: "en", en: "Clash" }, source: { name: { _base: "en", en: "X" } }, trigger: {}, recipe: recipe() },
    libraryPath
  )
  await installIntegration(pool, definition, "ready", editorId, false, true)
  const response = await post("/api/library/built", editor, { integrationId: "lib_shipped" })
  assert.equal(response.status, 409)
  assert.equal((await pool.query("SELECT 1 FROM app.built_library_entries WHERE id = 'lib_shipped'")).rows.length, 0)

  // A built entry's id is taken for the builder even once its source is deleted, until rejected
  await installBuilt("built_taken")
  assert.equal((await post("/api/library/built", editor, { integrationId: "built_taken" })).status, 200)
  assert.equal((await deleteIntegration(pool, "built_taken")).ok, true)
  assert.equal(await idTaken(pool, libraryPath, "built_taken"), true)
  assert.equal((await post("/api/library/built/built_taken/reject", admin)).status, 200)
  assert.equal(await idTaken(pool, libraryPath, "built_taken"), false)
})

test("library_install_rejects_inspect_mode", async () => {
  const bad = { id: "built_inspect", name: { _base: "en", en: "Bad" }, runtime: "python", destinations: [], contract: 2,
    recipe: { ...recipe(), config: { ...recipe().config, columns: [], mode: "inspect" } } }
  await pool.query(
    `INSERT INTO app.built_library_entries (id, definition, status, proposed_by, proposed_at, approved_by, decided_at)
     VALUES ($1, $2, 'approved', $3, now(), $3, now())`,
    ["built_inspect", JSON.stringify(bad), adminId]
  )
  const response = await post("/api/library/built_inspect/install", editor)
  assert.equal(response.status, 400)
  assert.match(((await response.json()) as { error: string }).error, /preview state/)
  assert.equal((await pool.query("SELECT 1 FROM app.integrations WHERE id = 'built_inspect'")).rows.length, 0)
})

/** Approves a new version of an approved entry whose source address is `url`, as if proposed from another copy. */
async function approveNewVersion(id: string, url: string): Promise<void> {
  const row = (await pool.query("SELECT definition FROM app.built_library_entries WHERE id = $1", [id])).rows[0]
  const next = structuredClone(row.definition)
  next.recipe.config.source = { url }
  await pool.query("UPDATE app.built_library_entries SET pending_definition = $2 WHERE id = $1", [id, JSON.stringify(next)])
  const approved = await post(`/api/library/built/${id}/approve`, admin)
  assert.equal(approved.status, 200, await approved.clone().text())
}

test("approved_v2_shows_update_on_installed_v1", async () => {
  await installBuilt("built_v2")
  await proposeAndApprove("built_v2")
  assert.equal((await entries(editor)).find(e => e.id === "built_v2")?.status, "installed")
  await approveNewVersion("built_v2", "https://data.example.org/v2.csv")
  const entry = (await entries(editor)).find(e => e.id === "built_v2")
  assert.equal(entry?.status, "update_available")
  assert.equal(entry?.changedHere, false)
  // Listing never applies anything
  assert.equal((await installed("built_v2")).recipe?.config.source.url, "https://data.example.org/cases.csv")
})

test("apply_v2_keeps_deployment_fields", async () => {
  await installBuilt("built_apply")
  await proposeAndApprove("built_apply")
  // Deployment fields changed here are not local edits of the source
  await installIntegration(pool, { ...(await installed("built_apply")), trigger: { cron: "0 9 * * 1" }, limits: { timeoutMs: 60000 } }, "ready", editorId)
  await approveNewVersion("built_apply", "https://data.example.org/v2.csv")
  assert.equal((await entries(editor)).find(e => e.id === "built_apply")?.status, "update_available")
  const response = await post("/api/library/built_apply/install", editor)
  assert.equal(response.status, 200, await response.clone().text())
  const after = await installed("built_apply")
  assert.equal(after.recipe?.config.source.url, "https://data.example.org/v2.csv")
  assert.deepEqual(after.trigger, { cron: "0 9 * * 1" })
  assert.deepEqual(after.limits, { timeoutMs: 60000 })
  assert.equal(after.code, await connectorCode("sheet_link", libraryPath))
  const entry = (await entries(editor)).find(e => e.id === "built_apply")
  assert.equal(entry?.status, "installed")
  assert.equal(entry?.changedHere, false)
  const base = (await pool.query("SELECT built_base FROM app.integrations WHERE id = 'built_apply'")).rows[0].built_base
  assert.equal(base.version, 2)
})

test("local_edit_still_changed_here", async () => {
  await installBuilt("built_local")
  await proposeAndApprove("built_local")
  const current = await installed("built_local")
  await installIntegration(pool, {
    ...current,
    recipe: { ...current.recipe!, config: { ...current.recipe!.config, source: { url: "https://data.example.org/mine.csv" } } }
  }, "ready", editorId)
  await approveNewVersion("built_local", "https://data.example.org/v2.csv")
  const entry = (await entries(editor)).find(e => e.id === "built_local")
  assert.equal(entry?.status, "installed")
  assert.equal(entry?.changedHere, true)
  // Installing over it keeps the local recipe (a connector-only update)
  await installLibraryEntry(pool, libraryPath, "built_local", editorId)
  assert.equal((await installed("built_local")).recipe?.config.source.url, "https://data.example.org/mine.csv")
})

/** A definition whose recipe is sound but whose other fields were tampered with. */
async function tampered(id: string): Promise<Record<string, unknown>> {
  const good = await buildDefinition(
    { id, name: { _base: "en", en: `Cases ${id}` }, source: { name: { _base: "en", en: "MoH" } }, trigger: {}, recipe: recipe() },
    libraryPath
  )
  const { code: _code, trigger: _trigger, ...rest } = good
  void _code
  void _trigger
  return {
    ...rest,
    description: { _base: "en", en: "Weekly cases" },
    runtime: "node",
    destinations: [{ kind: "table", tableId: "app_users_copy", action: "replace", columns: [{ id: "evil", type: "text" }] }],
    inputs: { stolen: { kind: "table", tableId: "other_table", format: "csv" } },
    secrets: ["other_key"],
    files: { data: { accept: [".csv"] } }
  }
}

function assertRebuilt(definition: Record<string, any>, id: string): void {
  assert.equal(definition.runtime, "python")
  assert.equal(definition.destinations.length, 1)
  assert.equal(definition.destinations[0].tableId, id)
  assert.deepEqual(definition.destinations[0].columns.map((c: any) => c.id), ["region", "cases"])
  assert.equal(definition.inputs, undefined)
  assert.equal(definition.secrets, undefined)
  assert.equal(definition.files, undefined)
  assert.deepEqual(definition.description, { _base: "en", en: "Weekly cases" })
}

test("import_with_mismatched_destination_is_rebuilt", async () => {
  const response = await post("/api/library/built/import", admin, {
    format: "wash-di-library-entry", version: 1, definition: await tampered("built_imp_tamper")
  })
  assert.equal(response.status, 200, await response.clone().text())
  const row = (await pool.query("SELECT definition FROM app.built_library_entries WHERE id = 'built_imp_tamper'")).rows[0]
  assertRebuilt(row.definition, "built_imp_tamper")
  assert.equal("code" in row.definition, false)
})

test("install_rebuilds_from_recipe", async () => {
  await pool.query(
    `INSERT INTO app.built_library_entries (id, definition, status, proposed_by, proposed_at, approved_by, decided_at)
     VALUES ($1, $2, 'approved', $3, now(), $3, now())`,
    ["built_tamper", JSON.stringify(await tampered("built_tamper")), adminId]
  )
  await installLibraryEntry(pool, libraryPath, "built_tamper", editorId)
  const definition = await installed("built_tamper")
  assertRebuilt(definition as unknown as Record<string, any>, "built_tamper")
  assert.equal(definition.code, await connectorCode("sheet_link", libraryPath))
  assert.equal((await entries(editor)).find(e => e.id === "built_tamper")?.changedHere, false)
})

test("library_search_skips_invalid_built_entries", async () => {
  // built_inspect (an approved entry with an inspect-mode recipe) cannot be loaded
  const text = await searchLibrary(pool, libraryPath, "cases")
  assert.ok(!text.includes("built_inspect"), text)
  assert.ok(text.includes("built_share"), text)
})
