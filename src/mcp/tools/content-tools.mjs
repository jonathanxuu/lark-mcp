import { registerWikiTools } from "./wiki-tools.mjs";
import { registerDriveTools } from "./drive-tools.mjs";

// Compatibility facade. The consolidated lark_documents tool remains the
// public default; legacy overlapping tools stay opt-in.
export function registerContentTools(server, dependencies) {
  const options = { exposeLegacyReadTools: false };
  registerWikiTools(server, dependencies, options);
  registerDriveTools(server, dependencies, options);
}
