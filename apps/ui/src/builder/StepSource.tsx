/**
 * Step 1: name the data, pick where it comes from and give its link or file.
 * Next reads the source once so the Columns step can list what it found.
 */
import { useEffect, useState } from "react"
import type { ConnectorId } from "@data-integrator/definitions"
import { listBuilderSecrets, setBuilderKey, uploadBuilderFile } from "../api.js"
import { Field, StepNav } from "./shared.js"
import { BuilderModel, connectorHelp, connectorLabel, CONNECTORS, suggestId } from "./useBuilderDraft.js"

/** Paging settings of a web API source. */
interface Paging {
  type: "none" | "page" | "next"
  param?: string
  start?: number
  path?: string
}

/** The text of a source field. */
function text(source: Record<string, unknown>, key: string): string {
  const value = source[key]
  return typeof value === "string" ? value : ""
}

/** The source step. */
export function StepSource({ model }: { model: BuilderModel }) {
  const { work, update } = model
  const source = work.source
  const setSource = (patch: Record<string, unknown>) => {
    const next = { ...source, ...patch }
    for (const key of Object.keys(patch)) if (patch[key] === undefined || patch[key] === "") delete next[key]
    update({ source: next })
  }
  // The pasted sample message stays as typed; only valid JSON objects are kept
  const [sampleText, setSampleText] = useState(() =>
    source.sampleMessage ? JSON.stringify(source.sampleMessage, null, 2) : ""
  )
  const [sampleError, setSampleError] = useState<string | null>(null)
  const [problem, setProblem] = useState<string | null>(null)

  function setName(name: string) {
    // The id follows the name until someone edits it on the Name step
    const followsName = !model.editing && (work.id === "" || work.id === suggestId(work.name))
    update({ name, ...(followsName ? { id: suggestId(name) } : {}) })
  }

  function pickConnector(connector: ConnectorId) {
    // An installed source keeps its connector
    if (connector === work.connector || model.editing) return
    // Settings of another connector do not carry over
    update({
      connector,
      source: connector === "web_api" ? { paging: { type: "none" }, auth: "none" } : {},
      writeMode: connector === "webhook" ? "append" : "replace",
      mergeKey: null
    })
    setSampleText("")
    setSampleError(null)
    setProblem(null)
  }

  function onSample(value: string) {
    setSampleText(value)
    if (value.trim() === "") {
      setSampleError(null)
      setSource({ sampleMessage: undefined })
      return
    }
    try {
      const parsed = JSON.parse(value)
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        setSampleError(T`The sample must be one message in curly brackets { }.`)
        return
      }
      setSampleError(null)
      setSource({ sampleMessage: parsed })
    } catch {
      setSampleError(T`This is not valid JSON yet. Check for missing quotes, commas or brackets.`)
    }
  }

  /** What still needs filling in, in plain words; null when ready. */
  function missing(): string | null {
    if (!work.name.trim()) return T`Give the data a name.`
    if (!work.connector) return T`Choose where the data comes from.`
    switch (work.connector) {
      case "sheet_link":
      case "web_api":
        if (!text(source, "url").trim()) return T`Paste the web address.`
        break
      case "hdx":
        if (!text(source, "url").trim()) return T`Paste the address of the HDX dataset.`
        if (!text(source, "resourceId").trim()) return T`Paste the id of the file in the dataset.`
        break
      case "arcgis":
        if (!text(source, "layerUrl").trim()) return T`Paste the address of the layer.`
        break
      case "webhook":
        if (!source.sampleMessage || sampleError) return T`Paste one sample message in JSON.`
        break
      case "upload":
        break
    }
    return null
  }

  async function next() {
    const why = missing()
    setProblem(why)
    if (why) return
    const id = work.id || suggestId(work.name)
    const result = await model.inspect({ id })
    if (result) await model.goTo("columns")
  }

  return (
    <section className="builder-step">
      <h2>{T`Where does the data come from?`}</h2>
      <Field label={T`Name`} help={T`A short name people will see, for example Cholera cases by region.`}>
        <input type="text" value={work.name} onChange={e => setName(e.target.value)} />
      </Field>

      <fieldset className="builder-choices">
        <legend>{T`Kind of source`}</legend>
        {CONNECTORS.map(id => (
          <label key={id} className={`builder-choice${work.connector === id ? " on" : ""}`}>
            <input type="radio" name="connector" checked={work.connector === id} onChange={() => pickConnector(id)} />
            <span>
              <b>{connectorLabel(id)}</b>
              <span className="dim">{connectorHelp(id)}</span>
            </span>
          </label>
        ))}
      </fieldset>

      {work.connector === "sheet_link" && (
        <>
          <Field label={T`Web address`} help={T`The link to the CSV or Excel file. For a Google Sheet, use File, Share, Publish to web, and copy the CSV link.`}>
            <input type="url" value={text(source, "url")} onChange={e => setSource({ url: e.target.value })} />
          </Field>
          <Field label={T`Sheet (optional)`} help={T`For an Excel file with more than one sheet. Leave empty to read the first sheet.`}>
            <input type="text" value={text(source, "sheet")} onChange={e => setSource({ sheet: e.target.value })} />
          </Field>
        </>
      )}

      {work.connector === "hdx" && (
        <>
          <Field label={T`Dataset address`} help={T`The address of the dataset page on data.humdata.org.`}>
            <input type="url" value={text(source, "url")} onChange={e => setSource({ url: e.target.value })} />
          </Field>
          <Field
            label={T`File id`}
            help={T`On the dataset page, open the file you want. Its address ends in /resource/ followed by the id: copy that id here.`}
          >
            <input type="text" value={text(source, "resourceId")} onChange={e => setSource({ resourceId: e.target.value.trim() })} />
          </Field>
        </>
      )}

      {work.connector === "arcgis" && (
        <Field label={T`Layer address`} help={T`The address of one layer, ending in /FeatureServer/ and a number, for example /FeatureServer/0.`}>
          <input type="url" value={text(source, "layerUrl")} onChange={e => setSource({ layerUrl: e.target.value })} />
        </Field>
      )}

      {work.connector === "web_api" && <WebApiFields model={model} setSource={setSource} />}

      {work.connector === "upload" && <UploadField model={model} setSource={setSource} />}

      {work.connector === "webhook" && (
        <Field
          label={T`Sample message`}
          help={T`Paste one message the other system sends, in JSON. Its fields become the columns.`}
        >
          <textarea
            className="builder-code"
            rows={8}
            value={sampleText}
            placeholder={'{ "station": "Garowe", "rain_mm": 12.5, "time": "2026-11-20T06:00:00Z" }'}
            onChange={e => onSample(e.target.value)}
          />
        </Field>
      )}
      {sampleError && <p className="error">{sampleError}</p>}
      {problem && <p className="error">{problem}</p>}

      <StepNav model={model} onNext={() => void next()} nextLabel={T`Read the source`} busyLabel={T`Reading the source…`} />
    </section>
  )
}

