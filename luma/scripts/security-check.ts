/**
 * Exercises the brute-force tarpit and the cross-site write rejection against a
 * running instance.
 *
 * The peer here is loopback and no proxy is declared, which is exactly the case
 * that no longer hard-locks: every request on earth looks the same from behind a
 * tunnel, so a lock on that counter would be a lever an attacker pulls to lock
 * the owner out. What is left is the pause curve, and this is what proves it is
 * still there — and still lets the owner in afterwards.
 *
 * This leaves a slow counter behind for the cooldown, so it is not part of the
 * e2e suite; run it on its own when touching auth. The tarpit is most of the
 * runtime — ten failures are about half a minute of deliberate pauses.
 *
 *   node --import tsx scripts/security-check.ts
 */
export {};

const BASE = process.env.LUMA_BASE ?? "http://127.0.0.1:8095/v1";
const CODE = process.env.LUMA_ACCESS_CODE ?? "AUDITCODE";

/** Comfortably past the 8s ceiling the server pauses for, so a hang still fails. */
const REQUEST_TIMEOUT_MS = 30_000;
const ATTEMPTS = 10;
const FREE_ATTEMPTS = 3;

let failures = 0;

function check(name: string, condition: unknown, note: string) {
  if (condition) {
    console.log(`PASS ${name} — ${note}`);
    return;
  }
  failures += 1;
  console.log(`FAIL ${name} — ${note}`);
}

const sign = async (accessCode: string) => {
  const started = Date.now();
  const reply = await fetch(`${BASE}/auth/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ accessCode, deviceName: "lock-check" }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  return {
    status: reply.status,
    elapsed: Date.now() - started,
    body: (await reply.json()) as { error?: { message?: string }; token?: string },
  };
};

const good = await sign(CODE);
const token = String(good.body.token);

const cross = await fetch(`${BASE}/conversations`, {
  method: "POST",
  headers: { authorization: `Bearer ${token}`, "content-type": "application/json", origin: "https://evil.example" },
  body: JSON.stringify({}),
});
console.log("cross-site write →", cross.status, (await cross.json() as { error?: { code?: string } }).error?.code);

const sameSite = await fetch(`${BASE}/conversations`, {
  method: "POST",
  headers: { authorization: `Bearer ${token}`, "content-type": "application/json", origin: "http://127.0.0.1:8095" },
  body: JSON.stringify({}),
});
const created = (await sameSite.json()) as { id?: string };
console.log("same-origin write →", sameSite.status);
if (created.id) {
  await fetch(`${BASE}/conversations/${created.id}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${token}` },
  });
}

const wrong: Array<{ status: number; elapsed: number }> = [];
for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
  const reply = await sign("definitely-wrong");
  wrong.push(reply);
  console.log(`attempt ${attempt} → ${reply.status} after ${reply.elapsed}ms ${reply.body.error?.message ?? ""}`);
}

/**
 * What `auth.ts` should have paused for, before network and process noise. The
 * pause is chosen from the failures already on the counter, so the nth attempt
 * is charged for the n-1 before it.
 */
const expected = (attempt: number) =>
  attempt - 1 <= FREE_ATTEMPTS ? 0 : Math.min(8_000, 500 * 2 ** (attempt - FREE_ATTEMPTS - 2));

check(
  "a wrong code is refused, not locked out",
  wrong.every((reply) => reply.status === 401),
  `statuses ${wrong.map((reply) => reply.status).join(", ")} — a 429 here would mean anyone can lock the owner out`,
);

const slow = wrong.slice(FREE_ATTEMPTS);
check(
  "the pause grows with each failure",
  slow.every((reply, index) => reply.elapsed >= (index ? slow[index - 1]!.elapsed * 0.9 : 0)),
  `${wrong.map((reply) => reply.elapsed).join("ms, ")}ms`,
);
check(
  "the pause reaches the curve the server promises",
  // 0.8 rather than 1.0: the clock here also covers the request itself.
  wrong.every((reply, index) => reply.elapsed >= expected(index + 1) * 0.8),
  `wanted about ${wrong.map((_, index) => expected(index + 1)).join("ms, ")}ms`,
);
const free = wrong.slice(0, FREE_ATTEMPTS + 1);
check(
  "the first few attempts cost nothing but the answer",
  free.every((reply) => reply.elapsed < 500),
  `${free.map((reply) => reply.elapsed).join("ms, ")}ms`,
);

const recovered = await sign(CODE);
check(
  "the owner can still sign in after the flood",
  recovered.status === 200 && Boolean(recovered.body.token),
  `${recovered.status} after ${recovered.elapsed}ms`,
);

console.log(failures ? `\n${failures} security check(s) failed` : "\nall security checks passed");
process.exit(failures ? 1 : 0);
