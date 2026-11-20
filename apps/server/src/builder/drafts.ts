/**
 * Source builder drafts: app.agent_sessions rows of kind "builder" whose
 * client_state holds the screens ({ step, id, name, source, trigger, recipe }).
 * Inspect and preview build the definition from the recipe and execute it as
 * a scratch run of the draft session (executor.ts), so rows land only in the
 * draft's own schema and nothing installed is touched. A draft's key is a
 * draft-scoped secret, set by admins only, never returned.
 */

import { IncomingMessage, ServerResponse } from "node:http"
import { access, readFile } from "node:fs/promises"
import path from "node:path"
import pg from "pg"
import { IntegrationDefinition, LocalizedString, Recipe, SourceInfo, Trigger } from "@data-integrator/definitions"
import { AuthUser } from "../auth.js"
import { executeRun, ExecutorDeps } from "../executor.js"
import { FileApiOptions, handleSessionUpload } from "../filesApi.js"
import { json, readJsonBody } from "../http.js"
import { deleteIntegration, ID_PATTERN, IntegrationExistsError, installIntegration } from "../install.js"
import { adoptSessionFiles } from "../files.js"
import { getWebhookToken } from "../webhooks.js"
import { queryRows } from "../queryApi.js"
import { RasterStore } from "../rasterStore.js"
import { cleanupScratch, draftSchema } from "../scratch.js"
import { getDraftSecrets, getSecrets, listDraftSecrets, loadSecretKey, MissingSecretError, setDraftSecret, setSecret } from "../secrets.js"
import { buildDefinition, PLACES_INPUT, validateRecipe } from "./buildDefinition.js"
import { CONNECTORS } from "./connectors.js"
import type { ConnectorRegistry } from "../library.js"
import { checkLink, Resolver } from "./linkSafety.js"
import { ADDRESS_FIELDS, KeyOrigins, keyOriginsOf } from "./origins.js"
import { suggestMatches } from "./places.js"

/** Wall-clock limit of an inspect or preview run. */
export const PREVIEW_TIMEOUT_MS = 120_000
/** Rows a preview returns. */
const PREVIEW_ROWS = 50
/** Builder drafts untouched this long are removed by housekeeping. */
export const DRAFT_MAX_AGE_HOURS = 24
/** Most places read from a places table for suggestions. */
const PLACES_LIMIT = 10_000
/** Most source names one suggestion request may send (the saved-match limit). */
const MAX_NAMES = 5000
/** Most type-error lines a preview reports. */
const TYPE_ERROR_LIMIT = 50
/** The only secret a builder draft holds. */
const KEY_NAME = "api_key"

/** What accepting a draft returns. */
export interface AcceptResult {
  integrationId: string
  /** Capability path senders post to (webhook sources only) */
  webhookUrl?: string
  /** The queued first run; absent for webhook sources and when queueing failed */
  runId?: string
}

/**
 * Whether an integration id is already used: an installed integration, a
 * shipped library entry, or a built library entry that was not rejected.
 */
export async function idTaken(pool: pg.Pool, libraryPath: string, id: string): Promise<boolean> {
  const installed = await pool.query("SELECT 1 FROM app.integrations WHERE id = $1", [id])
  if (installed.rows.length > 0) return true
  const built = await pool.query("SELECT 1 FROM app.built_library_entries WHERE id = $1 AND status <> 'rejected'", [id])
  if (built.rows.length > 0) return true
  return access(path.join(libraryPath, "integrations", id)).then(() => true, () => false)
}

/** The builder screens as saved on the draft. */
export interface DraftState {
  step?: string
  /** Integration id the accepted source will take; also the draft table's name */
  id?: string
  name?: LocalizedString | string
  source?: SourceInfo
  trigger?: Trigger
  recipe?: Recipe
  /** Set by the server when the draft edits an installed source: accepting updates that one integration */
  editing?: string
  /** Set by the server while the draft's key is the installed source's copied key */
  keyCopied?: boolean
  /**
   * Set by the server when a key is added (admin) or copied (edit draft): the
   * origins of the source addresses at that moment. The key is dropped as
   * soon as an address points to another origin. Never set by clients.
   */
  keyOrigins?: KeyOrigins
}

/** One builder draft as its routes see it. */
export interface Draft {
  id: string
  userId: string | null
  state: DraftState
  createdAt: string
  updatedAt: string
}

/** What the builder needs from its host. */
export interface BuilderOptions {
  /** Library root holding connectors/ */
  libraryPath: string
  /** Executor deps for inspect and preview; null on hosts without a job runner */
  executor: ExecutorDeps | null
  /** Host name resolver for link checks; tests inject one */
  resolve?: Resolver
  /** Connector registry; tests inject one with newer versions (defaults to CONNECTORS) */
  connectors?: ConnectorRegistry
  /** Test hook: runs between the id check and the install of an accept */
  beforeInstall?: (id: string) => Promise<void>
}

/** A refusal with the HTTP status to answer it with. */
export class BuilderError extends Error {
  readonly status: number

