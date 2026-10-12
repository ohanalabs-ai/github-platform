// Minimal shapes of what actions/github-script injects. Type-only (erased at load time) — no npm
// dependency on @actions/*; Node 24 strips these annotations natively when github-script imports a .ts.
export interface AnnotationProperties { title?: string; file?: string; startLine?: number }
export interface Core {
  info(message: string): void;
  notice(message: string, props?: AnnotationProperties): void;
  error(message: string, props?: AnnotationProperties): void;
  setOutput(name: string, value: string | number): void;
  summary: { addRaw(text: string, addEOL?: boolean): { write(): Promise<unknown> } };
}
export interface Ctx {
  core: Core;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  exec: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  github: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  context: any;
}
