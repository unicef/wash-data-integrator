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
import { CONNECTORS } from "../src/builder/connectors.js"
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
  await pool.query("UPDATE app.integrations SET definition = jsonb_set(definition, '{trigger}', '{\"cron\":\"0 6 * * *\"}') WHERE id = 'edit_cases'")

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
  assert.equal(row.rows[0].definition.trigger.cron, "0 6 * * *")
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

/** A keyed web_api source installed with an admin's key, and an edit draft of it. */
async function keyedEdit(id: string): Promise<string> {
  const first = await newDraft()
  await saveDraft(first, draftState(id, "web_api", { url: "https://data.example.org/api", auth: "key" }))
  const set = await call(`/api/builder/drafts/${first}/secrets/api_key`, admin, { method: "PUT", body: JSON.stringify({ value: "s3cret-value-123" }) })
  assert.equal(set.status, 200)
  assert.equal((await accept(first)).status, 200)
  const opened = await edit(id)
  assert.equal(opened.status, 201, await opened.clone().text())
  return ((await opened.json()) as { id: string }).id
}

const keyRows = async (draftId: string) =>
  (await pool.query("SELECT 1 FROM app.draft_secrets WHERE session_id = $1", [draftId])).rows.length

async function withUrl(draftId: string, url: string): Promise<void> {
  const got = (await (await call(`/api/builder/drafts/${draftId}`, editor)).json()) as { state: Record<string, any> }
  const state = got.state
  state.recipe.config.source = { ...state.recipe.config.source, url }
  await saveDraft(draftId, state)
}

test("edit_draft_url_host_change_drops_key", async () => {
  const draftId = await keyedEdit("edit_key_a")
  assert.equal(await keyRows(draftId), 1)
  HOSTS["evil.example.net"] = ["93.184.215.15"]
  await withUrl(draftId, "https://evil.example.net/api")
  assert.equal(await keyRows(draftId), 0)
  const preview = await call(`/api/builder/drafts/${draftId}/preview`, editor, { method: "POST", body: "{}" })
  assert.equal(preview.status, 409)
  assert.match(((await preview.json()) as { error: string }).error, /Waiting for an admin to add the key/)
  // Going back to the old host does not bring the key back
  await withUrl(draftId, "https://data.example.org/api")
  assert.equal(await keyRows(draftId), 0)
})

test("edit_draft_http_downgrade_drops_key", async () => {
  const draftId = await keyedEdit("edit_key_http")
  await withUrl(draftId, "http://data.example.org/api")
  assert.equal(await keyRows(draftId), 0)
})

test("edit_draft_port_change_drops_key", async () => {
  const draftId = await keyedEdit("edit_key_port")
  await withUrl(draftId, "https://data.example.org:8443/api")
  assert.equal(await keyRows(draftId), 0)
  // An explicit default port is the same origin
  const other = await keyedEdit("edit_key_port2")
  await withUrl(other, "https://data.example.org:443/api")
  assert.equal(await keyRows(other), 1)
})

test("inspect_and_preview_check_the_snapshot_they_run_with", async () => {
  HOSTS["evil.example.net"] = ["93.184.215.15"]
  const svc = new BuilderService(pool, builderOptions)
  let n = 0
  for (const run of [(d: any) => svc.inspect(d), (d: any) => svc.preview(d)]) {
    const copied = await keyedEdit(`edit_snap_${++n}`)
    // The stored row is still good; the snapshot a racing request holds points elsewhere
    const row = (await (await call(`/api/builder/drafts/${copied}`, editor)).json()) as { id: string; state: Record<string, any> }
    const source = { ...row.state.recipe.config.source, url: "https://evil.example.net/api" }
    const snap = { ...row, state: { ...row.state, recipe: { ...row.state.recipe, config: { ...row.state.recipe.config, source } } } }
    await assert.rejects(run(snap), (err: any) => err.status === 409)
    assert.equal(await keyRows(copied), 0)
  }
})

test("edit_draft_same_host_keeps_key", async () => {
  const draftId = await keyedEdit("edit_key_b")
  await withUrl(draftId, "https://data.example.org/other/path")
  assert.equal(await keyRows(draftId), 1)
})

