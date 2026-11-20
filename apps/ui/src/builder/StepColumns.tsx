/**
 * Step 2: the columns the source has. The user keeps, names and types each;
 * a web API source can also update rows by a key column instead of replacing.
 */
import { useEffect, useState } from "react"
import type { RecipeColumn } from "@data-integrator/definitions"
import { cellText, Field, StepNav } from "./shared.js"
import { BuilderModel, ID_PATTERN, readCleanupChanged, suggestId, usePending, writeModesOf } from "./useBuilderDraft.js"

type ColumnType = RecipeColumn["type"]

/** A type guessed from sample values: number, date, else text. */
function guessType(sample: unknown[]): ColumnType {
  const values = sample.map(cellText).map(v => v.trim()).filter(v => v !== "")
  if (values.length === 0) return "text"
  if (values.every(v => /^-?[\d,]*\.?\d+$/.test(v))) return "number"
  if (values.every(v => /^\d{4}-\d{2}-\d{2}([T ][\d:.]+Z?)?$/.test(v))) return "date"
  return "text"
}

/** Ids suggested for source names, kept apart from one another. */
function uniqueIds(names: string[]): string[] {
  const used = new Set<string>()
  return names.map(name => {
    const base = suggestId(name, "column")
    let id = base
    for (let n = 2; used.has(id); n++) id = `${base}_${n}`
    used.add(id)
    return id
  })
}

/** The type names the step offers. */
function typeOptions(): { value: ColumnType; label: string }[] {
  return [
    { value: "text", label: T`Text` },
    { value: "number", label: T`Number` },
    { value: "date", label: T`Date` },
    { value: "place", label: T`Place (region, district or other area)` }
  ]
}

/** One row of the columns table: the source column and, when kept, its settings. */
interface Row {
  from: string
  sample: unknown[]
  keep: boolean
  id: string
  type: ColumnType
  unit: string
}