/** Web address, where the records are, paging and key for a web API source. */
function WebApiFields({ model, setSource }: { model: BuilderModel; setSource: (patch: Record<string, unknown>) => void }) {
  const source = model.work.source
  const paging = (source.paging as Paging | undefined) ?? { type: "none" }
  const setPaging = (patch: Partial<Paging>) => setSource({ paging: { ...paging, ...patch } })
  const keyed = source.auth === "key"
  return (
    <>
      <Field label={T`Web address`} help={T`The address that answers with the records.`}>
        <input type="url" value={text(source, "url")} onChange={e => setSource({ url: e.target.value })} />
      </Field>
      <Field
        label={T`Where the records are (optional)`}
        help={T`Leave empty when the answer is just the list of records. If the list sits inside the answer under a name, give that name. For example: data.items`}
      >
        <input type="text" value={text(source, "recordsPath")} onChange={e => setSource({ recordsPath: e.target.value })} />
      </Field>
      <Field label={T`More than one page`} help={T`How the address gives the rest of the records when they do not fit in one answer.`}>
        <select
          value={paging.type}
          onChange={e => {
            const type = e.target.value as Paging["type"]
            setSource({
              paging: type === "page" ? { type, param: "page", start: 1 } : type === "next" ? { type, path: "links.next" } : { type }
            })
          }}
        >
          <option value="none">{T`All records come in one answer`}</option>
          <option value="page">{T`Numbered pages`}</option>
          <option value="next">{T`Each answer links to the next page`}</option>
        </select>
      </Field>
      {paging.type === "page" && (
        <div className="builder-row">
          <Field label={T`Name of the page number setting`} help={T`The name in the address that picks the page. It is often: page`}>
            <input type="text" value={paging.param ?? ""} onChange={e => setPaging({ param: e.target.value })} />
          </Field>
          <Field label={T`First page number`} help={T`Usually 1, sometimes 0.`}>
            <input
              type="number"
              min={0}
              value={paging.start ?? 1}
              onChange={e => setPaging({ start: e.target.value === "" ? undefined : Number(e.target.value) })}
            />
          </Field>
        </div>
      )}
      {paging.type === "next" && (
        <Field label={T`Where the next link is`} help={T`The name in each answer that holds the address of the next page. For example: links.next`}>
          <input type="text" value={paging.path ?? ""} onChange={e => setPaging({ path: e.target.value })} />
        </Field>
      )}
      <fieldset className="builder-choices compact">
        <legend>{T`Key`}</legend>
        <label>
          <input type="radio" name="auth" checked={!keyed} onChange={() => setSource({ auth: "none", keyHeader: undefined })} />{" "}
          {T`Open to anyone, no key needed`}
        </label>
        <label>
          <input type="radio" name="auth" checked={keyed} onChange={() => setSource({ auth: "key" })} /> {T`Needs a key`}
        </label>
      </fieldset>
      {keyed && (
        <>
          <Field
            label={T`Key goes in`}
            help={T`The name the service expects the key under. Most services use Authorization, which is used when this is empty.`}
          >
            <input
              type="text"
              placeholder="Authorization"
              value={text(source, "keyHeader")}
              onChange={e => setSource({ keyHeader: e.target.value })}
            />
          </Field>
          <KeyBox model={model} />
        </>
      )}
    </>
  )
}

