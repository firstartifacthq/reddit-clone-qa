// @ts-expect-error Node built-in declarations are outside this JavaScript slice's ambient types.
import { accessSync, constants, statSync } from "node:fs";
// @ts-expect-error Node built-in declarations are outside this JavaScript slice's ambient types.
import { dirname } from "node:path";

/** A probe belongs to the lifecycle timer, never to an HTTP observation.
 * @param {{prepare: (sql: string) => any, exec: (sql: string) => void}} database
 * @param {string} path
 */
export function durableCapability(database, path) {
  const identity = path === ":memory:" ? undefined : statSync(path);
  return () => {
    if (identity) {
      const current = statSync(path);
      if (identity.dev !== current.dev || identity.ino !== current.ino) throw new Error("storage identity changed");
      accessSync(path, constants.R_OK | constants.W_OK);
      accessSync(dirname(path), constants.R_OK | constants.W_OK | constants.X_OK);
    }
    if (database.prepare("PRAGMA synchronous").get().synchronous < 2 ||
        database.prepare("PRAGMA secure_delete").get().secure_delete !== 1 ||
        !["delete", "memory"].includes(database.prepare("PRAGMA journal_mode").get().journal_mode)) throw new Error("durability unavailable");
    database.prepare("SELECT id FROM users LIMIT 1").get();
    let began = false;
    try {
      database.exec("BEGIN IMMEDIATE");
      began = true;
      const result = database.prepare("UPDATE operational_capability SET pulse=1-pulse WHERE id=1").run();
      if (result.changes !== 1) throw new Error("capability singleton unavailable");
      database.exec("COMMIT");
    } catch (error) {
      if (began) { try { database.exec("ROLLBACK"); } catch {} }
      throw error;
    }
  };
}

/** @param {{check: () => void, onReady?: () => void, intervalMs?: number, schedule?: (work: () => void, delay: number) => (() => void)}} options */
export function createReadiness({ check, onReady = () => {}, intervalMs = 250,
  schedule = (work, delay) => {
    const timer = setTimeout(work, delay);
    // @ts-expect-error Node timers expose unref; the ambient library describes browser timers.
    timer.unref();
    return () => clearTimeout(timer);
  } }) {
  if (typeof check !== "function" || typeof onReady !== "function" || typeof schedule !== "function" ||
      !Number.isSafeInteger(intervalMs) || intervalMs < 1 || intervalMs > 5000) throw new TypeError("invalid readiness options");
  let state = "initializing";
  let sequence = 0;
  /** @type {(() => void) | undefined} */
  let cancel;
  /** @type {Set<(ready: boolean) => void>} */
  const observers = new Set();
  function tick() {
    if (state === "closed") return;
    try { check(); state = "ready"; onReady(); }
    catch { state = "degraded"; }
    sequence++;
    for (const observe of observers) observe(state === "ready");
    observers.clear();
    cancel = schedule(tick, intervalMs);
  }
  cancel = schedule(tick, 0);
  return {
    get state() { return state; },
    get sequence() { return sequence; },
    /** @returns {Promise<boolean>} */
    observe() {
      if (state === "closed" || state === "initializing") return Promise.resolve(false);
      // Wait for fresh, independently scheduled evidence. Polls cannot tick or repair.
      return new Promise(resolve => {
        /** @param {boolean} ready */
        const observer = ready => { clearTimeout(timeout); observers.delete(observer); resolve(ready); };
        const timeout = setTimeout(() => observer(false), intervalMs * 2 + 100);
        observers.add(observer);
      });
    },
    close() {
      state = "closed"; cancel?.();
      for (const observe of observers) observe(false);
      observers.clear();
    },
  };
}
