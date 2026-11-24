import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import { createHmac, randomBytes } from "node:crypto"
import { AddressInfo } from "node:net"
import { Server } from "node:http"
import path from "node:path"
import { fileURLToPath } from "node:url"
import pg from "pg"
import { migrate } from "../src/migrations.js"
import { authenticate, createApiToken, setPassword } from "../src/auth.js"
import { loadConfig } from "../src/config.js"
import { EwsSsoConfig, NonceStore, safeNext, UNUSABLE_PASSWORD_HASH, verifyEwsToken } from "../src/ewsSso.js"
import { createApiServer } from "../src/server.js"
import { TileRenderer } from "../src/tiles.js"
import { RasterStore } from "../src/rasterStore.js"
import { startTestDb, TestDb } from "./helpers/pg.js"

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "migrations")
const SECRET = "test-secret-that-is-at-least-32-characters"
const SSO: EwsSsoConfig = { secret: SECRET, loginUrl: "https://ews.example/api/di/sso", account: "ews@gmail.com", role: "editor" }

let db: TestDb
let pool: pg.Pool
let server: Server
let offServer: Server
let base: string
let offBase: string

const b64 = (value: unknown) => Buffer.from(typeof value === "string" ? value : JSON.stringify(value)).toString("base64url")

/** Signs a token as the EWS does; overrides let a test break one part. */
function token(
  claims: Record<string, unknown> = {},
  opts: { secret?: string; header?: unknown; now?: number } = {}
): string {
  const iat = Math.floor((opts.now ?? Date.now()) / 1000)
  const header = b64(opts.header ?? { alg: "HS256", typ: "JWT" })
  const payload = b64({ iss: "ews", aud: "di", sub: "national@ews.demo", iat, exp: iat + 60, nonce: randomBytes(16).toString("base64url"), ...claims })
  const sig = createHmac("sha256", opts.secret ?? SECRET).update(`${header}.${payload}`).digest("base64url")
  return `${header}.${payload}.${sig}`
}

/** Starts an API server on a random port. */
async function start(ewsSso: EwsSsoConfig | null): Promise<[Server, string]> {
  const s = createApiServer(pool, new TileRenderer(new RasterStore("/nonexistent"), "/nonexistent"),
    null, null, null, null, null, null, null, null, null, null, null, null, ewsSso)
  await new Promise<void>(resolve => s.listen(0, "127.0.0.1", resolve))
  return [s, `http://127.0.0.1:${(s.address() as AddressInfo).port}`]
}

/** Runs a handover against the SSO server without following the redirect. */
function handover(t: string, next = "/#/library", at = base): Promise<Response> {
  return fetch(`${at}/auth/ews-sso?token=${encodeURIComponent(t)}&next=${encodeURIComponent(next)}`, { redirect: "manual" })
}

/** Captures what the security log writes while fn runs. */
async function captureLog(fn: () => Promise<unknown>): Promise<string> {
  const lines: string[] = []
  const write = process.stdout.write.bind(process.stdout)
  process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    const text = String(chunk)
    if (text.includes('"type":"security"')) {
      lines.push(text)
      return true
    }
    return (write as (...args: unknown[]) => boolean)(chunk, ...rest)
  }) as typeof process.stdout.write
  try {
    await fn()
    await new Promise(resolve => setTimeout(resolve, 50))
  } finally {
    process.stdout.write = write
  }
  return lines.join("")
}

before(async () => {
  db = await startTestDb()
  pool = new pg.Pool({ connectionString: db.url })
  await migrate(pool, MIGRATIONS_DIR)
  ;[server, base] = await start(SSO)
  ;[offServer, offBase] = await start(null)
})

after(async () => {
  server?.close()
  offServer?.close()
  await pool?.end()
  await db?.stop()
})