/** Whether the draft's key is set; admins add it here, editors wait for one. */
function KeyBox({ model }: { model: BuilderModel }) {
  const [set, setSet] = useState<boolean | null>(null)
  const [value, setValue] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = () =>
    listBuilderSecrets(model.draftId).then(
      r => setSet(r.secrets.some(s => s.name === "api_key")),
      err => setError(err instanceof Error ? err.message : String(err))
    )
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => void refresh(), [model.draftId])

  async function save() {
    setBusy(true)
    setError(null)
    try {
      // The key is tied to the address saved with the draft, so the address is saved first
      await model.save()
      await setBuilderKey(model.draftId, value)
      setValue("")
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="builder-key">
      {set === null ? null : set ? (
        <p>
          <span className="chip chip-succeeded">{T`key added`}</span>{" "}
          <span className="dim">{T`The key is stored encrypted and cannot be shown again.`}</span>
        </p>
      ) : model.isAdmin ? null : (
        <p>
          <span className="chip chip-paused">{T`waiting`}</span>{" "}
          {T`Waiting for an admin to add the key. Your work is saved: send an admin the address of this page.`}
        </p>
      )}
      {model.isAdmin && set !== null && (
        <div className="builder-row">
          <Field label={set ? T`Replace the key` : T`Key`} help={T`Only admins can add keys. It is never shown again.`}>
            <input type="password" autoComplete="off" value={value} onChange={e => setValue(e.target.value)} />
          </Field>
          <button className="secondary" disabled={busy || value.length === 0} onClick={() => void save()}>
            {busy ? T`Saving…` : T`Save key`}
          </button>
        </div>
      )}
      {error && <div className="error">{error}</div>}
    </div>
  )
}

/** File picker and upload for an uploaded-file source. */
function UploadField({ model, setSource }: { model: BuilderModel; setSource: (patch: Record<string, unknown>) => void }) {
  const [progress, setProgress] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function upload(file: File) {
    setError(null)
    setProgress(0)
    try {
      await uploadBuilderFile(model.draftId, "data", file, setProgress)
      model.setUploadedName(file.name)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setProgress(null)
    }
  }

  return (
    <>
      <Field label={T`File`} help={T`A CSV or Excel file. You can upload a newer file later to refresh the data.`}>
        <input
          type="file"
          accept=".csv,.xlsx"
          disabled={progress !== null}
          onChange={e => {
            const file = e.target.files?.[0]
            e.target.value = ""
            if (file) void upload(file)
          }}
        />
      </Field>
      {progress !== null && <p className="dim" role="status">{T`Uploading… ${Math.round(progress * 100)}%`}</p>}
      {model.uploadedName && <p className="dim" role="status">{T`Uploaded: ${model.uploadedName}`}</p>}
      {!model.uploadedName && progress === null && (
        <p className="dim">{T`If you uploaded a file earlier in this draft, it is kept: you can go on, or upload again to replace it.`}</p>
      )}
      {error && <div className="error">{error}</div>}
      <Field label={T`Sheet (optional)`} help={T`For an Excel file with more than one sheet. Leave empty to read the first sheet.`}>
        <input type="text" value={text(model.work.source, "sheet")} onChange={e => setSource({ sheet: e.target.value })} />
      </Field>
    </>
  )
}
