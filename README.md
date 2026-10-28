# COUNSO Lark MCP

This service exposes Lark knowledge-base and file access to COUNSO through MCP. Every Lark data operation requires a member OAuth connection; writing is additionally restricted to creating a new document after explicit confirmation.

## Local test

1. Copy `.env.example` to `.env` and fill in the Lark app credentials.
2. Install dependencies: `npm install`.
3. Start the server: `npm start`.
4. Configure COUNSO with `http://localhost:4020/mcp` when COUNSO can reach the same machine.

## Lark OAuth connection

For the PDF's per-member connection model, configure the Lark app's OAuth redirect URL to:

`http://localhost:4020/oauth/lark/callback`

Start a member connection at `/oauth/lark/start?user_id=<COUNSO_USER_ID>`. The callback returns a `connection_id`; COUNSO must attach that ID to every Lark tool call. The service keeps the user token server-side and never returns it to the client.

For production, use an HTTPS redirect URL and move the connection store from memory to a persistent encrypted store. Restarting this local process clears active OAuth connections.

## Production domain configuration

When deploying behind an HTTPS reverse proxy, set the public URL in the server environment:

```env
PORT=4020
PUBLIC_BASE_URL=https://lark-mcp-test.zkid.xyz
LARK_OAUTH_REDIRECT_URI=https://lark-mcp-test.zkid.xyz/oauth/lark/callback
MCP_OAUTH_ISSUER=https://lark-mcp-test.zkid.xyz
MCP_RESOURCE=https://lark-mcp-test.zkid.xyz/mcp
```

The MCP endpoint for COUNSO is then:

`https://lark-mcp-test.zkid.xyz/mcp`

The exact `LARK_OAUTH_REDIRECT_URI` must also be added to the Lark application's OAuth redirect URL list. The public URL must terminate TLS before forwarding requests to this Node process; the Node process itself listens on `PORT`.

Available tools:

- `lark_documents`: the only exposed read tool. Use `action=inventory` to list accessible documents with summaries, or `action=read` with one or more Lark URLs/tokens to read them in one operation. `preview` is the default; `content` returns bounded full content; `metadata` avoids content reads.

Search results may be incomplete, especially for documents individually shared from another user's personal space. The Bot must tell users that a missing document can still be checked by passing its Lark document or Wiki URL to `lark_documents` with `action=read`.
- `save_draft_to_lark`: after `confirmed=true`, create a new Lark document, write a draft into it, and attempt to read it back for verification. It never edits or deletes the source document.
- `append_to_lark_document`: after `confirmed=true`, append content to an existing Lark document without replacing or deleting existing content.
- `edit_lark_document`: after `confirmed=true`, either replace all direct content blocks (`mode=replace_all`) or replace the text of one paragraph block (`mode=replace_block`, requires `block_id`).

When `save_draft_to_lark` creates a document, the service also grants the current OAuth user `edit` permission on that document. The app must have the document permission scope required by the Lark permissions API (the example configuration includes `drive:drive`). If granting permission fails, the document is still created and the tool response reports the failure explicitly.

The write tools are intentionally narrow: they require `confirmed=true`. `replace_all` is destructive to the document's direct content blocks, so use it only after displaying the replacement draft and confirming it. The server does not call write tools automatically during startup or read tests. Recursive scans and file counts are bounded to avoid accidentally loading an unbounded Drive. There is no application-identity fallback: missing or invalid `connection_id` blocks the operation.
