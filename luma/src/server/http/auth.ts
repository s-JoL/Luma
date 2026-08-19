import { createHash, randomBytes } from "node:crypto";
import { getConnInfo } from "@hono/node-server/conninfo";
import type { Context, Next } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import type { LoginResponse, SessionRecord } from "@shared/types.ts";
import { SECRET } from "../config.ts";
import type { Services } from "../services.ts";
import { constantTimeEquals } from "../crypto/secrets.ts";
import { verifyTotpStep } from "../crypto/totp.ts";
import { fail } from "./errors.ts";

const COOKIE_NAME = "luma_token";

/**
 * A session slides while it is being used and dies at a fixed distance from the
 * sign-in that created it whichever way. The idle window is what stops the owner
 * being asked again on a device they actually use; the ceiling is what stops a
 * token that leaked quietly from being useful forever. Neither extreme is right
 * on its own: 90 fixed days logs someone out mid-sentence for no gain, and a
 * window that only ever slides means a stolen cookie never dies.
 *
 * The numbers come from the closest comparable deployments. Home Assistant
 * sweeps a refresh token that has gone 90 days unused and otherwise never
 * expires one, so the idle sweep is the part it proves is liveable; 30 days is
 * taken instead of 90 because this login is exposed to the internet. LibreChat
 * gives a refresh token 7 days, which is too short to be a session here but is
 * the right cadence for replacing a token in place — so the leak window is 7
 * days even though the session is half a year.
 */
const SESSION_IDLE_MS = 30 * 24 * 60 * 60 * 1000;
const SESSION_MAX_MS = 180 * 24 * 60 * 60 * 1000;
const ROTATE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
/** Long enough for a request that was already in flight when the token changed. */
const ROTATION_GRACE_MS = 60 * 1000;
const NEW_TOKEN_HEADER = "x-luma-token";
const ROTATION_HEADER = "x-luma-token-rotation";
const STEP_UP_CODE_HEADER = "x-luma-access-code";
const STEP_UP_TOTP_HEADER = "x-luma-totp";

/**
 * Brute-force budget for a publicly reachable login. The shape matters more
 * than the numbers: a binary lock on a shared counter is a lever an attacker
 * pulls to lock the owner out, which is what the previous version handed them
 * at forty failures from anywhere. So the shared backstop only ever *slows*
 * attempts — an exponential pause of the kind the OWASP Authentication Cheat
 * Sheet prefers to a lockout — and a hard lock is reserved for a counter that
 * belongs to one client and cannot be filled by someone else.
 *
 * NIST SP 800-63B-4 §3.2.2 caps consecutive failures at 100 and says the cap is
 * a balance against "the potential need for account recovery"; the delay curve
 * reaches its ceiling well before that while leaving the door open.
 *
 * In-memory is enough — clearing it requires restarting the server, which
 * requires the machine.
 */
const FREE_ATTEMPTS = 3;
const DELAY_STEP_MS = 500;
const MAX_DELAY_MS = 8_000;
const ADDRESS_LIMIT = 8;
const SESSION_LIMIT = 8;
const SHARED_ALLOWANCE = 40;
const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
const LOCKOUT_MS = 15 * 60 * 1000;
const MAX_COUNTERS = 2_000;
const SHARED_KEY = "*";

const hash = (token: string) => createHash("sha256").update(token).digest("hex");
const pause = (ms: number) => (ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve());

interface Attempts {
  failures: number;
  first: number;
  lockedUntil: number;
}

const attempts = new Map<string, Attempts>();

/** Token hashes replaced by a rotation, and what they now point at. */
const rotated = new Map<string, { id: string; until: number }>();

/**
 * Counters are kept until something needs the room, because a distributed
 * attacker naming a new address per request would otherwise grow this map for
 * free. What is left after a sweep is only what is still inside its window.
 */
function sweep(now: number) {
  for (const [key, entry] of attempts) {
    if (now - entry.first > ATTEMPT_WINDOW_MS && entry.lockedUntil < now) attempts.delete(key);
  }
}

