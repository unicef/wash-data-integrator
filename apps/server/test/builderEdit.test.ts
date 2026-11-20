import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import { chmod, mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { AddressInfo } from "node:net"
import { Server } from "node:http"
import { randomBytes } from "node:crypto"
import { fileURLToPath } from "node:url"
import pg from "pg"
import { Runner } from "@mwater/integration-runner"
import { migrate } from "../src/migrations.js"
import { createApiToken, createUser } from "../src/auth.js"
import { createApiServer } from "../src/server.js"
import { TileRenderer } from "../src/tiles.js"
import { RasterStore } from "../src/rasterStore.js"
import { FileStore } from "../src/fileStore.js"
import { installIntegration } from "../src/install.js"
import { getSecrets } from "../src/secrets.js"
import { BuilderOptions, BuilderService } from "../src/builder/drafts.js"
import { startTestDb, TestDb } from "./helpers/pg.js"

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "migrations")
const LIBRARY = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "library")

const PY_IMAGE = "localhost/integrator-runtime-python:dev"

const HOSTS: Record<string, string[]> = { "data.example.org": ["93.184.215.14"] }
async function resolve(host: string): Promise<string[]> {
  const found = HOSTS[host]
  if (!found) throw new Error(`no such host ${host}`)
  return found
}
let builderOptions: BuilderOptions
let db: TestDb
let pool: pg.Pool
let server: Server
let base: string
let store: RasterStore
let workRoot: string
let admin: string
let editor: string
let otherEditor: string
let viewer: string
const key = randomBytes(32)
const runner = new Runner({ network: "integrator-jobs-exec", egress: "open" })

before(async () => {
  db = await startTestDb()
  pool = new pg.Pool({ connectionString: db.url })
  await migrate(pool, MIGRATIONS_DIR)
  process.env.INTEGRATOR_SECRET_KEY = key.toString("hex")
  admin = await createApiToken(pool, (await createUser(pool, "admin@example.org", "hunter2hunter2", "admin")).id, "a")
  editor = await createApiToken(pool, (await createUser(pool, "editor@example.org", "hunter2hunter2", "editor")).id, "e")
  otherEditor = await createApiToken(pool, (await createUser(pool, "other@example.org", "hunter2hunter2", "editor")).id, "o")
  viewer = await createApiToken(pool, (await createUser(pool, "viewer@example.org", "hunter2hunter2", "viewer")).id, "v")

  const storeRoot = await mkdtemp(path.join(tmpdir(), "builder-store-"))
  await chmod(storeRoot, 0o755)
  store = new RasterStore(storeRoot)
  workRoot = await mkdtemp(path.join(tmpdir(), "builder-work-"))
  const files = new FileStore(await mkdtemp(path.join(tmpdir(), "builder-files-")))
  builderOptions = {
    libraryPath: LIBRARY,
    resolve,
    executor: {
      pool,
      runner,
      store,
      workRoot,
      files,
      secretKey: key,
      images: { python: PY_IMAGE },
      databaseUrl: db.url
    }
  }
  const builder = new BuilderService(pool, builderOptions)
  server = createApiServer(
    pool, new TileRenderer(store, "/nonexistent"), null, null, store, null, null, null, LIBRARY, null, null, null,
    { store: files, maxUploadMb: 10 }, builder
  )
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}, { timeout: 180_000 })



after(async () => {
  delete process.env.INTEGRATOR_SECRET_KEY
  server?.close()
  await pool?.end()
  await db?.stop()
})


const accept = (id: string, bearer = editor) => call(`/api/builder/drafts/${id}/accept`, bearer, { method: "POST", body: "{}" })
const edit = (integration: string, bearer = editor) =>
  call(`/api/builder/drafts/from-integration/${integration}`, bearer, { method: "POST", body: "{}" })

test("edit_draft_copies_the_installed_source_and_accept_updates_it", async () => {
  const first = await newDraft()
  await saveDraft(first, draftState("edit_cases", "sheet_link", { url: "https://data.example.org/a.csv" }))
  assert.equal((await accept(first)).status, 200)
  await pool.query("UPDATE app.integrations SET definition = jsonb_set(definition, '{trigger}', '{\"schedule\":\"0 6 * * *\"}') WHERE id = 'edit_cases'")

  const opened = await edit("edit_cases")
  assert.equal(opened.status, 201, await opened.clone().text())
  const draftId = ((await opened.json()) as { id: string }).id
  const got = (await (await call(`/api/builder/drafts/${draftId}`, editor)).json()) as { state: Record<string, any> }
  assert.equal(got.state.id, "edit_cases")
  assert.equal(got.state.editing, "edit_cases")
  assert.equal(got.state.recipe.config.source.url, "https://data.example.org/a.csv")
  assert.equal(got.state.recipe.config.mode, undefined)

  // A client save cannot drop or move the edit target
  const state = { ...got.state, id: "somewhere_else", editing: undefined }
  state.recipe = { ...state.recipe, config: { ...state.recipe.config, source: { url: "https://data.example.org/b.csv" } } }
  await saveDraft(draftId, state)
  const accepted = await accept(draftId)
  assert.equal(accepted.status, 200, await accepted.clone().text())
  const row = await pool.query("SELECT version, enabled, definition FROM app.integrations WHERE id = 'edit_cases'")
  assert.equal(row.rows[0].version, 2)
  assert.equal(row.rows[0].definition.recipe.config.source.url, "https://data.example.org/b.csv")
  // The schedule is the deployment's and stays
  assert.equal(row.rows[0].definition.trigger.schedule, "0 6 * * *")
  assert.equal((await pool.query("SELECT 1 FROM app.integrations WHERE id = 'somewhere_else'")).rows.length, 0)
})

