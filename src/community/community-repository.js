/**
 * @typedef {object} Statement
 * @property {(...parameters: any[]) => {changes?: number}} run
 * @property {(...parameters: any[]) => unknown} get
 * @property {(...parameters: any[]) => unknown[]} all
 */

/**
 * @typedef {object} Database
 * @property {(sql: string) => Statement} prepare
 */

export class CommunityRepository {
  /** @param {Database} database */
  constructor(database) {
    this.insertCommunity = database.prepare("INSERT INTO communities (name) VALUES (?) ON CONFLICT(name) DO NOTHING");
    this.findCommunityStatement = database.prepare("SELECT name FROM communities WHERE name = ?");
    this.insertMembership = database.prepare(`INSERT INTO memberships (community_name, user_id, role)
      VALUES (?, ?, 'member') ON CONFLICT(community_name, user_id) DO NOTHING`);
    this.insertOwnerMembership = database.prepare("INSERT INTO memberships (community_name, user_id, role) VALUES (?, ?, 'owner')");
    this.findMembershipStatement = database.prepare(`SELECT users.username, memberships.role
      FROM memberships JOIN users ON users.id = memberships.user_id
      WHERE memberships.community_name = ? AND memberships.user_id = ?`);
    this.findMembershipByUsernameStatement = database.prepare(`SELECT users.id, users.username, memberships.role
      FROM memberships JOIN users ON users.id = memberships.user_id
      WHERE memberships.community_name = ? AND users.username = ?`);
    this.updateRoleStatement = database.prepare(`UPDATE memberships SET role = ?
      WHERE community_name = ? AND user_id = ? AND role <> 'owner'`);
    this.deleteNonOwnerMembershipStatement = database.prepare(`DELETE FROM memberships
      WHERE community_name = ? AND user_id = ? AND role <> 'owner'`);
    this.publicCommunitiesStatement = database.prepare("SELECT name FROM communities ORDER BY name");
  }

  /** @param {string} name */
  createCommunity(name) {
    return this.insertCommunity.run(name).changes === 1;
  }

  /** @param {string} name */
  findCommunity(name) {
    return /** @type {{name: string} | undefined} */ (this.findCommunityStatement.get(name));
  }

  /** @param {string} communityName @param {string} userId */
  createOwnerMembership(communityName, userId) {
    this.insertOwnerMembership.run(communityName, userId);
  }

  /** @param {string} communityName @param {string} userId */
  joinMembership(communityName, userId) {
    this.insertMembership.run(communityName, userId);
  }

  /** @param {string} communityName @param {string} userId */
  findMembership(communityName, userId) {
    return /** @type {{username: string, role: string} | undefined} */ (this.findMembershipStatement.get(communityName, userId));
  }

  /** @param {string} communityName @param {string} username */
  findMembershipByUsername(communityName, username) {
    return /** @type {{id: string, username: string, role: string} | undefined} */ (this.findMembershipByUsernameStatement.get(communityName, username));
  }

  /** @param {string} communityName @param {string} userId @param {"member" | "moderator"} role */
  updateNonOwnerRole(communityName, userId, role) {
    return this.updateRoleStatement.run(role, communityName, userId).changes === 1;
  }

  /** @param {string} communityName @param {string} userId */
  removeNonOwnerMembership(communityName, userId) {
    return this.deleteNonOwnerMembershipStatement.run(communityName, userId).changes === 1;
  }

  publicCommunities() {
    return /** @type {{name: string}[]} */ (this.publicCommunitiesStatement.all());
  }
}
