# Remote access

Luma is a single-owner server. The goal is to reach it from a phone on mobile
data without giving anyone else a way in, and without opening a port on the
home router.

## Shape of the deployment

```
iPhone ──HTTPS──▶ Cloudflare edge ──Access policy──▶ tunnel ──▶ 127.0.0.1:8090
                       (identity)                  (outbound only)
```

Three independent barriers, in the order an attacker meets them:

1. **Cloudflare Access** checks identity at the edge. A request without a valid
   Access session never reaches the machine at all.
2. **Luma's access code plus TOTP** authenticates the person, not the network.
   Compromising the Cloudflare account still leaves this.
3. **Device tokens** are per-device and revocable, so a lost phone costs one
   revocation rather than a credential rotation.

The tunnel makes only outbound connections, so there is no listening port to
find and no firewall rule to get wrong. Luma itself stays bound to `127.0.0.1`.

## How it runs here

`scripts/start.ps1` launches the connector alongside the server, so there is no
separate step. The binary and its config live in `runtime/cloudflared/`:

```yaml
tunnel: <tunnel-uuid>
credentials-file: <home>/.cloudflared/<tunnel-uuid>.json
ingress:
  - hostname: luma.example.com
    service: http://127.0.0.1:8090
  - service: http_status:404
```

The real hostname and tunnel id are deliberately not written down here. A
personal deployment's address is worth as much to an attacker as anything in
this document, and the repository is public.

The credentials file sits outside the repository on purpose — it is the tunnel's
private key. `runtime/` is git-ignored for the same reason.

Setting the tunnel up from scratch on a new machine:

```powershell
cloudflared tunnel login
cloudflared tunnel create luma
cloudflared tunnel route dns luma luma.example.com
```

To survive a reboot without anyone signing in, `cloudflared service install`
registers it as a Windows service; the one-click script covers the interactive
case instead.

## The Access policy

> **Not enabled on the author's deployment.** An unauthenticated request
> currently reaches Luma's own login page, so barrier 1 is missing and barrier 2
> is carrying the deployment on its own. Everything under "What the server
> enforces on its own" is written for exactly that case rather than on the
> assumption that Access is there. Add the policy below to get the layer back.

In the Cloudflare dashboard, under Zero Trust → Access → Applications, add a
self-hosted application for the hostname with a policy of **Allow · Emails ·
your address**. Pick a session duration you are comfortable re-authenticating
at; 30 days is reasonable for a personal device.

Add a second policy of **Bypass · Everyone** for the path `/v1/health` only if
you want uptime monitoring. Nothing else should bypass.

## Luma-side configuration

```powershell
$env:LUMA_TRUST_PROXY = "1"   # count rate limits against the real client IP
$env:LUMA_HOST = "127.0.0.1"  # never bind a public interface
```

`LUMA_TRUST_PROXY` is load-bearing and is **not set by `start.ps1` today**.
Behind a tunnel every request arrives from `127.0.0.1`, so without it Luma
cannot tell one client on the internet from another. Two things follow from
that, and both are handled rather than assumed:

- The per-address budget stops distinguishing anybody, so it is not allowed to
  lock. Attempts are slowed instead (below). Turning the flag on restores a real
  per-client budget and with it a per-client lockout.
- `X-Forwarded-Proto` is only believed from a declared proxy, so with the flag
  off the security screen reports 明文 HTTP even behind the tunnel and the
  session cookie is not marked `Secure`. That is the honest answer to "can this
  server prove it was reached over TLS", and it is another reason to set the flag.

With the flag on, Luma reads `CF-Connecting-IP`, then the first hop of
`X-Forwarded-For`, and only from a request that arrived over loopback — which
behind this tunnel is the only way in, because the listener is bound to
`127.0.0.1`. Nothing is read from a client-supplied header otherwise. `X-Real-IP`
is not read at all any more: it used to be the fallback on every request, which
handed an attacker a fresh rate-limit budget per request for the price of one
header.

Recovering the access code without restarting the server:

```powershell
powershell -File scripts\show-code.ps1
```

Then, in Settings → 安全:

1. Replace the generated access code with a long one — at least twelve
   characters. Keep the generated one if you have nowhere better to keep a
   passphrase; 80 random bits beats most things a person invents.
2. Enrol an authenticator app and confirm the code. Enrolment only takes effect
   after a generated code verifies, so a mis-scanned QR cannot lock you out.
