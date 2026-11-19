// The docker CLI as a function (node:child_process, no npm). Bytes in, bytes out, with a wall-clock timeout whose
// handler removes the container (killing the CLI client alone does not stop a running container).
import { spawn } from "node:child_process";
import type { Docker, DockerResult } from "./types.ts";

const MAX_CAPTURE = 80 * 1024 * 1024;

export const docker: Docker = (args, opts = {}) =>
  new Promise<DockerResult>((resolve) => {
    const child = spawn("docker", args, { stdio: ["pipe", "pipe", "pipe"] });
    const out: Buffer[] = [];
    let outLen = 0;
    let err = "";
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (opts.timeoutMs) {
      timer = setTimeout(async () => {
        timedOut = true;
        if (opts.onTimeout) await opts.onTimeout().catch(() => undefined);
        child.kill("SIGKILL");
      }, opts.timeoutMs);
    }
    child.stdout.on("data", (d: Buffer) => { if (outLen < MAX_CAPTURE) { out.push(d); outLen += d.length; } });
    child.stderr.on("data", (d: Buffer) => { if (err.length < 1024 * 1024) err += d.toString("utf8"); });
    child.on("error", (e) => { err += String(e); });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code: code === null ? -1 : code, stdout: Buffer.concat(out), stderr: err, timedOut });
    });
    child.stdin.on("error", () => undefined);
    if (opts.input) child.stdin.end(opts.input);
    else child.stdin.end();
  });
