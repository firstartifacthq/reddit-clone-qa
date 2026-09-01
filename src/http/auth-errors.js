export function authenticationError(response) {
  sendJson(response, 401, { error: { code: "authentication_required", message: "Sign in to continue." } });
}

export function sendJson(response, status, body, headers = {}) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers });
  response.end(JSON.stringify(body));
}

export function invalidRequest(response) {
  sendJson(response, 400, { error: { code: "invalid_request", message: "Unable to process this request." } });
}