3. Check that the page reports HTTPS. If it says 明文 HTTP, either the request did
   not come through the tunnel — in which case the access code travelled in clear
   text — or `LUMA_TRUST_PROXY` is unset, in which case the server has no way to
   tell the difference and says so.

Each of those is a change to a credential, so each asks for the access code again
before it applies. That is deliberate: a stolen session must not be able to
change what you would need to recover from it.

## What the server enforces on its own

Access is not enabled, so this is the whole of the defence today. It is written
around one rule: **nothing an attacker does may cost the owner a login.** A
control that fails that test is a denial of service with good intentions.

### Slowing guesses down instead of shutting the door

Failures are counted in a fifteen-minute window against two counters, and what
each counter is allowed to do differs:

- **The client's own counter.** Three failures are free. After that every answer
  is delayed, doubling from half a second to a ceiling of eight; at eight
  failures the counter closes for fifteen minutes — but only if the counter names
  a client that can actually be told apart from other clients, which needs
  `LUMA_TRUST_PROXY` and a proxy that sets `CF-Connecting-IP`. Without it every
  request shares one counter, so it slows attempts and never closes.
- **The shared counter.** Forty failures from anywhere are free, and after that
  every attempt from a client with no session is delayed on the same curve. It
  never closes, for anyone, ever.

An earlier version of this document claimed the global budget was "not a lever an
attacker can pull to lock the owner out". That was false: it locked
`loginLocked()` for everybody at forty failures, and because the per-address
identity came from a spoofable header, forty failures were free to produce. Both
halves of that are fixed above, and the shared counter must never be given a
lockout again — a pause is the control, not a door.

This is the shape the OWASP Authentication Cheat Sheet recommends over a plain
lockout, and the trusted/untrusted split is the one from OWASP's "Slow Down
Online Guessing Attacks with Device Cookies": lock a known client on its own,
never let an unknown one lock it. NIST SP 800-63B-4 §3.2.2 caps consecutive
failures at 100 and says the cap exists to balance guessing against "the
potential need for account recovery"; the delay curve is at its ceiling long
before that with the door still open.

A re-authentication on a route that already required a session — the step-up
below — is charged to that session's own counter instead of to the address. So a
flood from the network cannot spend a signed-in device's allowance, and a stolen
session cannot spend the login's. A success clears the counters it was charged
to, and never the shared one.

The two factors are counted separately, so wrong six-digit codes cannot use up
the access code's allowance or the reverse.

### The access code

A fresh install mints sixteen characters of Crockford base32 — 80 bits, in
groups of four, with no `I`, `L`, `O` or `U` to mistype. It used to be four
random bytes as hex, which is 32 bits: small enough to be worth guessing against
any limit loose enough to be usable. 80 bits is past the point where SP 800-63B-4
stops requiring a rate limit to hold a randomly generated secret at all, which
is what makes the throttling above a backstop rather than the only thing
standing there.

A replacement typed by the owner must be at least twelve characters. Longer is
better and a passphrase is fine; the pause curve does the rest.

### Sign-in tells you as little as possible

When an authenticator is enrolled and no code is sent, the answer is
`totp_required` — a prompt, not a failure, and it is decided before the access
code is looked at, so it says nothing about the code that came with it. It used
to be returned *after* the access code verified and without counting a failure,
which meant an attacker could confirm a guessed access code for free.

When both are sent, both are compared and one answer comes back for the pair:
`bad_credentials`, one message. Which half was wrong is exactly the thing worth
hiding, and the owner can see which fields they filled in.

### Codes are good once

A TOTP code that has been accepted is refused for the rest of its window, as
RFC 6238 §5.2 asks: the highest accepted step is remembered in the vault. So a
code read off the owner's screen, or captured from a phishing proxy, is already
spent. The accepted window stays at one step either side, which is the RFC's own
guidance and worth thirty seconds of clock drift, and the comparison walks the
whole window even after a match so the answer takes the same time either way.

The cost is that a code cannot be used twice within its own thirty seconds, so
enrolling and then signing in on a second device back to back means waiting for
the authenticator to roll over. That is the intended behaviour and the reason the
window is thirty seconds rather than an hour.

### Sessions renew, and still end

- **Idle window: 30 days.** Every authenticated request slides it. A device used
  weekly is never asked again.
