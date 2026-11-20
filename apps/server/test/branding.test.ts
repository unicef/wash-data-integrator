import { test } from "node:test"
import assert from "node:assert/strict"
import { readFile, readdir } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..")

async function walk(dir: string): Promise<string[]> {
  const out: string[] = []
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...(await walk(p)))
    else if (/\.tsx?$/.test(e.name)) out.push(p)
  }
  return out
}

test("no mWater name in served UI text", async () => {
  const files = [
    path.join(ROOT, "apps/ui/index.html"),
    path.join(ROOT, "apps/ui/src/localizations.json"),
    path.join(ROOT, "apps/server/static/openapi.json"),
    path.join(ROOT, "apps/server/src/settings.ts"),
    path.join(ROOT, "apps/server/src/agent/assistant.ts"),
    path.join(ROOT, "apps/server/src/agent/dashboard.ts"),
    path.join(ROOT, "apps/server/src/agent/designer.ts"),
    ...(await walk(path.join(ROOT, "apps/ui/src")))
  ]
  const offenders: string[] = []
  for (const f of files) {
    if (/mwater/i.test(await readFile(f, "utf8"))) offenders.push(path.relative(ROOT, f))
  }
  assert.deepEqual(offenders, [])
})

test("README credits upstream", async () => {
  const readme = await readFile(path.join(ROOT, "README.md"), "utf8")
  assert.ok(readme.includes("https://github.com/mWater/data-integrator"))
  assert.ok(readme.includes("WASH Data Integrator"))
})

test("NOTICE keeps mWater", async () => {
  assert.match(await readFile(path.join(ROOT, "NOTICE"), "utf8"), /mWater/)
})
