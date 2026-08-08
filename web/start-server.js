import { spawnSync, spawn } from "node:child_process";
import "dotenv/config";

// Build the latest server code before starting, so .env changes and source edits
// are always picked up by `node dist/server/index.js`.
console.log("[start-server] Building...");
const build = spawnSync("bun", ["run", "build"], { stdio: "inherit" });
if (build.status !== 0) {
  console.error("[start-server] Build failed. Fix the errors above and try again.");
  process.exit(build.status ?? 1);
}

console.log("[start-server] Starting server...");
const server = spawn("node", ["dist/server/index.js"], { stdio: "inherit" });
server.on("exit", (code) => process.exit(code ?? 0));
