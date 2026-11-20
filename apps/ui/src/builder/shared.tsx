/** Small pieces every builder step uses: a labelled field and the Back / Next bar. */
import type { ReactNode } from "react"
import type { BuilderModel } from "./useBuilderDraft.js"

/** A label, its control, and one short help line. */
export function Field({ label, help, children }: { label: string; help?: string; children: ReactNode }) {
  return (
    <div className="setting-field builder-field">
      <label>
        {label}
        {children}
      </label>
      {help && <p className="dim">{help}</p>}
    </div>
  )
}

/** The step's failure, worded by the server, and the Back / Next buttons. */
export function StepNav({
  model,
  onBack,
  onNext,
  nextLabel,
  nextDisabled,
  busyLabel
}: {
  model: BuilderModel
  onBack?: () => void
  onNext?: () => void
  nextLabel?: string
  nextDisabled?: boolean
  busyLabel?: string
}) {
  return (
    <>
      {model.error && (
        <div className="error" role="alert">
          {model.error}
        </div>
      )}
      <div className="builder-nav">
        {onBack && (
          <button className="secondary" disabled={model.busy} onClick={onBack}>
            {T`Back`}
          </button>
        )}
        {onNext && (
          <button disabled={model.busy || nextDisabled} onClick={onNext}>
            {model.busy && busyLabel ? busyLabel : (nextLabel ?? T`Next`)}
          </button>
        )}
        {model.busy && <span className="spinner" aria-hidden="true" />}
      </div>
    </>
  )
}

/** A value from the source or a preview row, as short text. */
export function cellText(value: unknown): string {
  if (value === null || value === undefined) return ""
  if (typeof value === "object") return JSON.stringify(value)
  return String(value)
}
