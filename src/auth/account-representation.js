/**
 * @typedef {object} Account
 * @property {string} id
 * @property {string} username
 */

/**
 * @param {Account} account
 * @returns {Account}
 */
export function accountRepresentation(account) {
  return { id: account.id, username: account.username };
}