function bucket(key: string) {
  const now = Date.now();
  const existing = attempts.get(key);
  if (existing && now - existing.first <= ATTEMPT_WINDOW_MS) return existing;
  if (!existing && attempts.size >= MAX_COUNTERS) sweep(now);
  const fresh = { failures: 0, first: now, lockedUntil: 0 };
  attempts.set(key, fresh);
  return fresh;
}

const trustsProxy = () => process.env.LUMA_TRUST_PROXY === "1";

/** `::ffff:1.2.3.4` is the same client as `1.2.3.4`, and a /64 is one host. */
function normalizeAddress(value: string) {
  const address = value.trim().toLowerCase().replace(/^::ffff:/, "");
  if (!address.includes(":")) return address;
  return address.split(":").slice(0, 4).join(":");
}

const isLoopback = (address: string) => address === "::1" || address.startsWith("127.");

/**
 * Who an attempt is counted against. The transport peer is the only part of
 * this an attacker cannot choose, so it is the base; a forwarded address is
 * read only when the deployment declares a proxy in front *and* the request
 * really arrived from it, which behind the tunnel means from loopback. Read
 * unconditionally — as `x-real-ip` used to be — a header is the opposite of a
 * rate limit: a fresh budget per request, free of charge.
 *
 * `specific` says whether the answer distinguishes one client from another at
 * all. Behind a tunnel with no declared proxy every request on earth arrives
 * from 127.0.0.1, so it does not, and nothing keyed on it may lock.
 */
function clientAddress(context: Context) {
  let peer = "";
  try {
    peer = normalizeAddress(getConnInfo(context).remote.address ?? "");
  } catch {
    peer = "";
  }
  if (trustsProxy() && (!peer || isLoopback(peer))) {
    const forwarded =
      context.req.header("cf-connecting-ip") ?? context.req.header("x-forwarded-for")?.split(",")[0];
    const declared = normalizeAddress(forwarded ?? "");
    if (declared) return { key: declared, specific: true };
  }
  if (!peer) return { key: "local", specific: false };
  return { key: peer, specific: !isLoopback(peer) };
}

type Factor = "code" | "totp";

interface Budget {
  key: string;
  /** Failures that cost nothing but a slower answer. */
  free: number;
  /** Failures that close this counter, or 0 for a counter that never closes. */
  lockAt: number;
}

/**
 * Which counters an attempt is charged to. A request that already holds a
 * session is charged to that session and nothing else: an attacker guessing
 * from the network then cannot spend a signed-in device's allowance, and a
 * stolen session cannot spend the owner's. That is the device-cookie split from
 * OWASP's "Slow Down Online Guessing Attacks with Device Cookies" — lock a
 * known client on its own, and never let an unknown one lock it.
 *
 * The two factors count separately, so a flood of wrong six-digit codes at the
 * step-up routes cannot use up the access code's allowance.
 */
function budgets(context: Context, factor: Factor, sessionId: string): Budget[] {
  if (sessionId) {
    return [{ key: `${factor}:session:${sessionId}`, free: FREE_ATTEMPTS, lockAt: SESSION_LIMIT }];
  }
  const address = clientAddress(context);
  return [
    { key: `${factor}:${address.key}`, free: FREE_ATTEMPTS, lockAt: address.specific ? ADDRESS_LIMIT : 0 },
    { key: SHARED_KEY, free: SHARED_ALLOWANCE, lockAt: 0 },
  ];
}

const delayFor = (failures: number, free: number) =>
  failures <= free ? 0 : Math.min(MAX_DELAY_MS, DELAY_STEP_MS * 2 ** (failures - free - 1));

interface Penalty {
  /** Seconds until this client may try again, or 0 — never set by a shared counter. */
  retryAfter: number;
  delayMs: number;
}

function penalty(list: Budget[]): Penalty {
  const now = Date.now();
  let retryAfter = 0;
  let delayMs = 0;
  for (const budget of list) {
    const entry = bucket(budget.key);
    if (budget.lockAt && entry.lockedUntil > now) {
      retryAfter = Math.max(retryAfter, Math.ceil((entry.lockedUntil - now) / 1000));
    }
    delayMs = Math.max(delayMs, delayFor(entry.failures, budget.free));
  }
  return { retryAfter, delayMs };
}

