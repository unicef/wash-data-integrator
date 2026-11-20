/**
 * The source builder: add a data source step by step, without code or AI.
 * #/builder starts a draft and moves to #/builder/<draftId>; that address
 * resumes the draft where it was left.
 */
import { useEffect, useState } from "react"
import { createBuilderDraft } from "../api.js"
import { LoadState } from "../LoadState.js"
import { StepAccept } from "./StepAccept.js"
import { StepCleanup } from "./StepCleanup.js"
import { StepColumns } from "./StepColumns.js"
import { StepPlaces } from "./StepPlaces.js"
import { StepPreview } from "./StepPreview.js"
import { StepSchedule } from "./StepSchedule.js"
import { StepSource } from "./StepSource.js"
import { BuilderModel, StepId, stepLabel, STEPS, useBuilderDraft } from "./useBuilderDraft.js"

/** Props for the builder page. */
interface BuilderPageProps {
  /** Draft to resume; null starts a new one */
  draftId: string | null
  /** False for viewers, who cannot add sources */
  canDesign: boolean
  /** True for admins, who can add keys */
  isAdmin: boolean
}

/** The builder page: starts or resumes a draft. */
export function BuilderPage({ draftId, canDesign, isAdmin }: BuilderPageProps) {
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!canDesign || draftId) return
    let cancelled = false
    createBuilderDraft().then(
      ({ id }) => !cancelled && window.location.replace(`#/builder/${id}`),
      err => !cancelled && setError(err instanceof Error ? err.message : String(err))
    )
    return () => {
      cancelled = true
    }
  }, [draftId, canDesign])

  if (!canDesign) {
    return (
      <main className="list-page">
        <h1>{T`New source`}</h1>
        <p>{T`Viewers cannot add sources. Ask an editor or an admin.`}</p>
      </main>
    )
  }
  if (!draftId) {
    return (
      <main className="list-page">
        {error ? <div className="error">{error}</div> : <p role="status">{T`Starting a new source…`}</p>}
      </main>
    )
  }
  return <BuilderDraftView key={draftId} draftId={draftId} isAdmin={isAdmin} />
}

/** One draft: the step list and the current step. */
function BuilderDraftView({ draftId, isAdmin }: { draftId: string; isAdmin: boolean }) {
  const { model, loadError, reload } = useBuilderDraft(draftId, isAdmin)
  const current = model?.work.step ?? "source"
  const currentIndex = STEPS.indexOf(current)

  return (
    <main className="list-page builder-page">
      <a className="page-back" href="#/integrations">
        ← {T`Integrations`}
      </a>
      <div className="list-head">
        <div className="catalog-header">
          <h1>{T`New source`}</h1>
          <p>{T`Add a data source step by step. Your work is saved at each step: open this page again to go on.`}</p>
        </div>
      </div>
      {!model ? (
        <LoadState error={loadError} onRetry={reload} />
      ) : (
        <>
          <ol className="builder-steps">
            {STEPS.map((step, i) => (
              <li key={step} className={step === current ? "on" : i < currentIndex ? "done" : undefined}>
                {i < currentIndex ? (
                  <button className="quiet" disabled={model.busy} onClick={() => void model.goTo(step)}>
                    <span className="builder-step-n">{i + 1}</span> {stepLabel(step)}
                  </button>
                ) : (
                  <span aria-current={step === current ? "step" : undefined}>
                    <span className="builder-step-n">{i + 1}</span> {stepLabel(step)}
                  </span>
                )}
              </li>
            ))}
          </ol>
          <CurrentStep step={current} model={model} />
        </>
      )}
    </main>
  )
}

/** The screen of one step. */
function CurrentStep({ step, model }: { step: StepId; model: BuilderModel }) {
  switch (step) {
    case "source": return <StepSource model={model} />
    case "columns": return <StepColumns model={model} />
    case "cleanup": return <StepCleanup model={model} />
    case "places": return <StepPlaces model={model} />
    case "preview": return <StepPreview model={model} />
    case "schedule": return <StepSchedule model={model} />
    case "accept": return <StepAccept model={model} />
  }
}