  /** Creates a refusal answered with the given status. */
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

/** The fields of a draft PUT body that are kept. */
const STATE_KEYS = ["step", "id", "name", "source", "trigger", "recipe"] as const

/** A preview's answer: the first rows as stored, and what matched or failed. */
export interface PreviewResult {
  rows: Record<string, unknown>[]
  rowCount: number
  matched: number
  unmatched: string[]
  typeErrors: string[]
}

/** Builder drafts: storage, link checks, place suggestions, inspect and preview runs, and the draft key. */
export class BuilderService {
  /** Creates the service over the app pool. */
  constructor(
    private readonly pool: pg.Pool,
    private readonly options: BuilderOptions
  ) {}

  /** Starts an empty draft owned by the user; returns its id. */
  async create(userId: string): Promise<string> {
    const row = await this.pool.query(
      `INSERT INTO app.agent_sessions (kind, user_id, status, client_state) VALUES ('builder', $1, 'active', '{}') RETURNING id`,
      [userId]
    )
    return row.rows[0].id
  }

  /** The draft when the user may see it: its creator or an admin. Null otherwise, so others never learn it exists. */
  async find(id: string, user: AuthUser): Promise<Draft | null> {
    const row = await this.pool.query(
      `SELECT id, user_id, client_state, created_at, updated_at FROM app.agent_sessions WHERE id = $1 AND kind = 'builder'`,
      [id]
    )
    const found = row.rows[0]
    if (!found) return null
    if (found.user_id !== user.id && user.role !== "admin") return null
    return {
      id: found.id,
      userId: found.user_id,
      state: (found.client_state ?? {}) as DraftState,
      createdAt: found.created_at.toISOString(),
      updatedAt: found.updated_at.toISOString()
    }
  }

