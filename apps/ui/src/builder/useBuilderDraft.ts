/**
 * Shared state of the source builder: the draft's screens as the steps edit
 * them, converted to and from the saved client state. Every step change saves
 * the whole state, so a draft resumes from #/builder/<draftId>.
 */
import { useCallback, useEffect, useRef, useState } from "react"
import type { ConnectorId, LocalizedString, RecipeColumn, RecipeConfig } from "@data-integrator/definitions"
import {
  BuilderInspect,
  BuilderState,
  getBuilderDraft,
  inspectBuilderDraft,
  saveBuilderDraft
} from "../api.js"
import { currentLocale, localizeData } from "../localization.js"

/** The builder's steps, in order. */
export const STEPS = ["source", "columns", "cleanup", "places", "preview", "schedule", "accept"] as const
export type StepId = (typeof STEPS)[number]

/** Connectors in the order the source step offers them. */
export const CONNECTORS: ConnectorId[] = ["sheet_link", "upload", "hdx", "arcgis", "web_api", "webhook"]

/** Connector version the builder writes (the server's registry is at 1 for all). */
const CONNECTOR_VERSION = 1

/** Stand-in column sent while reading a source whose columns are not chosen yet (the server wants one). */
const INSPECT_PLACEHOLDER = "inspect_placeholder"

/** The same pattern the server checks table and column ids against. */
export const ID_PATTERN = /^[a-z][a-z0-9_]{0,62}$/

/** Clean-up options of a recipe. */
export type Cleanup = RecipeConfig["cleanup"]
/** Places settings of a recipe. */
export type Places = NonNullable<RecipeConfig["places"]>

/** What the steps edit. */
export interface Work {
  step: StepId
  /** Table and source id */
  id: string
  /** Display name, in the current language */
  name: string
  connector: ConnectorId | null
  /** Connector settings (recipe.config.source) */
  source: Record<string, unknown>
  columns: RecipeColumn[]
  cleanup: Cleanup
  places: Places | null
  writeMode: RecipeConfig["writeMode"]
  mergeKey: string | null
  /** Schedule; null when it only runs on demand */
  cron: string | null
  provider: string
  license: string
  limitations: string
}

/** Step label, shown in the step list. */
export function stepLabel(step: StepId): string {
  switch (step) {
    case "source": return T`Source`
    case "columns": return T`Columns`
    case "cleanup": return T`Clean-up`
    case "places": return T`Places`
    case "preview": return T`Preview`
    case "schedule": return T`Name and schedule`
    case "accept": return T`Add`
  }
}

/** Connector name, as the source step lists it. */
export function connectorLabel(id: ConnectorId): string {
  switch (id) {
    case "sheet_link": return T`Spreadsheet or CSV at a link`
    case "hdx": return T`HDX dataset`
    case "arcgis": return T`ArcGIS feature service`
    case "web_api": return T`Web API (JSON)`
    case "upload": return T`Uploaded file`
    case "webhook": return T`Pushed data (webhook)`
  }
}

/** One line on what each connector reads. */
export function connectorHelp(id: ConnectorId): string {
  switch (id) {
    case "sheet_link": return T`A CSV or Excel file anyone can open from a web address, such as a shared Google Sheet.`
    case "hdx": return T`A file from a dataset on the Humanitarian Data Exchange.`
    case "arcgis": return T`A map layer published on ArcGIS Online or an ArcGIS server.`
    case "web_api": return T`A web address that answers with records in JSON.`
    case "upload": return T`A CSV or Excel file you upload here. Uploading a new file refreshes the data.`
    case "webhook": return T`Another system sends the data here as it happens, for example a sensor.`
  }
}

/** The write modes a connector offers (the server's registry). */
export function writeModesOf(connector: ConnectorId | null): RecipeConfig["writeMode"][] {
  if (connector === "webhook") return ["append"]
  if (connector === "web_api") return ["replace", "merge"]
  return ["replace"]
}

/** An id suggested from a name: lowercase snake_case starting with a letter. */
export function suggestId(text: string, fallback = "new_source"): string {
  const slug = text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
  if (!slug) return fallback
  return (/^[a-z]/.test(slug) ? slug : `c_${slug}`).slice(0, 63).replace(/_+$/, "")
}

/** A display name as one text in the current language. */
function nameText(name: BuilderState["name"]): string {
  return localizeData(name as LocalizedString | string | undefined)
}

/** The current language's text as a LocalizedString. */
function localized(text: string): LocalizedString {
  const locale = currentLocale()
  return { _base: locale, [locale]: text } as LocalizedString
}

/** Saved state to the steps' working copy. */
function fromState(state: BuilderState): Work {
  const config = state.recipe?.config
  const step = (STEPS as readonly string[]).includes(state.step ?? "") ? (state.step as StepId) : "source"
  return {
    step,
    id: state.id ?? "",
    name: nameText(state.name),
    connector: state.recipe?.connector ?? null,
    source: config?.source ?? {},
    columns: (config?.columns ?? []).filter(c => c.id !== INSPECT_PLACEHOLDER),
    cleanup: config?.cleanup ?? {},
    places: config?.places ?? null,
    writeMode: config?.writeMode ?? "replace",
    mergeKey: config?.mergeKey ?? null,
    cron: state.trigger?.cron ?? null,
    provider: state.source?.provider ?? "",
    license: state.source?.license ?? "",
    limitations: nameText(state.source?.limitations)
  }
}

/**
 * The steps' working copy as the full saved state. With forInspect, an empty
 * column list gets a stand-in and unpivoting is left out, so the source is
 * read with its own columns.
 */
