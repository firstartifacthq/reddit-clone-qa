# Reddit Clone QA

A local Node.js/SQLite Reddit-style application used for protocol and persistence exercises.

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
