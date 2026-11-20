/** Place-name key shared with the Python core (see library/connectors/normalise_cases.json). */
const DROPPED_WORDS = new Set(["region", "district", "province", "county", "state", "gobolka", "degmada"])

export function normalise(name: string): string {
  const text = String(name ?? "")
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
  return text.split(" ").filter((w) => w && !DROPPED_WORDS.has(w)).join(" ")
}
