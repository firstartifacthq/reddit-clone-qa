import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../src/app.js";

async function signup(app, username) {
  const response = await app.inject({ method: "POST", path: "/api/auth/signup", payload: JSON.stringify({ username, password: "privacy-pass-123" }) });
  return { account: await response.json(), cookie: response.headers.get("set-cookie").split(";", 1)[0] };
}

function seedEveryExportCategory(db, owner, other) {
  db.prepare("UPDATE users SET bio='export-account-canary' WHERE id=?").run(owner);
  db.prepare("INSERT INTO communities (canonical_name,display_name,owner_user_id,created_at) VALUES ('export-community','Export Community',?,1)").run(owner);
  db.prepare("INSERT INTO posts (id,community_name,author_user_id,type,title,media_filename,media_content_type,media_bytes,published_at) VALUES ('export-media-post','export-community',?,'media','export-post-canary','export.bin','image/png',?,1)").run(owner, Buffer.from([0, 1, 2, 253, 254, 255]));
  db.prepare("INSERT INTO posts (id,community_name,author_user_id,type,title,text_content,published_at) VALUES ('foreign-post','export-community',?,'text','foreign-title-canary','foreign-body-canary',2)").run(other);
  db.prepare("INSERT INTO post_idempotency (author_user_id,community_name,idempotency_key,body_digest,post_id,response_json) VALUES (?,'export-community','export-request-canary','digest-canary','export-media-post','{\"requestCanary\":true}')").run(owner);
  db.prepare("INSERT INTO comments (id,post_id,parent_id,author_user_id,body,depth,state,created_sequence) VALUES ('export-comment-canary','foreign-post',NULL,?,'export-comment-body',0,'active',1)").run(owner);
  db.prepare("INSERT INTO post_votes (post_id,voter_user_id,value) VALUES ('foreign-post',?,1)").run(owner);
  db.prepare("INSERT INTO reports (id,occurrence_sequence,post_id,community_name,reporter_user_id,reported_at) VALUES ('export-report-canary',1,'foreign-post','export-community',?,1)").run(owner);
  db.prepare("INSERT INTO saved_posts (user_id,post_id,saved_at) VALUES (?,'foreign-post',11)").run(owner);
  db.prepare("INSERT INTO post_history (user_id,post_id,viewed_at) VALUES (?,'foreign-post',12)").run(owner);
  db.prepare("INSERT INTO user_preferences (user_id,theme,compact_mode) VALUES (?,'dark',1)").run(owner);
  db.prepare("INSERT INTO personal_traversals (id,user_id,listing_kind,snapshot_key,created_at,expires_at) VALUES ('export-personal-traversal',?,'saved',?,1,100)").run(owner, "a".repeat(64));
  db.exec("INSERT INTO personal_traversal_items (traversal_id,ordinal,post_id,event_at) VALUES ('export-personal-traversal',0,'foreign-post',11); INSERT INTO personal_page_tokens (token,traversal_id,start_ordinal) VALUES ('export-personal-token','export-personal-traversal',0)");
  db.prepare("INSERT INTO feed_traversals (id,feed_kind,requester_user_id,created_at,expires_at) VALUES ('export-feed-traversal','home',?,1,100)").run(owner);
  db.exec("INSERT INTO feed_traversal_items (traversal_id,ordinal,post_id) VALUES ('export-feed-traversal',0,'foreign-post'); INSERT INTO feed_page_tokens (token,traversal_id,start_ordinal) VALUES ('export-feed-token','export-feed-traversal',0)");
  db.prepare("INSERT INTO notification_events (id,event_key,occurrence_sequence,recipient_user_id,kind,related_item_type,related_item_id,occurred_at) VALUES ('export-notification-event','export-notification-key',1,?,'vote','post','foreign-post',1)").run(owner);
  db.prepare("INSERT INTO notifications (id,event_id,owner_user_id,read_state) VALUES ('export-notification','export-notification-event',?,1)").run(owner);
  db.prepare("INSERT INTO notification_traversals (id,owner_user_id,snapshot_key,created_at,expires_at) VALUES ('export-notification-traversal',?,?,1,100)").run(owner, "b".repeat(64));
  db.exec("INSERT INTO notification_traversal_items (traversal_id,ordinal,notification_id) VALUES ('export-notification-traversal',0,'export-notification'); INSERT INTO notification_page_tokens (token,traversal_id,start_ordinal) VALUES ('export-notification-token','export-notification-traversal',0)");
  db.prepare("INSERT INTO user_blocks (blocker_user_id,blocked_user_id,created_at) VALUES (?,?,1)").run(owner, other);
  db.prepare("INSERT INTO post_creation_events (id,user_id,post_id,created_at) VALUES ('export-rate-canary',?,'export-media-post',1)").run(owner);
  db.prepare("INSERT INTO moderation_audit_events (id,occurrence_sequence,post_id,community_name,moderator_user_id,action,occurred_at) VALUES ('export-moderation-canary',1,'foreign-post','export-community',?,'removed',1)").run(owner);
  db.prepare("INSERT INTO moderation_queue_traversals (id,requester_user_id,authority_digest,created_at,expires_at) VALUES ('export-moderation-traversal',?,?,1,100)").run(owner, "c".repeat(64));
  db.exec("INSERT INTO moderation_queue_items (traversal_id,ordinal,report_id) VALUES ('export-moderation-traversal',0,'export-report-canary'); INSERT INTO moderation_queue_tokens (token,traversal_id,start_ordinal) VALUES ('export-moderation-token','export-moderation-traversal',0)");
  db.prepare("INSERT INTO privacy_jobs (id,operation,subject_user_id,subject_key,created_at) VALUES ('export-prior-job','export',?,?,0)").run(owner, owner);
  db.prepare("INSERT INTO privacy_job_events (id,job_id,occurrence_sequence,operation,action,occurred_at) VALUES ('export-prior-accepted','export-prior-job',1,'export','accepted',0)").run();
  db.prepare("INSERT INTO privacy_job_events (id,job_id,occurrence_sequence,operation,action,occurred_at) VALUES ('export-prior-completed','export-prior-job',2,'export','completed',1)").run();
  db.prepare("INSERT INTO privacy_export_payloads (job_id,payload_json) VALUES ('export-prior-job','{\"priorCanary\":true}')").run();
  db.prepare("INSERT INTO privacy_audit_traversals (id,administrator_user_id,maximum_sequence,created_at,expires_at) VALUES ('export-audit-traversal',?,2,1,100)").run(owner);
  db.exec("INSERT INTO privacy_audit_tokens (token,traversal_id,next_sequence) VALUES ('export-audit-token','export-audit-traversal',1)");
}

