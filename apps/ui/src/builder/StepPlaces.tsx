/**
 * Step 4: match the place column's names to the codes of a places table
 * already in WASH Data Integrator. Exact matches are chosen for the user;
 * close matches are offered, never chosen; any name can be left unmatched.
 */
import { useEffect, useMemo, useState } from "react"
import {
  listTableSchemas,
  PlaceSuggestion,
  previewBuilderDraft,
  suggestBuilderPlaces,
  TableSchema
} from "../api.js"
import { localizeData } from "../localization.js"
import { cellText, Field, StepNav } from "./shared.js"
import { BuilderModel, Places } from "./useBuilderDraft.js"

/** The choice value for "Leave unmatched". */
const UNMATCHED = ""

/** The first column whose id contains one of the words. */
function guessColumn(table: TableSchema | undefined, words: string[]): string {
  const ids = (table?.columns ?? []).map(c => c.id)
  for (const word of words) {
    const found = ids.find(id => id === word) ?? ids.find(id => id.includes(word))
    if (found) return found
  }
  return ""
}

/** The places step. */
export function StepPlaces({ model }: { model: BuilderModel }) {
  const { work } = model
  const placeColumn = work.columns.find(c => c.type === "place")
  const [tables, setTables] = useState<TableSchema[] | null>(null)
  const [tablesError, setTablesError] = useState<string | null>(null)
  const [table, setTable] = useState(work.places?.table ?? "")
  const [nameColumn, setNameColumn] = useState(work.places?.nameColumn ?? "")
  const [codeColumn, setCodeColumn] = useState(work.places?.codeColumn ?? "")
  const [suggestions, setSuggestions] = useState<PlaceSuggestion[] | null>(null)
  const [choices, setChoices] = useState<Record<string, string>>({})
  const [finding, setFinding] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)

  useEffect(() => {
    if (!placeColumn) return
    listTableSchemas().then(
      r => setTables(r.tables),
      err => setTablesError(err instanceof Error ? err.message : String(err))
    )
  }, [placeColumn])

  const chosenTable = useMemo(() => tables?.find(t => t.tableId === table), [tables, table])

  function pickTable(id: string) {
    setTable(id)
    const t = tables?.find(x => x.tableId === id)
    setNameColumn(guessColumn(t, ["name", "label"]))
    setCodeColumn(guessColumn(t, ["pcode", "code", "id"]))
    setSuggestions(null)
  }

  const places = (matches: Record<string, string>): Places => ({
    column: placeColumn!.id,
    table,
    nameColumn,
    codeColumn,
    matches
  })

  /** Saves the table choice, runs a preview to collect the names, and asks for suggestions. */
  async function findMatches() {
    if (!table || !nameColumn || !codeColumn) {
      setProblem(T`Choose the places table and its name and code columns.`)
      return
    }
    setProblem(null)
    setFinding(true)
    model.setError(null)
    try {
      const saved = work.places?.table === table ? work.places.matches : {}
      await model.save({ places: places(saved) })
      const preview = await previewBuilderDraft(model.draftId)
      const names = new Set<string>()
      for (const row of preview.rows) {
        const value = cellText(row[placeColumn!.id]).trim()
        if (value) names.add(value)
      }
      for (const name of preview.unmatched) names.add(name)
      for (const name of Object.keys(saved)) names.add(name)
      const found = await suggestBuilderPlaces(model.draftId, [...names].sort((a, b) => a.localeCompare(b)))
      setSuggestions(found)
      setChoices(
        Object.fromEntries(found.map(s => [s.name, s.name in saved ? saved[s.name] : (s.exact ?? UNMATCHED)]))
      )
    } catch (err) {
      model.setError(err instanceof Error ? err.message : String(err))
    } finally {
      setFinding(false)
    }
  }

  // A resumed draft with a table chosen lists its names straight away
  useEffect(() => {
    if (placeColumn && work.places?.table && tables && !suggestions && !finding) void findMatches()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tables])

  /**
   * The matches to save: every choice that differs from what the source would
   * match on its own. A name left unmatched despite an exact match is saved
   * empty; other unmatched names are not saved, so later runs still list them.
   */
  function matchesToSave(): Record<string, string> {
    const out: Record<string, string> = {}
    for (const s of suggestions ?? []) {
      const choice = choices[s.name] ?? UNMATCHED
      if (choice === UNMATCHED && !s.exact) continue
      out[s.name] = choice
    }
    return out
  }

  async function next() {
    if (!placeColumn) {
      await model.goTo("preview", { places: null })
      return
    }
    if (!suggestions) {
      setProblem(T`Find the matches first, or go back and mark no column as a place.`)
      return
    }
    await model.goTo("preview", { places: places(matchesToSave()) })
  }

  async function back() {
    const keep = placeColumn && table && nameColumn && codeColumn
    await model.goTo("cleanup", keep ? { places: places(suggestions ? matchesToSave() : work.places?.table === table ? work.places.matches : {}) } : {})
  }

  const matchedCount = suggestions ? suggestions.filter(s => (choices[s.name] ?? UNMATCHED) !== UNMATCHED).length : 0

  return (
    <section className="builder-step">
      <h2>{T`Match places`}</h2>
      {!placeColumn ? (
        <p>{T`No column is marked as a place, so there is nothing to match. Go back to Columns to mark one, or go on.`}</p>
      ) : (
        <>
          <p className="dim">
            {T`The names in ${placeColumn.id} are matched to the places in a table that is already here, such as a country's regions or districts. Each row then gets the place code too.`}
          </p>
          {tablesError && <div className="error">{tablesError}</div>}
          {tables === null && !tablesError && <p role="status">{T`Loading…`}</p>}
          {tables && (
            <div className="builder-row">
              <Field label={T`Places table`} help={T`The table that lists the places with their names and codes.`}>
                <select value={table} onChange={e => pickTable(e.target.value)}>
                  <option value="">{T`Choose a table`}</option>
                  {tables.map(t => (
                    <option key={t.tableId} value={t.tableId}>
                      {localizeData(t.name) || t.tableId}
                    </option>
                  ))}
                </select>
              </Field>
              {chosenTable && (
                <>
                  <Field label={T`Name column`} help={T`Holds the place names.`}>
                    <select value={nameColumn} onChange={e => { setNameColumn(e.target.value); setSuggestions(null) }}>
                      <option value="">{T`Choose a column`}</option>
                      {chosenTable.columns.map(c => (
                        <option key={c.id} value={c.id}>
                          {localizeData(c.name) || c.id}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label={T`Code column`} help={T`Holds the place codes.`}>
                    <select value={codeColumn} onChange={e => { setCodeColumn(e.target.value); setSuggestions(null) }}>
                      <option value="">{T`Choose a column`}</option>
                      {chosenTable.columns.map(c => (
                        <option key={c.id} value={c.id}>
                          {localizeData(c.name) || c.id}
                        </option>
                      ))}
                    </select>
                  </Field>
                </>
              )}
            </div>
          )}
          {tables && (
            <button className="secondary" disabled={finding || model.busy} onClick={() => void findMatches()}>
              {finding ? T`Finding matches…` : suggestions ? T`Find the matches again` : T`Find the matches`}
            </button>
          )}
          {finding && <p className="dim" role="status">{T`Reading the source and comparing the names. This can take a minute.`}</p>}

          {suggestions && (
            <>
              <p role="status">
                {T`${suggestions.length} names: ${matchedCount} matched, ${suggestions.length - matchedCount} left unmatched.`}
              </p>
              <p className="dim">
                {T`Names that are the same are chosen for you. Check the others: pick the right place from the list, or leave the name unmatched. Rows with an unmatched name are still kept.`}
              </p>
              <div className="data-scroll">
                <table className="builder-table">
                  <thead>
                    <tr>
                      <th>{T`Name in the source`}</th>
                      <th>{T`Place`}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {suggestions.map(s => (
                      <tr key={s.name}>
                        <td>{s.name}</td>
                        <td>
                          <select
                            aria-label={T`Place for ${s.name}`}
                            value={choices[s.name] ?? UNMATCHED}
                            onChange={e => setChoices(c => ({ ...c, [s.name]: e.target.value }))}
                          >
                            {s.exact && <option value={s.exact}>{T`${s.name} (${s.exact}), same name`}</option>}
                            {s.close.map(c => (
                              <option key={c.code} value={c.code}>
                                {T`${c.name} (${c.code}), similar name`}
                              </option>
                            ))}
                            {choices[s.name] &&
                              choices[s.name] !== s.exact &&
                              !s.close.some(c => c.code === choices[s.name]) && (
                                <option value={choices[s.name]}>{T`Code ${choices[s.name]}, chosen before`}</option>
                              )}
                            <option value={UNMATCHED}>{T`Leave unmatched`}</option>
                          </select>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {suggestions.length === 0 && <p className="dim">{T`The preview found no place names in this column.`}</p>}
            </>
          )}
        </>
      )}
      {problem && <p className="error">{problem}</p>}
      <StepNav model={model} onBack={() => void back()} onNext={() => void next()} nextDisabled={finding} />
    </section>
  )
}
