import { execSync } from "node:child_process";

execSync("pnpm --filter @sofia/desktop build", { stdio: "inherit" });
