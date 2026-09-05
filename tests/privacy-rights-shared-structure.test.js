import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../src/app.js";

async function signup(app, username) {
  const response = await app.inject({ method: "POST", path: "/api/auth/signup", payload: JSON.stringify({ username, password: "privacy-pass-123" }) });
  return { account: await response.json(), cookie: response.headers.get("set-cookie").split(";", 1)[0] };
}

test("AC-RC13-7B erasure preserves unrelated authority and navigable shared tombstone structure", async () => {
  const scheduled = [];
  const app = createApp({ databasePath: ":memory:", schedulePrivacyWork: (work) => scheduled.push(work) });
  const erased = await signup(app, "shared-owner");
  const moderator = await signup(app, "shared-moderator");
  const member = await signup(app, "shared-member");
  const db = app.database;
  db.prepare("INSERT INTO communities (canonical_name,display_name,owner_user_id,created_at) VALUES ('shared-community','Shared Community',?,1)").run(erased.account.id);
  db.prepare("INSERT INTO community_memberships (community_name,user_id,role) VALUES ('shared-community',?,'moderator')").run(moderator.account.id);
  db.prepare("INSERT INTO community_memberships (community_name,user_id,role) VALUES ('shared-community',?,'member')").run(member.account.id);
  db.prepare("INSERT INTO posts (id,community_name,author_user_id,type,title,text_content,published_at) VALUES ('erased-shared-post','shared-community',?,'text','private erased title','private erased body',1)").run(erased.account.id);
  db.prepare("INSERT INTO posts (id,community_name,author_user_id,type,title,text_content,published_at) VALUES ('other-shared-post','shared-community',?,'text','preserved title','preserved body',2)").run(moderator.account.id);
  db.prepare("INSERT INTO comments (id,post_id,parent_id,author_user_id,body,depth,state,created_sequence) VALUES ('erased-root','other-shared-post',NULL,?,'private root',0,'active',1)").run(erased.account.id);
  db.prepare("INSERT INTO comments (id,post_id,parent_id,author_user_id,body,depth,state,created_sequence) VALUES ('preserved-reply','other-shared-post','erased-root',?,'preserved reply',1,'active',2)").run(member.account.id);
  db.prepare("INSERT INTO post_votes (post_id,voter_user_id,value) VALUES ('other-shared-post',?,1)").run(erased.account.id);
  db.prepare("INSERT INTO post_votes (post_id,voter_user_id,value) VALUES ('erased-shared-post',?,-1)").run(member.account.id);

  const accepted = await app.inject({ method: "DELETE", path: "/api/me", headers: { cookie: erased.cookie } });
  assert.equal(accepted.statusCode, 202);
  scheduled.at(-1)();

  assert.deepEqual({ ...db.prepare("SELECT owner_user_id FROM communities WHERE canonical_name='shared-community'").get() }, { owner_user_id: "__privacy_tombstone__" });
  assert.deepEqual(db.prepare("SELECT user_id,role FROM community_memberships WHERE community_name='shared-community' ORDER BY role,user_id").all().map((row) => ({ ...row })), [
    { user_id: member.account.id, role: "member" },
    { user_id: moderator.account.id, role: "moderator" },
    { user_id: "__privacy_tombstone__", role: "owner" },
  ]);
  assert.deepEqual({ ...db.prepare("SELECT author_user_id,title,text_content FROM posts WHERE id='erased-shared-post'").get() }, { author_user_id: "__privacy_tombstone__", title: "[deleted]", text_content: "[deleted]" });
  assert.deepEqual({ ...db.prepare("SELECT author_user_id,body,state FROM comments WHERE id='erased-root'").get() }, { author_user_id: null, body: null, state: "deleted" });
  assert.deepEqual({ ...db.prepare("SELECT parent_id,author_user_id,body,state FROM comments WHERE id='preserved-reply'").get() }, { parent_id: "erased-root", author_user_id: member.account.id, body: "preserved reply", state: "active" });
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM post_votes WHERE post_id='other-shared-post'").get().count, 0, "erased votes stop contributing");
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM post_votes WHERE post_id='erased-shared-post' AND voter_user_id=?").get(member.account.id).count, 1, "unrelated votes survive");
  assert.equal(db.prepare("SELECT deletion_requested_at FROM users WHERE id='__privacy_tombstone__'").get().deletion_requested_at, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sessions WHERE user_id IN (?,?) AND revoked_at IS NULL").get(moderator.account.id, member.account.id).count, 2);

  const conversation = await app.inject({ method: "GET", path: "/api/posts/other-shared-post/comments?limit=10" });
  assert.equal(conversation.statusCode, 200);
  const comments = (await conversation.json()).comments;
  assert.deepEqual(comments.map((comment) => comment.id), ["erased-root", "preserved-reply"]);
  assert.equal(JSON.stringify(comments).includes("private root"), false);
  assert.ok(JSON.stringify(comments).includes("preserved reply"));
  const memberProfile = await app.inject({ method: "GET", path: "/api/users/shared-member" });
  assert.equal(memberProfile.statusCode, 200);
  const reservedSignup = await app.inject({ method: "POST", path: "/api/auth/signup", payload: JSON.stringify({ username: "__privacy_tombstone__", password: "privacy-pass-123" }) });
  assert.notEqual(reservedSignup.statusCode, 201);
  app.close();
});
