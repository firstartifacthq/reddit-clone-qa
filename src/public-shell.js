function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
  })[character]);
}

const clientScript = `<script>
  async function submitAuth(event, endpoint) {
    event.preventDefault();
    const form = event.currentTarget;
    const result = await fetch(endpoint, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: form.username.value, password: form.secret.value })
    });
    if (result.ok) location.reload();
    else document.querySelector('#auth-message').textContent = 'Unable to sign in. Try again.';
  }
  document.querySelector('#signup-form')?.addEventListener('submit', (event) => submitAuth(event, '/api/auth/signup'));
  document.querySelector('#login-form')?.addEventListener('submit', (event) => submitAuth(event, '/api/auth/login'));
  document.querySelector('#logout-form')?.addEventListener('submit', async (event) => {
    event.preventDefault(); await fetch('/api/auth/logout', { method: 'POST' }); location.reload();
  });
</script>`;

export function renderShell(account) {
  const main = account
    ? `<p>Signed in as <strong>${escapeHtml(account.username)}</strong>.</p>
       <nav><a href="/api/me">Account</a> <a href="/api/communities">Communities</a></nav>
       <form id="logout-form"><button type="submit">Log out</button></form>`
    : `<p id="auth-message" role="status">Sign in or create an account. Try again if a previous attempt was interrupted.</p>
       <nav><a href="/api/communities">Communities</a></nav>
       <form id="signup-form"><h2>Sign up</h2><label>Username <input name="username" required></label><label>Passphrase <input name="secret" type="password" required></label><button type="submit">Create account</button></form>
       <form id="login-form"><h2>Sign in</h2><label>Username <input name="username" required></label><label>Passphrase <input name="secret" type="password" required></label><button type="submit">Sign in</button></form>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Reddit clone</title></head><body><main><h1>Reddit clone</h1>${main}</main>${clientScript}</body></html>`;
}
