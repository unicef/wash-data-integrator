import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { access, chmod, mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { AddressInfo } from "node:net"
import { Server } from "node:http"
import { randomBytes } from "node:crypto"
import { fileURLToPath } from "node:url"
import pg from "pg"
import { Runner } from "@mwater/integration-runner"
import { IntegrationDefinition } from "@data-integrator/definitions"
import { migrate } from "../src/migrations.js"
import { createApiToken, createUser } from "../src/auth.js"
import { createApiServer } from "../src/server.js"
import { installIntegration } from "../src/install.js"
import { TileRenderer } from "../src/tiles.js"
import { RasterStore } from "../src/rasterStore.js"
import { FileStore } from "../src/fileStore.js"
import { createDraftSchema, draftSchema } from "../src/scratch.js"
import { sweepHousekeeping } from "../src/housekeeping.js"
import { BuilderService } from "../src/builder/drafts.js"
import { checkLink } from "../src/builder/linkSafety.js"
import { suggestMatches } from "../src/builder/places.js"
import { startTestDb, TestDb } from "./helpers/pg.js"

const execFileP = promisify(execFile)
const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "migrations")
const LIBRARY = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "library")
const PY_IMAGE = "localhost/integrator-runtime-python:dev"

async function ok(cmd: string, args: string[]): Promise<boolean> {
  try {
    await execFileP(cmd, args)
    return true
  } catch {
    return false
  }
}

// Real runs need podman, gVisor and the Python runtime image; CI has them
const PODMAN = await ok("podman", ["--version"])
const RUNSC = await access("/usr/local/bin/runsc").then(() => true, () => false)
const HAS_IMAGE = PODMAN && (await ok("podman", ["image", "exists", PY_IMAGE]))
const RUNS_AVAILABLE = PODMAN && RUNSC && HAS_IMAGE
const NO_RUNS = RUNS_AVAILABLE ? false : "needs podman, runsc and the Python runtime image (runs in CI)"

/** Test DNS: a fixed table, so no lookup leaves the machine. */
const HOSTS: Record<string, string[]> = {
  "localhost": ["127.0.0.1", "::1"],
  "example.org": ["93.184.215.14"],
  "data.example.org": ["93.184.215.14"],
  "sneaky.example.org": ["93.184.215.14", "10.1.2.3"]
}
async function resolve(host: string): Promise<string[]> {
  const found = HOSTS[host]
  if (!found) throw new Error(`no such host ${host}`)
  return found
}

/** A places table: admin areas with codes. */
const PLACES: IntegrationDefinition = {
  id: "som_admin_areas",
  name: { _base: "en", en: "Somalia admin areas" },
  trigger: {},
  runtime: "python",
  destinations: [{
    kind: "table",
    tableId: "som_admin_areas",
    action: "replace",
    columns: [{ id: "name", type: "text" }, { id: "code", type: "text" }]
  }],
  code: "def run(ctx): ...",
  contract: 2
}

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

  await installIntegration(pool, PLACES)
  const loaded = await pool.query(
    "INSERT INTO app.runs (integration_id, trigger, status) VALUES ('som_admin_areas', 'manual', 'succeeded') RETURNING id"
  )
  await pool.query(
    `INSERT INTO data.som_admin_areas (name, code, _run_id) VALUES
     ('Woqooyi Galbeed', 'SO11', $1), ('Banadir', 'SO22', $1), ('Bari', 'SO18', $1), ('Middle Shabelle', 'SO24', $1)`,
    [loaded.rows[0].id]
  )

  const storeRoot = await mkdtemp(path.join(tmpdir(), "builder-store-"))
  await chmod(storeRoot, 0o755)
  store = new RasterStore(storeRoot)
  workRoot = await mkdtemp(path.join(tmpdir(), "builder-work-"))
  const files = new FileStore(await mkdtemp(path.join(tmpdir(), "builder-files-")))
  if (RUNS_AVAILABLE) await runner.ensureReady()
  const builder = new BuilderService(pool, {
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
  })
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
  if (RUNS_AVAILABLE) await runner.teardown()
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

test("viewer_cannot_create_draft", async () => {
  const refused = await call("/api/builder/drafts", viewer, { method: "POST", body: "{}" })
  assert.equal(refused.status, 403)
  const id = await newDraft()
  assert.equal((await call(`/api/builder/drafts/${id}`, viewer)).status, 403)
  assert.equal((await call(`/api/builder/drafts/${id}/preview`, viewer, { method: "POST", body: "{}" })).status, 403)
})

