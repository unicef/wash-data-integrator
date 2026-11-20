import { ColumnSpec, IntegrationDefinition, LocalizedString, Recipe, SourceInfo, Trigger } from "@data-integrator/definitions"
import { assertNoSecretLikeKeys, ID_PATTERN } from "../install.js"
import { CONNECTORS, connectorCode } from "./connectors.js"

const MAX_MATCHES = 5000
/** The input id a places table is declared under (the connectors read it by this name). */
export const PLACES_INPUT = "places"

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v)
const isHttps = (v: unknown) => {
  try { return new URL(String(v)).protocol === "https:" } catch { return false }
}
const hasText = (v: unknown) => typeof v === "string" && v.trim() !== ""

/** Throws a user-readable Error when the recipe cannot be built or run. */
export function validateRecipe(recipe: Recipe, run?: "inspect" | "preview"): void {
  const inspect = run === "inspect"
  const info = CONNECTORS[recipe?.connector]
  if (!info) throw new Error(`Unknown connector "${recipe?.connector}".`)
  if (!Number.isInteger(recipe.connectorVersion) || recipe.connectorVersion < 1) {
    throw new Error("The connector version must be a positive whole number.")
  }
  const c = recipe.config
  if (!isObject(c)) throw new Error("The recipe has no settings.")
  if (!run && c.mode !== undefined) {
    throw new Error("This source was saved in a preview state; open it in the builder and accept again.")
  }
  if (!isObject(c.source)) throw new Error("The source settings are missing.")
  if (!Array.isArray(c.columns) || (c.columns.length === 0 && !inspect)) throw new Error("Choose at least one column.")
  for (const col of c.columns) {
    if (!isObject(col) || !hasText(col.from) || !hasText(col.id) || !hasText(col.type)) {
      throw new Error("Each column needs a source name, an id and a type.")
    }
    if (!ID_PATTERN.test(col.id)) {
      throw new Error(`Column id "${col.id}" is not valid: use lowercase letters, digits and underscores, starting with a letter.`)
    }
    if (!["text", "number", "date", "place"].includes(col.type)) throw new Error(`Column "${col.id}" has an unknown type "${col.type}".`)
  }
  const ids = c.columns.map((x) => x.id)
  if (new Set(ids).size !== ids.length) throw new Error("Column ids must be unique.")

  // Columns describe the table after clean-up: with an unpivot they are the id columns that remain
  const unpivot = c.cleanup?.unpivot
  if (unpivot) {
    if (!Array.isArray(unpivot.columns) || unpivot.columns.length === 0 || !unpivot.columns.every(hasText)) {
      throw new Error("Choose the columns to unpivot.")
    }
    for (const [what, id] of [["date", unpivot.dateColumnId], ["value", unpivot.valueColumnId]] as const) {
      if (typeof id !== "string" || !ID_PATTERN.test(id)) {
        throw new Error(`The unpivot ${what} column id "${id}" is not valid: use lowercase letters, digits and underscores, starting with a letter.`)
      }
    }
    if (unpivot.dateColumnId === unpivot.valueColumnId) throw new Error("The unpivot date and value columns need different ids.")
    for (const id of [unpivot.dateColumnId, unpivot.valueColumnId]) {
      if (ids.includes(id)) throw new Error(`The unpivot column id "${id}" is already used by another column.`)
    }
  }

  assertNoSecretLikeKeys(c.source)
  const s = c.source
  const need = (field: string, label = field) => {
    if (!hasText(s[field])) throw new Error(`The source needs a ${label}.`)
  }
  switch (recipe.connector) {
    case "sheet_link": need("url"); break
    case "hdx": need("url"); need("resourceId", "resource id"); break
    case "arcgis": need("layerUrl", "layer url"); break
    case "web_api":
      need("url")
      if (s.recordsPath !== undefined && typeof s.recordsPath !== "string") throw new Error("The records path must be text.")
      if (s.auth !== undefined && s.auth !== "none" && s.auth !== "key") throw new Error('Authentication must be "none" or "key".')
      if (s.auth === "key" && !isHttps(s.url)) throw new Error("A key can only be sent over https.")
      break
    case "webhook":
      if (!isObject(s.sampleMessage)) throw new Error("The source needs a sample message.")
      break
    case "upload": break
  }

  if (!info.writeModes.includes(c.writeMode)) {
    throw new Error(`Write mode "${c.writeMode}" is not available for ${info.label.en}: use ${info.writeModes.join(" or ")}.`)
  }
  if (c.writeMode === "merge" && !inspect) {
    if (!hasText(c.mergeKey)) throw new Error("Choose a key column to merge on.")
    // The final table is checked in buildDefinition: the key may be a place code or the unpivot date column
  }
  if (c.places && !inspect) {
    const col = c.columns.find((x) => x.id === c.places?.column)
    if (!col || col.type !== "place") throw new Error(`The place column "${c.places.column}" must be a column of type place.`)
  }
  if (c.places && isObject(c.places.matches) && Object.keys(c.places.matches).length > MAX_MATCHES) {
    throw new Error(`At most ${MAX_MATCHES} place matches are allowed.`)
  }
}

