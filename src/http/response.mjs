export function json(res, status, body, headers = {}) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    ...headers,
  });
  res.end(JSON.stringify(body));
}

export function redirect(res, location) {
  res.writeHead(302, { Location: location });
  res.end();
}

export async function readRequestBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

export function parseFormBody(req, body) {
  if ((req.headers["content-type"] ?? "").includes("application/json")) {
    return JSON.parse(body || "{}");
  }
  return Object.fromEntries(new URLSearchParams(body));
}