test("draft_visible_to_creator_and_admins_only", async () => {
  const id = await newDraft()
  await saveDraft(id, draftState("cholera_cases", "sheet_link", { url: "https://example.org/a.csv" }))
  const own = await call(`/api/builder/drafts/${id}`, editor)
  assert.equal(own.status, 200)
  const body = (await own.json()) as { id: string; state: { id: string; step: string } }
  assert.equal(body.id, id)
  assert.equal(body.state.id, "cholera_cases")
  assert.equal(body.state.step, "preview")
  assert.equal((await call(`/api/builder/drafts/${id}`, admin)).status, 200)
  assert.equal((await call(`/api/builder/drafts/${id}`, otherEditor)).status, 404)
  assert.equal(
    (await call(`/api/builder/drafts/${id}`, otherEditor, { method: "PUT", body: "{}" })).status,
    404
  )
  // Builder drafts are not design sessions (503 here: no agents are configured)
  assert.notEqual((await call(`/api/sessions/${id}`, admin)).status, 200)
})

test("check_link_rejects_unsafe_targets", async () => {
  await checkLink("https://example.org/a.csv", resolve)
  await checkLink("http://93.184.215.14/a.csv", resolve)
  for (const url of [
    "ftp://example.org/a.csv",
    "file:///etc/passwd",
    "not a url",
    "http://169.254.169.254/latest/meta-data",
    "http://localhost:5432",
    "http://127.0.0.1/",
    "http://10.0.0.5/x.csv",
    "http://172.16.3.4/",
    "http://192.168.1.1/",
    "http://0.0.0.0/",
    "http://[::1]/",
    "http://[fe80::1]/",
    "http://[fd12:3456::1]/",
    "http://[::ffff:10.0.0.1]/",
    "http://sneaky.example.org/a.csv",
    "http://unknown.invalid/"
  ]) {
    await assert.rejects(checkLink(url, resolve), Error, url)
  }
})

test("refuses_private_links", async () => {
  const id = await newDraft()
  for (const url of ["http://169.254.169.254/", "http://localhost:5432", "http://10.0.0.5/x.csv", "ftp://example.org/a.csv"]) {
    await saveDraft(id, draftState("private_link", "sheet_link", { url }))
    for (const action of ["inspect", "preview"]) {
      const response = await call(`/api/builder/drafts/${id}/${action}`, editor, { method: "POST", body: "{}" })
      assert.equal(response.status, 400, `${action} ${url}`)
      assert.match(((await response.json()) as { error: string }).error, /link/i)
    }
  }
  // ArcGIS layer links are checked too
  await saveDraft(id, draftState("private_link", "arcgis", { layerUrl: "http://192.168.0.10/arcgis/rest/services/x/0" }))
  assert.equal((await call(`/api/builder/drafts/${id}/preview`, editor, { method: "POST", body: "{}" })).status, 400)
  const runs = await pool.query("SELECT count(*)::int AS n FROM app.runs WHERE session_id = $1", [id])
  assert.equal(runs.rows[0].n, 0)
})

test("suggest_matches_exact_and_close", async () => {
  const places = [
    { name: "Woqooyi Galbeed", code: "SO11" },
    { name: "Banadir", code: "SO22" },
    { name: "Bari", code: "SO18" },
    { name: "Middle Shabelle", code: "SO24" },
    { name: "Lower Shabelle", code: "SO25" }
  ]
  const result = suggestMatches(["Woqooyi Galbeed Region", "Banaadir", "Gobolka Bari", "Mid Shabelle", "Atlantis"], places)
  assert.equal(result.length, 5)
  assert.equal(result[0].name, "Woqooyi Galbeed Region")
  assert.equal(result[0].exact, "SO11")
  assert.ok(!result[0].close.some(c => c.code === "SO11"), "the exact match is not repeated as close")
  assert.equal(result[1].exact, undefined)
  assert.equal(result[1].close[0].code, "SO22")
  assert.ok(result[1].close[0].score >= 0.5)
  assert.equal(result[2].exact, "SO18")
  assert.equal(result[3].exact, undefined)
  assert.equal(result[3].close[0].code, "SO24")
  assert.ok(result[3].close.length <= 3)
  for (const r of result) {
    for (let i = 1; i < r.close.length; i++) assert.ok(r.close[i - 1].score >= r.close[i].score)
  }
  assert.deepEqual(result[4], { name: "Atlantis", close: [] })

  // Through the route, reading the installed places table
  const id = await newDraft()
  await saveDraft(id, draftState("cases_with_places", "sheet_link", { url: "https://example.org/a.csv" }, {
    places: { column: "region", table: "som_admin_areas", nameColumn: "name", codeColumn: "code", matches: {} }
  }))
  const response = await call(`/api/builder/drafts/${id}/places/suggest`, editor, {
    method: "POST",
    body: JSON.stringify({ names: ["Gobolka Bari", "Banaadir"] })
  })
  assert.equal(response.status, 200)
  const routed = (await response.json()) as { name: string; exact?: string; close: { code: string }[] }[]
  assert.equal(routed[0].exact, "SO18")
  assert.equal(routed[1].close[0].code, "SO22")

  // Table and column names must be an installed table's
  for (const places of [
    { column: "region", table: "app.users", nameColumn: "name", codeColumn: "code", matches: {} },
    { column: "region", table: "som_admin_areas", nameColumn: "name; DROP TABLE x", codeColumn: "code", matches: {} },
    { column: "region", table: "no_such_table", nameColumn: "name", codeColumn: "code", matches: {} }
  ]) {
    await saveDraft(id, draftState("cases_with_places", "sheet_link", { url: "https://example.org/a.csv" }, { places }))
    const bad = await call(`/api/builder/drafts/${id}/places/suggest`, editor, {
      method: "POST",
      body: JSON.stringify({ names: ["Bari"] })
    })
    assert.equal(bad.status, 400, JSON.stringify(places))
  }
})