  /** Replaces the draft's saved screens with the known fields of the body. */
  async save(id: string, body: Record<string, unknown>): Promise<DraftState> {
    const state: Record<string, unknown> = {}
    for (const key of STATE_KEYS) if (body[key] !== undefined) state[key] = body[key]
    if (state.id !== undefined && state.id !== "") {
      if (typeof state.id !== "string" || !ID_PATTERN.test(state.id)) {
        throw new BuilderError(
          400,
          `The id "${String(state.id)}" is not valid: use lowercase letters, digits and underscores, starting with a letter.`
        )
      }
    }
    if (state.recipe !== undefined && (typeof state.recipe !== "object" || state.recipe === null || Array.isArray(state.recipe))) {
      throw new BuilderError(400, "The recipe must be an object.")
    }
    // The write and the key check are one step under the draft's key lock
    const client = await this.pool.connect()
    try {
      await client.query("BEGIN")
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`builder-key:${id}`])
      const existing = await client.query("SELECT client_state FROM app.agent_sessions WHERE id = $1", [id])
      // The edit target is the server's: a client never sets or drops it
      const editing = existing.rows[0]?.client_state?.editing
      // So are the origins a key was given for
      const keyOrigins = existing.rows[0]?.client_state?.keyOrigins
      if (keyOrigins && typeof keyOrigins === "object") state.keyOrigins = keyOrigins
      if (typeof editing === "string") {
        state.editing = editing
        state.id = editing
        if (existing.rows[0].client_state.keyCopied === true) state.keyCopied = true
        // An edit keeps the connector version the source was installed with
        const installed = await client.query("SELECT definition->'recipe'->'connectorVersion' AS version FROM app.integrations WHERE id = $1", [editing])
        const version = installed.rows[0]?.version
        if (state.recipe && typeof version === "number") (state.recipe as Record<string, unknown>).connectorVersion = version
      }
      await client.query("UPDATE app.agent_sessions SET client_state = $2, updated_at = now() WHERE id = $1", [
        id,
        JSON.stringify(state)
      ])
      if (await this.dropKeyOnOriginChange(client, id, state as DraftState)) {
        delete state.keyCopied
        delete state.keyOrigins
      }
      await client.query("COMMIT")
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {})
      throw err
    } finally {
      client.release()
    }
    return state as DraftState
  }

  /**
   * Opens an installed builder source as a new draft: its id, name, source
   * information, trigger and recipe (without a run mode), and its key copied
   * into the draft so reading the source works. Accepting the draft updates
   * that source (a new version) instead of installing a new one.
   */
  async createFromIntegration(integrationId: string, userId: string): Promise<string> {
    const row = await this.pool.query("SELECT definition FROM app.integrations WHERE id = $1", [integrationId])
    if (row.rows.length === 0) throw new BuilderError(404, "unknown integration")
    const definition = row.rows[0].definition as IntegrationDefinition
    if (!definition.recipe) throw new BuilderError(400, "Only sources made with the builder can be edited in the builder.")
    const info = (this.options.connectors ?? CONNECTORS)[definition.recipe.connector]
    if (info && definition.recipe.connectorVersion < info.version) throw new BuilderError(409, "Apply the connector update first.")
    const { mode: _mode, ...config } = definition.recipe.config as unknown as Record<string, unknown>
    void _mode
    const state: DraftState = {
      step: "source",
      id: integrationId,
      name: definition.name,
      source: definition.source as SourceInfo,
      trigger: definition.trigger,
      recipe: { ...definition.recipe, config: config as unknown as Recipe["config"] },
      editing: integrationId,
      ...(definition.secrets?.includes(KEY_NAME)
        ? { keyCopied: true, keyOrigins: keyOriginsOf(definition.recipe.config.source) }
        : {})
    }
    const created = await this.pool.query(
      `INSERT INTO app.agent_sessions (kind, user_id, status, client_state) VALUES ('builder', $1, 'active', $2) RETURNING id`,
      [userId, JSON.stringify(state)]
    )
    const draftId = created.rows[0].id as string
    if (definition.secrets?.includes(KEY_NAME)) {
      const key = this.secretKey()
      const kept = await getSecrets(this.pool, key, integrationId, [KEY_NAME]).catch(() => null)
      if (kept?.[KEY_NAME]) await setDraftSecret(this.pool, key, draftId, KEY_NAME, kept[KEY_NAME])
    }
    return draftId
  }

  /** Runs the connector in inspect mode and returns its inspect.json: columns with samples, and the row count. */
  async inspect(draft: Draft): Promise<unknown> {
    await this.dropKeyOnOriginChange(this.pool, draft.id, draft.state)
    const definition = await this.runDefinition(draft, "inspect")
    let inspected: unknown = null
    const status = await this.run(draft, definition, async outDir => {
      const text = await readFile(path.join(outDir, "inspect.json"), "utf8").catch(() => null)
      if (text === null) throw new Error("The connector wrote no inspect output")
      inspected = JSON.parse(text)
    })
    if (status.status !== "succeeded") throw new BuilderError(422, `Reading the source failed: ${status.error ?? status.status}`)
    return inspected
  }

  /** Runs the connector in preview mode into the draft schema and reports the first rows and the counts. */
  async preview(draft: Draft): Promise<PreviewResult> {
    await this.dropKeyOnOriginChange(this.pool, draft.id, draft.state)
    const definition = await this.runDefinition(draft, "preview")
    const outcome = await this.run(draft, definition)
    if (outcome.status !== "succeeded") throw new BuilderError(422, `The preview failed: ${outcome.error ?? outcome.status}`)
    const state = (outcome.state ?? {}) as { rows?: number; unmatchedPlaces?: string[] }
    const placeColumn = draft.state.recipe?.config?.places?.column
    const read = await this.readDraftTable(draft.id, definition.id, placeColumn)
    return {
      rows: read.rows,
      rowCount: typeof state.rows === "number" ? state.rows : read.count,
      matched: read.matched,
      unmatched: Array.isArray(state.unmatchedPlaces) ? state.unmatchedPlaces.map(String) : [],
      typeErrors: typeErrorLines(outcome.log ?? "")
    }
  }

  /** Suggests places for the names from the places table the recipe names. */
  async suggest(draft: Draft, names: unknown): Promise<ReturnType<typeof suggestMatches>> {
    if (!Array.isArray(names) || !names.every(n => typeof n === "string")) {
      throw new BuilderError(400, "names must be a list of text values.")
    }
    if (names.length > MAX_NAMES) throw new BuilderError(400, `At most ${MAX_NAMES} names can be matched at once.`)
    const places = draft.state.recipe?.config?.places
    if (!places) throw new BuilderError(400, "Choose a places table first.")
    const { table, nameColumn, codeColumn } = places
    for (const [label, value] of [["table", table], ["name column", nameColumn], ["code column", codeColumn]]) {
      if (typeof value !== "string" || !ID_PATTERN.test(value)) throw new BuilderError(400, `The places ${label} is not valid.`)
    }
    // queryRows checks the table and both columns against the installed data tables
    let result
    try {
      result = await queryRows(this.pool, table, { columns: [nameColumn, codeColumn], limit: PLACES_LIMIT })
    } catch (err) {
      throw new BuilderError(400, err instanceof Error ? err.message : String(err))
    }
    if (!result) throw new BuilderError(400, `There is no places table ${table}.`)
    const rows = result.rows.map(r => ({ name: String(r[nameColumn] ?? ""), code: String(r[codeColumn] ?? "") }))
    return suggestMatches(names, rows)
  }

  /**
   * Stores the draft's key, encrypted; the value is never returned. The key
   * is tied to the origins of the draft's source addresses as saved now.
   */
  async setKey(draft: Draft, value: unknown): Promise<void> {
    if (typeof value !== "string" || value.length === 0 || value.length > 65536) {
      throw new BuilderError(400, "The key must be 1 to 65536 characters.")
    }
    const secretKey = this.secretKey()
    // Under the draft's key lock, so a save cannot slip between reading the addresses and storing the key
    const client = await this.pool.connect()
    try {
      await client.query("BEGIN")
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`builder-key:${draft.id}`])
      const row = await client.query("SELECT client_state FROM app.agent_sessions WHERE id = $1", [draft.id])
      const state = (row.rows[0]?.client_state ?? {}) as DraftState
      await setDraftSecret(client, secretKey, draft.id, KEY_NAME, value)
      // An admin's own key for this draft is no longer the copied one
      await client.query(
        "UPDATE app.agent_sessions SET client_state = (client_state - 'keyCopied') || jsonb_build_object('keyOrigins', $2::jsonb) WHERE id = $1",
        [draft.id, JSON.stringify(keyOriginsOf(state.recipe?.config?.source))]
      )
      await client.query("COMMIT")
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {})
      throw err
    } finally {
      client.release()
    }
  }

  /**
   * A draft keeps its key (an admin's or one copied from the installed
   * source) only while every source address (url, layerUrl) keeps the origin
   * (scheme, host and port) it had when the key was given; otherwise the key
   * is deleted, so no other address ever receives it. An emptied address
   * sends nothing and is allowed. Checks the given state, the one a run or an
   * install is about to use. Returns whether the key was dropped.
   */
  private async dropKeyOnOriginChange(
    db: Pick<pg.PoolClient, "query">,
    draftId: string,
    state: DraftState
  ): Promise<boolean> {
    const given = state.keyOrigins
    if (!given || typeof given !== "object") return false
    const now = keyOriginsOf(state.recipe?.config?.source)
    const same = ADDRESS_FIELDS.every(field => now[field] === null || now[field] === (given[field] ?? null))
    if (same) return false
    await db.query("DELETE FROM app.draft_secrets WHERE session_id = $1 AND name = $2", [draftId, KEY_NAME])
    await db.query(`UPDATE app.agent_sessions SET client_state = client_state - 'keyCopied' - 'keyOrigins' WHERE id = $1`, [draftId])
    return true
  }

  /** The draft's secret names and update times, never values. */
  async listKeys(draft: Draft): Promise<{ name: string; updatedAt: string }[]> {
    return listDraftSecrets(this.pool, draft.id)
  }

  /**
   * Installs the draft's source, moves its upload and key to the new
   * integration, queues the first run (not for webhook sources, which return
   * their URL), and finishes the draft. A failure after the install removes
   * the integration again and leaves the draft as it was.
   */
  async accept(draft: Draft, user: AuthUser): Promise<AcceptResult> {
    const lock = await this.pool.connect()
    const draftLock = `builder-accept-draft:${draft.id}`
    const held: string[] = []
    try {
      // One accept per draft at a time; the draft is re-read under the lock
      await lock.query("SELECT pg_advisory_lock(hashtext($1))", [draftLock])
      held.push(draftLock)
      const fresh = await this.find(draft.id, user)
      if (!fresh) throw new BuilderError(404, "unknown draft")
      await this.dropKeyOnOriginChange(this.pool, fresh.id, fresh.state)
      const { id, recipe } = fresh.state
      if (!id) throw new BuilderError(400, "Give the source an id before accepting it.")
      if (!recipe) throw new BuilderError(400, "Choose a connector before accepting the source.")
      // And one per id across drafts
      const idLock = `builder-accept:${id}`
      await lock.query("SELECT pg_advisory_lock(hashtext($1))", [idLock])
      held.push(idLock)
      return await this.acceptLocked(fresh, id, recipe, user.id)
    } finally {
      for (const name of held.reverse()) await lock.query("SELECT pg_advisory_unlock(hashtext($1))", [name]).catch(() => {})
      lock.release()
    }
  }

  /** accept, holding the id's lock. */
  private async acceptLocked(draft: Draft, id: string, recipe: Recipe, userId: string): Promise<AcceptResult> {
    const status = await this.pool.query("SELECT status FROM app.agent_sessions WHERE id = $1", [draft.id])
    if (status.rows[0]?.status === "finished") throw new BuilderError(409, "This draft was already accepted.")
    try {
      validateRecipe(recipe)
    } catch (err) {
      throw new BuilderError(400, err instanceof Error ? err.message : String(err))
    }
    // An address changed after the preview is checked again
    await this.checkLinks(recipe)
    const editing = draft.state.editing
    let installed: IntegrationDefinition | null = null
    let installedStatus: "draft" | "ready" = "ready"
    let installedEnabled = true
    if (editing) {
      if (editing !== id) throw new BuilderError(400, "An edited source keeps its id.")
      const row = await this.pool.query("SELECT definition, status, enabled FROM app.integrations WHERE id = $1", [editing])
      installed = (row.rows[0]?.definition as IntegrationDefinition | undefined) ?? null
      if (!installed?.recipe) throw new BuilderError(409, "The source being edited is no longer installed.")
      installedStatus = row.rows[0].status
      installedEnabled = row.rows[0].enabled
      const info = (this.options.connectors ?? CONNECTORS)[installed.recipe.connector]
      if (info && installed.recipe.connectorVersion < info.version) throw new BuilderError(409, "Apply the connector update first.")
      if (installed.recipe.connector !== recipe.connector) throw new BuilderError(400, "The connector of an installed source cannot be changed.")
    } else if (await idTaken(this.pool, this.options.libraryPath, id)) {
      throw new BuilderError(409, `The id "${id}" is already used by another source.`)
    }
    const places = recipe.config.places
    if (places) {
      const known = await this.pool.query("SELECT 1 FROM app.data_tables WHERE id = $1", [places.table])
      if (known.rows.length === 0) throw new BuilderError(400, `There is no places table ${places.table}.`)
    }
    const name = toLocalized(draft.state.name, id)
    let definition: IntegrationDefinition
    try {
      definition = await buildDefinition(
        {
          id,
          name,
          source: draft.state.source ?? { name },
          trigger: draft.state.trigger ?? {},
          recipe,
          ...(places ? { places: { inputId: PLACES_INPUT, tableId: places.table } } : {})
        },
        this.options.libraryPath
      )
    } catch (err) {
      throw new BuilderError(400, err instanceof Error ? err.message : String(err))
    }
    // Everything the source needs is checked before anything is installed
    let secrets: Record<string, string> = {}
    if (definition.secrets?.length) {
      try {
        secrets = await getDraftSecrets(this.pool, this.secretKey(), draft.id, definition.secrets)
      } catch (err) {
        if (err instanceof MissingSecretError) throw new BuilderError(409, "Waiting for an admin to add the key.")
        throw err
      }
    }
    const slotIds = Object.keys(definition.files ?? {})
    const pins: Record<string, string> = {}
    for (const slotId of slotIds) {
      const staged = await this.pool.query(
        `SELECT id FROM app.file_versions WHERE session_id = $1 AND slot_id = $2 AND integration_id IS NULL AND purged_at IS NULL
         ORDER BY uploaded_at DESC, version DESC LIMIT 1`,
        [draft.id, slotId]
      )
      // An edited source keeps its current file when none is uploaded
      if (staged.rows.length === 0 && editing) continue
      if (staged.rows.length === 0) throw new BuilderError(400, "Upload a file before accepting the source.")
      pins[slotId] = staged.rows[0].id
    }
    const key = Object.keys(secrets).length > 0 ? this.secretKey() : null
    if (installed) {
      // Deployment-owned fields stay as installed; the builder changes the recipe
      const owned: Record<string, unknown> = { ...definition }
      for (const field of ["aoi", "trigger", "limits", "settingValues"] as const) {
        if (field in installed) owned[field] = installed[field]
        else delete owned[field]
      }
      definition = owned as unknown as IntegrationDefinition
      try {
        await installIntegration(this.pool, definition, installedStatus, draft.userId ?? userId)
        for (const [secretName, value] of Object.entries(secrets)) await setSecret(this.pool, key!, id, secretName, value)
        if (Object.keys(pins).length > 0) await adoptSessionFiles(this.pool, draft.id, id, Object.values(pins))
      } catch (err) {
        if (err instanceof BuilderError) throw err
        throw new BuilderError(400, err instanceof Error ? err.message : String(err))
      }
      return this.finishAccept(draft, id, definition, pins, installedEnabled)
    }

    await this.options.beforeInstall?.(id)
    // Insert-only and disabled: nothing else's integration is touched, and the
    // scheduler cannot queue a run until the key and file are in place
    try {
      await installIntegration(this.pool, definition, "ready", draft.userId ?? userId, false, true)
    } catch (err) {
      if (err instanceof IntegrationExistsError) throw new BuilderError(409, err.message)
      const message = err instanceof Error ? err.message : String(err)
      throw new BuilderError(/is owned by/.test(message) ? 409 : 400, message)
    }
    try {
      for (const [secretName, value] of Object.entries(secrets)) await setSecret(this.pool, key!, id, secretName, value)
      // The upload becomes version 1 of its slot: only the pinned (latest) one is adopted
      if (slotIds.length > 0) await adoptSessionFiles(this.pool, draft.id, id, Object.values(pins))
      await this.pool.query("UPDATE app.integrations SET enabled = true WHERE id = $1", [id])
    } catch (err) {
      // Never leave a half-installed source: remove our own install; the draft stays intact for a retry
      try {
        await this.pool.query("DELETE FROM app.integration_secrets WHERE integration_id = $1", [id])
        await deleteIntegration(this.pool, id)
      } catch (cleanup) {
        console.error(`builder accept ${id}: rollback failed: ${cleanup instanceof Error ? cleanup.message : cleanup}`)
        throw new BuilderError(500, `Accepting failed and the source "${id}" may need cleaning up by an admin.`)
      }
      throw err
    }

    return this.finishAccept(draft, id, definition, pins)
  }

  /** Queues the first run, finishes the draft and cleans its scratch area. */
  private async finishAccept(
    draft: Draft,
    id: string,
    definition: IntegrationDefinition,
    pins: Record<string, string>,
    queueRun = true
  ): Promise<AcceptResult> {
    const slotIds = Object.keys(pins)
    const result: AcceptResult = { integrationId: id }
    if (definition.trigger.webhook) {
      const token = await getWebhookToken(this.pool, id)
      if (token) result.webhookUrl = `/hooks/${token}`
    } else if (queueRun) {
      try {
        const queued = await this.pool.query(
          `INSERT INTO app.runs (integration_id, trigger, status, file_pins) VALUES ($1, 'manual', 'queued', $2::jsonb) RETURNING id`,
          [id, slotIds.length > 0 ? JSON.stringify(pins) : null]
        )
        result.runId = queued.rows[0].id
      } catch {
        // The install stands; the run can be started from the integration page
      }
    }
    // The pinned ids now belong to the integration; the draft is done
    await this.pool.query("DELETE FROM app.draft_secrets WHERE session_id = $1", [draft.id])
    await this.pool.query("UPDATE app.agent_sessions SET status = 'finished', updated_at = now() WHERE id = $1", [draft.id])
    const deps = this.options.executor
    if (deps) {
      await cleanupScratch(this.pool, deps.store, deps.workRoot, draft.id).catch(err =>
        console.warn(`builder draft ${draft.id}: scratch not cleaned: ${err instanceof Error ? err.message : err}`)
      )
    }
    return result
  }

  /** Refuses a recipe whose source addresses are not safe public links (checkLink). */
  private async checkLinks(recipe: Recipe): Promise<void> {
    const source = recipe.config.source
    for (const field of ADDRESS_FIELDS) {
      const value = source[field]
      if (value === undefined || value === null || value === "") continue
      try {
        await checkLink(String(value), this.options.resolve)
      } catch (err) {
        throw new BuilderError(400, err instanceof Error ? err.message : String(err))
      }
    }
  }

  /** The encryption key for draft secrets, or 503 when the deployment has none. */
  private secretKey(): Buffer {
    const configured = this.options.executor?.secretKey
    if (configured) return configured
    try {
      return loadSecretKey()
    } catch {
      throw new BuilderError(503, "INTEGRATOR_SECRET_KEY is not configured on this deployment")
    }
  }

  /**
   * The definition an inspect or preview executes: built from the draft's
   * recipe with the run mode set, links checked, the places table checked,
   * and the preview time limit.
   */
  private async runDefinition(draft: Draft, mode: "inspect" | "preview"): Promise<IntegrationDefinition> {
    const { id, recipe } = draft.state
    if (!id) throw new BuilderError(400, "Give the source an id before reading it.")
    if (!recipe) throw new BuilderError(400, "Choose a connector before reading the source.")
    try {
      validateRecipe(recipe, mode)
    } catch (err) {
      throw new BuilderError(400, err instanceof Error ? err.message : String(err))
    }
    // Refused before any run row exists
    await this.checkLinks(recipe)
    const places = recipe.config.places
    if (places) {
      if (typeof places.table !== "string" || !ID_PATTERN.test(places.table)) {
        throw new BuilderError(400, "The places table is not valid.")
      }
      const known = await this.pool.query("SELECT 1 FROM app.data_tables WHERE id = $1", [places.table])
      if (known.rows.length === 0) throw new BuilderError(400, `There is no places table ${places.table}.`)
    }
    const name = toLocalized(draft.state.name, id)
    let definition: IntegrationDefinition
    try {
      definition = await buildDefinition(
        {
          id,
          name,
          source: draft.state.source ?? { name },
          trigger: draft.state.trigger ?? {},
          recipe: { ...recipe, config: { ...recipe.config, mode } },
          run: mode,
          ...(places ? { places: { inputId: PLACES_INPUT, tableId: places.table } } : {})
        },
        this.options.libraryPath
      )
    } catch (err) {
      throw new BuilderError(400, err instanceof Error ? err.message : String(err))
    }
    return { ...definition, limits: { ...definition.limits, timeoutMs: PREVIEW_TIMEOUT_MS } }
  }

  /**
   * Executes one scratch run of the draft, the way a design session runs its
   * draft: a session-owned run row, claimed here and executed in process.
   */
  private async run(
    draft: Draft,
    definition: IntegrationDefinition,
    onJobOutput?: (outDir: string) => Promise<void>
  ): Promise<{ status: string; error: string | null; log: string | null; state: unknown }> {
    const deps = this.options.executor
    if (!deps) throw new BuilderError(503, "Previews need the job runner, which this server does not have.")
    let secrets: Record<string, string> = {}
    if (definition.secrets?.length) {
      try {
        secrets = await getDraftSecrets(this.pool, this.secretKey(), draft.id, definition.secrets)
      } catch (err) {
        if (err instanceof MissingSecretError) {
          throw new BuilderError(409, "Waiting for an admin to add the key.")
        }
        throw err
      }
    }
    const files: Record<string, string> = {}
    for (const slotId of Object.keys(definition.files ?? {})) {
      const staged = await this.pool.query(
        `SELECT id FROM app.file_versions WHERE session_id = $1 AND slot_id = $2 AND purged_at IS NULL
         ORDER BY uploaded_at DESC, version DESC LIMIT 1`,
        [draft.id, slotId]
      )
      if (staged.rows.length === 0) throw new BuilderError(400, "Upload a file before reading it.")
      files[slotId] = staged.rows[0].id
    }

    let runId: string
    try {
      const inserted = await this.pool.query(
        `INSERT INTO app.runs (session_id, trigger, status) VALUES ($1, 'agent', 'queued') RETURNING id`,
        [draft.id]
      )
      runId = inserted.rows[0].id
    } catch (err) {
      if ((err as { code?: string }).code === "23505") {
        throw new BuilderError(409, "This draft is already being read; wait for it to finish.")
      }
      throw err
    }
    const claimed = await this.pool.query(
      `UPDATE app.runs SET status = 'running', claimed_by = 'builder', heartbeat_at = now(), started_at = now()
       WHERE id = $1 AND status = 'queued' RETURNING id, integration_id, trigger, attempt`,
      [runId]
    )
    // Cold: no previous state and an empty /work, so a preview shows what a first run would store
    await executeRun(deps, claimed.rows[0], {
      cold: true,
      scratch: { sessionId: draft.id, definition, files, secrets },
      onJobOutput
    })
    await this.pool.query("UPDATE app.agent_sessions SET updated_at = now() WHERE id = $1", [draft.id])
    const final = await this.pool.query("SELECT status, error, log, state_out FROM app.runs WHERE id = $1", [runId])
    const row = final.rows[0]
    return { status: row.status, error: row.error, log: row.log, state: row.state_out }
  }

  /**
   * The first rows of the draft table and the number of distinct place names
   * that matched, read as the designer's query_table reads scratch tables:
   * read-only, under the sql_engine role.
   */
  private async readDraftTable(
    sessionId: string,
    tableId: string,
    placeColumn: string | undefined
  ): Promise<{ rows: Record<string, unknown>[]; count: number; matched: number }> {
    const schema = draftSchema(sessionId)
    const client = await this.pool.connect()
    try {
      await client.query("BEGIN TRANSACTION READ ONLY")
      await client.query("SET LOCAL ROLE sql_engine")
      await client.query("SET LOCAL statement_timeout = '15s'")
      const columns = await client.query(
        `SELECT column_name, udt_name FROM information_schema.columns
         WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position`,
        [schema, tableId]
      )
      if (columns.rows.length === 0) {
        await client.query("COMMIT")
        return { rows: [], count: 0, matched: 0 }
      }
      const names: string[] = columns.rows.map(r => r.column_name).filter(n => n !== "_id" && n !== "_run_id")
      const selectList = columns.rows
        .filter(r => names.includes(r.column_name))
        .map(r => {
          const col = quoteIdent(r.column_name)
          if (r.udt_name === "geometry") return `ST_AsGeoJSON(${col})::json AS ${col}`
          // Bare dates as text, or the driver shifts them through the local timezone
          if (r.udt_name === "date") return `${col}::text AS ${col}`
          return col
        })
        .join(", ")
      const table = `${schema}.${quoteIdent(tableId)}`
      const rows = await client.query(`SELECT ${selectList} FROM ${table} ORDER BY _id LIMIT $1`, [PREVIEW_ROWS])
      const codeColumn = placeColumn ? `${placeColumn}_code` : null
      const counted =
        placeColumn && codeColumn && names.includes(placeColumn) && names.includes(codeColumn)
          ? await client.query(
              `SELECT count(*)::int AS n,
                      count(DISTINCT ${quoteIdent(placeColumn)}) FILTER (WHERE COALESCE(${quoteIdent(codeColumn)}::text, '') <> '')::int AS matched
               FROM ${table}`
            )
          : await client.query(`SELECT count(*)::int AS n, 0 AS matched FROM ${table}`)
      await client.query("COMMIT")
      return { rows: rows.rows, count: counted.rows[0].n, matched: counted.rows[0].matched }
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {})
      throw err
    } finally {
      client.release()
    }
  }
}

