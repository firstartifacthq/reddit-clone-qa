# RC-15 implementation evidence

## Status and candidate

This is the implementation handoff for the bounded RC-15 repair attempt, not an
acceptance receipt. Independent Factory behavioral, security, maintainability and
qualification gates remain pending. A blocking or unobserved required gate prevents
RC-15 acceptance; neither this document nor a local passing suite clears that gate.

- Baseline: `af62617ae47d2fccd94dcdb8ba3154ec4a06fbf7`.
- Tested working candidate digest: `3e79b2fc5a6910af9d77f601aa09720e94af38ea5fe172804e7131c1023a0386`.
- Digest method: `candidateDigest()` in `tools/rc14-load.js` hashes the sorted
  source, migrations, tools, tests and package manifests. Documentation and ignored
  observation artifacts are outside that executable-candidate digest.
- Runtime: Node `v24.19.0`, incumbent ESM/built-in SQLite; no application dependency,
  migration, permission, customer interface or technology-strategy replacement.
- Evidence below was produced in this execution on isolated local fixtures and
  retained storage. No commit, deployment, live-user fault or external-backup action.

Paths prefixed `E/` below resolve to `.crabbox/evidence/rc15/` in the retained execution
lease. These ignored local artifacts must accompany independent review; repository
paths alone are reproducible checks, not claims that a later reviewer ran them.

## Reproduced repairs

`E/initial-regressions.log` records three discriminating failures against the original
source. `E/repair-check.log` records the repaired boundary tests plus affected privacy,
post and safety regressions (21 passed). The final suite reruns all three repairs.

| Defect | Before | Repair and preserved compatibility |
| --- | --- | --- |
| Privacy audit traversal ignored its stored expiry | Continuation at exactly 24 hours returned 200 rather than 422 | Pass the injected clock from `src/privacy/privacy-service.js` into `src/privacy/privacy-repository.js`; require `expires_at > now`. Rejection rolls back without state change. No migration or comment TTL. |
| Keyed post creation replay disclosed a moderator-removed payload | Cached creation response returned 201 rather than 404 | `src/post/post-repository.js` returns the retained post identity; `src/post/post-service.js` checks current readability before returning cached content; `src/app.js` maps the safe not-found result. Active retries and permitted restored-target retries retain their original identity. |
| Media route bypassed the directional block on protected direct reads | Blocked authenticated actor received media bytes with 200 rather than 404 | Propagate the current requester through `src/app.js` and the post service; filter media with the existing author-to-actor block table in the repository. No history is created by refusal; unrelated and established anonymous reads are preserved. |

No existing test was deleted, skipped or weakened. No constant-success acceptance,
restart, diagnostic or delivery endpoint was added. Test-only trusted seams hold jobs,
configure clocks/authority, inject precommit faults and drop already committed HTTP
responses. Ordinary HTTP requests exercise the resulting public behavior.

## Local final checks

| Command / observation | Measured result | Receipt |
| --- | --- | --- |
| Baseline `npm test` | 300 passed, zero skipped | `E/baseline.log` (baseline only) |
| Final `npm test` | 317 passed, 0 failed/cancelled/skipped/todo; 51,140.658 ms | `E/final-suite.log` |
| `npm run typecheck` | Exit 0; incumbent license and dependency `url.parse()` warnings retained, not security clearance | `E/typecheck.log` |
| `npm run build` | Exit 0 | `E/build.log` |
| `node tools/rc14-load.js` | Fixed 100 users / 300,000 ms; passed strict thresholds | `E/load.json`, `E/load.stderr` |
| Matched rendered browser | Required 320/768/1280 CSS widths, normal/200% root text, authentication interruption/rejection/correction, navigation and logout passed within final suite | `tests/rc14-browser.test.js`, `.crabbox/evidence/rc14-browser/` |
| Separate native AT and browser zoom | Both native-input rejection/correction/logout journeys completed; speech delivery timing inspected separately | `E/native-final.log`, `E/native/report.json`, `E/native/delivery-review.json` |

The sustained load began `2026-09-08T11:39:50.276Z`. There were 4,264,342 issued,
4,264,342 successful, zero failed and zero outstanding requests after settlement;
settlement ended at elapsed 300,017.338516 ms. Every one of the 100 per-user counts
is positive. Eligibility includes first-community-only, second-community-only, both
and empty users, with complete response content checked by the incumbent harness.
The latency population is all 4,264,342 issued requests. Failure rate is
`0 / 4264342 = 0`, strictly below 0.01; nearest-rank p95 at
`ceil(0.95 * 4264342) = 4051125` is `11.076144999999087 ms`, strictly below 750 ms.
The unchanged measurement tests cover incorrect successful responses, failed/slow
outcomes, population validity and equality rejection. This is local load evidence,
not independently issued Factory performance acceptance.

