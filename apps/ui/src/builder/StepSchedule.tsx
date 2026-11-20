/**
 * Step 6: the source's name, its table's name, how often it refreshes, and
 * where the data comes from (provider, licence, limitations), which everyone
 * who uses the data sees.
 */
import { useState } from "react"
import { CronDraft, CronEditor, fromCronDraft, toCronDraft } from "../CronEditor.js"
import { cronText } from "../localization.js"
import { Field, StepNav } from "./shared.js"
import { BuilderModel, ID_PATTERN, usePending, Work } from "./useBuilderDraft.js"

/** The name and schedule step. */
export function StepSchedule({ model }: { model: BuilderModel }) {
  const { work } = model
  const [name, setName] = useState(work.name)
  const [id, setId] = useState(work.id)
  // Daily at 06:00 UTC is offered only until a schedule was saved; after that an empty one means Manual only
  const [cronDraft, setCronDraftState] = useState<CronDraft>(() => toCronDraft(work.scheduleSet ? work.cron : "0 6 * * *"))
  const [cronTouched, setCronTouched] = useState(false)
  const setCronDraft = (draft: CronDraft) => {
    setCronDraftState(draft)
    setCronTouched(true)
  }
  const [provider, setProvider] = useState(work.provider)
  const [license, setLicense] = useState(work.license)
  const [limitations, setLimitations] = useState(work.limitations)
  const [problem, setProblem] = useState<string | null>(null)
  const scheduled = work.connector !== "upload" && work.connector !== "webhook"

  /** The step's fields; the schedule only once it was chosen here or saved before. */
  const patch = (chosen = !model.editing && (cronTouched || work.scheduleSet)): Partial<Work> => ({
    name,
    id: id.trim(),
    provider,
    license,
    limitations,
    ...(chosen ? { cron: scheduled ? fromCronDraft(cronDraft) : null, scheduleSet: true } : {})
  })
  usePending(model, () => patch())

  async function next() {
    if (!name.trim()) {
      setProblem(T`Give the source a name.`)
      return
    }
    if (!ID_PATTERN.test(id.trim())) {
      setProblem(T`The table name cannot be used. Use lowercase letters, digits and underscores, starting with a letter.`)
      return
    }
    setProblem(null)
    await model.goTo("accept", patch(true))
  }

  return (
    <section className="builder-step">
      <h2>{T`Name and schedule`}</h2>
      <Field label={T`Name`} help={T`The name people see in lists and on dashboards.`}>
        <input type="text" value={name} onChange={e => setName(e.target.value)} />
      </Field>
      <Field label={T`Table name`} help={T`The name of the table the data is saved in. Lowercase letters, digits and underscores. It cannot change later.`}>
        <input type="text" value={id} readOnly={!!model.editing} onChange={e => setId(e.target.value)} />
      </Field>

      <h3>{T`How often it refreshes`}</h3>
      {model.editing ? (
        <p>
          {work.cron ? cronText(work.cron) : T`Manual only`}{" "}
          <a href={`#/integration/${model.editing}`}>{T`Change the schedule on the source page`}</a>
        </p>
      ) : work.connector === "upload" ? (
        <p>{T`Runs when a new file is uploaded.`}</p>
      ) : work.connector === "webhook" ? (
        <p>{T`Runs when data arrives.`}</p>
      ) : (
        <>
          <CronEditor draft={cronDraft} onChange={setCronDraft} />
          <p className="dim">{T`Times are in UTC. Manual only means it refreshes only when someone starts it.`}</p>
        </>
      )}

      <h3>{T`About the data`}</h3>
      <Field label={T`Provider (optional)`} help={T`Who publishes the data, for example Ministry of Health.`}>
        <input type="text" value={provider} onChange={e => setProvider(e.target.value)} />
      </Field>
      <Field label={T`Licence (optional)`} help={T`The terms the data may be used under, for example CC-BY-4.0.`}>
        <input type="text" value={license} onChange={e => setLicense(e.target.value)} />
      </Field>
      <Field label={T`Limitations (optional)`} help={T`What people should know before using the data: gaps, delays, how accurate it is.`}>
        <textarea rows={3} value={limitations} onChange={e => setLimitations(e.target.value)} />
      </Field>

      {problem && <p className="error">{problem}</p>}
      <StepNav model={model} onBack={() => void model.goTo("preview", patch())} onNext={() => void next()} />
    </section>
  )
}
