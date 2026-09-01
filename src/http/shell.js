function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
}

const formScript = `<script>
for (const form of document.querySelectorAll("form[data-auth]")) {
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const fields = Object.fromEntries(new FormData(form));
    const response = await fetch(form.action, {
      method: "POST", credentials: "same-origin",
      headers: { "content-type": "application/json" }, body: JSON.stringify(fields)
    });
    if (response.ok) location.replace("/");
  });
}
document.querySelector("form[data-logout]")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const response = await fetch("/api/auth/logout", { method: "POST", credentials: "same-origin" });
  if (response.ok) location.replace("/");
});
</script>`;

export function renderShell(account) {
  const content = account
    ? `<main><h1>Reddit Clone</h1><p>Signed in as ${escapeHtml(account.username)}</p><nav><a href="/api/communities">Communities</a><form data-logout method="post" action="/api/auth/logout"><button>Sign out</button></form></nav></main>`
    : `<main><h1>Reddit Clone</h1><section><h2>Sign in</h2><form data-auth method="post" action="/api/auth/login"><label>Username <input name="identifier" autocomplete="username"></label><label>Password <input name="password" type="password" autocomplete="current-password"></label><button>Sign in</button></form></section><section><h2>Create account</h2><form data-auth method="post" action="/api/auth/signup"><label>Username <input name="username" autocomplete="username"></label><label>Password <input name="password" type="password" autocomplete="new-password"></label><button>Create account</button></form></section></main>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Reddit Clone</title></head><body>${content}${formScript}</body></html>`;
}
