import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createApp } from "../src/app.js";

async function signup(app, username, password = "privacy-pass-123") {
  const response = await app.inject({ method: "POST", path: "/api/auth/signup", payload: JSON.stringify({ username, password }) });
  return { account: await response.json(), cookie: response.headers.get("set-cookie").split(";", 1)[0] };
}

function seedErasureCategories(db, owner, other) {
  db.prepare("UPDATE users SET bio='ERASE_BIO_CANARY' WHERE id=?").run(owner);
  db.prepare("INSERT INTO communities (canonical_name,display_name,owner_user_id,created_at) VALUES ('erase-community','ERASE_COMMUNITY_CANARY',?,1)").run(owner);
  db.prepare("INSERT INTO posts (id,community_name,author_user_id,type,title,media_filename,media_content_type,media_bytes,published_at) VALUES ('erase-post','erase-community',?,'media','ERASE_TITLE_CANARY','ERASE_FILE_CANARY','image/png',?,1)").run(owner, Buffer.from("ERASE_MEDIA_CANARY"));
  db.prepare("INSERT INTO posts (id,community_name,author_user_id,type,title,text_content,published_at) VALUES ('preserved-post','erase-community',?,'text','PRESERVED_TITLE','PRESERVED_BODY',2)").run(other);
  db.prepare("INSERT INTO post_idempotency (author_user_id,community_name,idempotency_key,body_digest,post_id,response_json) VALUES (?,'erase-community','ERASE_REQUEST_CANARY','ERASE_DIGEST_CANARY','erase-post','{\"value\":\"ERASE_RESPONSE_CANARY\"}')").run(owner);
  db.prepare("INSERT INTO comments (id,post_id,parent_id,author_user_id,body,depth,state,created_sequence) VALUES ('erase-comment','preserved-post',NULL,?,'ERASE_COMMENT_CANARY',0,'active',1)").run(owner);
  db.prepare("INSERT INTO post_votes (post_id,voter_user_id,value) VALUES ('preserved-post',?,1)").run(owner);
  db.prepare("INSERT INTO reports (id,occurrence_sequence,post_id,community_name,reporter_user_id,reported_at) VALUES ('erase-report',1,'preserved-post','erase-community',?,1)").run(owner);
  db.prepare("INSERT INTO saved_posts (user_id,post_id,saved_at) VALUES (?,'preserved-post',1)").run(owner);
  db.prepare("INSERT INTO post_history (user_id,post_id,viewed_at) VALUES (?,'preserved-post',1)").run(owner);
  db.prepare("INSERT INTO user_preferences (user_id,theme,compact_mode) VALUES (?,'dark',1)").run(owner);
  db.prepare("INSERT INTO personal_traversals (id,user_id,listing_kind,snapshot_key,created_at,expires_at) VALUES ('erase-personal',?,'saved',?,1,100)").run(owner, "d".repeat(64));
  db.exec("INSERT INTO personal_traversal_items VALUES ('erase-personal',0,'preserved-post',1); INSERT INTO personal_page_tokens VALUES ('erase-personal-token','erase-personal',0)");
  db.prepare("INSERT INTO feed_traversals (id,feed_kind,requester_user_id,created_at,expires_at) VALUES ('erase-feed','home',?,1,100)").run(owner);
  db.exec("INSERT INTO feed_traversal_items VALUES ('erase-feed',0,'preserved-post'); INSERT INTO feed_page_tokens VALUES ('erase-feed-token','erase-feed',0)");
  db.prepare("INSERT INTO notification_events (id,event_key,occurrence_sequence,recipient_user_id,kind,related_item_type,related_item_id,occurred_at) VALUES ('erase-notification-event','ERASE_EVENT_KEY_CANARY',1,?,'vote','post','preserved-post',1)").run(owner);
  db.prepare("INSERT INTO notifications (id,event_id,owner_user_id,read_state) VALUES ('erase-notification','erase-notification-event',?,1)").run(owner);
  db.prepare("INSERT INTO notification_traversals (id,owner_user_id,snapshot_key,created_at,expires_at) VALUES ('erase-notification-traversal',?,?,1,100)").run(owner, "e".repeat(64));
  db.exec("INSERT INTO notification_traversal_items VALUES ('erase-notification-traversal',0,'erase-notification'); INSERT INTO notification_page_tokens VALUES ('erase-notification-token','erase-notification-traversal',0)");
  db.prepare("INSERT INTO user_blocks (blocker_user_id,blocked_user_id,created_at) VALUES (?,?,1)").run(owner, other);
  db.prepare("INSERT INTO post_creation_events (id,user_id,post_id,created_at) VALUES ('erase-rate',?,'erase-post',1)").run(owner);
  db.prepare("INSERT INTO moderation_audit_events (id,occurrence_sequence,post_id,community_name,moderator_user_id,action,occurred_at) VALUES ('erase-moderation',1,'preserved-post','erase-community',?,'removed',1)").run(owner);
  db.prepare("INSERT INTO moderation_queue_traversals (id,requester_user_id,authority_digest,created_at,expires_at) VALUES ('erase-moderation-traversal',?,?,1,100)").run(owner, "f".repeat(64));
  db.exec("INSERT INTO moderation_queue_items VALUES ('erase-moderation-traversal',0,'erase-report'); INSERT INTO moderation_queue_tokens VALUES ('erase-moderation-token','erase-moderation-traversal',0)");
}

