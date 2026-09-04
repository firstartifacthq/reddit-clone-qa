# Reddit clone QA

A local, server-rendered authentication, community, post, comment, and vote slice for the RC-06 campaign. It uses Node 24's built-in SQLite support and opaque, server-side session records; no production secret is read or required.

## Run locally

```sh
npm ci
npm start
```

Optional non-secret configuration is captured when the application starts:

- `PORT` (default `3000`)
- `DATABASE_PATH` (default `./reddit.sqlite`)
- `SESSION_LIFETIME_MS` (default one hour)
- `SESSION_COOKIE_NAME` (default `reddit_session`)
- `NODE_ENV=production` enables the cookie `Secure` attribute

## HTTP surface

- `POST /api/auth/signup`
- `POST /api/auth/login`
- `POST /api/auth/logout`
- `GET`, `PATCH`, and `DELETE /api/me`
- `GET`, `PATCH /api/me/preferences`
- `GET /api/me/saved`
- `GET /api/me/history`
- `GET /api/me/notifications?limit=:limit&cursor=:cursor`
- `PATCH`, `DELETE /api/me/notifications/:id`
- `GET /api/users/:username/notifications`
- `PUT`, `DELETE /api/posts/:id/save`
- `GET /api/users/:username`
- `GET /api/communities`
- `GET /api/search?q=:query[&type=community|post|comment]`
- `POST /api/communities`
- `POST /api/communities/:canonicalName/members`
- `DELETE /api/communities/:canonicalName/members/me`
- `PATCH /api/communities/:canonicalName/moderators`
- `GET /api/communities/:canonicalName/modlog`
- `GET /api/mod/queue?limit=:limit&cursor=:cursor`
- `DELETE /api/mod/posts/:id`
- `POST /api/mod/posts/:id/restore`
- `POST /api/posts/:id/reports`
- `POST /api/communities/:canonicalName/posts`
- `GET`, `PATCH`, and `DELETE /api/posts/:id`
- `GET`, `PUT`, and `DELETE /api/posts/:id/vote`
- `GET /api/posts/:id/media`
- `POST`, `GET /api/posts/:id/comments`
- `GET`, `PATCH`, and `DELETE /api/comments/:id`
- `GET /`

Authentication requests accept JSON with `username` and `password`. Successful signup and login return only an account's `id` and `username`; the opaque session is delivered solely in an `HttpOnly` cookie.

`GET /api/me` and successful `PATCH /api/me` return the owner profile: `id`, `username`, `bio`, and integer `revision`. Public lookups return only `id`, `username`, and `bio`. Usernames use ASCII-only surrounding-whitespace trimming, must be 3 through 32 ASCII letters, digits, underscores, or hyphens, and are unique without regard to ASCII case. Bios contain up to 500 Unicode code points; an empty string clears a bio.

A successful `DELETE /api/me` marks the account deletion-requested and revokes every session atomically. The account can no longer log in, authorize requests, or appear through public lookup, while its username remains reserved. Physical erasure and reactivation are intentionally out of scope.

Authenticated active users can create a community with a 3 through 21 character ASCII letter, digit, or underscore name. Names are ASCII-trimmed and case-folded for uniqueness. Creation makes the creator the immutable owner; joining is idempotent, non-owners can leave, and only the owner can promote or demote an existing active member. The public list contains canonical community names in deterministic order.

Current members can publish JSON text, HTTP(S) link, or image media posts. Media uploads use canonical base64 in the JSON request and are stored with their metadata in the local SQLite database; media reads return the accepted bytes with their declared image content type. Post creation accepts an optional `Idempotency-Key` for safe retries. Only the author can edit declared-form fields or delete a post.

Authenticated active users can set or replace their own vote as JSON `{ "value": 1 }` or `{ "value": -1 }` on another active author's unlocked post, inspect their current vote, or clear it. Vote score and author karma are derived from current durable votes; no vote ledger or aggregate override route is exposed.

Active community members can add JSON comments to a readable post, either top-level or with a same-post `parentId`. Conversations are depth-first pre-order pages; `limit` defaults to 25 and accepts 1 through 100. Returned cursors are opaque, resumable snapshots, so later comments do not enter an existing traversal. Comment authors may edit active comments or replace them with privacy-preserving tombstones while descendants retain their original nesting.

Authenticated active users can save a readable post and retrieve their saved posts or 90-day post-view history through owner-scoped, opaque paginated snapshots. A successful authenticated non-media post read records the latest view for that user and post. Preferences default to `{ "theme": "system", "compactMode": false }`; preference patches update only supplied valid fields atomically. Other users' saved and history routes always deny without revealing private records.

Notifications are private to their active owner. Eligible replies, standalone case-insensitive `u/username` mentions, effective votes on another user's post, and moderator removal of another user's post create one durable notice. Inbox pages are newest-event-first and use owner-bound opaque snapshots; owners can toggle `{ "read": true|false }` and terminally delete a notice. The delivery retry operation is available only through the application’s trusted in-process adapter and never accepts user-controlled authorization or a production secret.

`GET /api/search` accepts exactly one non-empty, trimmed `q` and an optional `type` of `community`, `post`, or `comment`. It returns `{ "results": [] }` or deterministic communities, posts, and active comments using type-specific fields. Invalid search input returns HTTP 400 `{ "error": "Invalid search" }`; a transient search read failure returns HTTP 503 `{ "error": "Search unavailable" }` with `Retry-After: 1`. Search reads canonical current state and does not record post-view history or create other user state.

`GET /api/feed/home`, `GET /api/feed/popular`, and `GET /api/communities/:canonicalName/feed` return `{ "posts": [...], "nextCursor": string | null }`. Home requires an active session and scopes posts to current memberships; Popular and a community feed include only currently readable canonical posts. Home and community feeds order by publication time descending, score descending, then post ID ascending. Popular orders by score descending, publication time descending, then post ID ascending. `limit` defaults to 25 and accepts canonical values from 1 through 100. Cursors are opaque, expire after 24 hours, and retain their issued order while fresh reads use current memberships and votes. Invalid pages return HTTP 422 `{ "error": "Invalid feed page" }`; transient feed reads return HTTP 503 `{ "error": "Feed unavailable" }` with `Retry-After: 1`.

Active members may report a currently readable post in a community they have joined. A member can create only one durable report for each post. Current community owners and moderators can read their responsible reports through opaque, deterministic queue cursors, remove a reported or unreported post, and restore a removed post. Removal hides the post from ordinary post, media, feed, search, comment, personal, and vote surfaces without deleting it; restoration exposes the original post again. Each successful state transition appends an immutable ordered entry to that community's modlog. Audit rewrite requests are rejected with HTTP 405.

Run `npm run typecheck`, `npm test`, and `npm run build` before submitting changes.