/** A draft name as a LocalizedString; plain text is taken as English. */
function toLocalized(name: DraftState["name"], fallback: string): LocalizedString {
  if (typeof name === "string" && name.trim() !== "") return { _base: "en", en: name }
  if (name && typeof name === "object") return name
  return { _base: "en", en: fallback }
}

/** Double-quotes an identifier. */
function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`
}

/** The type-error lines the connector core prints under "Type errors: N", indented by two spaces. */
export function typeErrorLines(log: string): string[] {
  const lines = log.split("\n")
  const start = lines.findIndex(l => /^Type errors: \d+\s*$/.test(l.trim()))
  if (start < 0) return []
  const errors: string[] = []
  for (const line of lines.slice(start + 1)) {
    if (!/^\s{2,}\S/.test(line)) break
    errors.push(line.trim())
    if (errors.length >= TYPE_ERROR_LIMIT) break
  }
  return errors
}

/**
 * Deletes one builder draft: its scratch area (draft schema, preview layers,
 * /work), the uploads no integration adopted, its scratch runs, its secrets
 * (by cascade) and the session row. Returns the removed uploads, whose bytes
 * the file store's own cleanup also finds.
 */
export async function deleteBuilderDraft(
  pool: pg.Pool,
  store: RasterStore,
  workRoot: string,
  sessionId: string
): Promise<{ id: string; ext: string }[]> {
  const client = await pool.connect()
  try {
    await client.query("BEGIN")
    const found = await client.query("SELECT 1 FROM app.agent_sessions WHERE id = $1 AND kind = 'builder' FOR UPDATE", [sessionId])
    if (found.rows.length === 0) {
      await client.query("ROLLBACK")
      return []
    }
    await cleanupScratch(client, store, workRoot, sessionId)
    const removed = await client.query(
      "DELETE FROM app.file_versions WHERE session_id = $1 AND integration_id IS NULL RETURNING id, ext",
      [sessionId]
    )
    await client.query("UPDATE app.file_versions SET session_id = NULL WHERE session_id = $1", [sessionId])
    await client.query("DELETE FROM app.runs WHERE session_id = $1 AND integration_id IS NULL", [sessionId])
    await client.query("UPDATE app.runs SET session_id = NULL WHERE session_id = $1", [sessionId])
    await client.query("DELETE FROM app.agent_sessions WHERE id = $1", [sessionId])
    await client.query("COMMIT")
    return removed.rows
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

/**
 * Answers a refusal sent before the request body is read, closing the
 * connection: an unread upload body must not be parsed as the next request.
 */
function refuse(res: ServerResponse, status: number, error: string): void {
  res.setHeader("connection", "close")
  json(res, status, { error })
}

/** Matches /api/builder/drafts/:id and its subresources. */
const DRAFT_PATH =
  /^\/api\/builder\/drafts\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(\/inspect|\/preview|\/accept|\/places\/suggest|\/secrets|\/secrets\/api_key|\/files\/[^/]+)?$/

/**
 * The /api/builder routes. Returns false when the path is not one of them.
 * Editors and admins only; a draft is visible to its creator and admins,
 * and only admins set its key.
 */
export async function routeBuilder(
  builder: BuilderService | null,
  files: FileApiOptions | null,
  pool: pg.Pool,
  user: AuthUser,
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  searchParams: URLSearchParams
): Promise<boolean> {
  if (!pathname.startsWith("/api/builder/")) return false
  if (user.role === "viewer") {
    refuse(res, 403, "Viewers cannot build sources")
    return true
  }
  if (!builder) {
    refuse(res, 503, "The source builder is not available on this server")
    return true
  }
  try {
    if (pathname === "/api/builder/drafts") {
      if (req.method !== "POST") {
        refuse(res, 405, "POST only")
        return true
      }
      json(res, 201, { id: await builder.create(user.id) })
      return true
    }
    const fromMatch = pathname.match(/^\/api\/builder\/drafts\/from-integration\/([a-z][a-z0-9_]*)$/)
    if (fromMatch) {
      if (req.method !== "POST") {
        refuse(res, 405, "POST only")
        return true
      }
      json(res, 201, { id: await builder.createFromIntegration(fromMatch[1], user.id) })
      return true
    }
    const match = pathname.match(DRAFT_PATH)
    if (!match) {
      refuse(res, 404, "not found")
      return true
    }
    const [, draftId, sub] = match
    // Only admins write keys: refused before anything else is read
    if (sub === "/secrets/api_key" && user.role !== "admin") {
      refuse(res, 403, "Only admins can add keys")
      return true
    }
    const draft = await builder.find(draftId, user)
    if (!draft) {
      refuse(res, 404, "unknown draft")
      return true
    }
    if (!sub && req.method === "GET") {
      json(res, 200, draft)
    } else if (!sub && req.method === "PUT") {
      const state = await builder.save(draft.id, await readJsonBody(req))
      json(res, 200, { id: draft.id, state })
    } else if (sub === "/inspect" && req.method === "POST") {
      json(res, 200, await builder.inspect(draft))
    } else if (sub === "/preview" && req.method === "POST") {
      json(res, 200, await builder.preview(draft))
    } else if (sub === "/accept" && req.method === "POST") {
      json(res, 200, await builder.accept(draft, user))
    } else if (sub === "/places/suggest" && req.method === "POST") {
      const body = await readJsonBody(req)
      json(res, 200, await builder.suggest(draft, body.names))
    } else if (sub === "/secrets" && req.method === "GET") {
      json(res, 200, { secrets: await builder.listKeys(draft) })
    } else if (sub === "/secrets/api_key" && req.method === "PUT") {
      const body = await readJsonBody(req)
      await builder.setKey(draft, body.value)
      json(res, 200, { name: KEY_NAME })
    } else if (sub?.startsWith("/files/") && req.method === "PUT") {
      await handleSessionUpload(pool, files, user, req, res, draft.id, sub.slice("/files/".length), searchParams)
    } else {
      refuse(res, 405, "method not allowed")
    }
  } catch (err) {
    if (!(err instanceof BuilderError)) throw err
    json(res, err.status, { error: err.message })
  }
  return true
}