test("editor_cannot_set_key_admin_can", async () => {
  const id = await newDraft()
  await saveDraft(id, draftState("keyed_api", "web_api", { url: "https://data.example.org/api", auth: "key" }))
  const refused = await call(`/api/builder/drafts/${id}/secrets/api_key`, editor, {
    method: "PUT",
    body: JSON.stringify({ value: "editor-tried-this" })
  })
  assert.equal(refused.status, 403)
  const before = (await (await call(`/api/builder/drafts/${id}/secrets`, editor)).json()) as { secrets: { name: string }[] }
  assert.deepEqual(before.secrets, [])
  const set = await call(`/api/builder/drafts/${id}/secrets/api_key`, admin, {
    method: "PUT",
    body: JSON.stringify({ value: "admin-set-this-key" })
  })
  assert.equal(set.status, 200)
  const names = (await (await call(`/api/builder/drafts/${id}/secrets`, editor)).json()) as { secrets: { name: string }[] }
  assert.deepEqual(names.secrets.map(s => s.name), ["api_key"])
  // The key is draft-scoped: no integration row claims the draft id
  assert.equal((await pool.query("SELECT 1 FROM app.integrations WHERE id = 'keyed_api'")).rows.length, 0)
  // Viewers see nothing, not even names
  assert.equal((await call(`/api/builder/drafts/${id}/secrets`, viewer)).status, 403)
})

test("key_never_returned", async () => {
  const value = "super-secret-api-key-value"
  const id = await newDraft()
  await saveDraft(id, draftState("keyed_api_two", "web_api", { url: "https://data.example.org/api", auth: "key" }))
  const set = await call(`/api/builder/drafts/${id}/secrets/api_key`, admin, { method: "PUT", body: JSON.stringify({ value }) })
  assert.equal(set.status, 200)
  const texts = [
    await set.text(),
    await (await call(`/api/builder/drafts/${id}/secrets`, admin)).text(),
    await (await call(`/api/builder/drafts/${id}`, admin)).text(),
    await (await call(`/api/builder/drafts/${id}`, editor)).text()
  ]
  for (const text of texts) assert.ok(!text.includes(value), text)
  // Stored encrypted, never in the draft's saved state
  const rows = await pool.query("SELECT value FROM app.draft_secrets WHERE session_id = $1", [id])
  assert.equal(rows.rows.length, 1)
  assert.ok(!Buffer.from(rows.rows[0].value).toString("utf8").includes(value))
  const state = await pool.query("SELECT client_state::text AS s FROM app.agent_sessions WHERE id = $1", [id])
  assert.ok(!String(state.rows[0].s).includes(value))
  // Bad values are refused without echoing them
  const empty = await call(`/api/builder/drafts/${id}/secrets/api_key`, admin, { method: "PUT", body: JSON.stringify({ value: "" }) })
  assert.equal(empty.status, 400)
})

test("upload_stages_in_the_draft", async () => {
  const id = await newDraft()
  const response = await call(`/api/builder/drafts/${id}/files/data?filename=cases.csv`, editor, {
    method: "PUT",
    body: "region,cases\nBari,3\n",
    headers: { "content-type": "text/csv" }
  })
  assert.equal(response.status, 201, await response.text())
  const rows = await pool.query("SELECT slot_id, integration_id FROM app.file_versions WHERE session_id = $1", [id])
  assert.deepEqual(rows.rows, [{ slot_id: "data", integration_id: null }])
  const refused = await call(`/api/builder/drafts/${id}/files/data?filename=cases.csv`, otherEditor, {
    method: "PUT",
    body: "x",
    headers: { "content-type": "text/csv" }
  })
  assert.equal(refused.status, 404)
})