test("AC-RC13-1A exhaustive snapshot is complete, immutable, credential-free, and owner scoped", async () => {
  const tasks = [];
  const app = createApp({ databasePath: ":memory:", schedulePrivacyWork: (task) => tasks.push(task) });
  const owner = await signup(app, "export-owner");
  const foreign = await signup(app, "export-foreign");
  seedEveryExportCategory(app.database, owner.account.id, foreign.account.id);

  const accepted = await app.inject({ method: "POST", path: "/api/me/export", headers: { cookie: owner.cookie } });
  assert.equal(accepted.statusCode, 202);
  const job = await accepted.json();
  app.database.prepare("UPDATE users SET bio='post-acceptance-canary' WHERE id=?").run(owner.account.id);
  app.database.prepare("INSERT INTO comments (id,post_id,parent_id,author_user_id,body,depth,state,created_sequence) VALUES ('post-acceptance-comment','foreign-post',NULL,?,'too late',0,'active',2)").run(owner.account.id);
  tasks.at(-1)();

  const first = await app.inject({ method: "GET", path: `/api/me/export/jobs/${job.jobId}/result`, headers: { cookie: owner.cookie } });
  const second = await app.inject({ method: "GET", path: `/api/me/export/jobs/${job.jobId}/result`, headers: { cookie: owner.cookie } });
  assert.equal(first.statusCode, 200);
  const firstText = await first.text();
  assert.equal(await second.text(), firstText, "completed snapshot replay is byte stable");
  const snapshot = JSON.parse(firstText);
  const expectedCategories = ["sessionFacts","memberships","communities","posts","postRequests","comments","votes","reports","saved","history","preferences","personalTraversals","personalTraversalItems","personalPageTokens","feedTraversals","feedTraversalItems","feedPageTokens","notifications","notificationEvents","notificationTraversals","notificationTraversalItems","notificationPageTokens","blocks","rateFacts","moderation","moderationTraversals","moderationTraversalItems","moderationPageTokens","rightsJobs","rightsEvents","auditTraversals","auditTokens"];
  assert.deepEqual(Object.keys(snapshot.data).sort(), expectedCategories.sort());
  for (const category of expectedCategories) assert.ok(snapshot.data[category].length > 0, `${category} must be represented by the exhaustive fixture`);
  assert.equal(snapshot.account.bio, "export-account-canary");
  assert.equal(snapshot.data.posts[0].media_bytes, Buffer.from([0, 1, 2, 253, 254, 255]).toString("base64"));
  const serialized = JSON.stringify(snapshot);
  for (const canary of ["export-request-canary","export-comment-canary","export-report-canary","export-personal-traversal","export-feed-traversal","export-notification-event","export-rate-canary","export-moderation-canary","export-prior-job","export-audit-token"]) assert.ok(serialized.includes(canary), `missing ${canary}`);
  for (const prohibited of ["password_verifier","password_salt","token_digest","privacy-pass-123","foreign-title-canary","foreign-body-canary","post-acceptance-canary","post-acceptance-comment"]) assert.equal(serialized.includes(prohibited), false, `must not export ${prohibited}`);
  const crossOwner = await app.inject({ method: "GET", path: `/api/me/export/jobs/${job.jobId}/result`, headers: { cookie: foreign.cookie } });
  assert.equal(crossOwner.statusCode, 404);
  app.close();
});