test("edit_accept_after_host_change_needs_admin_key", async () => {
  const draftId = await keyedEdit("edit_key_c")
  HOSTS["evil.example.net"] = ["93.184.215.15"]
  await withUrl(draftId, "https://evil.example.net/api")
  const refused = await accept(draftId)
  assert.equal(refused.status, 409)
  assert.match(((await refused.json()) as { error: string }).error, /Waiting for an admin/)
  // An admin's own key for the draft is kept and lets the accept through
  const set = await call(`/api/builder/drafts/${draftId}/secrets/api_key`, admin, { method: "PUT", body: JSON.stringify({ value: "new-key-456789" }) })
  assert.equal(set.status, 200)
  await withUrl(draftId, "https://evil.example.net/api2")
  assert.equal(await keyRows(draftId), 1)
  assert.equal((await accept(draftId)).status, 200)
  assert.equal((await getSecrets(pool, key, "edit_key_c", ["api_key"])).api_key, "new-key-456789")
})

test("edit_is_refused_while_a_connector_update_is_pending_and_keeps_the_version", async () => {
  const first = await newDraft()
  await saveDraft(first, draftState("edit_ver", "sheet_link", { url: "https://data.example.org/a.csv" }))
  assert.equal((await accept(first)).status, 200)
  const real = builderOptions.connectors
  builderOptions.connectors = { ...CONNECTORS, sheet_link: { ...CONNECTORS.sheet_link, version: 2 } }
  try {
    const refused = await edit("edit_ver")
    assert.equal(refused.status, 409)
    assert.match(((await refused.json()) as { error: string }).error, /Apply the connector update first/)
  } finally {
    builderOptions.connectors = real
  }
  // The draft's recipe keeps the installed version even if a client sends another
  const draftId = ((await (await edit("edit_ver")).json()) as { id: string }).id
  const got = (await (await call(`/api/builder/drafts/${draftId}`, editor)).json()) as { state: Record<string, any> }
  await saveDraft(draftId, { ...got.state, recipe: { ...got.state.recipe, connectorVersion: 7 } })
  const saved = (await (await call(`/api/builder/drafts/${draftId}`, editor)).json()) as { state: Record<string, any> }
  assert.equal(saved.state.recipe.connectorVersion, 1)
})

test("edit_accept_refuses_while_a_connector_update_is_pending", async () => {
  const first = await newDraft()
  await saveDraft(first, draftState("edit_acc_ver", "sheet_link", { url: "https://data.example.org/a.csv" }))
  assert.equal((await accept(first)).status, 200)
  const draftId = ((await (await edit("edit_acc_ver")).json()) as { id: string }).id
  const real = builderOptions.connectors
  builderOptions.connectors = { ...CONNECTORS, sheet_link: { ...CONNECTORS.sheet_link, version: 2 } }
  try {
    const refused = await accept(draftId)
    assert.equal(refused.status, 409)
    assert.match(((await refused.json()) as { error: string }).error, /Apply the connector update first/)
    assert.equal((await pool.query("SELECT version FROM app.integrations WHERE id = 'edit_acc_ver'")).rows[0].version, 1)
  } finally {
    builderOptions.connectors = real
  }
})

test("edit_accept_keeps_status_and_queues_no_run_when_paused", async () => {
  const first = await newDraft()
  await saveDraft(first, draftState("edit_paused", "sheet_link", { url: "https://data.example.org/a.csv" }))
  assert.equal((await accept(first)).status, 200)
  await pool.query("UPDATE app.integrations SET enabled = false, status = 'draft' WHERE id = 'edit_paused'")
  await pool.query("DELETE FROM app.runs WHERE integration_id = 'edit_paused'")
  const draftId = ((await (await edit("edit_paused")).json()) as { id: string }).id
  const response = await accept(draftId)
  assert.equal(response.status, 200, await response.clone().text())
  assert.equal(((await response.json()) as { runId?: string }).runId, undefined)
  const row = await pool.query("SELECT status, enabled FROM app.integrations WHERE id = 'edit_paused'")
  assert.deepEqual(row.rows[0], { status: "draft", enabled: false })
  assert.equal((await pool.query("SELECT 1 FROM app.runs WHERE integration_id = 'edit_paused'")).rows.length, 0)
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


