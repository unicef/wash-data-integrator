import { normalise } from "./normalise.js"

/** Smallest trigram similarity offered as a close match. */
const CLOSE_MIN_SCORE = 0.5
/** Close matches offered per name. */
const CLOSE_LIMIT = 3

/** Suggestions for one source place name. */
export interface PlaceSuggestion {
  /** The name as it appears in the source */
  name: string
  /** Code of the place whose normalised name equals this one's */
  exact?: string
  /** Best other places by trigram similarity, highest first */
  close: { code: string; name: string; score: number }[]
}

/** 3-character shingles of a normalised name, padded with a space on each side. */
function trigrams(key: string): Set<string> {
  const padded = ` ${key} `
  const grams = new Set<string>()
  for (let i = 0; i + 3 <= padded.length; i++) grams.add(padded.slice(i, i + 3))
  return grams
}

/** Jaccard similarity of two trigram sets. */
function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let shared = 0
  for (const gram of a) if (b.has(gram)) shared++
  return shared / (a.size + b.size - shared)
}

/**
 * Suggests a place for each source name: the normalised-exact match first
 * (what the connector would pick on its own), then up to three close matches
 * by trigram similarity of at least 0.5, the exact one left out.
 */
export function suggestMatches(names: string[], places: { name: string; code: string }[]): PlaceSuggestion[] {
  const indexed = places.map(place => {
    const key = normalise(place.name)
    return { place, key, grams: trigrams(key) }
  })
  return names.map(name => {
    const key = normalise(name)
    const exact = key ? indexed.find(p => p.key === key) : undefined
    const grams = trigrams(key)
    const close = key
      ? indexed
          .filter(p => p !== exact && p.key !== "")
          .map(p => ({ code: p.place.code, name: p.place.name, score: Math.round(jaccard(grams, p.grams) * 100) / 100 }))
          .filter(c => c.score >= CLOSE_MIN_SCORE)
          .sort((a, b) => b.score - a.score)
          .slice(0, CLOSE_LIMIT)
      : []
    return exact ? { name, exact: exact.place.code, close } : { name, close }
  })
}
