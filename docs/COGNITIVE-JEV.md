# Cognitive Jev for governed MainSpot development

## Checkpoint

State: **VALIDATED_OFFLINE**. Live provider use of this development advisory is OFF.
No Telegram notification, Relay, framework reinstall or general migration is included.
The separate product Jev classifier (`JEV_MODE` disabled/shadow/primary, APR-0002) is
documented in README §5.1; it does not use this launcher, its credential file or its budget.

Framework reference: `5e3dc307a4089f462b9742b76fd002cf910102fa`.
The consumer checks its imported framework files against that reference before
review. Unrelated owner-lab schema changes in the local framework are not adopted.
Existing MainSpot canon, cards and registry are preserved. QS-0001..QS-0003 were
ingested and archived by RUN-0001 (`.canonflow/skill-runs/RUN-0001.skill-report.yaml`);
QS-0003 produced APR-0001, which cannot be exercised because its proposal had
already expired (see "Live decision status").

## Persistent HDC console

The console runs as the existing user service `mainspot-hdc.service`, not through
a globally installed `canonflow-hdc` command. Unit:
`/home/administrador/.config/systemd/user/mainspot-hdc.service`.

The unit is enabled for `default.target`; user lingering is already enabled
(`Linger=yes`), so the user manager can start it at boot without an open login.
`Restart=always` retries after 3 seconds. It uses the existing private Python
interpreter and the existing `canonflow_hdc.cli serve` module, without bootstrap,
package installation or framework/canon changes.

Open the pending session (QS-0004, follow-up of the RUN-0001 ingestion):

```sh
xdg-open 'https://mainspot.hdc.com/#/sessions/QS-0004'
```

Service operations:

```sh
systemctl --user status mainspot-hdc.service
systemctl --user start mainspot-hdc.service
systemctl --user restart mainspot-hdc.service
journalctl --user -u mainspot-hdc.service -n 50 --no-pager
```

Read-only recovery (HDC-0007): the pinned backend can stay in read-only mode
(`writes_enabled: false`, answers rejected with `503 WRITES_DISABLED`) after
`decision-state/index.json` or `latest.json` is rewritten while the service runs.
Writers that do this include `canonflow-hdc publish-session`, `rebuild-index` and
the HDC-0006 regeneration script. After any such write, and whenever the HTTPS UI
shows the read-only banner, run:

```sh
curl -s http://127.0.0.1:8765/api/v1/ready
systemctl --user restart mainspot-hdc.service   # only if writes_enabled is false
```

Text typed while read-only stays in that browser tab (`sessionStorage`). Reload
the same tab after the restart and send again.

The console binds only to `127.0.0.1:8765`. Its service environment explicitly
unsets TypeSafe/CJL/OpenRouter keys. Starting HDC does not activate Jev inference.
A controlled restart and the QS-0003 browser surface were verified; the machine
was not rebooted for verification. QS-0003 was later answered (ANS-0003) and
ingested as APR-0001.

### Local HTTPS via LXC webserver

`/etc/hosts` maps `mainspot.hdc.com` to `10.209.99.101` (LXC `webserver`).
The versioned vhost is `scripts/deploy/mainspot.hdc.com.conf`, installed as
`/etc/nginx/sites-available/mainspot.hdc.com.conf` and enabled inside that LXC.
The existing pricing-dashboard vhost provided the installation pattern.

Persistent LXD device `mainspot-hdc` uses `bind=container`:
container `127.0.0.1:8765` forwards to host `127.0.0.1:8765`. The HDC service
continues to bind only to host loopback. Nginx permits only host bridge address
`10.209.99.1` and loopback clients; HTTP redirects to HTTPS.

The self-signed certificate has the exact SAN `mainspot.hdc.com`, `CA:FALSE`
and serverAuth usage. Its private key remains inside the LXC with mode 0600.
Public certificate trust is installed in `/usr/local/share/ca-certificates/`
and the user's NSS database. Certificate expiry: `2029-01-22T11:04:59Z`.

Only the legitimate `https://mainspot.hdc.com` Origin is translated to the
upstream loopback Origin; other nonempty origins are refused. HDC's Host and
CSRF checks remain enabled, and `/_control/` is not proxied. No framework
code or canonical decisions were changed.

Verified: trusted TLS without insecure flags, readiness HTTP 200, browser
workspace, HTTP redirect, cross-origin 403, non-host client 403, missing-CSRF
403, and invalid-answer 422 after valid origin/CSRF/hash guards. The negative
submission checks created no answers or approval records; QS-0003 stayed PENDING.
Direct loopback access remains available at `http://127.0.0.1:8765/`.

