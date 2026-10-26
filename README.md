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

- `health_check`: verify Lark application authentication.
- `list_lark_wiki_spaces`: list accessible knowledge bases.
- `list_lark_wiki_nodes`: list pages under a knowledge base or parent page.
- `read_lark_wiki`: read a Lark wiki URL or wiki node token.
- `read_lark_document`: read a Lark `/docx/` or `/docs/` URL.
- `list_lark_drive_files`: list files in a Lark Drive folder.
- `list_all_lark_files`: recursively list accessible files and folders with source URLs and metadata.
- `read_lark_file`: extract text from PDF, Word, Excel, CSV, Markdown, or text files.
- `search_lark_wiki`: search knowledge-base page titles.
- `search_lark_drive_files`: search file names in the Drive root or a specified folder.
- `save_draft_to_lark`: after `confirmed=true`, create a new Lark document, write a draft into it, and attempt to read it back for verification. It never edits or deletes the source document.

The write tool is intentionally narrow: it does not edit or delete existing documents, and the server does not call it automatically during startup or read tests. Recursive scans and file counts are bounded to avoid accidentally loading an unbounded Drive. There is no application-identity fallback: missing or invalid `connection_id` blocks the operation.
