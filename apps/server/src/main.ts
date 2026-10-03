import { loadConfig } from "./config.ts";
import { startSuiteServer } from "./server.ts";

const config = loadConfig();
const server = await startSuiteServer(config);

console.log(`Tadooer listening on ${server.baseUrl}`);

const shutdown = async (): Promise<void> => {
  await server.close();
  process.exitCode = 0;
};

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
