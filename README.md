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
- `list_lark_document_blocks`: list direct document blocks and their IDs for precise edits.
- `list_lark_drive_files`: list files in a Lark Drive folder.
- `list_all_lark_files`: recursively list accessible files and folders with source URLs and metadata.
- `read_lark_file`: extract text from PDF, Word, Excel, CSV, Markdown, or text files.
- `search_lark_wiki`: search knowledge-base page titles.
- `search_lark_drive_files`: search file names in the Drive root or a specified folder.
- `search_lark_documents`: search indexed Bot/application-visible cloud documents and Wiki pages through Search V2; supports empty-query browsing and pagination. It is not guaranteed to enumerate every document individually shared from another user's personal space; a direct URL/token remains authoritative.
- `inventory_lark_documents`: one read-only aggregate inventory of Search V2, Wiki spaces, and Drive metadata, with `metadata`, `preview`, and bounded `content` modes to reduce repeated permission prompts.

Search results may be incomplete, especially for documents individually shared from another user's personal space. The Bot must tell users that a missing document can still be checked by pasting its Lark document or Wiki URL; `read_lark_document` and `read_lark_wiki` then verify direct read permission.
- `save_draft_to_lark`: after `confirmed=true`, create a new Lark document, write a draft into it, and attempt to read it back for verification. It never edits or deletes the source document.
- `append_to_lark_document`: after `confirmed=true`, append content to an existing Lark document without replacing or deleting existing content.
- `edit_lark_document`: after `confirmed=true`, either replace all direct content blocks (`mode=replace_all`) or replace the text of one paragraph block (`mode=replace_block`, requires `block_id`).

When `save_draft_to_lark` creates a document, the service also grants the current OAuth user `edit` permission on that document. The app must have the document permission scope required by the Lark permissions API (the example configuration includes `drive:drive`). If granting permission fails, the document is still created and the tool response reports the failure explicitly.

The write tools are intentionally narrow: they require `confirmed=true`. `replace_all` is destructive to the document's direct content blocks, so use it only after displaying the replacement draft and confirming it. The server does not call write tools automatically during startup or read tests. Recursive scans and file counts are bounded to avoid accidentally loading an unbounded Drive. There is no application-identity fallback: missing or invalid `connection_id` blocks the operation.
