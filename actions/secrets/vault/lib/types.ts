// Minimal shapes of what actions/github-script injects. Type-only (erased at load time) — no npm
// dependency on @actions/*; Node 24 strips these annotations natively when github-script imports a .ts.
export interface Core {
  info(message: string): void;
  warning(message: string): void;
  setSecret(value: string): void;
  setOutput(name: string, value: string | number): void;
  exportVariable(name: string, value: string): void;
  setFailed(message: string): void;
  summary: { addRaw(text: string, addEOL?: boolean): { write(): Promise<unknown> } };
}
export interface ExecOptions { input?: Buffer; silent?: boolean; ignoreReturnCode?: boolean; env?: Record<string, string> }
export interface Exec {
  exec(cmd: string, args?: string[], opts?: ExecOptions): Promise<number>;
}
export interface Ctx {
  core: Core;
  exec: Exec;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  github: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  context: any;
}
