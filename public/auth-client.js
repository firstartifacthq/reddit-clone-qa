const storageKey = "redditly-auth-operation";

function validOperation(saved, kind) {
  return saved?.kind === kind && /^[A-Za-z0-9_-]{16,128}$/.test(saved.id);
}

function formBody(form) {
  const body = new URLSearchParams();
  for (const field of form.elements) {
    if (field.name && !field.disabled) body.append(field.name, field.value);
  }
  return body;
}

export function installAuthClient({
  documentRef = document,
  storage = sessionStorage,
  cryptoRef = crypto,
  fetchRef = fetch,
  replaceDocument = (html) => {
    documentRef.open();
    documentRef.write(html);
    documentRef.close();
  }
} = {}) {
  if (documentRef.querySelector("[data-auth-success], [data-auth-terminal]")) storage.removeItem(storageKey);
  const form = documentRef.querySelector(".auth-form");
  if (!form) return null;

  const input = form.querySelector("[name=operationId]");
  const retry = form.querySelector(".retry");
  const primary = form.querySelector("button[type=submit]:not(.retry)");
  const status = form.querySelector("[data-auth-status]");
  const kind = form.action.endsWith("/register") ? "register" : "sign-in";
  let saved;
  try { saved = JSON.parse(storage.getItem(storageKey)); } catch { saved = null; }
  input.value = validOperation(saved, kind) ? saved.id : cryptoRef.randomUUID().replaceAll("-", "");
  storage.setItem(storageKey, JSON.stringify({ id: input.value, kind }));

  const submit = async (event) => {
    event?.preventDefault?.();
    storage.setItem(storageKey, JSON.stringify({ id: input.value, kind }));
    retry.hidden = true;
    retry.disabled = true;
    primary.disabled = true;
    status.hidden = false;
    status.textContent = "Submitting...";
    try {
      const response = await fetchRef(form.action, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: formBody(form),
        credentials: "same-origin"
      });
      const html = await response.text();
      const terminal = html.includes("data-auth-success") || html.includes("data-auth-terminal");
      if (terminal) storage.removeItem(storageKey);
      for (const field of form.elements) {
        if (field.type === "password") field.value = "";
      }
      replaceDocument(html);
    } catch {
      primary.disabled = false;
      retry.disabled = false;
      retry.hidden = false;
      status.textContent = "The result was interrupted. Retry this request.";
    }
  };

  form.addEventListener("submit", submit);
  return { submit };
}

if (typeof document !== "undefined") installAuthClient();
