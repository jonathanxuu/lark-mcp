export function createApiClient({ getAccessToken, getConnectionProvider, parseJson, fetchWithRetry }) {
  async function get(path, connectionId = "", identity = "bot") {
    const token = await getAccessToken(connectionId, identity);
    const provider = getConnectionProvider(connectionId);
    const response = await fetchWithRetry(`${provider.apiBaseUrl}${path}`, { headers: { Authorization: `Bearer ${token}` } }, `${provider.label} GET ${path}`);
    return parseJson(response);
  }

  async function request(path, method, body, connectionId = "", identity = "bot") {
    const token = await getAccessToken(connectionId, identity);
    const provider = getConnectionProvider(connectionId);
    const response = await fetchWithRetry(`${provider.apiBaseUrl}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=utf-8" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }, `${provider.label} ${method} ${path}`);
    return parseJson(response);
  }

  async function getBuffer(path, connectionId = "", identity = "bot") {
    const token = await getAccessToken(connectionId, identity);
    const provider = getConnectionProvider(connectionId);
    const response = await fetchWithRetry(`${provider.apiBaseUrl}${path}`, { headers: { Authorization: `Bearer ${token}` } }, `${provider.label} GET ${path}`);
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`${provider.label} download error ${response.status}: ${text.slice(0, 300)}`);
    }
    return Buffer.from(await response.arrayBuffer());
  }

  return { get, request, getBuffer };
}