test("a valid token is accepted once; tampered, expired, wrong-audience and replayed tokens are refused", () => {
  const nonces = new NonceStore()
  const now = Date.now()
  const good = token({}, { now })
  assert.deepEqual(verifyEwsToken(good, SECRET, nonces, now), { ok: true, subject: "national@ews.demo" })
  assert.deepEqual(verifyEwsToken(good, SECRET, nonces, now), { ok: false, reason: "replayed" })

  const [h, p, s] = token({}, { now }).split(".")
  const forged = b64({ ...JSON.parse(Buffer.from(p, "base64url").toString()), sub: "admin@ews.demo" })
  assert.equal(verifyEwsToken(`${h}.${forged}.${s}`, SECRET, nonces, now).ok, false)
  assert.deepEqual(verifyEwsToken(`${h}.${p}.${s.slice(0, -2)}AA`, SECRET, nonces, now), { ok: false, reason: "bad-signature" })
  assert.deepEqual(verifyEwsToken(token({}, { secret: "another-secret-of-at-least-32-characters" }), SECRET, nonces, now),
    { ok: false, reason: "bad-signature" })
  assert.deepEqual(verifyEwsToken(token({}, { header: { alg: "none", typ: "JWT" } }), SECRET, nonces, now), { ok: false, reason: "malformed" })
  assert.deepEqual(verifyEwsToken(`${h}.${p}.`, SECRET, nonces, now), { ok: false, reason: "bad-signature" })
  assert.deepEqual(verifyEwsToken("not-a-token", SECRET, nonces, now), { ok: false, reason: "malformed" })
  assert.deepEqual(verifyEwsToken("", SECRET, nonces, now), { ok: false, reason: "malformed" })

  assert.deepEqual(verifyEwsToken(token({}, { now: now - 61_000 }), SECRET, nonces, now), { ok: false, reason: "expired" })
  assert.deepEqual(verifyEwsToken(token({ aud: "ews" }, { now }), SECRET, nonces, now), { ok: false, reason: "bad-claims" })
  assert.deepEqual(verifyEwsToken(token({ iss: "someone" }, { now }), SECRET, nonces, now), { ok: false, reason: "bad-claims" })
  const iat = Math.floor(now / 1000)
  assert.deepEqual(verifyEwsToken(token({ iat, exp: iat + 3600 }, { now }), SECRET, nonces, now), { ok: false, reason: "bad-claims" })
  assert.deepEqual(verifyEwsToken(token({ iat: iat + 600, exp: iat + 660 }, { now }), SECRET, nonces, now), { ok: false, reason: "bad-claims" })
  assert.deepEqual(verifyEwsToken(token({ nonce: "short" }, { now }), SECRET, nonces, now), { ok: false, reason: "bad-claims" })
})

test("used nonces are forgotten only after their token has expired", () => {
  const nonces = new NonceStore()
  assert.equal(nonces.claim("n1", 1_000, 0), true)
  assert.equal(nonces.claim("n1", 1_000, 500), false)
  assert.equal(nonces.claim("n2", 5_000, 2_000), true)
  assert.equal(nonces.claim("n1", 9_000, 2_000), true)
})

test("next is a relative DI path, else /", () => {
  assert.equal(safeNext("/#/library"), "/#/library")
  assert.equal(safeNext("/#/integration/som_ipc"), "/#/integration/som_ipc")
  for (const bad of ["//evil.example", "https://evil.example", "evil.example", "/\\evil.example", "\\\\evil", "javascript:alert(1)", "/\nx", "", null, undefined]) {
    assert.equal(safeNext(bad), "/", String(bad))
  }
})

test("a handover signs the browser in as the shared account, created with an unusable password, and goes to next", async () => {
  const res = await handover(token())
  assert.equal(res.status, 302)
  assert.equal(res.headers.get("location"), "/#/library")
  assert.equal(res.headers.get("cache-control"), "no-store")
  const cookie = res.headers.get("set-cookie") ?? ""
  assert.match(cookie, /^di_session=[^;]+; HttpOnly; Path=\/; SameSite=Lax/)

  const me = await fetch(`${base}/api/me`, { headers: { cookie: cookie.split(";")[0] } })
  assert.equal(me.status, 200)
  const body = (await me.json()) as { user: { email: string; role: string } }
  assert.deepEqual([body.user.email, body.user.role], ["ews@gmail.com", "editor"])
  const row = await pool.query("SELECT password_hash FROM app.users WHERE email = 'ews@gmail.com'")
  assert.equal(row.rows[0].password_hash, UNUSABLE_PASSWORD_HASH)
})

test("an open redirect through next is impossible", async () => {
  for (const next of ["//evil.example/x", "https://evil.example", "/\\evil.example"]) {
    const res = await handover(token(), next)
    assert.equal(res.status, 302)
    assert.equal(res.headers.get("location"), "/")
  }
})

test("a refused handover shows a plain page linking back to the EWS, with no redirect and no session", async () => {
  const t = token()
  assert.equal((await handover(t)).status, 302)
  for (const bad of [t, token({ aud: "other" }), token({}, { now: Date.now() - 120_000 }), `${t.slice(0, -4)}AAAA`]) {
    const res = await handover(bad)
    assert.equal(res.status, 400)
    assert.equal(res.headers.get("location"), null)
    assert.equal(res.headers.get("set-cookie"), null)
    const html = await res.text()
    assert.match(html, /href="https:\/\/ews\.example\/"/)
    assert.match(html, /href="\/\?local=1"/)
  }
})

test("a disabled shared account is refused", async () => {
  await pool.query("UPDATE app.users SET disabled = true WHERE email = 'ews@gmail.com'")
  try {
    const res = await handover(token())
    assert.equal(res.status, 403)
    assert.equal(res.headers.get("set-cookie"), null)
  } finally {
    await pool.query("UPDATE app.users SET disabled = false WHERE email = 'ews@gmail.com'")
  }
})

