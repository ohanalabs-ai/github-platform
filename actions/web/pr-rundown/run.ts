// 📸 web-pr-rundown · run: start the PR image (and the baseline) on localhost, then run capture/capture.ts in the pinned Playwright
// image against them. The site needs no network beyond the runner: no preview URL, no SSO. Containers are removed afterwards.
// Env: HEAD_IMAGE, BASE_IMAGE?, CONTAINER_PORT, PLAYWRIGHT_IMAGE, HELPERS (abs path of actions/web/pr-rundown), DENYLIST (abs, may
//      not exist), OUT (abs), VIEWPORTS, PAGES, MAX_PAGES, THRESHOLD, HEAD_LABEL, BASE_LABEL, GH_TOKEN.
import { existsSync, mkdirSync } from "node:fs";
import type { Ctx } from "../preview-review/types.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const e = (k: string) => process.env[k] || "";

async function up(url: string, seconds: number): Promise<boolean> {
  const end = Date.now() + seconds * 1000;
  while (Date.now() < end) {
    try { if ((await fetch(url)).status < 500) return true; } catch { /* not yet */ }
    await sleep(2000);
  }
  return false;
}

export default async function run({ core, exec }: Ctx): Promise<void> {
  const port = e("CONTAINER_PORT") || "3000";
  const servers: Array<{ name: string; image: string; host: number }> = [{ name: "rundown-head", image: e("HEAD_IMAGE"), host: 3101 }];
  if (e("BASE_IMAGE")) servers.push({ name: "rundown-base", image: e("BASE_IMAGE"), host: 3102 });
  mkdirSync(e("OUT"), { recursive: true });
  const registry = e("HEAD_IMAGE").split("/")[0];
  await exec.exec("docker", ["login", registry, "-u", "x-access-token", "--password-stdin"], { input: Buffer.from(e("GH_TOKEN")), silent: true });
  try {
    for (const s of servers) {
      await exec.exec("docker", ["run", "-d", "--rm", "--name", s.name, "-p", `127.0.0.1:${s.host}:${port}`, s.image]);
      if (!(await up(`http://127.0.0.1:${s.host}/`, 90))) {
        await exec.exec("docker", ["logs", s.name], { ignoreReturnCode: true });
        return core.setFailed(`${s.image} did not answer on :${port} within 90 s (input container-port?)`);
      }
    }
    const args = [
      "run", "--rm", "--network", "host", "--ipc", "host",
      "-v", `${e("HELPERS")}:/a`, "-v", `${e("OUT")}:/out`, "-w", "/a/capture",
      "-e", "HEAD_URL=http://127.0.0.1:3101", "-e", `HEAD_IMAGE=${e("HEAD_IMAGE")}`, "-e", `HEAD_LABEL=${e("HEAD_LABEL")}`,
      "-e", "OUT=/out", "-e", `VIEWPORTS=${e("VIEWPORTS")}`, "-e", `PAGES=${e("PAGES")}`, "-e", `MAX_PAGES=${e("MAX_PAGES")}`, "-e", `THRESHOLD=${e("THRESHOLD")}`,
    ];
    if (e("BASE_IMAGE")) args.push("-e", "BASE_URL=http://127.0.0.1:3102", "-e", `BASE_IMAGE=${e("BASE_IMAGE")}`, "-e", `BASE_LABEL=${e("BASE_LABEL")}`);
    if (existsSync(e("DENYLIST"))) args.push("-v", `${e("DENYLIST")}:/denylist.txt:ro`, "-e", "DENYLIST=/denylist.txt");
    else core.warning(`deny-list ${e("DENYLIST")} not found — the rendered pages are not scanned`);
    args.push(e("PLAYWRIGHT_IMAGE"), "sh", "-c", "npm ci --no-audit --no-fund --ignore-scripts && node capture.ts");
    const rc = await exec.exec("docker", args, { ignoreReturnCode: true });
    if (rc !== 0) core.setFailed(`capture failed (exit ${rc}) — see the log above`);
  } finally {
    for (const s of servers) await exec.exec("docker", ["rm", "-f", s.name], { ignoreReturnCode: true, silent: true });
  }
}
