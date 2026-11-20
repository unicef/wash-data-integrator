import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import path from "node:path"
import { fileURLToPath } from "node:url"
import pg from "pg"
import { IntegrationDefinition } from "@data-integrator/definitions"
import { migrate } from "../src/migrations.js"
import { installIntegration, definitionHash } from "../src/install.js"
import { startTestDb, TestDb } from "./helpers/pg.js"

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "migrations")

/** A draft as a design session first saves it. */
const DRAFT: IntegrationDefinition = {
  id: "versioned",
  name: { _base: "en", en: "Versioned" },
  trigger: {},
  runtime: "python",
  destinations: [{ kind: "table", tableId: "versioned_rows", action: "append", columns: [{ id: "site", type: "text" }] }],
  code: "def run(ctx): return {}",
  contract: 2
}

let db: TestDb
let pool: pg.Pool

before(async () => {
  db = await startTestDb()
  pool = new pg.Pool({ connectionString: db.url })
  await migrate(pool, MIGRATIONS_DIR)
})

after(async () => {
  await pool?.end()
  await db?.stop()
})

test("install archives what the row holds when a design session rewrote it in place", async () => {
  assert.equal((await installIntegration(pool, DRAFT, "draft")).version, 1)
  // Design sessions write the draft's row directly, without archiving
  const edited = { ...DRAFT, code: "def run(ctx): return {'data': {}}" }
  await pool.query("UPDATE app.integrations SET definition = $2 WHERE id = $1", [DRAFT.id, JSON.stringify(edited)])

  // Finishing with that same definition must archive it, not reuse v1
  assert.equal((await installIntegration(pool, edited, "ready")).version, 2)
  const archived = await pool.query("SELECT definition->>'code' AS code FROM app.integration_versions WHERE integration_id = $1 AND version = 2", [DRAFT.id])
  assert.equal(archived.rows[0].code, edited.code)

  // A true re-install of the current version stays a no-op
  assert.equal((await installIntegration(pool, edited, "ready")).version, 2)
})

/** DRAFT under its own id and table, so tests do not collide on table ownership. */
const withRecipe = (id: string, recipe: unknown): IntegrationDefinition => ({
  ...DRAFT,
  id,
  destinations: [{ kind: "table", tableId: `${id}_rows`, action: "append", columns: [{ id: "site", type: "text" }] }],
  recipe
} as unknown as IntegrationDefinition)

const RECIPE = {
  connector: "hdx" as const,
  connectorVersion: 1,
  config: {
    source: { resourceId: "abc-123", auth: "key" },
    columns: [{ from: "Site", id: "site", type: "text" as const }],
    cleanup: { skipRows: 1 },
    writeMode: "replace" as const
  }
}

test("recipe_round_trips_through_install", async () => {
  const def = withRecipe("recipe_ok", RECIPE)
  await installIntegration(pool, def, "draft")
  const row = await pool.query("SELECT definition FROM app.integrations WHERE id = $1", [def.id])
  assert.deepEqual(row.rows[0].definition.recipe, RECIPE)
})

test("recipe_rejects_unknown_connector", async () => {
  const def = withRecipe("recipe_bad", { ...RECIPE, connector: "pdf" })
  await assert.rejects(installIntegration(pool, def, "draft"), /unknown connector/)
})

test("recipe_rejects_secret_like_config", async () => {
  for (const key of ["apiKey", "access_token", "password", "client_secret"]) {
    const def = withRecipe("recipe_secret", { ...RECIPE, config: { ...RECIPE.config, source: { url: "https://x.org", [key]: "v" } } })
    await assert.rejects(installIntegration(pool, def, "draft"), /secrets go in the secrets store/)
  }
})

test("recipe_must_be_well_formed", async () => {
  const def = withRecipe("recipe_shape", { connector: "hdx", connectorVersion: "1", config: {} })
  await assert.rejects(installIntegration(pool, def, "draft"), /recipe/)
})

test("definition_without_recipe_unchanged", () => {
  // Pinned from the pre-change implementation
  assert.equal(definitionHash(DRAFT), "7d4afc890653f119f4eb01ee579f5aceee46d08a1b1959c1c7a3fe50976c0b8c")
})
