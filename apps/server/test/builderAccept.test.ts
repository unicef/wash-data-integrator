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

test("accept_installs_and_queues_first_run", async () => {
  const id = await newDraft()
  await saveDraft(id, draftState("sheet_cases", "sheet_link", { url: "https://data.example.org/cases.csv" }))
  const response = await accept(id)
  assert.equal(response.status, 200, await response.clone().text())
  const body = (await response.json()) as { integrationId: string; webhookUrl?: string }
  assert.equal(body.integrationId, "sheet_cases")
  assert.equal(body.webhookUrl, undefined)
  const row = await pool.query("SELECT status, enabled FROM app.integrations WHERE id = 'sheet_cases'")
  assert.equal(row.rows[0].status, "ready")
  const runs = await pool.query("SELECT trigger, status FROM app.runs WHERE integration_id = 'sheet_cases'")
  assert.deepEqual(runs.rows, [{ trigger: "manual", status: "queued" }])
  const session = await pool.query("SELECT status FROM app.agent_sessions WHERE id = $1", [id])
  assert.equal(session.rows[0].status, "finished")
  // A second accept of the same draft is refused
  assert.equal((await accept(id)).status, 409)
})

test("accept_rejects_inspect_mode_recipe", async () => {
  const id = await newDraft()
  await saveDraft(id, draftState("inspect_left", "sheet_link", { url: "https://data.example.org/a.csv" }, { mode: "inspect", columns: [] }))
  const refused = await accept(id)
  assert.equal(refused.status, 400)
  assert.match(((await refused.json()) as { error: string }).error, /preview state/)
  assert.equal((await pool.query("SELECT 1 FROM app.integrations WHERE id = 'inspect_left'")).rows.length, 0)
})

test("accept_refuses_taken_id", async () => {
  const first = await newDraft()
  await saveDraft(first, draftState("taken_one", "sheet_link", { url: "https://data.example.org/a.csv" }))
  assert.equal((await accept(first)).status, 200)
  const second = await newDraft()
  await saveDraft(second, draftState("taken_one", "sheet_link", { url: "https://data.example.org/b.csv" }))
  const refused = await accept(second)
  assert.equal(refused.status, 409)
  // A shipped library entry is taken too
  const shipped = await newDraft()
  await saveDraft(shipped, draftState("copernicus_dem_glo30", "sheet_link", { url: "https://data.example.org/c.csv" }))
  assert.equal((await accept(shipped)).status, 409)
  // An invalid recipe is a 400 with the validator's message
  const bad = await newDraft()
  await saveDraft(bad, draftState("bad_one", "sheet_link", {}))
  const invalid = await accept(bad)
  assert.equal(invalid.status, 400)
  assert.match(((await invalid.json()) as { error: string }).error, /url/)
  assert.equal((await pool.query("SELECT 1 FROM app.integrations WHERE id = 'bad_one'")).rows.length, 0)
})

test("upload_file_becomes_slot_version_1", async () => {
  const id = await newDraft()
  const upload = await call(`/api/builder/drafts/${id}/files/data?filename=cases.csv`, editor, {
    method: "PUT",
    body: "region,cases\nBari,3\n",
    headers: { "content-type": "text/csv" }
  })
  assert.equal(upload.status, 201, await upload.text())
  await saveDraft(id, draftState("upload_cases", "upload", {}))
  const response = await accept(id)
  assert.equal(response.status, 200, await response.clone().text())
  const version = await pool.query(
    "SELECT id, version, slot_id, session_id FROM app.file_versions WHERE integration_id = 'upload_cases'"
  )
  assert.equal(version.rows.length, 1)
  assert.equal(version.rows[0].version, 1)
  assert.equal(version.rows[0].slot_id, "data")
  const run = await pool.query("SELECT file_pins FROM app.runs WHERE integration_id = 'upload_cases'")
  assert.deepEqual(run.rows[0].file_pins, { data: version.rows[0].id })
})

test("upload_accept_without_file_is_refused_and_installs_nothing", async () => {
  const id = await newDraft()
  await saveDraft(id, draftState("upload_none", "upload", {}))
  assert.equal((await accept(id)).status, 400)
  assert.equal((await pool.query("SELECT 1 FROM app.integrations WHERE id = 'upload_none'")).rows.length, 0)
})

test("webhook_accept_returns_url_no_run", async () => {
  const id = await newDraft()
  await saveDraft(id, draftState("hook_cases", "webhook", { sampleMessage: { region: "Bari", cases: 3 } }))
  const response = await accept(id)
  assert.equal(response.status, 200, await response.clone().text())
  const body = (await response.json()) as { integrationId: string; webhookUrl: string }
  const token = await pool.query("SELECT webhook_token FROM app.integrations WHERE id = 'hook_cases'")
  assert.equal(body.webhookUrl, `/hooks/${token.rows[0].webhook_token}`)
  assert.equal((await pool.query("SELECT 1 FROM app.runs WHERE integration_id = 'hook_cases'")).rows.length, 0)
})