function assertNoRetainedValue(database, value) {
  for (const { name: table } of database.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()) {
    for (const { name: column } of database.prepare("SELECT name FROM pragma_table_info(?)").all(table)) {
      const quotedTable = `"${table.replaceAll('"', '""')}"`;
      const quotedColumn = `"${column.replaceAll('"', '""')}"`;
      assert.equal(database.prepare(`SELECT 1 FROM ${quotedTable} WHERE instr(CAST(${quotedColumn} AS TEXT), ?) > 0 LIMIT 1`).get(value), undefined, `${table}.${column} retained ${value}`);
    }
  }
}

test("AC-RC13-7A exhaustive deletion revokes exports and removes SQL and raw-artifact canaries", async () => {
  const directory = await mkdtemp(join(tmpdir(), "reddit-privacy-erasure-"));
  const databasePath = join(directory, "privacy.sqlite");
  const scheduled = [];
  try {
    const app = createApp({ databasePath, schedulePrivacyWork: (work) => scheduled.push(work), administratorAuthority: (account) => account.username === "erase-admin" });
    const admin = await signup(app, "erase-admin");
    const owner = await signup(app, "erase-username-canary", "ERASE_PASSWORD_CANARY");
    const other = await signup(app, "preserved-user");
    seedErasureCategories(app.database, owner.account.id, other.account.id);

    const exportAcceptance = await app.inject({ method: "POST", path: "/api/me/export", headers: { cookie: owner.cookie } });
    const exportJob = await exportAcceptance.json();
    scheduled.at(-1)();
    assert.equal((await app.inject({ method: "GET", path: `/api/me/export/jobs/${exportJob.jobId}/result`, headers: { cookie: owner.cookie } })).statusCode, 200);

    const deletionAcceptance = await app.inject({ method: "DELETE", path: "/api/me", headers: { cookie: owner.cookie } });
    assert.equal(deletionAcceptance.statusCode, 202);
    const deletionJob = await deletionAcceptance.json();
    assert.equal(app.database.prepare("SELECT COUNT(*) AS count FROM privacy_export_payloads WHERE job_id=?").get(exportJob.jobId).count, 0, "snapshot is erased at deletion acceptance");
    assert.deepEqual(app.database.prepare("SELECT action FROM privacy_job_events WHERE job_id=? ORDER BY occurrence_sequence").all(exportJob.jobId).map((row) => row.action), ["accepted", "completed", "revoked"]);
    assert.deepEqual(app.database.prepare("SELECT action FROM privacy_job_events WHERE job_id=? ORDER BY occurrence_sequence").all(deletionJob.jobId).map((row) => row.action), ["accepted"]);
    scheduled.at(-1)();

    const status = await app.inject({ method: "GET", path: `/api/admin/users/delete/${deletionJob.jobId}`, headers: { cookie: admin.cookie } });
    assert.deepEqual(await status.json(), { jobId: deletionJob.jobId, operation: "deletion", state: "completed" });
    assert.deepEqual(app.database.prepare("SELECT action FROM privacy_job_events WHERE job_id=? ORDER BY occurrence_sequence").all(deletionJob.jobId).map((row) => row.action), ["accepted", "completed"]);
    assert.equal((await app.inject({ method: "GET", path: `/api/me/export/jobs/${exportJob.jobId}/result`, headers: { cookie: owner.cookie } })).statusCode, 401);
    assert.equal((await app.inject({ method: "GET", path: "/api/users/ERASE_USERNAME_CANARY" })).statusCode, 404);
    assert.equal(app.database.prepare("SELECT username FROM users WHERE id=?").get(other.account.id).username, "preserved-user");
    assert.equal(app.database.prepare("SELECT title FROM posts WHERE id='preserved-post'").get().title, "PRESERVED_TITLE");
    assert.equal(app.database.prepare("PRAGMA foreign_key_check").all().length, 0);
    assert.equal(app.database.prepare("PRAGMA integrity_check").get().integrity_check, "ok");

    const forbidden = [owner.account.id, "ERASE_USERNAME_CANARY", "ERASE_BIO_CANARY", "ERASE_TITLE_CANARY", "ERASE_FILE_CANARY", "ERASE_MEDIA_CANARY", "ERASE_REQUEST_CANARY", "ERASE_DIGEST_CANARY", "ERASE_RESPONSE_CANARY", "ERASE_COMMENT_CANARY"];
    for (const value of forbidden) assertNoRetainedValue(app.database, value);
    app.close();

    for (const filename of await readdir(directory)) {
      const raw = (await readFile(join(directory, filename))).toString("latin1");
      for (const value of forbidden) assert.equal(raw.includes(value), false, `${filename} retained raw ${value}`);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
