/**
 * The browsable integration library: entries under
 * <libraryPath>/integrations/<id>/ (definition.json plus one code file).
 * Installing copies the entry's values into the integration's definition —
 * the single specification from then on. Updating re-installs the entry but
 * carries the deployment-owned fields over from the installed definition, so
 * a locally chosen AOI, schedule, limits, or setting values survive library
 * updates; the same fields are excluded from update detection.
 *
 * Built entries (app.built_library_entries) are builder-made sources an
 * editor proposed and an admin approved. They are stored without code: an
 * install inlines the connector's current code. An installed builder source
 * has an update when its connector version is behind the registry, and
 * applying it keeps the source's settings (recipe.config) as they are.
 */

import { access, readdir, readFile } from "node:fs/promises"
import path from "node:path"
import pg from "pg"
import { ConnectorId, LocalizedString, IntegrationDefinition, Recipe, SettingValue } from "@data-integrator/definitions"
import { AuthUser } from "./auth.js"
import { canonicalDefinition, installIntegration, ID_PATTERN } from "./install.js"
import { keepValidSettingValues } from "./integrationSettings.js"
import { ConnectorInfo, CONNECTORS, connectorCode } from "./builder/connectors.js"
import { validateRecipe } from "./builder/buildDefinition.js"

/** The connector registry update detection reads; tests pass one with a bumped version. */
export type ConnectorRegistry = Record<ConnectorId, ConnectorInfo>

/** Fields the deployment owns once installed: carried over on update, ignored in update detection. */
const DEPLOYMENT_FIELDS = ["aoi", "trigger", "limits", "settingValues"] as const

/** One library entry with its relationship to the deployment. */
export interface LibraryEntry {
  /** Entry id (= integration id when installed) */
  id: string
  /** Display name */
  name: LocalizedString
  /** What the integration does */
  description: LocalizedString | null
  /** Source provenance (name, provider, license, url) */
  source: unknown
  /** Suggested cadence */
  trigger: unknown
  /** Runtime image id */
  runtime: string
  /** Declared destinations: kind + id */
  destinations: { kind: string; id: string }[]
  /** Relationship to this deployment */
  status: "not_installed" | "installed" | "update_available"
  /** Installed version, when installed */
  installedVersion: number | null
  /** Shipped with the library, or made with the source builder */
  origin: "shipped" | "built"
  /** Review state of a built entry (proposed ones are listed to admins only) */
  builtStatus?: "proposed" | "approved" | "rejected"
  /** Built entries: the installed copy differs from the approved entry */
  changedHere?: boolean
  /** Built entries, admins only: a new version waits for approval */
  pendingVersion?: boolean
}

/** A refusal from the built-library routes, with the HTTP status to answer it with. */
export class LibraryError extends Error {
  readonly status: number

