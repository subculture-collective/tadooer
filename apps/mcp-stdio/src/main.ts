import { loadMcpCatalog } from "./catalog.ts";
import { loadConfig } from "./config.ts";
import { McpStdioServer } from "./protocol.ts";

try {
  const [config, catalog] = await Promise.all([
    loadConfig(process.argv.slice(2)),
    Promise.resolve(loadMcpCatalog()),
  ]);
  const server = new McpStdioServer(catalog, config, "0.0.0-dev");
  await server.serve(process.stdin, process.stdout);
} catch {
  // A stdio MCP process must reserve stdout for JSON-RPC replies. Deliberately
  // avoid token paths, credentials, network internals, and catalog details.
  process.stderr.write("Tadooer MCP adapter could not start.\n");
  process.exitCode = 1;
}
