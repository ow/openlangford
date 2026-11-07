// `pnpm dev` runs this first: one dev server per checkout family. A second one in another worktree or
// terminal doubles the Supabase connections and the AI binding's remote calls, and the one left behind
// keeps running for days. Set DEV_ALLOW_MULTIPLE=1 to run another on purpose.
import { execFileSync } from "node:child_process";
import path from "node:path";

if (process.env.DEV_ALLOW_MULTIPLE !== "1") {
  // The main checkout, so a server started from a worktree under .claude/worktrees counts too.
  const root = path.resolve(process.cwd(), "../..").replace(/\/\.claude\/worktrees\/[^/]+$/, "");
  const ps = execFileSync("ps", ["-axo", "pid=,lstart=,command="], { encoding: "utf8" });
  const running = ps.split("\n").filter((line) => line.includes("@react-router/dev/bin.js dev") && line.includes(root)
    && !line.includes(` ${process.pid} `) && !line.startsWith(`${process.ppid} `));
  if (running.length) {
    const [pid, ...rest] = running[0].trim().split(/\s+/);
    const port = rest.join(" ").match(/--port[= ](\d+)/)?.[1] ?? "5173";
    console.error(`A dev server is already running for this checkout (pid ${pid}, started ${rest.slice(0, 5).join(" ")}) on port ${port}.`);
    console.error(`Use it, or stop it with: kill ${pid}`);
    console.error("To run a second one anyway: DEV_ALLOW_MULTIPLE=1 pnpm dev --port <other port>");
    process.exit(1);
  }
}
