const storageKey = "redditly-auth-operation";
if (document.querySelector("[data-auth-success], [data-auth-terminal]")) sessionStorage.removeItem(storageKey);

const form = document.querySelector(".auth-form");
if (form) {
  const input = form.querySelector("[name=operationId]");
  const kind = form.action.endsWith("/register") ? "register" : "sign-in";
  let saved;

  try { saved = JSON.parse(sessionStorage.getItem(storageKey)); } catch { saved = null; }
  if (saved?.kind === kind && /^[A-Za-z0-9_-]{16,128}$/.test(saved.id)) {
    input.value = saved.id;
  } else {
    input.value = crypto.randomUUID().replaceAll("-", "");
    sessionStorage.setItem(storageKey, JSON.stringify({ id: input.value, kind }));
  }
  form.addEventListener("submit", () => {
    sessionStorage.setItem(storageKey, JSON.stringify({ id: input.value, kind }));
  });
}
