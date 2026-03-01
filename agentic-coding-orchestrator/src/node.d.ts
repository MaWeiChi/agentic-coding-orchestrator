/**
 * Minimal Node.js type declarations for building without @types/node.
 * Install @types/node as devDependency and delete this file for full types.
 */

declare module "fs" {
  export function existsSync(path: string): boolean;
  export function readFileSync(path: string, encoding: string): string;
  export function writeFileSync(path: string, data: string, encoding?: string): void;
  export function mkdirSync(path: string, options?: { recursive?: boolean }): string | undefined;
  export function readdirSync(path: string): string[];
  export function statSync(path: string): { isDirectory(): boolean; isFile(): boolean; mtimeMs: number };
  export function unlinkSync(path: string): void;
  export function rmSync(path: string, options?: { recursive?: boolean; force?: boolean }): void;
}

declare module "path" {
  export function join(...paths: string[]): string;
  export function resolve(...paths: string[]): string;
  export function dirname(path: string): string;
  export function basename(path: string, ext?: string): string;
  export function extname(path: string): string;
  export function relative(from: string, to: string): string;
  export function isAbsolute(path: string): boolean;
}

declare module "child_process" {
  export function execSync(command: string, options?: {
    cwd?: string;
    encoding?: string;
    stdio?: string | string[];
  }): string | Buffer;
}

declare module "os" {
  export function tmpdir(): string;
  export function homedir(): string;
}

declare var process: {
  argv: string[];
  exit(code?: number): never;
  cwd(): string;
  env: Record<string, string | undefined>;
};

declare var console: {
  log(...args: any[]): void;
  error(...args: any[]): void;
  warn(...args: any[]): void;
};

declare var require: (id: string) => any;

declare class Buffer {
  static from(str: string, encoding?: string): Buffer;
  toString(encoding?: string): string;
  readonly length: number;
}

declare var __dirname: string;
declare var __filename: string;