function charge(list: Budget[]) {
  const now = Date.now();
  for (const budget of list) {
    const entry = bucket(budget.key);
    entry.failures += 1;
    if (budget.lockAt && entry.failures >= budget.lockAt) entry.lockedUntil = now + LOCKOUT_MS;
  }
}

/** A success clears this client's counters, but never the shared backstop. */
function clearFailures(context: Context, sessionId: string) {
  for (const factor of ["code", "totp"] as const) {
    for (const budget of budgets(context, factor, sessionId)) {
      if (budget.key !== SHARED_KEY) attempts.delete(budget.key);
    }
  }
}

export const loginLocked = (context: Context) => penalty(budgets(context, "code", "")).retryAfter;

const CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CODE_CHARS = 16;

/**
 * Access-code file used to bootstrap the first login on a fresh install.
 *
 * Sixteen characters of Crockford's base32 is 80 bits, well past the 64 bits at
 * which NIST SP 800-63B-4 stops requiring a rate limit to hold a randomly
 * generated secret against online guessing — so the throttling above is a
 * backstop here rather than the thing holding the door. Four bytes of hex, what
 * this used to mint, was 32 bits: guessable by a patient attacker against any
 * limit loose enough to be usable. The alphabet has no I, L, O or U and it is
 * grouped in fours, because the owner types this on a phone.
 */
export function ensureAccessCode(services: Services) {
  const existing = services.vault.get(SECRET.accessCode);
  if (existing) return existing;
  const generated = [...randomBytes(CODE_CHARS)]
    .map((byte) => CODE_ALPHABET[byte & 31])
    .join("")
    .replace(/(.{4})(?=.)/g, "$1-");
  const code = process.env.LUMA_ACCESS_CODE?.trim() || generated;
  services.vault.set(SECRET.accessCode, code);
  return code;
}

/** True once an authenticator has been enrolled and confirmed. */
export const totpEnabled = (services: Services) => services.vault.has(SECRET.totp);

/** Highest time step already spent, so a code cannot be used twice. */
const TOTP_STEP = "totp-step";

/**
 * RFC 6238 §5.2: a code that has been accepted must be refused for the rest of
 * its window. Verifying and spending are separate calls because a code must not
 * be burnt by an attempt that failed for another reason — the owner typing the
 * wrong access code alongside the right six digits would otherwise have to wait
 * for the next one.
 */
export function checkTotp(services: Services, secret: string, candidate: string) {
  const step = verifyTotpStep(secret, candidate);
  const spent = Number(services.vault.get(TOTP_STEP) ?? "0");
  return { ok: step !== null && step > (Number.isFinite(spent) ? spent : 0), step };
}

export function acceptTotp(services: Services, step: number | null) {
  if (step !== null) services.vault.set(TOTP_STEP, String(step));
}

/**
 * Cookies must only be marked Secure when the connection really is TLS, and the
 * security screen reports this to the owner as the answer to "did this arrive
 * over the tunnel" — so a forwarded protocol is believed only from a declared
 * proxy. Otherwise anyone who can reach the port decides what that display says.
 */
export function overTls(context: Context) {
  if (trustsProxy() && context.req.header("x-forwarded-proto")?.split(",")[0]?.trim() === "https") return true;
  return new URL(context.req.url).protocol === "https:";
}

function writeCookie(context: Context, token: string, ttlMs: number) {
  setCookie(context, COOKIE_NAME, token, {
    httpOnly: true,
    // Strict is safe here because the app is a same-origin SPA: the first
    // navigation needs no cookie, and every API call after it is same-site.
    sameSite: "Strict",
    secure: overTls(context),
    path: "/",
    maxAge: Math.floor(ttlMs / 1000),
  });
}

export function issueToken(services: Services, context: Context, deviceName: string): LoginResponse {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = services.store.createSession(hash(token), deviceName || "web", SESSION_MAX_MS);
  writeCookie(context, token, SESSION_MAX_MS);
  return { token, expiresAt };
}

