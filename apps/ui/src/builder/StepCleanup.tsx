/**
 * Step 3: optional clean-up. Skip rows above the table, say which row holds
 * the column names, keep only some rows, and turn dates that run across the
 * columns into a date column and a value column.
 */
import { useState } from "react"
import { Field, StepNav } from "./shared.js"
import { BuilderModel, Cleanup, ID_PATTERN, suggestId } from "./useBuilderDraft.js"

type Filter = NonNullable<Cleanup["filters"]>[number]

/** A whole number from a field, or undefined when empty or zero. */
function count(value: string): number | undefined {
  const n = Math.floor(Number(value))
  return value.trim() === "" || !Number.isFinite(n) || n <= 0 ? undefined : n
}

/** The clean-up step. */
export function StepCleanup({ model }: { model: BuilderModel }) {
  const { work, inspected } = model
  const [cleanup, setCleanup] = useState<Cleanup>(work.cleanup)
  const [problem, setProblem] = useState<string | null>(null)
  const set = (patch: Partial<Cleanup>) => {
    const next: Cleanup = { ...cleanup, ...patch }
    for (const key of Object.keys(patch) as (keyof Cleanup)[]) if (patch[key] === undefined) delete next[key]
    setCleanup(next)
  }
  const sourceColumns = inspected?.columns.map(c => c.name) ?? work.columns.map(c => c.from)
  const filters = cleanup.filters ?? []
  const setFilter = (index: number, patch: Partial<Filter>) =>
    set({ filters: filters.map((f, i) => (i === index ? { ...f, ...patch } : f)) })
  const unpivot = cleanup.unpivot

  /** What is wrong, in plain words; null when fine. */
  function check(): string | null {
    if (filters.some(f => !f.column)) return T`Choose a column for each row filter, or remove it.`
    if (unpivot) {
      if (unpivot.columns.length === 0) return T`Tick the columns that hold one date each.`
      for (const id of [unpivot.dateColumnId, unpivot.valueColumnId]) {
        if (!ID_PATTERN.test(id)) {
          return T`The name "${id}" cannot be used. Use lowercase letters, digits and underscores, starting with a letter.`
        }
      }
      if (unpivot.dateColumnId === unpivot.valueColumnId) return T`The date column and the value column need different names.`
    }
    return null
  }

  async function next() {
    const why = check()
    setProblem(why)
    if (why) return
    // The server reads the wide columns from the column list, so each must be kept
    let columns = work.columns
    if (unpivot) {
      const used = new Set(columns.map(c => c.id))
      for (const name of unpivot.columns) {
        if (columns.some(c => c.from === name)) continue
        const base = suggestId(name, "column")
        let id = base
        for (let n = 2; used.has(id); n++) id = `${base}_${n}`
        used.add(id)
        columns = [...columns, { from: name, id, type: "number" }]
      }
    }
    // Other rows above the table give other column names: show them on the Columns step
    const base = model.inspectedCleanup ?? { skipRows: work.cleanup.skipRows, headerRow: work.cleanup.headerRow }
    if (base.skipRows !== cleanup.skipRows || base.headerRow !== cleanup.headerRow) {
      const result = await model.inspect({ cleanup, columns })
      if (result) await model.goTo("columns")
      return
    }
    await model.goTo("places", { cleanup, columns })
  }

  return (
    <section className="builder-step">
      <h2>{T`Clean-up (optional)`}</h2>
      <p className="dim">{T`Most sources need none of this. Skip ahead if the columns looked right.`}</p>

      <div className="builder-row">
        <Field label={T`Skip the first rows`} help={T`For files with a title or notes above the table.`}>
          <input type="number" min={0} value={cleanup.skipRows ?? ""} onChange={e => set({ skipRows: count(e.target.value) })} />
        </Field>
        <Field label={T`Column names are on row`} help={T`Counted after the skipped rows. Leave empty when they are on the first row.`}>
          <input type="number" min={1} value={cleanup.headerRow ?? ""} onChange={e => set({ headerRow: count(e.target.value) })} />
        </Field>
      </div>

      <h3>{T`Keep only some rows`}</h3>
      {filters.length === 0 && <p className="dim">{T`All rows are kept.`}</p>}
      {filters.map((f, i) => (
        <div className="builder-row builder-filter" key={i}>
          <select aria-label={T`Column`} value={f.column} onChange={e => setFilter(i, { column: e.target.value })}>
            <option value="">{T`Choose a column`}</option>
            {sourceColumns.map(name => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
          <select aria-label={T`How to compare`} value={f.op} onChange={e => setFilter(i, { op: e.target.value as Filter["op"] })}>
            <option value="equals">{T`is`}</option>
            <option value="contains">{T`contains`}</option>
          </select>
          <input type="text" aria-label={T`Value`} value={f.value} onChange={e => setFilter(i, { value: e.target.value })} />
          <button className="quiet" onClick={() => set({ filters: filters.filter((_, j) => j !== i) })}>
            {T`Remove`}
          </button>
        </div>
      ))}
      <button className="secondary compact" onClick={() => set({ filters: [...filters, { column: "", op: "equals", value: "" }] })}>
        {T`Add a row filter`}
      </button>
      <p className="dim">{T`Upper and lower case are treated the same.`}</p>

      <h3>{T`Dates across the columns`}</h3>
      <label className="builder-check">
        <input
          type="checkbox"
          checked={unpivot !== undefined}
          onChange={e => set({ unpivot: e.target.checked ? { columns: [], dateColumnId: "date", valueColumnId: "value" } : undefined })}
        />{" "}
        {T`The table has one column per date, month or year`}
      </label>
      <p className="dim">{T`These columns are turned into two: one for the date and one for the value.`}</p>
      {unpivot && (
        <>
          <div className="builder-checks">
            {sourceColumns.map(name => (
              <label key={name}>
                <input
                  type="checkbox"
                  checked={unpivot.columns.includes(name)}
                  onChange={e =>
                    set({
                      unpivot: {
                        ...unpivot,
                        columns: e.target.checked ? [...unpivot.columns, name] : unpivot.columns.filter(c => c !== name)
                      }
                    })
                  }
                />{" "}
                {name}
              </label>
            ))}
          </div>
          <div className="builder-row">
            <Field label={T`Name of the date column`}>
              <input type="text" value={unpivot.dateColumnId} onChange={e => set({ unpivot: { ...unpivot, dateColumnId: e.target.value.trim() } })} />
            </Field>
            <Field label={T`Name of the value column`}>
              <input type="text" value={unpivot.valueColumnId} onChange={e => set({ unpivot: { ...unpivot, valueColumnId: e.target.value.trim() } })} />
            </Field>
          </div>
        </>
      )}

      {problem && <p className="error">{problem}</p>}
      <StepNav model={model} onBack={() => void model.goTo("columns", { cleanup })} onNext={() => void next()} />
    </section>
  )
}
