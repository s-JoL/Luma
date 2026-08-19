/**
 * Everything that stands between the internet and this deployment, driven
 * through `app.fetch` against a sandbox database in a temp directory: no port is
 * bound, no network is touched, and `data/` is never opened.
 *
 * The claims are the ones the login is actually attacked on — that guessing gets
 * slower rather than locking the owner out, that a header cannot buy a fresh
 * budget, that a session dies at a fixed distance from the sign-in however often
 * it is refreshed, that a stolen cookie cannot rewrite the credentials it was
 * stolen with, and that no answer says which half of a login was wrong.
 *
 * The deliberate pauses in `auth.ts` are most of the runtime: about fifteen
 * seconds, plus up to five more waiting out a TOTP window.
 *
 *   node --import tsx scripts/audit-auth.ts
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "luma-auth-"));
process.env.LUMA_DATA_DIR = path.join(sandbox, "data");
// Both are read at request time by the code under test, so the machine's own
// environment would otherwise decide what this audit measures.
delete process.env.LUMA_ACCESS_CODE;
delete process.env.LUMA_TRUST_PROXY;

const { createServices } = await import("../src/server/services.ts");
const { createApp } = await import("../src/server/http/app.ts");
const { SECRET } = await import("../src/server/config.ts");

const services = createServices();
const app = createApp(services);

let failures = 0;

async function check(name: string, run: () => Promise<string | void> | string | void) {
  try {
    const note = await run();
    console.log(`PASS ${name}${note ? ` — ${note}` : ""}`);
  } catch (error) {
    failures += 1;
    console.log(`FAIL ${name} — ${error instanceof Error ? error.message : String(error)}`);
  }
}

function assert(condition: unknown, message: string) {
  if (!condition) throw new Error(message);
}

const ORIGIN = "http://luma.audit";
const DAY_MS = 24 * 60 * 60 * 1000;
const hash = (token: string) => crypto.createHash("sha256").update(token).digest("hex");

/** Every field any route under test answers with, so one shape covers them all. */
interface Payload {
  error?: { code?: string; message?: string };
  token?: string;
  expiresAt?: number;
  secret?: string;
  uri?: string;
  totpEnabled?: boolean;
  trustProxy?: boolean;
  currentSessionId?: string;
  sessions?: Array<{ id: string; device: string; createdAt: number; lastSeen: number; expiresAt: number }>;
}

interface CallOptions {
  token?: string;
  cookie?: string;
  body?: unknown;
  headers?: Record<string, string>;
  /** `null` sends no Origin at all, which is what a native client looks like. */
  origin?: string | null;
}

async function call(method: string, endpoint: string, options: CallOptions = {}) {
  const headers: Record<string, string> = {};
  if (options.origin !== null) headers.origin = options.origin ?? ORIGIN;
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  if (options.cookie) headers.cookie = `luma_token=${options.cookie}`;
  if (options.body !== undefined) headers["content-type"] = "application/json";
  Object.assign(headers, options.headers);
  const started = Date.now();
  const response = await app.fetch(
    new Request(`${ORIGIN}/v1${endpoint}`, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    }),
  );
  const text = await response.text();
  return {
    status: response.status,
    elapsed: Date.now() - started,
    headers: response.headers,
    body: (text ? (JSON.parse(text) as Payload) : {}) as Payload,
  };
}

const login = (accessCode: string, totp = "", headers: Record<string, string> = {}) =>
  call("POST", "/auth/token", { body: { accessCode, totp, deviceName: "audit" }, headers });

const stepUp = (accessCode: string, totp = "") => ({
  "x-luma-access-code": accessCode,
  ...(totp ? { "x-luma-totp": totp } : {}),
});

async function signIn(accessCode: string, totp = "") {
  const reply = await login(accessCode, totp);
  assert(reply.status === 200 && reply.body.token, `sign-in failed: ${reply.status} ${reply.body.error?.code}`);
  return String(reply.body.token);
}

/** What `auth.ts` pauses for on the nth consecutive failure, before it charges it. */
const expectedDelay = (attempt: number, free = 3) =>
  attempt - 1 <= free ? 0 : Math.min(8_000, 500 * 2 ** (attempt - free - 2));

let code = String(services.vault.get(SECRET.accessCode));
let owner = await signIn(code);

// ------------------------------------------------------------- the front door