## Native observation detail

The successful run started `2026-09-08T12:06:48.140Z` and finished at
`12:08:47.611Z`, bound to the same digest. It used the provisioned matched
Playwright 1.63.0 / Chromium 153.0.8010.12 revision 1243, Orca 50.2, AT-SPI2 2.60.6,
Speech Dispatcher 0.12.1 and PulseAudio 17.0. The image identity and matched module
and browser-cache paths are in `E/native/report.json`.

`E/native-run.sh` and `E/native-observe.mjs` retain the local observation method.
Headed Chromium received native X11 focus and keyboard input, not CDP keyboard
substitution. Orca logged control labels including Username, Passphrase, Sign in,
Create account and Log out. Its output contained the complete dynamic failure:

> Unable to sign in. Check your username and passphrase, then try again.

| Journey | Orca full-message output | Speech Dispatcher Pulse playback END | Submit focus still retained through |
| --- | --- | --- | --- |
| Normal | 12:07:15.525135 | 12:07:21.851135 | 12:07:28.630 |
| Native 200% zoom | 12:08:14.895319 | 12:08:21.220175 | 12:08:28.014 |

`E/native/orca.log` records the full utterance; `E/native/speech-dispatcher.log`
records the selected installed `espeak-ng` module, the complete marked utterance,
last-word markers, actual Pulse writes and playback completion before focus leaves
submission. `E/native/speech.wav` contains 5,456,262 stereo 44.1 kHz 16-bit frames,
with 5,356,868 nonzero samples. `delivery-review.json` retains extracted log lines
and measured audio properties. This is native runtime speech-delivery evidence,
not a DOM announcement assertion or a claimed human listening/transcription session.
Raw audio is retained for independent review.

Actual browser zoom used five native zoom-in shortcuts: device pixel ratio 2,
636 CSS-pixel inner width and unchanged 16px root font. This is separate from the
rendered suite's root-text scaling. Native Tab/Shift-Tab reached the form and
navigation controls with visible 3px focus outlines and successful hit tests;
geometry checks retained no overlap or page-level horizontal overflow. The native
helper allows one CSS pixel for integer viewport/scroll rounding (observed bottom
454.453125 against integer inner height 454); it does not change the incumbent
rendered gate. Normal and zoomed correction both yielded `/api/me` 200; logout and
replay of each revoked session yielded 401. Screenshots are
`E/native/{normal,zoom200}-{rejection,authenticated}.png`.

Setup failures are retained, not passed observations: default D-Bus socket creation
outside the permitted runtime failed; the operator restored the same execution lease
handle without replacing the candidate. Explicit short per-session socket paths under
`/tmp/software-factory`, the provisioned AT-SPI service directory and explicit installed
Speech Dispatcher configuration resolved native service discovery. A duplicate nav
selector and then subpixel rounding caused observation-helper failures; these were
corrected only in ignored local observation scripts. `E/native-setup-first.log` and
`E/native-setup-{second,third,fourth}/` preserve failed runs. No fallback facility was
installed, no filesystem authority broadened and no unperformed run marked passed.

## Feature inventory to supporting evidence

All listed `tests/` checks ran in the final 317-test suite. Connected fixtures in
`tools/rc15-ledger.js` use four distinct accounts and two communities, independent
expected payloads/identities and a ledger observed again after reopen and process loss.
The older tests remain valuable fresh regression evidence, not historical acceptance.