export interface LoginAttempt {
  accessCode?: string;
  totp?: string;
  deviceName?: string;
}

export type LoginResult =
  | { ok: true }
  | { ok: false; code: "locked" | "totp_required" | "bad_credentials"; retryAfter?: number };

/**
 * One place that decides whether a login succeeds, so the access code and the
 * second factor can never be checked in the wrong order or skipped.
 *
 * Both factors are compared before either verdict is given and one answer comes
 * back for both, because naming the half that was wrong confirmed a guessed
 * access code — and confirmed it for free, since a missing second factor was
 * never counted as a failure. A missing code is still only a prompt, but it is
 * answered before the access code is looked at, so the prompt says nothing
 * about the code that came with it.
 */
export async function checkLogin(
  services: Services,
  context: Context,
  body: LoginAttempt,
): Promise<LoginResult> {
  const secret = services.vault.get(SECRET.totp);
  const supplied = (body.totp ?? "").trim();
  if (secret && !supplied) return { ok: false, code: "totp_required" };

  const list = budgets(context, "code", "");
  const { retryAfter, delayMs } = penalty(list);
  if (retryAfter) return { ok: false, code: "locked", retryAfter };

  const codeOk = constantTimeEquals(ensureAccessCode(services), (body.accessCode ?? "").trim());
  const totp = secret ? checkTotp(services, secret, supplied) : { ok: true, step: null };
  if (!codeOk || !totp.ok) {
    charge(list);
    await pause(delayMs);
    return { ok: false, code: "bad_credentials" };
  }
  acceptTotp(services, totp.step);
  clearFailures(context, "");
  return { ok: true };
}

/**
 * Re-authentication in front of a change that would outlive the session making
 * it. Without it one stolen cookie is a permanent takeover: it could set a new
 * access code, switch the second factor off and revoke the owner's own devices,
 * and the owner would have nothing left to sign in with. It costs a
 * confirmation on five routes and nothing anywhere else.
 *
 * The credentials arrive in headers so no request body changes shape and a
 * native client sends them exactly as the browser does. Failures are charged to
 * this session's own counter, so a stolen session is throttled without the
 * owner's login being affected either way.
 */
export async function requireStepUp(services: Services, context: Context, fallbackTotp = "") {
  const sessionId = currentSessionId(context);
  const secret = services.vault.get(SECRET.totp);
  const code = (context.req.header(STEP_UP_CODE_HEADER) ?? "").trim();
  const supplied = (context.req.header(STEP_UP_TOTP_HEADER) ?? fallbackTotp).trim();
  if (!code || (secret && !supplied)) {
    return fail(
      context,
      403,
      "step_up_required",
      secret
        ? "Confirm your access code and a current authenticator code to change this"
        : "Confirm your access code to change this",
    );
  }

  const list = budgets(context, "totp", sessionId);
  const { retryAfter, delayMs } = penalty(list);
  if (retryAfter) {
    return fail(
      context,
      429,
      "too_many_attempts",
      `Too many attempts. Try again in ${Math.ceil(retryAfter / 60)} minutes.`,
    );
  }

  const codeOk = constantTimeEquals(ensureAccessCode(services), code);
  const totp = secret ? checkTotp(services, secret, supplied) : { ok: true, step: null };
  if (!codeOk || !totp.ok) {
    charge(list);
    await pause(delayMs);
    return fail(context, 403, "bad_step_up", "That confirmation is not correct");
  }
  acceptTotp(services, totp.step);
  clearFailures(context, sessionId);
  return null;
}

function credential(context: Context) {
  const header = context.req.header("authorization");
  if (header?.toLowerCase().startsWith("bearer ")) return { token: header.slice(7).trim(), viaCookie: false };
  const cookie = getCookie(context, COOKIE_NAME) ?? "";
  return { token: cookie, viaCookie: Boolean(cookie) };
}

function rotatedTo(id: string) {
  const entry = rotated.get(id);
  if (!entry) return "";
  if (entry.until < Date.now()) {
    rotated.delete(id);
    return "";
  }
  return entry.id;
}

