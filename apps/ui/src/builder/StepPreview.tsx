/**
 * Step 5: run the source once into a temporary table and show what would be
 * stored: the first 50 rows, the row count, places matched and not, and
 * values that did not fit their column. Nothing installed is touched.
 */
import { useEffect, useState } from "react"
import { BuilderPreview, previewBuilderDraft } from "../api.js"
import { cellText, StepNav } from "./shared.js"
import { BuilderModel } from "./useBuilderDraft.js"

/** The preview step. */
export function StepPreview({ model }: { model: BuilderModel }) {
  const [preview, setPreview] = useState<BuilderPreview | null>(null)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const hasPlaces = model.work.columns.some(c => c.type === "place") && model.work.places !== null

  async function run() {
    setRunning(true)
    setError(null)
    try {
      setPreview(await previewBuilderDraft(model.draftId))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setRunning(false)
    }
  }

  useEffect(() => {
    void run()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const headers = preview && preview.rows.length > 0 ? Object.keys(preview.rows[0]) : []

  return (
    <section className="builder-step">
      <h2>{T`Preview`}</h2>
      <p className="dim">{T`The source is read once into a temporary table. Nothing is saved for others to see until you add the source.`}</p>
      {running && (
        <p role="status">
          <span className="spinner" aria-hidden="true" /> {T`Running the preview. This can take up to two minutes.`}
        </p>
      )}
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      {preview && !running && (
        <>
          <ul className="builder-facts">
            <li>
              <b>{preview.rowCount.toLocaleString()}</b> {preview.rowCount === 1 ? T`row would be stored` : T`rows would be stored`}
              {preview.rows.length < preview.rowCount && <span className="dim"> {T`(the first ${preview.rows.length} are shown below)`}</span>}
            </li>
            {hasPlaces && (
              <li>
                <b>{preview.matched.toLocaleString()}</b> {T`place names matched`},{" "}
                <b>{preview.unmatched.length.toLocaleString()}</b> {T`not matched`}
              </li>
            )}
            <li>
              <b>{preview.typeErrors.length.toLocaleString()}</b> {T`values did not fit their column`}
            </li>
          </ul>

          {preview.unmatched.length > 0 && (
            <div className="builder-notice">
              <h3>{T`Place names not matched`}</h3>
              <p className="dim">{T`These rows are kept without a place code. Go back to Places to match them.`}</p>
              <p>{preview.unmatched.join(", ")}</p>
            </div>
          )}

          {preview.typeErrors.length > 0 && (
            <div className="builder-notice">
              <h3>{T`Values that did not fit`}</h3>
              <p className="dim">{T`These values are left empty. Go back to Columns to change the kind of values, or fix them in the source.`}</p>
              <ul>
                {preview.typeErrors.map((line, i) => (
                  <li key={i}>
                    <code>{line}</code>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {preview.rows.length === 0 ? (
            <p>{T`The preview stored no rows. Check the source and the clean-up settings.`}</p>
          ) : (
            <div className="data-scroll">
              <table className="data-table builder-table">
                <thead>
                  <tr>
                    {headers.map(h => (
                      <th key={h}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {preview.rows.map((row, i) => (
                    <tr key={i}>
                      {headers.map(h => (
                        <td key={h}>{cellText(row[h])}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
      <div className="builder-nav-extra">
        <button className="secondary" disabled={running} onClick={() => void run()}>
          {T`Run the preview again`}
        </button>
      </div>
      <StepNav
        model={model}
        onBack={() => void model.goTo("places")}
        onNext={() => void model.goTo("schedule")}
        nextDisabled={running || !preview}
      />
    </section>
  )
}
