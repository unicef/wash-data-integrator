import { readFile } from "node:fs/promises"
import path from "node:path"
import { CONNECTOR_IDS, ConnectorId, LocalizedString } from "@data-integrator/definitions"

export interface ConnectorInfo {
  version: number
  label: LocalizedString
  writeModes: ("replace" | "append" | "merge")[]
  needsFile: boolean
  needsWebhook: boolean
}

const label = (en: string): LocalizedString => ({ _base: "en", en })

export const CONNECTORS: Record<ConnectorId, ConnectorInfo> = {
  sheet_link: { version: 1, label: label("Spreadsheet or CSV at a link"), writeModes: ["replace"], needsFile: false, needsWebhook: false },
  hdx: { version: 1, label: label("HDX dataset"), writeModes: ["replace"], needsFile: false, needsWebhook: false },
  arcgis: { version: 1, label: label("ArcGIS feature service"), writeModes: ["replace"], needsFile: false, needsWebhook: false },
  web_api: { version: 1, label: label("Web API (JSON)"), writeModes: ["replace", "merge"], needsFile: false, needsWebhook: false },
  upload: { version: 1, label: label("Uploaded file"), writeModes: ["replace"], needsFile: true, needsWebhook: false },
  webhook: { version: 1, label: label("Pushed data (webhook)"), writeModes: ["append"], needsFile: false, needsWebhook: true },
}

const CORE_IMPORT = "from _core import *  # core-import"

/** The connector's single-file code: the shared core followed by the connector, minus its core import line. */
export async function connectorCode(id: ConnectorId, libraryPath: string): Promise<string> {
  if (!(CONNECTOR_IDS as readonly string[]).includes(id)) throw new Error(`Unknown connector "${id}".`)
  const dir = path.join(libraryPath, "connectors")
  const core = await readFile(path.join(dir, "_core.py"), "utf8")
  const connector = await readFile(path.join(dir, `${id}.py`), "utf8")
  const lines = connector.split("\n")
  if (lines[0].trimEnd() !== CORE_IMPORT) throw new Error(`Connector ${id} must start with: ${CORE_IMPORT}`)
  return `${core.replace(/\s+$/, "")}\n\n\n${lines.slice(1).join("\n").replace(/^\n+/, "")}`
}
