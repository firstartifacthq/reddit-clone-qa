/** @typedef {object} Statement
 * @property {(...parameters: any[]) => {changes: number}} run
 * @property {(...parameters: any[]) => any} get
 * @property {(...parameters: any[]) => any[]} all
 */
/** @typedef {{prepare: (sql: string) => Statement}} Database */

export class CommunityRepository {
  /** @param {Database} database */
  constructor(database) {
    this.insertCommunity = database.prepare("INSERT INTO communities (canonical_name, display_name, owner_user_id, created_at) VALUES (?, ?, ?, ?)");
    this.findCommunity = database.prepare("SELECT canonical_name, owner_user_id FROM communities WHERE canonical_name = ?");
    this.findRole = database.prepare("SELECT role FROM community_memberships WHERE community_name = ? AND user_id = ?");
    this.findActiveUser = database.prepare("SELECT id FROM users WHERE username = ? COLLATE NOCASE AND deletion_requested_at IS NULL");
    this.assignRole = database.prepare("UPDATE community_memberships SET role = ? WHERE community_name = ? AND user_id = ? AND role IN ('member', 'moderator')");
    this.join = database.prepare("INSERT INTO community_memberships (community_name, user_id, role) VALUES (?, ?, 'member') ON CONFLICT (community_name, user_id) DO NOTHING");
    this.leave = database.prepare("DELETE FROM community_memberships WHERE community_name = ? AND user_id = ? AND role IN ('member', 'moderator')");
    this.list = database.prepare("SELECT canonical_name FROM communities ORDER BY canonical_name");
  }

  /** @param {{canonicalName: string, displayName: string, ownerId: string, createdAt: number}} community */
  createCommunity(community) { this.insertCommunity.run(community.canonicalName, community.displayName, community.ownerId, community.createdAt); }

  /** @param {string} communityName */
  communityByName(communityName) { return /** @type {{canonical_name: string, owner_user_id: string} | undefined} */ (this.findCommunity.get(communityName)); }

  /** @param {string} communityName @param {string} userId */
  roleForUser(communityName, userId) { return /** @type {{role: "member" | "moderator" | "owner"} | undefined} */ (this.findRole.get(communityName, userId)); }

  /** @param {string} username */
  activeUserByUsername(username) { return /** @type {{id: string} | undefined} */ (this.findActiveUser.get(username)); }

  /** @param {string} communityName @param {string} userId @param {"member" | "moderator"} role */
  setNonOwnerRole(communityName, userId, role) { return this.assignRole.run(role, communityName, userId).changes; }

  /** @param {string} communityName @param {string} userId */
  joinUser(communityName, userId) { this.join.run(communityName, userId); }

  /** @param {string} communityName @param {string} userId */
  leaveUser(communityName, userId) { return this.leave.run(communityName, userId).changes; }

  listCommunityNames() { return this.list.all().map((row) => row.canonical_name); }
}
