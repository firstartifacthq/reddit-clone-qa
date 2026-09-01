import { hashPassword, normalizeUsername, validCredentials, verifyPassword } from "./passwords.js";

export class AuthService {
  constructor({ store, sessions, clock }) {
    this.store = store;
    this.sessions = sessions;
    this.clock = clock;
    this.dummyPasswordHashPromise = hashPassword("not-a-user-password");
  }

  async signup({ username, password }) {
    const normalized = normalizeUsername(username);
    if (!validCredentials(normalized, password)) return null;
    const passwordHash = await hashPassword(password);
    try {
      return this.store.transaction(() => {
        const account = this.store.createAccount(normalized, passwordHash, this.clock());
        return { account, token: this.sessions.issue(account.id) };
      });
    } catch (error) {
      if (error?.code === "ERR_SQLITE_CONSTRAINT_UNIQUE") return null;
      throw error;
    }
  }

  async login({ identifier, password }) {
    const username = normalizeUsername(identifier);
    const account = this.store.findAccountByUsername(username);
    const passwordHash = account?.password_hash ?? await this.dummyPasswordHashPromise;
    const valid = typeof password === "string" && await verifyPassword(password, passwordHash);
    if (!account || !valid) return null;
    return { account, token: this.sessions.issue(account.id) };
  }

  currentAccount(token) {
    return this.sessions.resolve(token);
  }

  logout(token) {
    this.sessions.revoke(token);
  }
}