test("preview_needs_an_id_and_a_buildable_recipe", async () => {
  const id = await newDraft()
  assert.equal((await call(`/api/builder/drafts/${id}/preview`, editor, { method: "POST", body: "{}" })).status, 400)
  await saveDraft(id, { ...draftState("bad_recipe", "sheet_link", {}), step: "source" })
  const response = await call(`/api/builder/drafts/${id}/inspect`, editor, { method: "POST", body: "{}" })
  assert.equal(response.status, 400)
  assert.match(((await response.json()) as { error: string }).error, /url/)
})

test("preview_writes_only_draft_schema", { skip: NO_RUNS }, async () => {
  const id = await newDraft()
  const upload = await call(`/api/builder/drafts/${id}/files/data?filename=cases.csv`, editor, {
    method: "PUT",
    body: "region,cases\nGobolka Bari,3\nAtlantis,x\nBanadir,5\n",
    headers: { "content-type": "text/csv" }
  })
  assert.equal(upload.status, 201, await upload.text())
  await saveDraft(id, draftState("uploaded_cases", "upload", {}, {
    places: { column: "region", table: "som_admin_areas", nameColumn: "name", codeColumn: "code", matches: {} }
  }))

  const inspected = await call(`/api/builder/drafts/${id}/inspect`, editor, { method: "POST", body: "{}" })
  assert.equal(inspected.status, 200, await inspected.clone().text())
  const inspect = (await inspected.json()) as { columns: { name: string; sample: unknown[] }[]; rows: number }
  assert.deepEqual(inspect.columns.map(c => c.name), ["region", "cases"])
  assert.equal(inspect.rows, 3)

  const response = await call(`/api/builder/drafts/${id}/preview`, editor, { method: "POST", body: "{}" })
  assert.equal(response.status, 200, await response.clone().text())
  const preview = (await response.json()) as {
    rows: Record<string, unknown>[]; rowCount: number; matched: number; unmatched: string[]; typeErrors: string[]
  }
  assert.ok(preview.rows.length <= 50)
  assert.equal(preview.rowCount, preview.rows.length)
  assert.deepEqual(preview.unmatched, ["Atlantis"])
  assert.equal(preview.matched, 2)
  assert.equal(preview.typeErrors.length, 1)

  // The only table carrying the draft id lives in the draft schema
  const tables = await pool.query("SELECT table_schema FROM information_schema.tables WHERE table_name = 'uploaded_cases'")
  assert.deepEqual(tables.rows.map(r => r.table_schema), [draftSchema(id)])
  assert.equal((await pool.query("SELECT 1 FROM app.integrations WHERE id = 'uploaded_cases'")).rows.length, 0)
  assert.equal((await pool.query("SELECT 1 FROM app.data_tables WHERE id = 'uploaded_cases'")).rows.length, 0)
}, { timeout: 300_000 })

test("draft_cleanup_after_24h", async () => {
  const userId = (await pool.query("SELECT id FROM app.users WHERE email = 'editor@example.org'")).rows[0].id
  const make = async (age: string) => {
    const row = await pool.query(
      `INSERT INTO app.agent_sessions (kind, user_id, status, client_state, created_at, updated_at)
       VALUES ('builder', $1, 'active', '{"id": "old_draft"}', now() - $2::interval, now() - $2::interval) RETURNING id`,
      [userId, age]
    )
    const id = row.rows[0].id as string
    await createDraftSchema(pool, id)
    await pool.query(`CREATE TABLE ${draftSchema(id)}.old_draft (x int)`)
    await pool.query("INSERT INTO app.runs (session_id, trigger, status) VALUES ($1, 'agent', 'succeeded')", [id])
    await pool.query("INSERT INTO app.draft_secrets (session_id, name, value) VALUES ($1, 'api_key', '\\x00')", [id])
    return id
  }
  const stale = await make("25 hours")
  const fresh = await make("1 hour")
  const result = await sweepHousekeeping(pool, store, workRoot)
  assert.ok(result.builderDrafts >= 1)
  const schemaExists = async (id: string) =>
    (await pool.query("SELECT 1 FROM pg_namespace WHERE nspname = $1", [draftSchema(id)])).rows.length > 0
  assert.equal((await pool.query("SELECT 1 FROM app.agent_sessions WHERE id = $1", [stale])).rows.length, 0)
  assert.equal(await schemaExists(stale), false)
  assert.equal((await pool.query("SELECT 1 FROM app.draft_secrets WHERE session_id = $1", [stale])).rows.length, 0)
  assert.equal((await pool.query("SELECT 1 FROM app.runs WHERE session_id = $1", [stale])).rows.length, 0)
  assert.equal((await pool.query("SELECT 1 FROM app.agent_sessions WHERE id = $1", [fresh])).rows.length, 1)
  assert.equal(await schemaExists(fresh), true)
})