export function toState(work: Work, forInspect = false): BuilderState {
  const state: BuilderState = { step: work.step }
  if (work.id) state.id = work.id
  if (work.name.trim()) state.name = localized(work.name.trim())
  const url = typeof work.source.url === "string" ? work.source.url : typeof work.source.layerUrl === "string" ? work.source.layerUrl : ""
  state.source = {
    name: localized(work.name.trim() || work.id),
    ...(url ? { url } : {}),
    ...(work.provider.trim() ? { provider: work.provider.trim() } : {}),
    ...(work.license.trim() ? { license: work.license.trim() } : {}),
    ...(work.limitations.trim() ? { limitations: localized(work.limitations.trim()) } : {})
  }
  state.trigger = work.cron && work.connector !== "upload" && work.connector !== "webhook" ? { cron: work.cron } : {}
  if (work.connector) {
    const modes = writeModesOf(work.connector)
    let writeMode = modes.includes(work.writeMode) ? work.writeMode : modes[0]
    let columns = work.columns
    let cleanup = work.cleanup
    if (forInspect) {
      if (columns.length === 0) columns = [{ from: INSPECT_PLACEHOLDER, id: INSPECT_PLACEHOLDER, type: "text" }]
      if (writeMode === "merge") writeMode = modes[0]
      const { unpivot: _unpivot, ...rest } = cleanup
      cleanup = rest
    }
    const config: RecipeConfig = { source: work.source, columns, cleanup, writeMode }
    if (writeMode === "merge" && work.mergeKey) config.mergeKey = work.mergeKey
    if (work.places) config.places = work.places
    state.recipe = { connector: work.connector, connectorVersion: CONNECTOR_VERSION, config }
  }
  return state
}

/** The builder's state and the calls the steps make. */
export interface BuilderModel {
  draftId: string
  isAdmin: boolean
  work: Work
  /** Changes the working copy without saving */
  update: (patch: Partial<Work>) => void
  /** Saves the working copy with the patch; resolves to what was saved */
  save: (patch?: Partial<Work>) => Promise<Work>
  /** Saves the patch and moves to another step */
  goTo: (step: StepId, patch?: Partial<Work>) => Promise<void>
  /** Saves for reading and reads the source; null when it failed (see error) */
  inspect: (patch?: Partial<Work>) => Promise<BuilderInspect | null>
  /** Last read of the source, kept in memory */
  inspected: BuilderInspect | null
  /** Skip and header rows the last read used */
  inspectedCleanup: { skipRows?: number; headerRow?: number } | null
  /** True while saving or reading */
  busy: boolean
  /** Last failure, as the server worded it */
  error: string | null
  setError: (error: string | null) => void
  /** File name uploaded in this visit (an upload source) */
  uploadedName: string | null
  setUploadedName: (name: string | null) => void
}

/** Loads a draft and keeps it saved as the steps change. */
export function useBuilderDraft(draftId: string, isAdmin: boolean): { model: BuilderModel | null; loadError: string | null; reload: () => void } {
  const [work, setWorkState] = useState<Work | null>(null)
  // The latest copy, so a save right after another step's save never reads a stale render
  const workRef = useRef<Work | null>(null)
  const setWork = useCallback((next: Work | null) => {
    workRef.current = next
    setWorkState(next)
  }, [])
  const [loadError, setLoadError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [inspected, setInspected] = useState<BuilderInspect | null>(null)
  const [inspectedCleanup, setInspectedCleanup] = useState<BuilderModel["inspectedCleanup"]>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [uploadedName, setUploadedName] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoadError(null)
    getBuilderDraft(draftId).then(
      draft => {
        if (!cancelled) setWork(fromState(draft.state))
      },
      err => !cancelled && setLoadError(err instanceof Error ? err.message : String(err))
    )
    return () => {
      cancelled = true
    }
  }, [draftId, attempt, setWork])

  const update = useCallback(
    (patch: Partial<Work>) => {
      if (workRef.current) setWork({ ...workRef.current, ...patch })
    },
    [setWork]
  )

  const save = useCallback(
    async (patch: Partial<Work> = {}): Promise<Work> => {
      const next = { ...workRef.current!, ...patch }
      await saveBuilderDraft(draftId, toState(next))
      setWork(next)
      return next
    },
    [draftId, setWork]
  )

  const goTo = useCallback(
    async (step: StepId, patch: Partial<Work> = {}) => {
      setBusy(true)
      setError(null)
      try {
        await save({ ...patch, step })
        window.scrollTo(0, 0)
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setBusy(false)
      }
    },
    [save]
  )

  const inspect = useCallback(
    async (patch: Partial<Work> = {}): Promise<BuilderInspect | null> => {
      const next = { ...workRef.current!, ...patch }
      setWork(next)
      setBusy(true)
      setError(null)
      try {
        await saveBuilderDraft(draftId, toState(next, true))
        const result = await inspectBuilderDraft(draftId)
        // Put the real state back: the stand-in column was only for reading
        await saveBuilderDraft(draftId, toState(next))
        setInspected(result)
        setInspectedCleanup({ skipRows: next.cleanup.skipRows, headerRow: next.cleanup.headerRow })
        return result
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
        return null
      } finally {
        setBusy(false)
      }
    },
    [draftId, setWork]
  )

  const model: BuilderModel | null = work
    ? {
        draftId,
        isAdmin,
        work,
        update,
        save,
        goTo,
        inspect,
        inspected,
        inspectedCleanup,
        busy,
        error,
        setError,
        uploadedName,
        setUploadedName
      }
    : null
  return { model, loadError, reload: () => setAttempt(n => n + 1) }
}