| Inventory | Feature-specific checks under `tests/` | Connected checks |
| --- | --- | --- |
| RC-01 Authentication/session shell | `auth-flow.test.js`, `rc14-browser.test.js` | `rc15-journey`, `rc15-boundaries`, native run |
| RC-02 Profiles/account lifecycle | `profile-flow.test.js`, `profile-migration.test.js` | `rc15-journey`, `rc15-lifecycle` |
| RC-03 Communities/membership/roles | `community-flow.test.js`, `community-migration.test.js` | `rc15-lifecycle`, `rc15-consistency` |
| RC-04 Text/link/media posts | `post-flow.test.js`, `post-migration.test.js` | `rc15-journey`, `rc15-boundaries`, `rc15-lifecycle` |
| RC-05 Comments/replies | `comment-flow.test.js`, `comment-migration.test.js` | `rc15-journey`, `rc15-pagination`, `rc15-lifecycle` |
| RC-06 Votes/score/karma | `vote-flow.test.js`, `vote-migration.test.js` | `rc15-journey`, `rc15-consistency`, `rc15-lifecycle` |
| RC-07 Feeds | `feed-flow.test.js`, `feed-migration.test.js` | `rc15-journey`, `rc15-pagination`, sustained load |
| RC-08 Literal typed search | `search-flow.test.js` | `rc15-journey`, `rc15-recovery` |
| RC-09 Reporting/moderation/audit | `moderation-flow.test.js`, `moderation-migration.test.js` | `rc15-lifecycle`, `rc15-consistency`, `rc15-pagination` |
| RC-10 Safety/rates/blocks | `safety-controls-flow.test.js`, `safety-controls-migration.test.js` | `rc15-boundaries` |
| RC-11 Notifications | `notification-flow.test.js`, `notification-migration.test.js` | `rc15-journey`, `rc15-consistency`, `rc15-pagination` |
| RC-12 Personal state | `personal-state-flow.test.js`, `personal-state-migration.test.js` | `rc15-journey`, `rc15-boundaries`, `rc15-pagination` |
| RC-13 Administration/export/erasure | `privacy-rights-*.test.js` | `rc15-lifecycle`, `rc15-consistency`, `rc15-boundaries` |
| RC-14 Accessibility/performance/readiness/recovery | `rc14-*.test.js` | `rc15-recovery`, final load and native observations |

Connected check names in the tables abbreviate `tests/<name>.test.js`.

## Criterion evidence map

These rows map unchanged criterion IDs to local success, boundary, invalid-input,
permission, transition, recovery and prohibited-effect checks as applicable. They do
not assert exhaustive independent coverage: every row still requires independent
Factory evaluation on the final candidate. Supplementary feature tests fill boundaries
that the connected tests do not repeat, including schema damage, deeper comment
ordering, role matrices and durable privacy phases.