test("key_moves_to_integration_secret", async () => {
  const id = await newDraft()
  await saveDraft(id, draftState("keyed_cases", "web_api", { url: "https://data.example.org/api", auth: "key" }))
  const set = await call(`/api/builder/drafts/${id}/secrets/api_key`, admin, { method: "PUT", body: JSON.stringify({ value: "s3cret-value-123" }) })
  assert.equal(set.status, 200)
  const response = await accept(id)
  assert.equal(response.status, 200, await response.clone().text())
  assert.ok(!(await response.clone().text()).includes("s3cret-value-123"))
  const moved = await getSecrets(pool, key, "keyed_cases", ["api_key"])
  assert.equal(moved.api_key, "s3cret-value-123")
  assert.equal((await pool.query("SELECT 1 FROM app.draft_secrets WHERE session_id = $1", [id])).rows.length, 0)
})

test("accept_waits_for_key", async () => {
  const id = await newDraft()
  await saveDraft(id, draftState("nokey_cases", "web_api", { url: "https://data.example.org/api", auth: "key" }))
  const response = await accept(id)
  assert.equal(response.status, 409)
  assert.match(((await response.json()) as { error: string }).error, /Waiting for an admin to add the key/)
  assert.equal((await pool.query("SELECT 1 FROM app.integrations WHERE id = 'nokey_cases'")).rows.length, 0)
  // Once the key is added the same draft accepts
  await call(`/api/builder/drafts/${id}/secrets/api_key`, admin, { method: "PUT", body: JSON.stringify({ value: "abcdef123456" }) })
  assert.equal((await accept(id)).status, 200)
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


async function stage(draftId: string, body: string): Promise<void> {
  const upload = await call(`/api/builder/drafts/${draftId}/files/data?filename=cases.csv`, editor, {
    method: "PUT",
    body,
    headers: { "content-type": "text/csv" }
  })
  assert.equal(upload.status, 201, await upload.text())
}

test("accept_refuses_id_installed_meanwhile", async () => {
  const id = await newDraft()
  await saveDraft(id, draftState("meanwhile_one", "sheet_link", { url: "https://data.example.org/a.csv" }))
  builderOptions.beforeInstall = async taken => {
    await installIntegration(pool, {
      id: taken, name: { _base: "en", en: "Other" }, trigger: {}, runtime: "python",
      destinations: [{ kind: "table", tableId: taken, action: "replace", columns: [{ id: "x", type: "text" }] }],
      code: "def run(ctx): ...", contract: 2
    })
  }
  try {
    const refused = await accept(id)
    assert.equal(refused.status, 409)
  } finally {
    delete builderOptions.beforeInstall
  }
  // The other install is untouched (version 1, still enabled, not deleted)
  const row = await pool.query("SELECT version, enabled FROM app.integrations WHERE id = 'meanwhile_one'")
  assert.deepEqual(row.rows, [{ version: 1, enabled: true }])
  assert.equal((await pool.query("SELECT status FROM app.agent_sessions WHERE id = $1", [id])).rows[0].status, "active")
})

test("rollback_on_file_failure_removes_only_its_own_install", async () => {
  const id = await newDraft()
  await stage(id, "region,cases\nBari,3\n")
  await saveDraft(id, draftState("rollback_files", "upload", {}))
  await pool.query(`CREATE OR REPLACE FUNCTION app.test_block_adopt() RETURNS trigger AS $$
    BEGIN IF NEW.integration_id = 'rollback_files' THEN RAISE EXCEPTION 'blocked for test'; END IF; RETURN NEW; END $$ LANGUAGE plpgsql`)
  await pool.query("CREATE TRIGGER test_block_adopt BEFORE UPDATE ON app.file_versions FOR EACH ROW EXECUTE FUNCTION app.test_block_adopt()")
  try {
    const failed = await accept(id)
    assert.ok(failed.status >= 400)
  } finally {
    await pool.query("DROP TRIGGER test_block_adopt ON app.file_versions")
  }
  assert.equal((await pool.query("SELECT 1 FROM app.integrations WHERE id = 'rollback_files'")).rows.length, 0)
  assert.equal((await pool.query("SELECT 1 FROM app.integration_secrets WHERE integration_id = 'rollback_files'")).rows.length, 0)
  assert.equal((await pool.query("SELECT status FROM app.agent_sessions WHERE id = $1", [id])).rows[0].status, "active")
  const staged = await pool.query("SELECT integration_id FROM app.file_versions WHERE session_id = $1", [id])
  assert.deepEqual(staged.rows, [{ integration_id: null }])
  // A retry once the fault is gone succeeds
  assert.equal((await accept(id)).status, 200)
})

test("upload_three_times_installs_one_version", async () => {
  const id = await newDraft()
  await stage(id, "region,cases\nBari,1\n")
  await stage(id, "region,cases\nBari,2\n")
  await stage(id, "region,cases\nBari,3\n")
  await saveDraft(id, draftState("upload_thrice", "upload", {}))
  assert.equal((await accept(id)).status, 200)
  const versions = await pool.query("SELECT version FROM app.file_versions WHERE integration_id = 'upload_thrice'")
  assert.deepEqual(versions.rows, [{ version: 1 }])
})

test("concurrent_accepts_of_one_draft_install_once", async () => {
  const id = await newDraft()
  await saveDraft(id, draftState("race_one", "sheet_link", { url: "https://data.example.org/a.csv" }))
  const [a, b] = await Promise.all([accept(id), accept(id)])
  assert.deepEqual([a.status, b.status].sort(), [200, 409])
  assert.equal((await pool.query("SELECT 1 FROM app.runs WHERE integration_id = 'race_one'")).rows.length, 1)
})