test("edit_refuses_a_source_without_recipe_and_unknown_ones", async () => {
  assert.equal((await edit("no_such_source")).status, 404)
  await installIntegration(pool, {
    id: "plain_one", name: { _base: "en", en: "Plain" }, trigger: {}, runtime: "python",
    destinations: [{ kind: "table", tableId: "plain_one", action: "replace", columns: [{ id: "x", type: "text" }] }],
    code: "def run(ctx): ...", contract: 2
  } as never)
  assert.equal((await edit("plain_one")).status, 400)
  assert.equal((await edit("plain_one", viewer)).status, 403)
})

test("edit_cannot_change_the_connector", async () => {
  const first = await newDraft()
  await saveDraft(first, draftState("edit_conn", "sheet_link", { url: "https://data.example.org/a.csv" }))
  assert.equal((await accept(first)).status, 200)
  const draftId = ((await (await edit("edit_conn")).json()) as { id: string }).id
  await saveDraft(draftId, draftState("edit_conn", "hdx", { url: "https://data.example.org/d", resourceId: "r" }))
  assert.equal((await accept(draftId)).status, 400)
})

test("integration_detail_lists_unmatched_places_of_a_run", async () => {
  const first = await newDraft()
  await saveDraft(first, draftState("unmatched_src", "sheet_link", { url: "https://data.example.org/a.csv" }))
  assert.equal((await accept(first)).status, 200)
  await pool.query("UPDATE app.runs SET status = 'succeeded', started_at = now(), state_out = $1 WHERE integration_id = 'unmatched_src'", [
    JSON.stringify({ rows: 3, unmatchedCount: 2, unmatchedPlaces: ["Bary", "Gjirokaster"] })
  ])
  const detail = (await (await call("/api/integrations/unmatched_src", editor)).json()) as { runs: { unmatched: unknown }[] }
  assert.deepEqual(detail.runs[0].unmatched, { count: 2, places: ["Bary", "Gjirokaster"] })
})

test("integration_detail_reports_a_connector_update", async () => {
  const first = await newDraft()
  await saveDraft(first, draftState("old_conn", "sheet_link", { url: "https://data.example.org/a.csv" }))
  assert.equal((await accept(first)).status, 200)
  const current = (await (await call("/api/integrations/old_conn", editor)).json()) as { connectorUpdate: unknown }
  assert.equal(current.connectorUpdate, null)
  await pool.query("UPDATE app.integrations SET definition = jsonb_set(definition, '{recipe,connectorVersion}', '0') WHERE id = 'old_conn'")
  const behind = (await (await call("/api/integrations/old_conn", editor)).json()) as { connectorUpdate: unknown }
  assert.deepEqual(behind.connectorUpdate, { from: 0, to: 1 })
})

function call(pathname: string, bearer: string, init?: RequestInit): Promise<Response> {
  return fetch(`${base}${pathname}`, {
    ...init,
    headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json", ...init?.headers }
  })
}

async function newDraft(bearer = editor): Promise<string> {
  const response = await call("/api/builder/drafts", bearer, { method: "POST", body: "{}" })
  assert.equal(response.status, 201)
  return ((await response.json()) as { id: string }).id
}

/** A builder draft's saved screens. */
function draftState(id: string, connector: string, source: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return {
    step: "preview",
    id,
    name: { _base: "en", en: "Cholera cases" },
    source: { name: { _base: "en", en: "Ministry of Health" } },
    trigger: {},
    recipe: {
      connector,
      connectorVersion: 1,
      config: {
        source,
        columns: [
          { from: "region", id: "region", type: "place" },
          { from: "cases", id: "cases", type: "number" }
        ],
        cleanup: {},
        writeMode: connector === "webhook" ? "append" : "replace",
        ...extra
      }
    }
  }
}

async function saveDraft(draftId: string, state: unknown, bearer = editor): Promise<void> {
  const response = await call(`/api/builder/drafts/${draftId}`, bearer, { method: "PUT", body: JSON.stringify(state) })
  assert.equal(response.status, 200, await response.text())
}