| Criterion | Local evidence and relevant boundary |
| --- | --- |
| AC-RC15-1 | `rc15-journey`, `tools/rc15-ledger.js`: same profile/account, memberships, three post types, replies, score/karma, typed search, report target, notification references, saves/history/preferences and unrelated controls across reopen. |
| AC-RC15-2 | `rc15-pagination`: all seven families, defaults, sizes 1/100, initial ordered inventory, replay, insert/rerank, restart and exact 24-hour boundaries; `rc15-boundaries`: audit expiry and invalid grammar with full-state comparison; `rc15-lifecycle`: removed payload and demoted cursor; existing feed/comment/moderation/personal/notification/privacy-audit tests retain tie, depth and authority checks. |
| AC-RC15-2A | `E/load.json` and `rc14-measurement.test.js`: complete caller-correct population and strict thresholds, as measured above. |
| AC-RC15-2B | `rc15-consistency`: overlapping joins/saves/reports and current-vote operations, legal serial-order oracle and notification retries; existing community/vote process workers preserve cross-connection coverage. |
| AC-RC15-3 | `rc15-boundaries`: malformed paging on nine routes, wrong parents/preferences/content/export override and removed keyed retry, full business-table equality on refusal; existing validators/flow tests preserve fixed errors and valid recovery. |
| AC-RC15-3A | `rc15-boundaries`: inclusive configured posting limit/window, executable content/unsafe schemes, blocked direct/media reads without history and unrelated access. |
| AC-RC15-4 | `rc15-lifecycle`: scoped role/moderation and foreign exports; `privacy-rights-authorization.test.js` and existing feature flows: independent administration, forged authority, author/private ownership and current authority on resumed pages. |
| AC-RC15-4A | `rc15-boundaries`: retained credentials across Home, posting, personal state and rights before/at/after expiry and logout; active fresh sign-in/unrelated session controls; `rc15-lifecycle`: deletion restriction. |
| AC-RC15-5 | `rc15-lifecycle` and repaired keyed replay: populated removal, direct/media/comments/private/retained reads, refused mutations, one ordered event and unrelated content. Notifications retain only established event references, never removed payload. |
| AC-RC15-5A | `rc15-lifecycle`, `moderation-flow.test.js`: same-identity restoration, removal/restoration event order, stable dependencies and repeated transitions; deleted content cannot restore. |
| AC-RC15-5B | `rc15-lifecycle`, `community-flow.test.js`: single scoped membership role changes, stable repetition, denied owner/nonmember/inactive reassignment and no site authority. |
| AC-RC15-5C | `rc15-lifecycle`: queue token issued before demotion loses authority; mutation denial preserves state, membership survives; existing moderation flow supplements scope checks. |
| AC-RC15-5D | `rc15-lifecycle`, `community-flow.test.js`, `feed-flow.test.js`: leave/rejoin does not resurrect moderation or remove ownership; fresh Home changes while established retained-public-candidate behavior is preserved. |
| AC-RC15-5E | `rc15-lifecycle`, `privacy-rights-export.test.js`: pending export identity, acceptance-time snapshot, cross-feature categories and exclusion of secrets/foreign private data. |
| AC-RC15-5F | `rc15-lifecycle`, `privacy-rights-flow.test.js`, `privacy-rights-export.test.js`: original completed snapshot, repeated owner reads, foreign denial, delayed work and distinct later export. |
| AC-RC15-5G | `rc15-lifecycle`, `rc15-consistency`, `privacy-rights-deletion.test.js`: coupled restriction/session/export revocation, owner/admin acceptance and surviving administrator reconciliation. |
| AC-RC15-5H | `rc15-lifecycle`, `privacy-rights-erasure.test.js`, `privacy-rights-shared-structure.test.js`: local artifact canaries, completed erasure, non-authenticating ownership tombstone, attached surviving replies and unrelated authority. |
| AC-RC15-5I | `rc15-lifecycle`, `privacy-rights-transitions.test.js`, `privacy-rights-recovery.test.js`: duplicate/reordered durable work, terminal revocation/erasure, immutable events and unsupported reverse transitions. |
| AC-RC15-5J | `rc15-lifecycle`, `post-flow.test.js`, `comment-flow.test.js`: deleted saved/voted post loses private visibility and contribution; body/author-free comment ancestor preserves surviving reply. |
| AC-RC15-6 | `rc15-recovery`: connected ledger through SIGTERM/SIGKILL and retained-path/write recovery; `rc14-recovery.test.js`, `rc14-storage.test.js`, `privacy-rights-recovery.test.js`: autonomous jobs, durable phases, terminal work and no empty replacement store. |
| AC-RC15-6A | `rc15-consistency`: full business-state rollback for comment/vote delivery, moderation audit/delivery, preferences and privacy acceptance; valid retries commit complete effects. |
| AC-RC15-6B | `rc15-consistency`: transport drops responses only after successful application commitment; keyed post/vote/removal/export retry and administrator deletion reconciliation preserve identities and revoked credentials. |
| AC-RC15-6C | `rc15-recovery`, `rc14-health.test.js`, `rc14-storage.test.js`: readiness is observation-only; recovery without health polling, safe unavailable states and unsupported process-control requests. |
| AC-RC15-7 | This candidate-bound matrix, final local receipts and retained regressions support handoff only. Independent behavioral/security/maintainability/qualification outcomes are pending; no RC-15 acceptance or campaign closure is claimed. |
| AC-RC15-7A | Source diff contains three scoped repairs only; 300 incumbent tests preserved and 17 checks added. Ordinary interfaces, independent fixture data and real retained receipts; failed setup attempts and test-assumption corrections are not presented as passes. |
| AC-RC15-7B | Fresh `rc14-browser.test.js` within final suite plus separate candidate-bound native AT/audio/zoom evidence detailed above; session outcomes are actual HTTP observations, not geometry substitutes. |

## Investigation corrections and remaining authority

Some development failures were incorrect test assumptions, not product defects:
notification contracts contain reference metadata rather than payloads; SQLite rows
have null prototypes; community names use underscores rather than hyphens; clearing
a vote returns 204; configured sessions have a 1000 ms minimum. Clock phases in the
pagination test were made monotonic to avoid deleting a traversal in one forward
phase and then expecting it to reappear after moving time backwards. Corresponding
logs (`E/lifecycle-recovery.log`, `E/consistency.log`, `E/boundary-paging.log` and
later passing targeted/final logs) retain the investigation history. No public
assertion was removed to accommodate these corrections.

The five modified source files retain existing ownership/module boundaries and
transactions. The two new fixture modules separate HTTP/process mechanics from
independent participation data; six new test files organize composition boundaries.
Existing package manifests, migrations, load accounting and rendered gate remain
unchanged. Missing historical license metadata is not resolved by this scoped change.
Independent reviewers must still assess behavioral completeness, security and
maintainability and issue their own candidate-bound findings. Any new candidate code
change invalidates affected receipts and requires appropriate reruns before acceptance.
