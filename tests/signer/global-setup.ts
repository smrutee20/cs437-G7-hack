// Builds the signer bundle and runs it in the pinned workerd binary on a free
// loopback port with a random per-run service credential. Also runs a separate
// test-only worker (vector-worker.ts) that exposes the library's native RSA-RAW
// path without the 3072-bit policy, so RFC 9474's 4096-bit vector can be checked.
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, openSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "rolldown";
import type { TestProject } from "vitest/node";

declare module "vitest" {
  interface ProvidedContext {
    signerUrl: string;
    signerToken: string;
    vectorSignerUrl: string;
    signerLogPath: string;
    signerControlUrl: string;
  }
}

const root = resolve(import.meta.dirname, "../..");
const workerdBinary = resolve(root, "node_modules/@cloudflare/workerd-linux-64/bin/workerd");

function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => (typeof address === "object" && address ? resolvePort(address.port) : reject(new Error("no port"))));
    });
  });
}

async function waitForHealth(url: string, token: string, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`SETUP ERROR: workerd exited with ${child.exitCode} before becoming ready.`);
    try {
      const response = await fetch(`${url}/health`, { headers: { authorization: `Bearer ${token}` } });
      if (response.ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error("SETUP ERROR: workerd signer did not become ready within 15 s.");
}

export default async function setup(project: TestProject) {
  try {
    execFileSync(workerdBinary, ["--version"], { stdio: "ignore" });
  } catch {
    throw new Error(`SETUP ERROR: pinned workerd binary is missing at ${workerdBinary}. Run \`npm ci\`.`);
  }
  execFileSync("npm", ["run", "build", "-w", "@iitgn-feedback/signer"], { cwd: root, stdio: "ignore" });

  const scratch = mkdtempSync(join(tmpdir(), "feedback-signer-test-"));
  await build({
    input: resolve(import.meta.dirname, "vector-worker.ts"),
    platform: "neutral",
    resolve: { conditionNames: ["source", "import", "default"], mainFields: ["module", "main"] },
    output: { file: join(scratch, "vector-worker.js"), format: "esm" },
    logLevel: "silent",
  });
  writeFileSync(
    join(scratch, "vector.capnp"),
    `using Workerd = import "/workerd/workerd.capnp";
const config :Workerd.Config = (
  services = [(name = "vector", worker = .w), (name = "no-network", network = (allow = []))],
  sockets = [(name = "http", address = "127.0.0.1:0", http = (), service = "vector")],
);
const w :Workerd.Worker = (
  modules = [(name = "worker.js", esModule = embed "vector-worker.js")],
  compatibilityDate = "2026-10-01",
  globalOutbound = "no-network",
);
`,
  );

  const token = randomBytes(32).toString("base64url");
  const logPath = join(scratch, "signer.log");
  const children = new Set<ChildProcess>();
  let signer: ChildProcess;
  let signerUrl = "";

  // Restartable production signer (same port), so tests can prove keys survive a restart.
  const startSigner = async (port: number) => {
    const log = openSync(logPath, "a");
    signer = spawn(workerdBinary, ["serve", "config.capnp", "--socket-addr", `http=127.0.0.1:${port}`], {
      cwd: resolve(root, "services/signer"),
      env: { PATH: process.env.PATH, SIGNER_SERVICE_TOKEN: token },
      stdio: ["ignore", log, log],
    });
    children.add(signer);
    signerUrl = `http://127.0.0.1:${port}`;
    await waitForHealth(signerUrl, token, signer);
  };
  const stopSigner = () =>
    new Promise<void>((resolveStop) => {
      if (signer.exitCode !== null) return resolveStop();
      signer.once("exit", () => resolveStop());
      signer.kill("SIGTERM");
    });

  await startSigner(await freePort());

  const vectorPort = await freePort();
  const vector = spawn(workerdBinary, ["serve", "vector.capnp", "--socket-addr", `http=127.0.0.1:${vectorPort}`], {
    cwd: scratch,
    env: { PATH: process.env.PATH },
    stdio: ["ignore", "ignore", "ignore"],
  });
  children.add(vector);
  await waitForHealth(`http://127.0.0.1:${vectorPort}`, "", vector);

  // Tiny loopback control endpoint so a test file can request a signer restart.
  const controlPort = await freePort();
  const control = createServer((socket) => {
    socket.once("data", async () => {
      await stopSigner();
      await startSigner(Number(new URL(signerUrl).port));
      socket.end("restarted");
    });
  }).listen(controlPort, "127.0.0.1");

  project.provide("signerUrl", signerUrl);
  project.provide("signerToken", token);
  project.provide("vectorSignerUrl", `http://127.0.0.1:${vectorPort}`);
  project.provide("signerLogPath", logPath);
  project.provide("signerControlUrl", `127.0.0.1:${controlPort}`);

  return async () => {
    control.close();
    for (const child of children) if (child.exitCode === null) child.kill("SIGTERM");
    rmSync(scratch, { recursive: true, force: true });
  };
}