await check("the generated access code is long enough not to need the rate limit", () => {
  // Crockford's base32 without I, L, O or U, grouped in fours for a phone.
  assert(/^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){3}$/.test(code), `generated code was ${code}`);
  const bits = code.replace(/-/g, "").length * 5;
  assert(bits >= 64, `${bits} bits is inside the range NIST asks a verifier to rate-limit`);
  return `${code.replace(/-/g, "").length} characters, ${bits} bits`;
});

await check("nothing behind the door answers without a credential", async () => {
  for (const [method, endpoint] of [
    ["GET", "/bootstrap"],
    ["GET", "/security"],
    ["POST", "/security/sessions/revoke-others"],
  ] as const) {
    const reply = await call(method, endpoint);
    assert(reply.status === 401, `${method} ${endpoint} answered ${reply.status}`);
    assert(reply.body.error?.code === "unauthorized", `${endpoint} → ${reply.body.error?.code}`);
  }
  const invented = await call("GET", "/security", { token: "not-a-token" });
  assert(invented.status === 401, `an invented token answered ${invented.status}`);
  return "401 unauthorized for anonymous and for a made-up token";
});

await check("guessing gets slower and never locks the owner out", async () => {
  const attempts: number[] = [];
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    const reply = await login("definitely-not-the-code");
    assert(reply.status === 401, `attempt ${attempt} answered ${reply.status}, not 401`);
    // A lock on a counter every client on earth shares is a lever an attacker
    // pulls, not a defence: this is the case that must only ever slow down.
    assert(reply.body.error?.code !== "too_many_attempts", `attempt ${attempt} locked a shared counter`);
    attempts.push(reply.elapsed);
  }
  for (const [index, elapsed] of attempts.entries()) {
    assert(elapsed + 100 >= (attempts[index - 1] ?? 0), `attempt ${index + 1} was faster than the one before it`);
    assert(elapsed >= expectedDelay(index + 1) * 0.8, `attempt ${index + 1} paused ${elapsed}ms`);
  }
  assert(attempts[5]! > attempts[0]! + 500, `the curve is flat: ${attempts.join("ms, ")}ms`);
  const recovered = await login(code);
  assert(recovered.status === 200, `the owner was refused after the flood: ${recovered.status}`);
  return `${attempts.join("ms, ")}ms, then the owner still got in`;
});

await check("with a proxy declared, one client locks and another does not", async () => {
  process.env.LUMA_TRUST_PROXY = "1";
  try {
    const attacker = { "cf-connecting-ip": "203.0.113.7" };
    let locked = 0;
    for (let attempt = 1; attempt <= 8; attempt += 1) {
      const reply = await login("definitely-not-the-code", "", attacker);
      if (reply.body.error?.code === "too_many_attempts") locked = attempt;
    }
    assert(!locked, `the counter closed at attempt ${locked}, before the failures were spent`);

    // The correct code, from the address that spent the budget.
    const shut = await login(code, "", attacker);
    assert(shut.status === 429, `a locked client got ${shut.status}`);
    assert(shut.body.error?.code === "too_many_attempts", `code was ${shut.body.error?.code}`);

    const elsewhere = await login(code, "", { "cf-connecting-ip": "198.51.100.9" });
    assert(elsewhere.status === 200, `the owner was locked out from another address: ${elsewhere.status}`);
    return "203.0.113.7 shut out for 15 minutes, 198.51.100.9 signed in";
  } finally {
    delete process.env.LUMA_TRUST_PROXY;
  }
});

await check("a forwarded address buys nothing when no proxy is declared", async () => {
  const attempts: number[] = [];
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    // A fresh identity per request, which is what the budget would be reset by
    // if these headers were believed from an undeclared peer.
    const spoofed = {
      "cf-connecting-ip": `192.0.2.${attempt}`,
      "x-forwarded-for": `192.0.2.${attempt}, 203.0.113.1`,
    };
    const reply = await login("definitely-not-the-code", "", spoofed);
    assert(reply.status === 401, `attempt ${attempt} answered ${reply.status}`);
    attempts.push(reply.elapsed);
  }
  assert(attempts[5]! >= expectedDelay(6) * 0.8, `six identities cost ${attempts.join("ms, ")}ms — the budget reset`);
  const recovered = await login(code);
  assert(recovered.status === 200, `the owner was refused: ${recovered.status}`);
  return `charged to one counter anyway: ${attempts.join("ms, ")}ms`;
});

// ---------------------------------------------------------------- the session

