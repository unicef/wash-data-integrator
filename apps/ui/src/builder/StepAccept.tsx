/**
 * Step 7: a summary, then Add installs the source for this deployment and
 * starts its first run. A pushed-data source shows the address to send to
 * and a test command instead.
 */
import { useState } from "react"
import { acceptBuilderDraft, BuilderAccept } from "../api.js"
import { cronText } from "../localization.js"
import { StepNav } from "./shared.js"
import { BuilderModel, connectorLabel } from "./useBuilderDraft.js"

/** The accept step. */
export function StepAccept({ model }: { model: BuilderModel }) {
  const { work } = model
  const [result, setResult] = useState<BuilderAccept | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)

  async function accept() {
    model.setError(null)
    setAdding(true)
    try {
      setResult(await acceptBuilderDraft(model.draftId))
    } catch (err) {
      // Validation and conflict messages are written for people: shown as they come
      model.setError(err instanceof Error ? err.message : String(err))
    } finally {
      setAdding(false)
    }
  }

  const schedule =
    work.connector === "upload"
      ? T`Runs when a new file is uploaded.`
      : work.connector === "webhook"
        ? T`Runs when data arrives.`
        : work.cron
          ? cronText(work.cron)
          : T`Manual only`

  if (result) {
    const url = result.webhookUrl ? `${window.location.origin}${result.webhookUrl}` : null
    const sample = JSON.stringify(work.source.sampleMessage ?? {})
    const curl = url ? `curl -X POST -H "content-type: application/json" -d '${sample.replace(/'/g, "'\\''")}' ${url}` : null
    const copy = (text: string, what: string) =>
      void navigator.clipboard.writeText(text).then(() => setCopied(what), () => setCopied(null))
    return (
      <section className="builder-step">
        <h2>{T`The source is added`}</h2>
        {result.runId && <p>{T`The first run has started. The data appears in the table when it finishes.`}</p>}
        {!url && !result.runId && <p>{T`Start the first run from the source's page.`}</p>}
        {url && curl && (
          <>
            <p>{T`Give the other system this address. Each message it sends there adds rows to the table.`}</p>
            <div className="builder-copy">
              <code>{url}</code>
              <button className="secondary compact" onClick={() => copy(url, "url")}>
                {copied === "url" ? T`Copied` : T`Copy`}
              </button>
            </div>
            <p className="dim">{T`Keep the address private: anyone who has it can send data. To test it, run this command in a terminal; it sends the sample message.`}</p>
            <div className="builder-copy">
              <code>{curl}</code>
              <button className="secondary compact" onClick={() => copy(curl, "curl")}>
                {copied === "curl" ? T`Copied` : T`Copy`}
              </button>
            </div>
          </>
        )}
        <div className="builder-nav">
          <a className="button-link" href={`#/integration/${result.integrationId}`}>
            {T`Open the source`}
          </a>
          <a className="dim-link" href="#/builder">
            {T`Add another source`}
          </a>
        </div>
      </section>
    )
  }

  return (
    <section className="builder-step">
      <h2>{T`Check and add`}</h2>
      <dl className="builder-summary">
        <dt>{T`Name`}</dt>
        <dd>{work.name}</dd>
        <dt>{T`Source`}</dt>
        <dd>{work.connector ? connectorLabel(work.connector) : ""}</dd>
        <dt>{T`Table name`}</dt>
        <dd>
          <code>{work.id}</code>
        </dd>
        <dt>{T`Columns`}</dt>
        <dd>
          {[
            ...work.columns.map(c => c.from),
            ...(work.cleanup.unpivot ? [work.cleanup.unpivot.dateColumnId, work.cleanup.unpivot.valueColumnId] : [])
          ].join(", ")}
        </dd>
        {work.places && (
          <>
            <dt>{T`Places`}</dt>
            <dd>
              {T`${work.columns.find(c => c.id === work.places?.column)?.from ?? work.places.column} matched to ${work.places.table}`}
            </dd>
          </>
        )}
        <dt>{T`Refreshes`}</dt>
        <dd>{schedule}</dd>
        {work.provider && (
          <>
            <dt>{T`Provider`}</dt>
            <dd>{work.provider}</dd>
          </>
        )}
      </dl>
      <p className="dim">{T`Adding installs the source here and starts its first run. You can change the schedule later on the source's page.`}</p>
      <StepNav
        model={model}
        onBack={() => void model.goTo("schedule")}
        onNext={() => void accept()}
        nextDisabled={adding}
        nextLabel={adding ? T`Adding…` : T`Add this source`}
      />
    </section>
  )
}