Reload the vhost after an authorized config/certificate change:

```sh
lxc exec webserver -- nginx -t
lxc exec webserver -- systemctl reload nginx
```

### HDC UI: production redesign, validation, ordering and refresh recovery

The HTTPS vhost serves the complete HDC frontend from `scripts/deploy/hdc-ui/`
(installed as `/var/www/mainspot-hdc-ui/` in LXC `webserver`) through the
`location = /`, `^~ /css/` and `^~ /js/` blocks; `/api` still reaches the pinned
backend. This is a UI-only override: the CanonFlow package and backend contracts
remain unchanged and the consumer's framework pin check still passes against the
reference above. Direct loopback access retains the original UI; use the HTTPS URL.
`index.html` carries the backend's CSP and security headers; all assets are
served with `Cache-Control: no-cache`.

Every HDC change made for MainSpot is recorded for CanonFlow upstream in
`.canonflow-updates/` (index, per-change records, stacked patches against the
pin, retirement steps). `scripts/deploy/hdc-ui/` is byte-identical to the
HDC-0003 + HDC-0004 + HDC-0005 + HDC-0007 patch stack applied to the pinned
frontend (HDC-0007's backend fix is not deployable until the pin moves).

HDC-0005 is the production UI/UX redesign within the §11 visual contract (dark
header, light cards, seal palette, risk chips, navigation rail): design tokens
with WCAG AA text contrast, overview with human needs first, an inbox with
search and filters, history and decision-record detail pages, a traceability
graph, and a workspace with progress, question navigation, option cards,
inline validation with focus on the first error, and a mobile layout.
axe-core reported 0 WCAG 2.2 AA violations across the audited views
(see `.canonflow-updates/HDC-0005-rediseno-ui-produccion.md`).

The override clears obsolete field errors on edit/new submission, shows the
current backend validation details, and includes an unchanged displayed order
only after the human explicitly checks its confirmation. Recommendations are
never selected automatically; only matching human drafts are restored. Required
questions, comments, authorship, CSRF and hash binding remain enforced.

For the reported QS-0001 payload, pure offline validation accepts Q-LIMITS and
reports missing Q-APPROVALS, Q-NFR and Q-PRIORITY. The previous Q-LIMITS message
could persist in the old UI even after its comment had been corrected.

Verified with real Chromium and the existing Python backend in an isolated
temporary synthetic project: missing-comment rejection; stale-error clearing;
visible missing-question diagnostics; and successful canonical ANS publication
with a nonblank override comment and explicitly confirmed, unmoved order.
The original validation checks posted no real MainSpot answers. QS-0001 was
PENDING at that checkpoint and was subsequently already ANSWERED when refresh
recovery was inspected. No human answer was submitted or rewritten by this work.
Trusted HTTPS serves the exact patch-stack bytes with `Cache-Control: no-cache`;
SHA-256 values are recorded in the checkpoint and in HDC-0005.

Refresh recovery:

- PENDING sessions restore saved choices, comments, free text, risk fields,
  priority order and its explicit confirmation only for the exact QS content
  hash. Comment-only drafts are preserved even before an option is selected.
- Each edit immediately creates a tab-local `sessionStorage` backup under
  `hdc-pending-draft:QS-xxxx`, before the 600 ms debounced server save. The backup
  is removed after acknowledgement or successful explicit submission. It is not
  encrypted storage or an approval record; never enter API keys in HDC.
- A refresh during an interrupted save reply reconciles an identical committed
  server draft. New edits during a save remain dirty and are saved afterwards.
  Existing ETag checks retain conflicting local edits without overwriting the
  other tab's server draft.
- Drafts from another question version remain visible as review-only text and
  are not applied to current controls.
- The author's name is restored, but the identity checkbox is always unchecked
  after refresh. Sending remains an explicit human action.
- ANSWERED, INGESTED and ARCHIVED sessions display the canonical answers in
  disabled controls only when their submission binds the current question hash.
  They do not start draft autosave or reopen the session.

Exercised with real Chromium and the existing Python backend in isolated
synthetic projects: all eight question types, comment-only recovery, refresh
before any server draft exists, interrupted acknowledgement, editing during a
slow save, stale-source isolation, multi-tab conflict, explicit submission and
no draft recreation afterwards. Refresh of the submitted fixture also retained
its saved values/comments in read-only controls.

On MainSpot's actual HTTPS QS-0001, refresh displayed all 9 stored values and 5
stored comments correctly in read-only mode. The canonical answer SHA-256
remained unchanged across refresh; no real answer POST was made. A normal or
hard refresh now reloads the saved state rather than requiring manual re-entry.

Reinstall the local override after container recovery:

```sh
lxc exec webserver -- install -d -m 0755 -o root -g root /var/www/mainspot-hdc-ui
tar -C scripts/deploy/hdc-ui --owner=0 --group=0 -cf - . | lxc exec webserver -- tar -C /var/www/mainspot-hdc-ui --no-same-owner -xf -
lxc exec webserver -- sh -c 'find /var/www/mainspot-hdc-ui -type d -exec chmod 0755 {} +; find /var/www/mainspot-hdc-ui -type f -exec chmod 0644 {} +'
lxc file push scripts/deploy/mainspot.hdc.com.conf webserver/etc/nginx/sites-available/mainspot.hdc.com.conf --uid 0 --gid 0 --mode 0644
lxc exec webserver -- nginx -t
lxc exec webserver -- systemctl reload nginx
```

On an authorized framework upgrade, reconcile the nine frontend files against
the new upstream frontend before retaining them. Rollback removes the vhost's
`/`, `/css/` and `/js/` locations and reloads Nginx, restoring the pinned UI.



## Exact credential installation

New private installation directory:
`/home/administrador/.config/mainspot/cognitive-jev/` (0700).

Credential file:
`/home/administrador/.config/mainspot/cognitive-jev/typesafe-api-key` (0600).
It contains only the key, not a shell program or dotenv assignments. It has NOT
been created with a placeholder. An existing `mainspot-secrets.env` is not read
or altered.

From an interactive local terminal in this repository:

```sh
python3 -B scripts/canonflow-jev.py set-key
python3 -B scripts/canonflow-jev.py status
```

`set-key` prompts without echo and refuses noninteractive entry, existing files,
unsafe directories and invalid values. Do not put the value in shell arguments,
chat, HDC answers, prompts or documentation. `status` checks only presence, owner
and permissions; it does not print or read the value.

Only an explicitly authorized `review-live` process reads the file and populates
`TYPESAFE_API_KEY` for the existing Cognitive Jev adapter and its bounded worker.
It is not exported to a shell, systemd service, MainSpot API or HDC server. Normal
same-user/root filesystem privileges still apply; these modes are not per-process
OS isolation. There is no background inference service.

CJL experimental uses `JEV_API_KEY`. This consumer does not import or enable CJL;
it removes inherited `JEV_API_KEY`, `OPENROUTER_API_KEY` and `TYPESAFE_API_KEY` and
loads only the prescribed private credential for an authorized live invocation.

## Installed process and dependencies

Private interpreter:
`/home/administrador/.local/share/mainspot/cognitive-jev/venv/bin/python`.

The launcher automatically re-execs review commands with this interpreter in
isolated Python mode. Dependencies were installed with hash verification from
`scripts/canonflow-jev-requirements.lock`, copied from the existing HDC lock.
The CanonFlow package itself was not reinstalled, and no HDC server was started.

## Connection and actual review point

```sh
python3 -B scripts/canonflow-jev.py review-offline
```

The fixed input is `.canonflow/cognitive/synthetic-p0/input.json`:

- consumer: existing `cognitive_loops.review`;
- loop/stage: `functional_canon_loop` / `functional_review`;
- local bound artifacts: MainSpot functional state, source register and DR-0001;
- question: synthetic wording change that preserves human approval of visible edits;
- axes: E (material difference), C (bounded causal mechanism), X (exposure/preservation).

The small verifier carriers under `synthetic-p0/` are explicitly synthetic test
fixtures, NOT approved MainSpot canon or human decisions. Their VERIFIED label
exists only to exercise the existing deterministic verifier contract. No actual
MainSpot canonical obligation is promoted or replaced.

Authority and transition carriers are removed from provider state by the existing
slice. No customer content, PII, secrets or complete private documents are allowed.
A new dataset or changed manifest requires a newly bound approval.

Default `.canonflow/cognitive/config.yaml` remains disabled with zero budget.
`live-candidate.yaml` is PROPOSED ONLY and is not automatically consumed by the
framework. The launcher permits it only after validating an ingested HDC APR/DEC
bound to `.canonflow/state/cognitive-jev-activation-proposal.json`, all source/input
hashes, and the proposal expiry. It never changes framework contracts.

## Live decision status

QS-0003 (`.canonflow/decision-sessions/archived/QS-0003.questions.json`) was answered
`approve` by Carlos Pinacho at `2026-10-21T18:23:36Z` and ingested as APR-0001, bound
to the exact proposal hash below. The proposal's `valid_until` is
`2026-10-21T10:31:40.759930+00:00`, earlier than the approval, so
`review-live --approval APR-0001` passes the HDC authority and binding checks and
then stops with `ACTIVATION_EXPIRED`, before reading the credential
(`.canonflow/skill-runs/RUN-0001/evidence/EV-0004-launcher-apr-0001.txt`).
A live call requires a renewed proposal with fresh hashes and a new hash-bound
session (Recovery step 5); APR-0001's authority is not reused.

The expired proposal was byte-bound in that session. It proposed:

- endpoint `https://api.typesafe.ai/v1/systemone`;
- pinned model `jev-1.13.0`, not a moving alias;
- one synthetic request, no retry, total HTTP deadline 10 seconds;
- local admission budget USD 0.001;
- conservative local reservation USD 0.000731136;
- request/response bounds 16384/8192 bytes;
- accounting input/output allowances 17408/9216 tokens;
- expiry `2026-10-21T10:31:40.759930+00:00`.

Public price observed: USD 0.042 per million input tokens; output free.
`typesafe-models-observed-2026-10-20-jev-1.13.0` is a LOCAL observation identifier,
not an invented vendor price version. The public API specification says 0.2.0.
TypeSafe's model/alias pages have moving-alias inconsistencies; this connection
requires the explicit 1.13.0 response and refuses model mismatch.

The ledger limits admission using local conservative estimates and observed cost.
It is NOT a provider-enforced token ceiling or guaranteed invoice cap. No credit
purchase, auto-top-up or account change is authorized. Standard data handling is
assumed for the synthetic sample only; no ZDR agreement is assumed.

A renewed proposal follows the same rule: after the owner approves in HDC and the
answer is legitimately ingested, use `review-live --approval` with the resulting
APR/DEC ID. Merely answering, creating a key, editing YAML or repeating the command
does not authorize a request. APR-0001 is the only record created so far and it
is bound to the expired proposal.

The live ledger will be `out/cognitive/provider/jev-budget.sqlite3`. Never delete
or reset it to obtain another attempt; failures and interrupted calls consume the
reservation. A separate budget requires a separate human decision.

## Exercised verification

Successful cases across the runs:

| Suite | Cases |
|---|---:|
| Existing `check_cognitive_jev.py` | 49 |
| Existing `check_cognitive_slice.py` | 32 |
| Existing `check_cognitive_loops.py` | 4 |
| MainSpot `check-canonflow-jev.py` | 9 |

The first attempts exposed missing portalocker and Flask in the chosen Python
environments. Dependencies were installed in the private environment from the
existing hash lock; only the failed cases were repeated, not all passing cases.
No claim is made that all suites were rerun as one clean invocation.

Coverage includes missing credential; OFF/data policy rejection before dispatch;
exhausted budget; atomic durable reservations, failures and restarts; invalid
responses/model mismatch; safe errors; credential echo rejection; payload hash
changes; incomplete manifest; expired/uningested HDC authority; restrictive
credential permissions; and noninteractive key entry rejection.

Observed default review:
`30d3225d-066f-4444-8506-5c660af071fb`, deterministic PASS, cognitive OFF,
REQUEST_HDC because no RAR/SSR exists. This is not provider verification.

Observed explicit offline HTTP-fixture integration:
`4afcdb6d-9f51-4344-b3ac-4ac1b5a4e47e`, deterministic PASS, cognitive EVALUATED,
REQUEST_HDC, advisory_only=true, authorization=null, execution=NONE.
Receipt: `out/cognitive/offline-transport/OFFLINE-ONLY-receipt.json`.
Its transport was mocked, network requests were zero, and its separate ledger
contains fixture pricing. It is NEVER evidence of a live TypeSafe call.

Actual CLI smoke `review-live --approval APR-9999` returned
HDC_AUTHORIZATION_REQUIRED, exit 2, before credential use/provider dispatch.

## Recovery

1. Read `.canonflow/cognitive/checkpoint.json`, SRP-0001 and APR-0001.
2. Keep the default config OFF; do not load a project `.env` or enable CJL.
3. Provision the key locally using `set-key`; check presence using `status`.
4. Do not synthesize human records or accept a stale proposal (APR-0001 is bound to an expired one).
5. If the proposal expires or bound artifacts change, prepare a new hash-bound
   question; never rewrite the published session or reuse its authority.
6. With a valid ingested approval, run the one-shot live review and observe both
   provider metadata and the concrete loop-review handoff. Only then may the
   checkpoint become LIVE_ADVISORY_VERIFIED.

Sources: https://docs.typesafe.ai/models,
https://docs.typesafe.ai/api/system-one,
https://docs.typesafe.ai/legal.
