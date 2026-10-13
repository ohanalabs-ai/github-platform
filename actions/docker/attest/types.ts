// Minimal shapes of what actions/github-script injects. Type-only (erased at load time) — no npm
// dependency on @actions/*; Node 24 strips these annotations natively when github-script imports a .ts.
export interface Core {
  getInput(name: string): string;
  getIDToken(audience?: string): Promise<string>;
  setOutput(name: string, value: string | number): void;
  setFailed(message: string): void;
  setSecret(value: string): void;
  info(message: string): void;
  notice(message: string): void;
  warning(message: string): void;
  error(message: string): void;
  summary: { addRaw(text: string, addEOL?: boolean): { write(): Promise<unknown> } };
}
export interface ExecOutput { exitCode: number; stdout: string; stderr: string }
export interface ExecOptions { input?: Buffer; silent?: boolean; ignoreReturnCode?: boolean; cwd?: string; env?: Record<string, string> }
export interface Exec {
  exec(cmd: string, args?: string[], opts?: ExecOptions): Promise<number>;
  getExecOutput(cmd: string, args?: string[], opts?: ExecOptions): Promise<ExecOutput>;
}
export interface Ctx {
  core: Core;
  exec: Exec;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  github?: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  context?: any;
}