export interface BuildInput {
  id: string
  name: LocalizedString
  source: SourceInfo
  trigger: Trigger
  recipe: Recipe
  places?: { inputId: string; tableId: string }
  /** Set only by builder draft runs (inspect or preview); the recipe's config.mode is then expected */
  run?: "inspect" | "preview"
}

/** Turns builder input into a full definition: destination schema, files, secrets, trigger and the connector's code. */
export async function buildDefinition(input: BuildInput, libraryPath: string): Promise<IntegrationDefinition> {
  if (!ID_PATTERN.test(input.id)) throw new Error(`The id "${input.id}" is not valid: use lowercase letters, digits and underscores, starting with a letter.`)
  validateRecipe(input.recipe, input.run)
  const { connector, config } = input.recipe
  const info = CONNECTORS[connector]

  const unpivot = config.cleanup?.unpivot
  const columns: ColumnSpec[] = []
  for (const col of config.columns) {
    const spec: ColumnSpec = { id: col.id, type: col.type === "place" ? "text" : col.type }
    if (col.unit) spec.units = col.unit
    columns.push(spec)
    if (col.type === "place") columns.push({ id: `${col.id}_code`, type: "text" })
  }
  if (unpivot) columns.push({ id: unpivot.dateColumnId, type: "date" }, { id: unpivot.valueColumnId, type: "number" })

  const ids = columns.map((c) => c.id)
  if (new Set(ids).size !== ids.length) throw new Error("Column ids must be unique, including the generated place code and unpivot columns.")

  if (config.writeMode === "merge" && input.run !== "inspect" && !ids.includes(config.mergeKey as string)) {
    throw new Error(`The merge key "${config.mergeKey}" is not a column of the saved table (the unpivoted columns are replaced by the date and value columns). Choose another key.`)
  }

  const def: IntegrationDefinition = {
    id: input.id,
    name: input.name,
    source: input.source,
    trigger: { ...input.trigger },
    runtime: "python",
    destinations: [{
      kind: "table",
      tableId: input.id,
      action: config.writeMode,
      ...(config.writeMode === "merge" ? { mergeColumns: [config.mergeKey as string] } : {}),
      columns,
    }],
    recipe: input.recipe,
    code: await connectorCode(connector, libraryPath),
    contract: 2,
  }
  if (info.needsWebhook) def.trigger.webhook = true
  if (info.needsFile) def.files = { data: { accept: [".csv", ".xlsx"] } }
  if (connector === "web_api" && config.source.auth === "key") def.secrets = ["api_key"]
  if (input.places) def.inputs = { [input.places.inputId]: { kind: "table", tableId: input.places.tableId, format: "csv" } }
  return def
}
