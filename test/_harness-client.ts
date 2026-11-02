import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import readline from "node:readline";

export type McpMessage = Record<string, unknown> & { id?: number };

export interface McpHarnessOptions {
  command: string;
  args: string[];
  cwd: string;
  timeoutMs?: number;
  // Optional environment for tests that relocate the config dir via $HOME.
  // Unset: inherits process.env — except that a $HOME still pointing at the
  // account's REAL home is replaced by a throwaway directory, so no spawned
  // server can read the developer's real profile, session eligibility marker
  // or running managed browser. A test that relocated $HOME keeps its value.
  env?: NodeJS.ProcessEnv;
}

/**
 * Minimal MCP client over stdio. Used by the Gate A harnesses; it does not
 * import the server, so it works identically against tsx (source) and node
 * (compiled bundle). No real credentials are used anywhere.
 */
export class McpClient {
  private proc: ChildProcess;
  private pending = new Map<number, { resolve: (v: McpMessage) => void; timer: NodeJS.Timeout }>();
  private nextId = 0;
  private options: McpHarnessOptions;
  notifications: string[] = [];
  stderr: string[] = [];
  private isolatedHome: string | undefined;

  constructor(options: McpHarnessOptions) {
    this.options = options;
    let env = this.options.env;
    if (!env) {
      if (!process.env.HOME || process.env.HOME === userInfo().homedir) {
        this.isolatedHome = mkdtempSync(join(tmpdir(), "mcp-harness-home-"));
        env = { ...process.env, HOME: this.isolatedHome };
      } else {
        env = process.env;
      }
    }
    this.proc = spawn(this.options.command, this.options.args, {
      cwd: this.options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env,
    });
    const rl = readline.createInterface({ input: this.proc.stdout as NodeJS.ReadableStream });
    rl.on("line", (raw) => {
      let msg: McpMessage;
      try {
        msg = JSON.parse(raw) as McpMessage;
      } catch {
        return; // ignore non-JSON lines
      }
      if (typeof msg.id === "number" && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        p.resolve(msg);
      } else if (msg.method) {
        this.notifications.push(msg.method as string);
      }
    });
    (this.proc.stderr as NodeJS.ReadableStream).on("data", (d) => {
      this.stderr.push(d.toString().trim());
    });
  }

  sendRequest(method: string, params: unknown = {}): Promise<McpMessage> {
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timeout on ${method} (${this.options.timeoutMs ?? 15000}ms)`));
      }, this.options.timeoutMs ?? 15000);
      this.pending.set(id, { resolve, timer });
      this.proc.stdin?.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  sendNotification(method: string, params: unknown = {}): void {
    this.proc.stdin?.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }

  async initialize(): Promise<McpMessage> {
    const result = await this.sendRequest("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "gate-a-harness", version: "1.0.0" },
    });
    this.sendNotification("notifications/initialized", {});
    await new Promise((r) => setTimeout(r, 300));
    return result;
  }

  kill(): void {
    this.proc.kill();
    for (const [, p] of this.pending) clearTimeout(p.timer);
    this.pending.clear();
    const home = this.isolatedHome;
    this.isolatedHome = undefined;
    if (!home) return;
    const remove = () => rmSync(home, { recursive: true, force: true });
    if (this.proc.exitCode !== null || this.proc.signalCode !== null) remove();
    else this.proc.once("exit", remove);
  }
}
