export async function parseJson(response, operation = "Lark API") {
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`${operation} returned HTTP ${response.status}: ${text.slice(0, 300)}`);
  }
  if (!response.ok || body.code !== 0) {
    throw new Error(`${operation} failed: Lark API error ${body.code ?? response.status}: ${body.msg ?? text}`);
  }
  return body;
}

export async function fetchWithRetry(url, options, operation = "Lark API") {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await fetch(url, options);
    } catch (error) {
      lastError = error;
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 300 * (attempt + 1)));
    }
  }
  const cause = lastError.cause?.code ?? lastError.cause?.message ?? lastError.code ?? lastError.message;
  console.error(`[Lark] ${operation} network request failed after retries: ${cause}`);
  throw new Error(`Lark network request failed during ${operation}: ${cause}`);
}