test("the audit line names the EWS user; neither the token nor the secret is logged", async () => {
  const t = token({ sub: "audit@ews.demo" })
  const log = await captureLog(() => handover(t))
  const found = log.split("\n").find(l => l.startsWith("{") && l.includes('"auth.ews_sso"'))
  assert.ok(found, "no auth.ews_sso line was logged")
  const line = JSON.parse(found)
  assert.equal(line.event, "auth.ews_sso")
  assert.equal(line.outcome, "success")
  assert.equal(line.ewsSubject, "audit@ews.demo")
  assert.equal(line.email, "ews@gmail.com")
  assert.ok(!log.includes(t.split(".")[2]))
  assert.ok(!log.includes(SECRET))
  const refused = await captureLog(() => handover(t))
  assert.match(refused, /"outcome":"replayed"/)
  assert.ok(!refused.includes(t.split(".")[2]))
})

test("the shared account cannot sign in with a password, even one an admin set, and is not locked out", async () => {
  await handover(token())
  await setPassword(pool, "ews@gmail.com", "a-real-password-123")
  for (const email of ["ews@gmail.com", "EWS@Gmail.com"]) {
    const res = await fetch(`${base}/api/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "a-real-password-123" })
    })
    assert.equal(res.status, 401)
    assert.equal(res.headers.get("set-cookie"), null)
  }
  const row = await pool.query("SELECT failed_logins FROM app.users WHERE email = 'ews@gmail.com'")
  assert.equal(row.rows[0].failed_logins, 0)
  // Created by the handover, its stored hash matches no password at all
  await pool.query("UPDATE app.users SET password_hash = $1 WHERE email = 'ews@gmail.com'", [UNUSABLE_PASSWORD_HASH])
  assert.equal((await authenticate(pool, "ews@gmail.com", "")).ok, false)
  assert.equal((await authenticate(pool, "ews@gmail.com", UNUSABLE_PASSWORD_HASH)).ok, false)
})

test("a signed-out browser is told to sign in at the EWS; Bearer API calls still get the plain 401", async () => {
  const browser = await fetch(`${base}/api/me`)
  assert.equal(browser.status, 401)
  assert.deepEqual(await browser.json(), { error: "not signed in", ewsLoginUrl: "https://ews.example/api/di/sso" })

  const api = await fetch(`${base}/api/me`, { headers: { authorization: "Bearer dit_not-a-real-token" } })
  assert.equal(api.status, 401)
  assert.deepEqual(await api.json(), { error: "not signed in" })
  const data = await fetch(`${base}/api/integrations`, { headers: { authorization: "Bearer dit_not-a-real-token" } })
  assert.equal(data.status, 401)
  assert.match(data.headers.get("content-type") ?? "", /application\/json/)

  // A valid token is unaffected by single sign-on
  const owner = await pool.query("SELECT id FROM app.users WHERE email = 'ews@gmail.com'")
  const pat = await createApiToken(pool, owner.rows[0].id, "test")
  assert.equal((await fetch(`${base}/api/me`, { headers: { authorization: `Bearer ${pat}` } })).status, 200)
})

test("fully off without EWS_DI_SSO_SECRET: no handover, no EWS sign-in address, the account can log in normally", async () => {
  const res = await handover(token(), "/#/library", offBase)
  assert.equal(res.headers.get("set-cookie"), null)
  assert.notEqual(res.status, 302)
  const me = await fetch(`${offBase}/api/me`)
  assert.deepEqual(await me.json(), { error: "not signed in" })

  await setPassword(pool, "ews@gmail.com", "a-real-password-123")
  const login = await fetch(`${offBase}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "ews@gmail.com", password: "a-real-password-123" })
  })
  assert.equal(login.status, 200)
  assert.equal(loadConfig({ DATABASE_URL: "postgres://x/y" }).ewsSso, null)
})

test("configuration: defaults, and refused values", () => {
  const env = { DATABASE_URL: "postgres://x/y", EWS_DI_SSO_SECRET: SECRET }
  assert.deepEqual(loadConfig(env).ewsSso, { secret: SECRET, loginUrl: null, account: "ews@gmail.com", role: "editor" })
  assert.deepEqual(
    loadConfig({ ...env, EWS_DI_SSO_LOGIN_URL: "https://ews.t4d.world/api/di/sso", EWS_DI_SSO_ACCOUNT: "EarlyWarning@Example.org", EWS_DI_SSO_ROLE: "viewer" }).ewsSso,
    { secret: SECRET, loginUrl: "https://ews.t4d.world/api/di/sso", account: "earlywarning@example.org", role: "viewer" }
  )
  assert.throws(() => loadConfig({ ...env, EWS_DI_SSO_SECRET: "short" }), /at least 32 characters/)
  assert.throws(() => loadConfig({ ...env, EWS_DI_SSO_LOGIN_URL: "ews.t4d.world" }), /EWS_DI_SSO_LOGIN_URL/)
  assert.throws(() => loadConfig({ ...env, EWS_DI_SSO_ROLE: "owner" }), /EWS_DI_SSO_ROLE/)
  assert.throws(() => loadConfig({ ...env, EWS_DI_SSO_ACCOUNT: "earlywarning" }), /EWS_DI_SSO_ACCOUNT/)
  try {
    loadConfig({ ...env, EWS_DI_SSO_ROLE: "owner" })
  } catch (err) {
    assert.ok(!String(err).includes(SECRET))
  }
})