await check("a session dies at a fixed distance from the sign-in", async () => {
  const reply = await login(code);
  const ceiling = Number(reply.body.expiresAt) - Date.now();
  assert(Math.abs(ceiling - 180 * DAY_MS) < 5_000, `the ceiling is ${Math.round(ceiling / DAY_MS)} days`);
  const row = services.store.listSessions().find((session) => session.id === hash(String(reply.body.token)));
  assert(row, "the session was issued without a row to expire");
  assert(Math.abs(row!.expiresAt - row!.createdAt - 180 * DAY_MS) < 5_000, "the row disagrees with the response");
  return `${Math.round(ceiling / DAY_MS)} days from the sign-in, whatever it is used for`;
});

await check("a cookie write must come from this origin, and a bearer write too", async () => {
  const endpoint = "/security/sessions/revoke-others";
  const rejected: Array<[string, CallOptions]> = [
    ["bearer", { token: owner, origin: "https://evil.example" }],
    ["cookie", { cookie: owner, origin: "https://evil.example" }],
    ["bearer, declared by the browser", { token: owner, headers: { "sec-fetch-site": "cross-site" } }],
    ["cookie, declared by the browser", { cookie: owner, headers: { "sec-fetch-site": "cross-site" } }],
    ["cookie with no origin at all", { cookie: owner, origin: null }],
  ];
  for (const [label, options] of rejected) {
    const reply = await call("POST", endpoint, options);
    assert(reply.status === 403, `${label} answered ${reply.status}`);
    assert(reply.body.error?.code === "bad_origin", `${label} → ${reply.body.error?.code}`);
  }

  // Step-up is what stops a legitimate write here, so anything else in its place
  // means the origin check turned one away.
  const allowed: Array<[string, CallOptions]> = [
    ["a same-origin bearer write", { token: owner }],
    ["a same-origin cookie write", { cookie: owner }],
    // A cross-site page cannot attach a bearer token in the first place, so a
    // client that names no origin is a native one rather than an attack.
    ["a native client naming no origin", { token: owner, origin: null }],
  ];
  for (const [label, options] of allowed) {
    const reply = await call("POST", endpoint, options);
    assert(reply.body.error?.code === "step_up_required", `${label} → ${reply.status} ${reply.body.error?.code}`);
  }

  const read = await call("GET", "/security", { cookie: owner, origin: "https://evil.example" });
  assert(read.status === 200, `a cross-site read answered ${read.status}, and reads are not the hole`);
  return `${rejected.length} cross-site writes rejected, ${allowed.length} legitimate ones let through`;
});

await check("a session left idle dies, and is swept out of the list", async () => {
  const stale = await signIn(code);
  const swept = await signIn(code);
  const idle = Date.now() - 31 * DAY_MS;
  for (const token of [stale, swept]) {
    services.store.db.run("UPDATE sessions SET last_seen = ? WHERE token_hash = ?", idle, hash(token));
  }

  const refused = await call("GET", "/security", { token: stale });
  assert(refused.status === 401, `an idle session answered ${refused.status}`);
  assert(!services.store.listSessions().some((row) => row.id === hash(stale)), "the dead row was left behind");

  const listed = await call("GET", "/security", { token: owner });
  assert(listed.status === 200, `the live session answered ${listed.status}`);
  assert(
    !listed.body.sessions?.some((row) => row.id === hash(swept)),
    "an idle session was offered as a device to revoke",
  );
  assert(!services.store.listSessions().some((row) => row.id === hash(swept)), "it was hidden rather than swept");
  return "31 days idle: refused, delisted and deleted";
});

await check("rotation replaces the token without moving the ceiling", async () => {
  const old = await signIn(code);
  // A session a week old is what rotation is for; the ceiling stays where that
  // sign-in put it, which is what the replacement must not quietly extend.
  const createdAt = Date.now() - 8 * DAY_MS;
  const ceiling = createdAt + 180 * DAY_MS;
  services.store.db.run(
    "UPDATE sessions SET created_at = ?, expires_at = ? WHERE token_hash = ?",
    createdAt,
    ceiling,
    hash(old),
  );

  const quiet = await call("GET", "/security", { token: old });
  assert(quiet.status === 200, `a client that cannot store a replacement answered ${quiet.status}`);
  assert(!quiet.headers.get("x-luma-token"), "a replacement was handed to a client that never said it would keep it");

  const rotated = await call("GET", "/security", { token: old, headers: { "x-luma-token-rotation": "1" } });
  const replacement = rotated.headers.get("x-luma-token") ?? "";
  assert(replacement && replacement !== old, `no replacement arrived: ${JSON.stringify(replacement)}`);
  const fresh = services.store.listSessions().find((row) => row.id === hash(replacement));
  assert(fresh, "the replacement names no session");
  assert(Math.abs(fresh!.expiresAt - ceiling) < 5_000, `rotation moved the ceiling by ${fresh!.expiresAt - ceiling}ms`);
  assert(!services.store.listSessions().some((row) => row.id === hash(old)), "the old row outlived its replacement");

  const inFlight = await call("GET", "/security", { token: old });
  assert(inFlight.status === 200, `a request already in flight was signed out: ${inFlight.status}`);
  assert(inFlight.body.currentSessionId === hash(replacement), "the grace window points at the wrong session");
  const withNew = await call("GET", "/security", { token: replacement });
  assert(withNew.status === 200, `the replacement does not work: ${withNew.status}`);
  return `ceiling held at ${Math.round((ceiling - Date.now()) / DAY_MS)} days, old token still good for 60s`;
});

