/** @typedef {{id: string, username: string}} Account */

/** @param {unknown} value */
function escapeHtml(value) {
  /** @type {Record<string, string>} */
  const entities = { "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" };
  return String(value).replace(/[&<>'"]/g, character => entities[character] || character);
}
const clientScript = `<script>
  let pending = false;
  async function submitAuth(event, endpoint, action) {
    event.preventDefault();
    if (pending) return;
    pending = true;
    const form = event.currentTarget;
    const button = form.querySelector('button');
    const message = document.querySelector('#auth-message');
    button.setAttribute('aria-disabled', 'true');
    message.textContent = 'Please wait...';
    try {
      const result = await fetch(endpoint, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: form.elements.username ? JSON.stringify({ username: form.elements.username.value, password: form.elements.secret.value }) : undefined
      });
      if (result.ok) { location.reload(); return; }
      message.textContent = 'Unable to ' + action + '. ' + (action === 'log out' ? 'You may still be signed in. Try again.' : 'Check your username and passphrase, then try again.');
    } catch {
      message.textContent = 'The result was not confirmed because the connection was interrupted. Check your account or try again.';
    } finally {
      pending = false;
      button.removeAttribute('aria-disabled');
    }
  }
  for (const [name, action] of [['signup', 'create an account'], ['login', 'sign in'], ['logout', 'log out']]) {
    document.querySelector('#' + name + '-form')?.addEventListener('submit', event => submitAuth(event, '/api/auth/' + name, action));
  }
</script>`;
const styles = `<style>
  * { box-sizing: border-box; }
  body { margin: 0; color: #202020; background: #fafafa; font-family: Georgia, serif; font-size: 1rem; line-height: 1.5; }
  main { max-width: 56rem; margin: auto; padding: 1rem; overflow-wrap: anywhere; }
  h1 { font-size: 2rem; line-height: 1.2; }
  h2 { font-size: 1.4rem; margin-top: 0; }
  nav { display: flex; flex-wrap: wrap; gap: 1rem; margin-block: 1rem; }
  a { color: #194d80; }
  form { min-width: 0; border: 1px solid #aaa; padding: 1rem; margin-block: 1rem; background: white; }
  label { display: block; margin-block: .75rem; }
  input { display: block; width: 100%; max-width: 28rem; min-width: 0; }
  input, button { font: inherit; padding: .5rem; }
  button { max-width: 100%; white-space: normal; color: #202020; cursor: pointer; }
  :focus-visible { outline: 3px solid #005eaa; outline-offset: 3px; }
  [aria-disabled='true'] { cursor: wait; }
  #auth-message { min-height: 3em; }
</style>`;
/** @param {string} kind @param {string} title @param {string} button */
function authForm(kind, title, button) {
  return `<form id="${kind}-form" aria-labelledby="${kind}-heading"><h2 id="${kind}-heading">${title}</h2>
    <label for="${kind}-username">Username</label><input id="${kind}-username" name="username" autocomplete="username" required aria-describedby="auth-message">
    <label for="${kind}-secret">Passphrase</label><input id="${kind}-secret" name="secret" type="password" autocomplete="${kind === "signup" ? "new-password" : "current-password"}" required aria-describedby="auth-message">
    <button type="submit">${button}</button></form>`;
}
/** @param {Account | undefined} account */
export function renderShell(account) {
  const status = account ? `Signed in as <strong>${escapeHtml(account.username)}</strong>.` : "Sign in or create an account. Try again if a previous attempt was interrupted.";
  const main = `<p>${status}</p><nav aria-label="Account navigation">${account ? '<a href="/api/me">Account</a> ' : ''}<a href="/api/communities">Communities</a></nav>
    <p id="auth-message" role="alert" aria-live="assertive" aria-atomic="true"></p>` + (account
    ? '<form id="logout-form" aria-label="Sign out"><button type="submit">Log out</button></form>'
    : authForm("signup", "Sign up", "Create account") + authForm("login", "Sign in", "Sign in"));
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Reddit clone</title>${styles}</head><body><main><h1>Reddit clone</h1>${main}</main>${clientScript}</body></html>`;
}
