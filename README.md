# Reddit Clone QA

A local Node.js/SQLite Reddit-style application used for protocol and persistence exercises.

## Reliability and accessibility (RC-14)

Run `npm start` with a retained `DATABASE_PATH` and a local `PORT` (defaults:
`./reddit.sqlite`, 3000). The listening runtime retries initialization independently;
listening alone is not readiness. Keep the database and its parent directory writable.
The application keeps SQLite's synchronous durability and secure deletion enabled.
Schema version 13 adds only an identity-constrained, non-user capability singleton.

`GET /health/ready` returns 200 with `{"status":"ready"}` only after initialization
and a fresh independent durable-capability sample; initializing, inaccessible or
non-writable storage returns 503 with `{"status":"not-ready"}`. The monitor checks
retained file identity, canonical reads and a real committed operational-row update.
A query can await the next scheduled sample, but never starts monitoring, migrations,
worker delivery or repair. It cannot recreate a missing retained database.
`POST /health/ready` returns 405 (`Allow: GET`) before body buffering or authentication.
`GET /debug/restart` returns 404 for every caller, including administrators. Operational
responses contain fixed public information, no cookies, paths or diagnostics.

Recovery belongs to the local process owner, not an HTTP control. SIGTERM closes owned
work; after graceful or abrupt restart, existing durable privacy checkpoints resume.
Transient worker reads or writes leave accepted jobs pending for autonomous retry after
storage returns. Accepted is not completed, and a lost response alone does not prove
rollback. Existing idempotency, authority, deletion and expiry rules still apply.

Developer verification (Node 24):

```sh
npm test
npm run typecheck
npm run build
node tools/rc14-load.js
```

`npm test` includes real isolated loopback HTTP, SQLite faults and subprocess restart
checks and mandatory rendered-browser journeys. It is not the sustained performance
qualification. The separate load command accepts no duration, population or target
argument: it creates 100 distinct authenticated users with alpha-only, beta-only,
both and empty eligibility before one uninterrupted 300-second closed-loop interval.
Every complete response is compared with the user's exact expected content. All issued
requests, including failures and outstanding requests, contribute to the failure rate
and nearest-rank p95. Equality at 1 percent or 750 ms fails. Its JSON report identifies
the candidate digest, interval, per-user counts, complete population and both results.
Fixtures own temporary stores, dynamic loopback ports and teardown, never production data.

Final local qualification on 2026-09-06 at 19:43:55 UTC used Node 24.19.0 and
candidate digest `ed63c77f36922b255723a981f9dad48763c75c29762bf8954a14ce3ca42af799`.
Across 100 users and the full 300000ms issue interval, all 4,122,246 issued requests
settled successfully: failure rate 0, nearest-rank p95 11.964591ms, outstanding 0.
Both strict thresholds passed on that same population. The complete developer command
`npm test && npm run typecheck && npm run build && node tools/rc14-load.js` passed,
including all 300 tests. These local receipts do not replace later Factory qualification.

Browser checks require the sealed image
`sha256:507836265d75817d6463538211a832318994ad5753198866693bd0537b819325`,
Playwright 1.63.0 at `/usr/local/lib/node_modules/playwright` and matched Chromium
153.0.8010.12 revision 1243 under `/opt/software-factory/playwright-browsers`.
`FACTORY_PLAYWRIGHT_MODULE_PATH` and `PLAYWRIGHT_BROWSERS_PATH`, if provided, must
identify those exact locations. Missing or mismatched artifacts fail rather than skip;
do not install or use a fallback browser. Infrastructure launch checks are not product
acceptance. `node --test tests/rc14-browser.test.js` drives keyboard signup, sign-in,
sign-out, existing navigation, rejected and interrupted authentication, actual session
checks, forward/backward traversal and focus geometry. It observes 320, 768 and 1280
CSS-pixel widths with normal and 200-percent root text, reapplied after every navigation.
Masked screenshots are retained in `.crabbox/evidence/rc14-browser/`.

Root-text scaling and browser accessibility-tree assertions are automated evidence,
not observations of actual browser zoom or screen-reader speech. Supplemental local
checks must use the exact matched headed browser, its native zoom controls, and only
operator-verified native assistive-technology facilities. On the candidate, traverse
anonymous and signed-in landmarks and controls, reject credentials, observe the dynamic
failure announcement, correct the attempt, and verify keyboard reachability at 200-percent
native zoom. Record the actual facility, method and observed output separately from
DOM assertions; an unavailable facility is an unresolved observation, not a passing check.

The 2026-09-06 candidate observation used Orca 50.2, AT-SPI2 2.60.6,
Speech Dispatcher 0.12.1 and PulseAudio 17.0 with the matched headed Chromium.
Native X11 focus and keyboard input (not CDP keyboard events) traversed the real
anonymous and signed-in controls. Orca spoke their labels, form/navigation context,
and the complete failed-sign-in message before focus moved from the submit button.
Correcting credentials produced an authenticated `/api/me` response; logout and replay
of the revoked cookie both produced 401. Feedback uses a persistent atomic alert:
the tested Orca version classified `role="status"` text changes as unannounced status-bar
updates, so a DOM-only live-region assertion was insufficient.

A second native observation used the browser's own zoom shortcuts to reach 200 percent
(device scale 2, 640 CSS-pixel viewport, unchanged 16px root text). The rejection,
correction and logout journey retained visible, unobscured control focus, fitting
controls, no overlap and no page-level horizontal overflow through reloads. Native
speech, recorded audio, screenshots, focus observations and session results are in
`.crabbox/evidence/rc14-native-at-1mljbe/`; the candidate-bound `report.json` records
both announcement timing and actual zoom separately from the automated text checks.
These are candidate observations, not the operator's infrastructure smoke results.
The diagnostic uses private short XDG runtime paths to respect Unix socket path limits,
then retains its artifacts under the evidence directory and stops only owned processes.

## Privacy rights (RC-13)

Authenticated owners may request an export with `POST /api/me/export`, inspect it at
`GET /api/me/export/jobs/{jobId}`, and retrieve a completed result at
`GET /api/me/export/jobs/{jobId}/result`. Exports are durable acceptance-time snapshots
of owner-scoped exportable data; they exclude passwords, password-verification material,
session credentials and privileged security material.

`DELETE /api/me` accepts an owner deletion job and immediately revokes all sessions.
It also revokes all exports and their local snapshot payloads. Rights jobs progress
asynchronously and resume after restart. There is deliberately no customer cancellation,
reactivation, expiry, legal-hold, external-backup erasure, or managed deployment surface.

Site operators can supply a comma-separated `ADMINISTRATOR_IDS` list of stable account
IDs at process startup (or use the application-factory authority seam in local tests).
There is no HTTP authority-grant endpoint; community ownership, moderation, profile
fields, headers, and request bodies cannot grant site administration. Current trusted
administrators may use `POST /api/admin/users/delete` with `{ "userId": "..." }`,
read `GET /api/admin/users/delete/{jobId}`, and traverse append-only privacy history at
`GET /api/admin/audit?limit=1`. Audit events are immutable and privacy-safe; audit
mutation attempts such as `DELETE /api/admin/audit/{eventId}` return 405.

Completed deletion removes local recoverable identity, credentials, owner content and
snapshots, retaining only non-identifying audit and shared-structure tombstone evidence.
Downloaded copies and backup systems outside this checkout are not application-controlled
artifacts.