// ---------------------------------------------------------------- the step-up

const MUTATIONS = [
  ["PUT", "/security/access-code", { value: "abcdefghijkl" }],
  ["POST", "/security/totp", undefined],
  ["DELETE", "/security/totp", { code: "000000" }],
  ["DELETE", "/security/sessions/some-session-id", undefined],
  ["POST", "/security/sessions/revoke-others", undefined],
] as const;

await check("every change that outlives the session is confirmed first", async () => {
  for (const [method, endpoint, body] of MUTATIONS) {
    const reply = await call(method, endpoint, { token: owner, body });
    assert(reply.status === 403, `${method} ${endpoint} answered ${reply.status}`);
    assert(reply.body.error?.code === "step_up_required", `${method} ${endpoint} → ${reply.body.error?.code}`);
  }
  const wrong = await call("PUT", "/security/access-code", {
    token: owner,
    body: { value: "abcdefghijkl" },
    headers: stepUp("not-the-access-code"),
  });
  assert(wrong.status === 403 && wrong.body.error?.code === "bad_step_up", `a wrong code → ${wrong.status}`);
  assert(services.vault.get(SECRET.accessCode) === code, "the access code changed on a refused confirmation");

  // The one write that is its own proof: a code from the authenticator being
  // enrolled is what the confirmation would have asked for anyway.
  const confirm = await call("POST", "/security/totp/confirm", { token: owner, body: { code: "000000" } });
  assert(confirm.body.error?.code === "invalid", `enrolment confirm demanded ${confirm.body.error?.code}`);
  return `${MUTATIONS.length} mutations gated, confirm/ exempt, a wrong confirmation changes nothing`;
});

await check("a chosen access code has to be long enough to survive the internet", async () => {
  const short = await call("PUT", "/security/access-code", {
    token: owner,
    body: { value: "abcdefghijk" },
    headers: stepUp(code),
  });
  assert(short.status === 400, `an 11-character code answered ${short.status}`);
  assert(short.body.error?.code === "invalid", `→ ${short.body.error?.code}`);

  const chosen = "audit-access-code";
  const accepted = await call("PUT", "/security/access-code", {
    token: owner,
    body: { value: chosen },
    headers: stepUp(code),
  });
  assert(accepted.status === 200, `a ${chosen.length}-character code answered ${accepted.status}`);
  code = chosen;
  assert(services.vault.get(SECRET.accessCode) === code, "the new code was not stored");
  // Every other device signed in with the old one, so none of them may survive.
  const rows = services.store.listSessions();
  assert(rows.length === 1 && rows[0]!.id === hash(owner), `${rows.length} sessions survived the rotation`);
  return "11 refused, 12 is the floor, other devices signed out";
});

// -------------------------------------------------------------- the authenticator

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/**
 * The authenticator's half of RFC 6238, written out here rather than imported
 * from the server: a helper both sides shared would agree with itself even if
 * the profile were wrong, and interoperating with a real phone is the property.
 */