  /** Creates a refusal answered with the given status. */
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

/**
 * Canonical JSON with the deployment-owned fields stripped, for update
 * detection. Uses canonicalDefinition, so translation-only differences never
 * read as an update.
 */
function comparableJson(definition: IntegrationDefinition): string {
  const stripped: Record<string, unknown> = { ...definition }
  for (const field of DEPLOYMENT_FIELDS) delete stripped[field]
  return JSON.stringify(canonicalDefinition(stripped))
}

/**
 * A builder source compared with its built entry: the code is re-inlined from
 * the connector and its version tracked on its own, so both are left out.
 */
function builtComparableJson(definition: IntegrationDefinition): string {
  const { code: _code, ...rest } = definition
  void _code
  const recipe = rest.recipe ? { ...rest.recipe, connectorVersion: 0 } : rest.recipe
  return comparableJson({ ...rest, recipe } as IntegrationDefinition)
}

/** The definition with the connector's current code and version inlined. */
async function withCurrentConnector(
  definition: IntegrationDefinition,
  libraryPath: string,
  connectors: ConnectorRegistry
): Promise<IntegrationDefinition> {
  const recipe = definition.recipe!
  const info = connectors[recipe.connector]
  if (!info) throw new Error(`Unknown connector "${recipe.connector}".`)
  return {
    ...definition,
    recipe: { ...recipe, connectorVersion: info.version },
    code: await connectorCode(recipe.connector, libraryPath)
  }
}

/** One built entry row. */
interface BuiltRow {
  id: string
  definition: IntegrationDefinition
  status: "proposed" | "approved" | "rejected"
  pending: boolean
}

/** Whether the shipped library has an entry directory of this id. */
function shippedEntryExists(libraryPath: string, id: string): Promise<boolean> {
  return access(path.join(libraryPath, "integrations", id)).then(() => true, () => false)
}

/**
 * Loads an approved built entry ready to install: the connector's current
 * code inlined, and the trigger a builder source needs (none but the webhook
 * flag; the schedule is the deployment's). Null when there is none.
 */
export async function loadBuiltEntry(
  pool: pg.Pool,
  libraryPath: string,
  id: string,
  connectors: ConnectorRegistry = CONNECTORS
): Promise<IntegrationDefinition | null> {
  if (!ID_PATTERN.test(id)) return null
  const row = await pool.query("SELECT definition FROM app.built_library_entries WHERE id = $1 AND status = 'approved'", [id])
  if (row.rows.length === 0) return null
  const definition = row.rows[0].definition as IntegrationDefinition
  if (definition.id !== id || !definition.recipe) return null
  assertValidRecipe(definition as unknown as Record<string, unknown>)
  const trigger = connectors[definition.recipe.connector]?.needsWebhook ? { webhook: true } : {}
  return withCurrentConnector({ ...definition, trigger }, libraryPath, connectors)
}

/** A shipped entry, or else an approved built one, with its code inlined; null when neither exists. */
export async function loadAnyLibraryEntry(
  pool: pg.Pool,
  libraryPath: string,
  id: string
): Promise<IntegrationDefinition | null> {
  return (await loadLibraryEntry(libraryPath, id)) ?? (await loadBuiltEntry(pool, libraryPath, id))
}

/** Loads one entry's full definition (code file inlined), or null. */
export async function loadLibraryEntry(libraryPath: string, id: string): Promise<IntegrationDefinition | null> {
  if (!ID_PATTERN.test(id)) return null
  const dir = path.join(libraryPath, "integrations", id)
  let definition: IntegrationDefinition
  try {
    definition = JSON.parse(await readFile(path.join(dir, "definition.json"), "utf8"))
  } catch {
    return null
  }
  for (const codeFile of ["code.py", "code.mjs"]) {
    const code = await readFile(path.join(dir, codeFile), "utf8").catch(() => null)
    if (code !== null) {
      definition.code = code
      return definition
    }
  }
  return null
}

/** What listLibrary needs to know beyond the library itself. */
export interface ListLibraryOptions {
  /** The viewer's role: admins also see proposed built entries */
  role?: AuthUser["role"]
  /** Connector registry for update detection (defaults to CONNECTORS) */
  connectors?: ConnectorRegistry
}

/** Lists the library with each entry's installed/update status, built entries included. */
export async function listLibrary(
  pool: pg.Pool,
  libraryPath: string,
  options: ListLibraryOptions = {}
): Promise<LibraryEntry[]> {
  const connectors = options.connectors ?? CONNECTORS
  let ids: string[]
  try {
    ids = (await readdir(path.join(libraryPath, "integrations"))).filter(id => ID_PATTERN.test(id)).sort()
  } catch {
    ids = []
  }
  const installed = await pool.query("SELECT id, version, definition FROM app.integrations")
  const byId = new Map<string, { version: number; definition: IntegrationDefinition }>(
    installed.rows.map(row => [row.id, { version: row.version, definition: row.definition }])
  )

  const summary = (id: string, definition: IntegrationDefinition) => ({
    id,
    name: definition.name ?? { _base: "en", en: id },
    description: definition.description ?? null,
    source: definition.source ?? null,
    trigger: definition.trigger ?? {},
    runtime: definition.runtime,
    destinations: (definition.destinations ?? []).map(d =>
      d.kind === "table" ? { kind: "table", id: d.tableId } : { kind: "raster", id: d.layerId }
    )
  })

  const entries: LibraryEntry[] = []
  const shippedIds = new Set<string>()
  for (const id of ids) {
    const definition = await loadLibraryEntry(libraryPath, id)
    if (!definition || definition.id !== id) continue
    shippedIds.add(id)
    const current = byId.get(id)
    entries.push({
      ...summary(id, definition),
      status: !current
        ? "not_installed"
        : comparableJson(current.definition) === comparableJson(definition)
          ? "installed"
          : "update_available",
      installedVersion: current?.version ?? null,
      origin: "shipped"
    })
  }

  const isAdmin = options.role === "admin"
  const built = await pool.query(
    `SELECT id, definition, status, pending_definition IS NOT NULL AS pending FROM app.built_library_entries
     WHERE status = 'approved' OR (status = 'proposed' AND $1) ORDER BY id`,
    [isAdmin]
  )
  for (const row of built.rows as BuiltRow[]) {
    // A shipped entry always wins its id
    if (shippedIds.has(row.id) || row.definition.id !== row.id || !row.definition.recipe) continue
    const current = byId.get(row.id)
    const recipe = current?.definition.recipe
    const info = connectors[row.definition.recipe.connector]
    const behind = !!recipe && !!info && recipe.connectorVersion < info.version
    entries.push({
      ...summary(row.id, { ...row.definition, trigger: {} }),
      status: !current ? "not_installed" : !recipe || behind ? "update_available" : "installed",
      installedVersion: current?.version ?? null,
      origin: "built",
      builtStatus: row.status,
      ...(current ? { changedHere: builtComparableJson(current.definition) !== builtComparableJson(row.definition) } : {}),
      ...(isAdmin && row.pending ? { pendingVersion: true } : {})
    })
  }
  return entries.sort((a, b) => a.id.localeCompare(b.id))
}

/**
 * Installs or updates one entry, shipped or approved built. On update, the
 * deployment-owned fields keep their installed values (present, absent, or
 * explicit null alike). An installed builder source updates by its connector
 * alone: the connector's current code and version, everything else as
 * installed. Returns null when the entry does not exist.
 */
export async function installLibraryEntry(
  pool: pg.Pool,
  libraryPath: string,
  id: string,
  createdBy: string | null,
  connectors: ConnectorRegistry = CONNECTORS
): Promise<{ version: number } | null> {
  const shipped = await loadLibraryEntry(libraryPath, id)
  const entry = shipped ?? (await loadBuiltEntry(pool, libraryPath, id, connectors))
  if (!entry || entry.id !== id) return null
  const installed = await pool.query("SELECT definition FROM app.integrations WHERE id = $1", [id])
  if (!shipped && installed.rows[0]?.definition.recipe) {
    const current = installed.rows[0].definition as IntegrationDefinition
    return installIntegration(pool, await withCurrentConnector(current, libraryPath, connectors), "ready", createdBy)
  }
  const definition: Record<string, unknown> = { ...entry }
  if (installed.rows.length > 0) {
    const current = installed.rows[0].definition as Record<string, unknown>
    for (const field of DEPLOYMENT_FIELDS) {
      if (field in current) definition[field] = current[field]
      else delete definition[field]
    }
    // Values for settings the entry no longer declares, or no longer accepts, fall back to its defaults
    const kept = keepValidSettingValues(
      current.settingValues as Record<string, SettingValue> | undefined,
      entry.settings
    )
    if (Object.keys(kept).length > 0) definition.settingValues = kept
    else delete definition.settingValues
  }
  return installIntegration(pool, definition as unknown as IntegrationDefinition, "ready", createdBy)
}

/**
 * Applies a connector update to an installed builder source: the connector's
 * current code and version, with its settings and deployment fields as they
 * are. Never runs on its own, only on this explicit request.
 */
export async function applyConnectorUpdate(
  pool: pg.Pool,
  libraryPath: string,
  id: string,
  createdBy: string | null,
  connectors: ConnectorRegistry = CONNECTORS
): Promise<{ version: number }> {
  const row = await pool.query("SELECT definition FROM app.integrations WHERE id = $1", [id])
  if (row.rows.length === 0) throw new LibraryError(404, "unknown integration")
  const current = row.rows[0].definition as IntegrationDefinition
  if (!current.recipe) throw new LibraryError(400, "Only sources made with the builder have connector updates.")
  const info = connectors[current.recipe.connector]
  if (!info) throw new LibraryError(400, `Unknown connector "${current.recipe.connector}".`)
  if (current.recipe.connectorVersion >= info.version) throw new LibraryError(409, "The connector is already up to date.")
  return installIntegration(pool, await withCurrentConnector(current, libraryPath, connectors), "ready", createdBy)
}

/**
 * Stores a definition for approval: a new proposed entry, or the pending
 * version of an approved one (a proposed or rejected entry is replaced and
 * set back to proposed). One atomic upsert; never changes an approved definition.
 */
async function upsertBuiltDefinition(
  pool: pg.Pool,
  id: string,
  definition: Record<string, unknown>,
  userId: string
): Promise<{ rows: { status: "proposed" | "approved"; pending: boolean }[] }> {
  return pool.query(
    `INSERT INTO app.built_library_entries AS e (id, definition, status, proposed_by, proposed_at)
     VALUES ($1, $2, 'proposed', $3, now())
     ON CONFLICT (id) DO UPDATE SET
       definition = CASE WHEN e.status = 'approved' THEN e.definition ELSE EXCLUDED.definition END,
       pending_definition = CASE WHEN e.status = 'approved' THEN EXCLUDED.definition ELSE NULL END,
       approved_by = CASE WHEN e.status = 'approved' THEN e.approved_by ELSE NULL END,
       decided_at = CASE WHEN e.status = 'approved' THEN e.decided_at ELSE NULL END,
       note = CASE WHEN e.status = 'approved' THEN e.note ELSE NULL END,
       status = CASE WHEN e.status = 'approved' THEN 'approved' ELSE 'proposed' END,
       proposed_by = EXCLUDED.proposed_by,
       proposed_at = EXCLUDED.proposed_at
     RETURNING status, pending_definition IS NOT NULL AS pending`,
    [id, JSON.stringify(definition), userId]
  )
}

/** Throws a 400 LibraryError when a stored or shared definition has no valid recipe. */
function assertValidRecipe(definition: Record<string, unknown>): void {
  const recipe = definition.recipe as Recipe | undefined
  if (!recipe || typeof recipe !== "object") throw new LibraryError(400, "The entry has no recipe.")
  try {
    validateRecipe(recipe)
  } catch (err) {
    throw new LibraryError(400, err instanceof Error ? err.message : String(err))
  }
}

/**
 * Proposes an installed builder source for the library, as its definition
 * without the deployment-owned fields and without code (secrets travel as
 * names only). A proposal for an approved entry waits as its pending version.
 */
export async function proposeBuiltEntry(
  pool: pg.Pool,
  libraryPath: string,
  integrationId: string,
  userId: string
): Promise<{ id: string; status: "proposed" | "approved"; pending: boolean }> {
  if (!ID_PATTERN.test(integrationId)) throw new LibraryError(404, "unknown integration")
  const row = await pool.query("SELECT definition FROM app.integrations WHERE id = $1", [integrationId])
  if (row.rows.length === 0) throw new LibraryError(404, "unknown integration")
  const installed = row.rows[0].definition as IntegrationDefinition
  if (!installed.recipe) throw new LibraryError(400, "Only sources made with the builder can be proposed for the library.")
  try {
    validateRecipe(installed.recipe)
  } catch (err) {
    throw new LibraryError(400, err instanceof Error ? err.message : String(err))
  }
  if (await shippedEntryExists(libraryPath, integrationId)) {
    throw new LibraryError(409, `The library already has an entry "${integrationId}".`)
  }
  const proposed: Record<string, unknown> = { ...installed }
  for (const field of [...DEPLOYMENT_FIELDS, "code"]) delete proposed[field]
  const result = await upsertBuiltDefinition(pool, integrationId, proposed, userId)
  return { id: integrationId, status: result.rows[0].status, pending: result.rows[0].pending }
}

/** Where an approve or reject found nothing to decide: unknown (404) or already decided (409). */
async function nothingToDecide(pool: pg.Pool, id: string): Promise<never> {
  const row = await pool.query("SELECT 1 FROM app.built_library_entries WHERE id = $1", [id])
  if (row.rows.length === 0) throw new LibraryError(404, "unknown library entry")
  throw new LibraryError(409, "Nothing waits for a decision on this entry.")
}

/** Approves a proposed entry, or promotes an approved entry's pending version (bumping its version). */
export async function approveBuiltEntry(pool: pg.Pool, id: string, adminId: string): Promise<{ version: number }> {
  const waiting = await pool.query(
    "SELECT COALESCE(pending_definition, definition) AS definition FROM app.built_library_entries WHERE id = $1",
    [id]
  )
  if (waiting.rows.length > 0) assertValidRecipe(waiting.rows[0].definition)
  const result = await pool.query(
    `UPDATE app.built_library_entries SET
       definition = COALESCE(pending_definition, definition),
       version = CASE WHEN pending_definition IS NOT NULL THEN version + 1 ELSE version END,
       pending_definition = NULL,
       status = 'approved',
       approved_by = $2,
       decided_at = now(),
       note = NULL
     WHERE id = $1 AND (status = 'proposed' OR (status = 'approved' AND pending_definition IS NOT NULL))
     RETURNING version`,
    [id, adminId]
  )
  if (result.rows.length === 0) return nothingToDecide(pool, id)
  return { version: result.rows[0].version }
}

/** Rejects a proposed entry, or drops an approved entry's pending version; the note says why. */
export async function rejectBuiltEntry(pool: pg.Pool, id: string, note: string | null): Promise<void> {
  const result = await pool.query(
    `UPDATE app.built_library_entries SET
       status = CASE WHEN status = 'approved' THEN 'approved' ELSE 'rejected' END,
       pending_definition = NULL,
       note = $2,
       decided_at = now()
     WHERE id = $1 AND (status = 'proposed' OR (status = 'approved' AND pending_definition IS NOT NULL))`,
    [id, note]
  )
  if (result.rowCount === 0) await nothingToDecide(pool, id)
}

/** The file format of a shared built entry. */
const ENTRY_FORMAT = "wash-di-library-entry"

/** An approved built entry as a shareable file: no code, no AOI, no setting values. Null when there is none. */
export async function exportBuiltEntry(
  pool: pg.Pool,
  id: string
): Promise<{ format: string; version: number; definition: Record<string, unknown> } | null> {
  if (!ID_PATTERN.test(id)) return null
  const row = await pool.query("SELECT definition FROM app.built_library_entries WHERE id = $1 AND status = 'approved'", [id])
  if (row.rows.length === 0) return null
  const definition: Record<string, unknown> = { ...row.rows[0].definition }
  assertValidRecipe(definition)
  for (const field of ["code", "aoi", "settingValues"]) delete definition[field]
  return { format: ENTRY_FORMAT, version: 1, definition }
}

/**
 * Stores a shared entry file for approval: as a new proposed entry, or as the
 * pending version of an approved entry with the same id. Never changes an
 * approved definition, and never installs anything.
 */
export async function importBuiltEntry(
  pool: pg.Pool,
  libraryPath: string,
  file: Record<string, unknown>,
  adminId: string
): Promise<{ id: string; status: "proposed" | "approved"; pending: boolean }> {
  if (file.format !== ENTRY_FORMAT || file.version !== 1) {
    throw new LibraryError(400, `This is not a library entry file (expected format "${ENTRY_FORMAT}", version 1).`)
  }
  const raw = file.definition
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new LibraryError(400, "The file has no definition.")
  if ("code" in raw) {
    throw new LibraryError(400, "This file contains code. Library entries are built from connectors; code is not accepted.")
  }
  const definition = { ...(raw as Record<string, unknown>) }
  const id = definition.id
  if (typeof id !== "string" || !ID_PATTERN.test(id)) throw new LibraryError(400, "The entry id is missing or not valid.")
  assertValidRecipe(definition)
  if (await shippedEntryExists(libraryPath, id)) throw new LibraryError(400, `The library already has an entry "${id}".`)
  const hand = await pool.query("SELECT definition->'recipe' IS NOT NULL AS built FROM app.integrations WHERE id = $1", [id])
  if (hand.rows.length > 0 && !hand.rows[0].built) {
    throw new LibraryError(400, `An integration "${id}" that was not made with the builder is already installed.`)
  }
  // Deployment-owned fields (aoi, trigger, limits, setting values) never travel; the schedule is the importer's
  for (const field of [...DEPLOYMENT_FIELDS, "code"]) delete definition[field]
  const result = await upsertBuiltDefinition(pool, id, definition, adminId)
  return { id, status: result.rows[0].status, pending: result.rows[0].pending }
}
