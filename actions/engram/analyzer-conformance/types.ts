// Minimal shapes of what actions/github-script injects. Type-only (erased at load time) — no npm
// dependency on @actions/*; Node 24 strips these annotations natively when github-script imports a .ts.
export interface Core {
  setOutput(name: string, value: string | number): void;
  setFailed(message: string): void;
  info(message: string): void;
  notice(message: string): void;
  warning(message: string): void;
  error(message: string): void;
  summary: { addRaw(text: string, addEOL?: boolean): { write(): Promise<unknown> } };
}
export interface Ctx {
  core: Core;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  exec?: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  github?: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  context?: any;
}

/** One docker CLI invocation's result. `stdout` stays a Buffer: the analyzer output and `docker cp` tars are bytes. */
export interface DockerResult { code: number; stdout: Buffer; stderr: string; timedOut: boolean }
export interface DockerOpts { input?: Buffer; timeoutMs?: number; onTimeout?: () => Promise<void> }
export type Docker = (args: string[], opts?: DockerOpts) => Promise<DockerResult>;

export type Status = "pass" | "fail" | "n/a";
export interface Check { id: string; status: Status; detail: string }

export interface Report {
  analyzer: string;
  image: string;
  digest: string;
  profile: "cli" | "grpc";
  mode: "enforce" | "report";
  checks: Check[];
  ok: boolean;
}