function totpCode(secret: string, step: number) {
  let bits = 0;
  let value = 0;
  const key: number[] = [];
  for (const character of secret.toUpperCase().replace(/=+$/, "")) {
    const index = BASE32.indexOf(character);
    if (index < 0) continue;
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      key.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const digest = crypto.createHmac("sha1", Buffer.from(key)).update(counter).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}

/**
 * Only three codes are live at once — one step either side of now — and each
 * one spent raises the watermark past the ones before it, so this whole section
 * has to run inside a single window or it would be testing the clock.
 */
const remaining = 30_000 - (Date.now() % 30_000);
if (remaining < 5_000) await new Promise((resolve) => setTimeout(resolve, remaining + 50));
const step = Math.floor(Date.now() / 30_000);
let secret = "";

await check("an enrolment counts for nothing until a code proves it arrived", async () => {
  const started = await call("POST", "/security/totp", { token: owner, headers: stepUp(code) });
  assert(started.status === 200 && started.body.secret, `enrolment answered ${started.status}`);
  secret = String(started.body.secret);
  assert(started.body.uri?.startsWith("otpauth://totp/"), `the app cannot scan ${started.body.uri}`);
  assert(!services.vault.has(SECRET.totp), "the secret was adopted before anything proved it was received");

  const before = await call("GET", "/security", { token: owner });
  assert(before.body.totpEnabled === false, "an unconfirmed enrolment switched two-factor on");

  const stale = await call("POST", "/security/totp/confirm", {
    token: owner,
    body: { code: totpCode(secret, step + 5_000) },
  });
  assert(stale.status === 400 && stale.body.error?.code === "bad_totp", `a code from another day → ${stale.status}`);
  assert(!services.vault.has(SECRET.totp), "a rejected code still enrolled the secret");

  const confirmed = await call("POST", "/security/totp/confirm", {
    token: owner,
    body: { code: totpCode(secret, step - 1) },
  });
  assert(confirmed.status === 200, `a real code answered ${confirmed.status}`);
  assert(confirmed.body.totpEnabled === true, "the confirmation did not switch it on");
  assert(services.vault.get(SECRET.totp) === secret, "a different secret was adopted");
  return "pending until confirmed, then adopted";
});

await check("no answer says which half of a login was wrong", async () => {
  // The access code is wrong and the second factor is a real, unspent code; then
  // the other way round. Naming the half that failed is what confirms a guess.
  const badCode = await login("definitely-not-the-code", totpCode(secret, step));
  const badTotp = await login(code, totpCode(secret, step + 5_000));
  assert(badCode.status === badTotp.status, `${badCode.status} vs ${badTotp.status}`);
  assert(badCode.body.error?.code === badTotp.body.error?.code, `${badCode.body.error?.code} vs ${badTotp.body.error?.code}`);
  assert(badCode.body.error?.message === badTotp.body.error?.message, "the messages differ");
  assert(badCode.status === 401, `a failed login answered ${badCode.status}`);

  // A missing second factor is only a prompt, and it is answered before the
  // access code is looked at, so it says nothing about the code beside it.
  const prompt = await login("definitely-not-the-code");
  assert(prompt.body.error?.code === "totp_required", `an empty second factor → ${prompt.body.error?.code}`);
  return `both "${badCode.body.error?.message}"`;
});

await check("a code from the authenticator cannot be spent twice", async () => {
  const used = totpCode(secret, step);
  const first = await call("POST", "/security/totp", { token: owner, headers: stepUp(code, used) });
  assert(first.status === 200, `a valid confirmation answered ${first.status} ${first.body.error?.code}`);

  const replayed = await call("POST", "/security/totp", { token: owner, headers: stepUp(code, used) });
  assert(replayed.status === 403, `the same code answered ${replayed.status}`);
  assert(replayed.body.error?.code === "bad_step_up", `→ ${replayed.body.error?.code}`);

  // The next code still works, so what was refused was the replay rather than
  // the route: an owner watching their authenticator roll over is not stuck.
  const next = await call("POST", "/security/totp", { token: owner, headers: stepUp(code, totpCode(secret, step + 1)) });
  assert(next.status === 200, `the following code answered ${next.status} ${next.body.error?.code}`);
  assert(Math.floor(Date.now() / 30_000) === step, "the window rolled over mid-check, so this proved nothing");
  return "accepted once, refused on replay, and the next one is accepted";
});

await check("with an authenticator enrolled, the confirmation needs both halves", async () => {
  const before = services.store.listSessions().length;
  const alone = await call("POST", "/security/sessions/revoke-others", { token: owner, headers: stepUp(code) });
  assert(alone.status === 403, `an access code alone answered ${alone.status}`);
  assert(alone.body.error?.code === "step_up_required", `→ ${alone.body.error?.code}`);
  assert(
    /authenticator/i.test(alone.body.error?.message ?? ""),
    `the prompt does not say what is missing: ${alone.body.error?.message}`,
  );
  assert(services.store.listSessions().length === before, "the refused confirmation revoked something anyway");
  return "the access code on its own is refused once a second factor exists";
});

await services.close();
fs.rmSync(sandbox, { recursive: true, force: true });
console.log(failures ? `\n${failures} auth check(s) failed` : "\nall auth checks passed");
process.exit(failures ? 1 : 0);