export const currentSessionId = (context: Context) => {
  const { token } = credential(context);
  if (!token) return "";
  const id = hash(token);
  return rotatedTo(id) || id;
};

const sessionRow = (services: Services, id: string) =>
  services.store.listSessions().find((row) => row.id === id);

/**
 * The session behind a request, slid forward if it is still inside its idle
 * window. The row's own `expires_at` is the ceiling, so the store already
 * refuses anything past it; the idle window is enforced here against
 * `last_seen`, which is what lets the lifetime slide without rewriting a row
 * on every request.
 */
function authenticate(services: Services, token: string) {
  const id = hash(token);
  const current = rotatedTo(id) || id;
  const row = sessionRow(services, current);
  if (!row) return null;
  if (Date.now() - row.lastSeen > SESSION_IDLE_MS) {
    services.store.deleteSession(current);
    return null;
  }
  if (!services.store.touchSession(current)) return null;
  return row;
}

/**
 * Sessions that could still be used. A row only leaves the table at its
 * ceiling, so one that has sat out its idle window is already dead, and listing
 * it would invite revoking something that is not there.
 */
export function liveSessions(services: Services) {
  const now = Date.now();
  const rows = services.store.listSessions();
  for (const row of rows) {
    if (now - row.lastSeen > SESSION_IDLE_MS) services.store.deleteSession(row.id);
  }
  return rows.filter((row) => now - row.lastSeen <= SESSION_IDLE_MS);
}

/**
 * A session that has been alive a week is given a new token, so a cookie or a
 * bearer token that leaked unnoticed stops working long before the session's
 * own ceiling. The client has to say it can store the replacement: handing a new
 * token to one that drops it would sign the owner out, which is the failure this
 * file exists to avoid.
 */
function rotateIfDue(services: Services, context: Context, session: SessionRecord) {
  if (context.req.header(ROTATION_HEADER) !== "1") return;
  if (Date.now() - session.createdAt < ROTATE_AFTER_MS) return;
  // Nothing on the client can read the headers of a stream it is consuming, so
  // a replacement announced there would be lost.
  if (context.res.headers.get("content-type")?.startsWith("text/event-stream")) return;
  const token = randomBytes(32).toString("base64url");
  const remaining = session.expiresAt - Date.now();
  services.store.createSession(hash(token), session.device, remaining);
  services.store.deleteSession(session.id);
  rotated.set(session.id, { id: hash(token), until: Date.now() + ROTATION_GRACE_MS });
  writeCookie(context, token, remaining);
  context.header(NEW_TOKEN_HEADER, token);
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * A cookie-authenticated write must come from this origin. `SameSite=Strict`
 * already covers current browsers; `Sec-Fetch-Site` and the `Origin` comparison
 * close the same hole for anything that ignores it. A cookie write that names no
 * origin at all is refused too, since every browser sends one on a write and
 * anything that is not a browser should be holding a bearer token — which a
 * cross-site page cannot attach in the first place.
 */
function crossSite(context: Context, viaCookie: boolean) {
  const site = context.req.header("sec-fetch-site");
  if (site) return site !== "same-origin" && site !== "none";
  const origin = context.req.header("origin");
  if (!origin) return viaCookie;
  try {
    return new URL(origin).host !== new URL(context.req.url).host;
  } catch {
    return true;
  }
}

export function requireAuth(services: Services) {
  return async (context: Context, next: Next) => {
    const { token, viaCookie } = credential(context);
    const session = token ? authenticate(services, token) : null;
    if (!session) return fail(context, 401, "unauthorized", "Sign in to continue");
    if (!SAFE_METHODS.has(context.req.method) && crossSite(context, viaCookie)) {
      return fail(context, 403, "bad_origin", "Cross-site request rejected");
    }
    await next();
    rotateIfDue(services, context, session);
  };
}

export function revokeCurrent(services: Services, context: Context) {
  const id = currentSessionId(context);
  if (id) {
    services.store.deleteSession(id);
    rotated.delete(id);
  }
  writeCookie(context, "", 0);
}
