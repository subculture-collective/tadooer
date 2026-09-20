import { chmod, cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const args = process.argv.slice(2);
if (args.length !== 0 && (args.length !== 2 || args[0] !== "--prefix")) {
  throw new Error(
    "Usage: node deploy/install-assistant.mjs [--prefix <directory>]",
  );
}
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const prefix = resolve(args[1] ?? resolve(homedir(), ".local"));
const destination = resolve(prefix, "share", "tadooer");
const binary = resolve(prefix, "bin", "tadooer-mcp");
// Fail before creating an incomplete installation when build output is missing.
const runtime = await readFile(resolve(root, "apps/mcp-stdio/dist/main.mjs"));
await mkdir(destination, { recursive: true });
await mkdir(dirname(binary), { recursive: true });
await writeFile(resolve(destination, "main.mjs"), runtime);
await cp(resolve(root, "plugins/tadooer"), resolve(destination, "plugin"), {
  recursive: true,
});
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
await writeFile(
  binary,
  `#!/bin/sh\nexec node ${quote(resolve(destination, "main.mjs"))} "$@"\n`,
  { mode: 0o755 },
);
await chmod(binary, 0o755);
process.stdout.write(
  `Installed ${binary}\nPlugin: ${resolve(destination, "plugin")}\nConfigure ~/.config/tadooer/mcp.json (or TADOOER_MCP_CONFIG) and keep its referenced token file mode 0600.\n`,
);
