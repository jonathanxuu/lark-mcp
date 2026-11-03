// Stable application entrypoint. HTTP and MCP wiring currently live in server.mjs
// and can be moved behind this boundary without changing deployment commands.
import "./server.mjs";