- **Ceiling: 180 days from the sign-in that created the session**, whatever
  happens. The row's `expires_at` is that ceiling, so it is the store that
  enforces it.
- **Rotation: every 7 days.** The token is replaced in place, the old one stays
  good for sixty seconds so a request already in flight does not fail, and the
  session's ceiling is carried across unchanged. That is what bounds a token that
  leaked quietly to a week rather than to half a year.

Ninety fixed days used to be the whole policy, and it slid nothing: an actively
used device was signed out mid-sentence for no security gain. The numbers here
are borrowed rather than invented. Home Assistant sweeps a refresh token that has
gone 90 days unused and otherwise never expires one, which is the part it proves
is liveable — 30 days is taken instead of 90 because this login is on the open
internet. LibreChat gives a refresh token 7 days, too short to be a session here
but the right cadence for replacing a token in place.

Rotation is negotiated: it only happens for a client that sends
`X-Luma-Token-Rotation: 1`, and the replacement comes back in `X-Luma-Token`.
Handing a new token to a client that does not know to keep it would sign the
owner out, which is the failure this whole design is avoiding. A client that
never sends the header keeps its token to the ceiling. Rotation is also skipped
on an event stream, since nothing on the client side can read those headers.

### A stolen session is not a takeover

Rotating the access code, enrolling or disabling the second factor, and revoking
a device all require the access code again — and a current authenticator code
when one is enrolled — in `X-Luma-Access-Code` and `X-Luma-Totp`. A session
cookie on its own can read the security screen and change nothing on it.

Without that, one stolen cookie was permanent: set a new access code, turn the
second factor off, revoke the owner's devices, and the owner has nothing left to
sign in with. Revoking is on the list for the same reason — it is how someone
else would push the owner off their own server.

Failed confirmations are charged to that session's counter, which does close at
eight. Locking one session for fifteen minutes cannot keep the owner out: the
login path has its own counters and the owner holds the credentials.

### The rest

- The session cookie is `HttpOnly`, `SameSite=Strict`, and `Secure` when the
  connection is TLS. A cookie-authenticated write must also be same-origin by
  `Sec-Fetch-Site` or by `Origin`, and a cookie write that names neither is
  refused — a browser always sends one, and anything that is not a browser
  should be using the bearer token, which a cross-site page cannot attach.
- A bearer token is treated as the cookie's equal, not its poor relation: same
  idle window, same ceiling, same rotation offer, same step-up. A cross-site
  `Origin` is refused on it too; what it is allowed to do is name no origin at
  all, because a hostile page cannot attach the header in the first place. So the
  native client loses nothing by having no `SameSite` to rely on.
- Responses carry `nosniff`, `DENY` framing, a same-origin referrer policy, and
  a content security policy that keeps scripts, styles and connections on this
  origin. HSTS is sent when the request can be shown to have arrived over HTTPS.
- Changing the access code revokes every other device's session, so rotation
  after a suspected leak is one action rather than a cleanup.
- A session that has sat out its idle window is deleted when it is next seen or
  next listed, so the device list in Settings only offers sessions that exist.

## Alternatives considered

**Tailscale.** Strictly less exposed — nothing is published at all — but every
client needs the app installed and connected, which is friction on a phone you
hand to someone or a browser you do not control. Worth switching to if the
threat model tightens.

**Port forward plus Caddy.** Fewer moving parts conceptually, but it puts a
listening port on the home connection, makes the router part of the security
boundary, and leaves certificate renewal as something that can silently fail.

**Cloudflare Tunnel without Access.** Half the benefit, and what is running
today: the origin stays hidden, but the login page is exposed to the whole
internet, so the access code's 80 bits and the pause curve are the only things
standing between an attacker and a session. That is a defensible place to be —
it is not a comfortable one, and it is the reason the second factor is worth
enrolling even though nobody else knows the hostname.

**Passkeys as the primary factor.** The right end state for "secure but never
annoying", and unbuilt. A WebAuthn credential cannot be phished, cannot be
replayed, and on a phone it is a thumb rather than nineteen typed characters —
and enrolment is a one-time cost in a single-owner app. It needs a real origin
over TLS (the tunnel already gives one), a credential table, and an
`apple-app-site-association` file plus an Associated Domains entitlement before
the iOS client can share the browser's passkey. The access code and TOTP stay as
the recovery path, which is also what makes the change safe to attempt: if the
passkey path fails, nothing has been taken away.