/** The columns step. */
export function StepColumns({ model }: { model: BuilderModel }) {
  const { work, inspected, inspectedCleanup } = model
  const [rows, setRows] = useState<Row[] | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  // The two columns dates across the columns become; the server adds them to the table
  const unpivot = work.cleanup.unpivot
  const made = unpivot ? [unpivot.dateColumnId, unpivot.valueColumnId] : []

  // Read the source when this visit has not yet, or when the clean-up changed which columns it has
  useEffect(() => {
    const stale = !inspected || !inspectedCleanup || readCleanupChanged(inspectedCleanup, work.cleanup)
    if (stale && !model.busy) void model.inspect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Rows follow each read of the source; columns chosen before keep their settings
  useEffect(() => {
    if (!inspected) return
    const chosen = new Map(work.columns.map(c => [c.from, c]))
    const fresh = work.columns.length === 0
    const made = inspectedCleanup?.unpivot ? [inspectedCleanup.unpivot.dateColumnId, inspectedCleanup.unpivot.valueColumnId] : []
    const listed = inspected.columns.filter(c => !made.includes(c.name))
    const ids = uniqueIds(listed.map(c => c.name))
    setRows(
      listed.map((c, i) => {
        const col = chosen.get(c.name)
        return {
          from: c.name,
          sample: c.sample,
          keep: fresh || col !== undefined,
          id: col?.id ?? ids[i],
          type: col?.type ?? guessType(c.sample),
          unit: col?.unit ?? ""
        }
      })
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inspected])

  const missingFromSource = inspected && rows ? work.columns.filter(c => !rows.some(r => r.from === c.from)) : []

  const setRow = (index: number, patch: Partial<Row>) =>
    setRows(rs => rs && rs.map((r, i) => (i === index ? { ...r, ...patch } : r)))

  const kept = (rows ?? []).filter(r => r.keep)
  const columns: RecipeColumn[] = kept.map(r => ({
    from: r.from,
    id: r.id.trim(),
    type: r.type,
    ...(r.type === "number" && r.unit.trim() ? { unit: r.unit.trim() } : {})
  }))
  const modes = writeModesOf(work.connector)
  usePending(model, () => (rows ? { columns } : {}))

  /** What is wrong with the choices, in plain words; null when they are fine. */
  function check(): string | null {
    if (columns.length === 0) return T`Keep at least one column.`
    for (const c of columns) {
      if (!ID_PATTERN.test(c.id)) {
        return T`The name "${c.id}" cannot be used. Use lowercase letters, digits and underscores, starting with a letter.`
      }
    }
    const ids = columns.flatMap(c => (c.type === "place" ? [c.id, `${c.id}_code`] : [c.id]))
    const clash = made.find(id => ids.includes(id))
    if (clash) {
      return T`"${clash}" is the name of a column made by clean-up. Give this column another name, or rename that one on the Clean-up step.`
    }
    const twice = ids.find((id, i) => ids.indexOf(id) !== i)
    if (twice) return T`Two columns are called "${twice}". Give each column its own name.`
    if (columns.filter(c => c.type === "place").length > 1) return T`Only one column can be a place.`
    if (work.writeMode === "merge" && !columns.some(c => c.id === work.mergeKey) && !made.includes(work.mergeKey ?? "")) {
      return T`Choose the column that identifies each row.`
    }
    return null
  }

  async function next() {
    const why = check()
    setProblem(why)
    if (why) return
    const place = columns.find(c => c.type === "place")
    // Places settings follow the place column; without one there is nothing to match
    const places = place && work.places ? { ...work.places, column: place.id } : null
    await model.goTo("cleanup", { columns, places })
  }

  return (
    <section className="builder-step">
      <h2>{T`Which columns do you want?`}</h2>
      {!inspected || !rows ? (
        model.busy ? (
          <p role="status">{T`Reading the source…`}</p>
        ) : (
          <>
            <p>{T`The source has not been read yet.`}</p>
            <StepNav model={model} onBack={() => void model.goTo("source")} onNext={() => void model.inspect()} nextLabel={T`Read the source`} />
          </>
        )
      ) : (
        <>
          <p className="dim">
            {T`Found ${rows.length} columns in ${inspected.rows} rows read. Untick the columns you do not need, give each a name for the table, and say what kind of values it holds.`}
          </p>
          {missingFromSource.length > 0 && (
            <p className="error">
              {T`These columns are no longer in the source and were left out: ${missingFromSource.map(c => c.from).join(", ")}`}
            </p>
          )}
          <div className="data-scroll">
            <table className="builder-table">
              <thead>
                <tr>
                  <th>{T`Keep`}</th>
                  <th>{T`Column in the source`}</th>
                  <th>{T`Name in the table`}</th>
                  <th>{T`Kind of values`}</th>
                  <th>{T`Unit (optional)`}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={r.from} className={r.keep ? undefined : "off"}>
                    <td>
                      <input
                        type="checkbox"
                        checked={r.keep}
                        aria-label={T`Keep ${r.from}`}
                        onChange={e => setRow(i, { keep: e.target.checked })}
                      />
                    </td>
                    <td>
                      <b>{r.from}</b>
                      <div className="dim builder-sample">{r.sample.map(cellText).join(", ")}</div>
                    </td>
                    <td>
                      <input
                        type="text"
                        disabled={!r.keep}
                        aria-label={T`Name in the table for ${r.from}`}
                        value={r.id}
                        onChange={e => setRow(i, { id: e.target.value })}
                      />
                    </td>
                    <td>
                      <select
                        disabled={!r.keep}
                        aria-label={T`Kind of values in ${r.from}`}
                        value={r.type}
                        onChange={e => setRow(i, { type: e.target.value as ColumnType })}
                      >
                        {typeOptions().map(o => (
                          <option key={o.value} value={o.value}>
                            {o.label}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      {r.type === "number" && (
                        <input
                          type="text"
                          disabled={!r.keep}
                          placeholder={T`e.g. mm`}
                          aria-label={T`Unit of ${r.from}`}
                          value={r.unit}
                          onChange={e => setRow(i, { unit: e.target.value })}
                        />
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="dim">
            {T`Names in the table use lowercase letters, digits and underscores. A place column also gets a second column with the place code.`}
          </p>
          {unpivot && (
            <p>
              {T`Made by clean-up from the date columns: ${unpivot.dateColumnId} (date) and ${unpivot.valueColumnId} (number).`}
            </p>
          )}

          {modes.includes("merge") && (
            <fieldset className="builder-choices compact">
              <legend>{T`On each refresh`}</legend>
              <label>
                <input
                  type="radio"
                  name="writeMode"
                  checked={work.writeMode !== "merge"}
                  onChange={() => model.update({ writeMode: "replace", mergeKey: null })}
                />{" "}
                {T`Replace all rows with what the source has now`}
              </label>
              <label>
                <input type="radio" name="writeMode" checked={work.writeMode === "merge"} onChange={() => model.update({ writeMode: "merge" })} />{" "}
                {T`Update rows that are already there and add new ones`}
              </label>
              {work.writeMode === "merge" && (
                <Field label={T`Column that identifies each row`} help={T`Rows with the same value here are the same record, for example a station id.`}>
                  <select value={work.mergeKey ?? ""} onChange={e => model.update({ mergeKey: e.target.value || null })}>
                    <option value="">{T`Choose a column`}</option>
                    {columns.map(c => (
                      <option key={c.id} value={c.id}>
                        {c.from}
                      </option>
                    ))}
                    {made.map(id => (
                      <option key={id} value={id}>
                        {id}
                      </option>
                    ))}
                  </select>
                </Field>
              )}
            </fieldset>
          )}

          {problem && <p className="error">{problem}</p>}
          <div className="builder-nav-extra">
            <button className="secondary" disabled={model.busy} onClick={() => void model.inspect({ columns })}>
              {T`Read the source again`}
            </button>
          </div>
          <StepNav model={model} onBack={() => void model.goTo("source", { columns })} onNext={() => void next()} />
        </>
      )}
    </section>
  )
}
