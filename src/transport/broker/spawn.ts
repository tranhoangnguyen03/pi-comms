import { spawn } from "child_process";
import { existsSync, mkdirSync, readFileSync, rmdirSync, statSync, unlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { fileURLToPath } from "url";
import net from "net";
import { randomUUID } from "crypto";
import type { BrokerRuntimeInfo } from "../types.ts";
import { createMessageReader, writeMessage } from "./framing.ts";
import {
  ensureIntercomRuntimeDir,
  getAgentDirPath,
  getBrokerConnectTarget,
  getBrokerPidFilePath,
  getIntercomDirPath,
  INTERCOM_PROTOCOL_NAME,
  INTERCOM_PROTOCOL_VERSION,
  INTERCOM_RUNTIME_FILE_MODE,
  restrictIntercomRuntimeFile,
  type BrokerConnectTarget,
} from "./paths.ts";
import {
  isBrokerVersionOlder,
  isProcessAlive,
  readBrokerArtifactVersion,
  readBrokerPidMetadata,
  verifyBrokerProcess,
} from "./runtime-claim.ts";

export { verifyBrokerProcess } from "./runtime-claim.ts";

const INTERCOM_DIR = getIntercomDirPath();
const BROKER_PID = getBrokerPidFilePath(INTERCOM_DIR);
const BROKER_SPAWN_LOCK = join(INTERCOM_DIR, "broker.spawn.lock");
const BROKER_RECLAIM_LOCK = `${BROKER_SPAWN_LOCK}.reclaim`;
const BROKER_STARTUP_STDERR_LIMIT = 4_000;
const BROKER_RETIRE_TIMEOUT_MS = 2_500;
const BROKER_START_TIMEOUT_MS = 5_000;
const BROKER_LOCK_WAIT_TIMEOUT_MS = BROKER_RETIRE_TIMEOUT_MS + BROKER_START_TIMEOUT_MS + 1_500;

type BrokerLaunchSpec = {
  command: string;
  args: string[];
  captureStartupStderr: boolean;
};

export type BrokerHealthProbe = { ok: boolean } & BrokerRuntimeInfo;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function isBrokerHealthOkMessage(message: unknown, requestId: string): boolean {
  if (typeof message !== "object" || message === null || !("type" in message)) {
    return false;
  }
  const response = message as Record<string, unknown>;
  return response.type === "health_ok"
    && response.requestId === requestId
    && response.protocol === INTERCOM_PROTOCOL_NAME
    && response.version === INTERCOM_PROTOCOL_VERSION;
}

function isBrokerAcceptable(health: BrokerHealthProbe, targetVersion?: string): boolean {
  return health.ok && !isBrokerVersionOlder(health.packageVersion, targetVersion);
}

export function getBrokerSpawnOptions(
  env: NodeJS.ProcessEnv = process.env,
  captureStderr = true,
): {
  detached: true;
  stdio: "ignore" | ["ignore", "ignore", "pipe"];
  cwd: string;
  env: NodeJS.ProcessEnv;
  windowsHide: true;
} {
  const agentDir = getAgentDirPath(env);
  return {
    detached: true,
    stdio: captureStderr ? ["ignore", "ignore", "pipe"] : "ignore",
    // Windows locks a process's cwd against renames, so keep it outside the package.
    cwd: getIntercomDirPath(agentDir),
    env: { ...env, PI_CODING_AGENT_DIR: agentDir, NODE_NO_WARNINGS: "1" },
    windowsHide: true,
  };
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export async function spawnBrokerIfNeeded(brokerURL: URL): Promise<void> {
  ensureIntercomRuntimeDir(INTERCOM_DIR);
  const targetVersion = readBrokerArtifactVersion(brokerURL);
  const deadline = Date.now() + BROKER_LOCK_WAIT_TIMEOUT_MS;

  while (true) {
    if (isBrokerAcceptable(await isBrokerRunning(), targetVersion)) {
      return;
    }

    const lockToken = acquireSpawnLock();
    if (!lockToken) {
      const outcome = await waitForBrokerOrReclaim(targetVersion, Math.max(deadline - Date.now(), 250));
      if (outcome === "ready") {
        return;
      }
      continue;
    }

    try {
      const current = await isBrokerRunning();
      if (isBrokerAcceptable(current, targetVersion)) {
        return;
      }
      if (current.ok && isBrokerVersionOlder(current.packageVersion, targetVersion)) {
        // Pre-F12 brokers keep any queued mail in RAM only; replacing an older broker
        // discards that RAM state. Verify the broker process before sending SIGTERM.
        if (!await retireOutdatedBroker(current)) {
          return;
        }
      }

      const launch: BrokerLaunchSpec = { command: process.execPath, args: [fileURLToPath(brokerURL)], captureStartupStderr: true };
      const child = spawn(launch.command, launch.args, getBrokerSpawnOptions(process.env, launch.captureStartupStderr));
      let brokerStderr = "";
      const rememberBrokerStderr = (chunk: Buffer | string) => {
        brokerStderr = `${brokerStderr}${chunk.toString()}`.slice(-BROKER_STARTUP_STDERR_LIMIT);
      };
      const brokerStartupError = (message: string, cause?: unknown) => {
        const stderr = brokerStderr.trim();
        const errorMessage = stderr ? `${message}\nBroker stderr:\n${stderr}` : message;
        return cause === undefined ? new Error(errorMessage) : new Error(errorMessage, { cause });
      };
      child.stderr?.on("data", rememberBrokerStderr);
      // The detached broker's diagnostic pipe must not keep its starter alive.
      if (child.stderr instanceof net.Socket) child.stderr.unref();
      child.unref();

      await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          child.stderr?.off("data", rememberBrokerStderr);
          child.stderr?.resume();
          child.off("error", onError);
          child.off("close", onExit);
        };

        const onError = (error: Error) => {
          cleanup();
          reject(brokerStartupError(`Failed to spawn intercom broker: ${error.message}`, error));
        };

        const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
          cleanup();
          if (signal) {
            reject(brokerStartupError(`Intercom broker exited before startup with signal ${signal}`));
            return;
          }
          reject(brokerStartupError(`Intercom broker exited before startup with code ${code ?? "unknown"}`));
        };

        child.once("error", onError);
        child.once("close", onExit);
        waitForStartedBroker(targetVersion, BROKER_START_TIMEOUT_MS).then(() => {
          cleanup();
          resolve();
        }, (error) => {
          cleanup();
          const startupError = toError(error);
          reject(brokerStartupError(startupError.message, startupError));
        });
      });
      return;
    } finally {
      releaseSpawnLock(lockToken);
    }
  }
}

async function retireOutdatedBroker(current: BrokerHealthProbe): Promise<boolean> {
  const filePid = readBrokerPidMetadata(BROKER_PID).pid;
  if (current.pid !== undefined && filePid !== undefined && current.pid !== filePid) {
    return false;
  }
  const pid = current.pid ?? filePid;
  if (!pid || !verifyBrokerProcess(pid, INTERCOM_DIR)) {
    return false;
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return true;
    return false;
  }
  const deadline = Date.now() + BROKER_RETIRE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid) && !(await probeBrokerHealth()).ok) {
      return true;
    }
    await sleep(20);
  }
  return !isProcessAlive(pid) && !(await probeBrokerHealth()).ok;
}

async function isBrokerRunning(): Promise<BrokerHealthProbe> {
  const first = await probeBrokerHealth();
  if (first.ok) {
    return first;
  }

  const { pid } = readBrokerPidMetadata(BROKER_PID);
  if (!pid || !isProcessAlive(pid)) {
    return { ok: false };
  }
  return probeBrokerHealth();
}

function connectToBrokerTarget(target: BrokerConnectTarget): net.Socket {
  return typeof target === "string"
    ? net.connect(target)
    : net.connect({ host: target.host, port: target.port });
}

function probeBrokerHealth(): Promise<BrokerHealthProbe> {
  return new Promise((resolve) => {
    let target: BrokerConnectTarget;
    try {
      target = getBrokerConnectTarget();
    } catch {
      resolve({ ok: false });
      return;
    }

    const socket = connectToBrokerTarget(target);
    const requestId = randomUUID();
    const expectedStateId = typeof target === "string" ? undefined : target.stateId;
    let settled = false;
    const finish = (probe: BrokerHealthProbe) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      socket.off("connect", onConnect);
      socket.off("error", onError);
      socket.off("data", reader);
      socket.destroy();
      resolve(probe);
    };
    const onConnect = () => {
      try {
        writeMessage(socket, {
          type: "health",
          requestId,
          ...(expectedStateId ? { stateId: expectedStateId } : {}),
        });
      } catch {
        finish({ ok: false });
      }
    };
    const onError = () => finish({ ok: false });
    const reader = createMessageReader((message) => {
      if (!isBrokerHealthOkMessage(message, requestId)) {
        finish({ ok: false });
        return;
      }
      const response = message as Record<string, unknown>;
      finish({
        ok: true,
        ...(typeof response.packageVersion === "string" ? { packageVersion: response.packageVersion } : {}),
        ...(Number.isSafeInteger(response.pid) && Number(response.pid) > 0 ? { pid: Number(response.pid) } : {}),
        ...(Number.isSafeInteger(response.startedAt) && Number(response.startedAt) > 0 ? { startedAt: Number(response.startedAt) } : {}),
      });
    }, () => finish({ ok: false }));
    socket.on("connect", onConnect);
    socket.on("error", onError);
    socket.on("data", reader);
    const timeout = setTimeout(() => finish({ ok: false }), 1000);
  });
}

function writeSpawnLockFile(token: string): void {
  writeFileSync(BROKER_SPAWN_LOCK, `${process.pid}\n${Date.now()}\n${token}\n`, {
    flag: "wx",
    mode: INTERCOM_RUNTIME_FILE_MODE,
  });
  restrictIntercomRuntimeFile(BROKER_SPAWN_LOCK);
}

function acquireSpawnLock(): string | null {
  const token = randomUUID();
  const maxRetries = 5;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      writeSpawnLockFile(token);
      return token;
    } catch (error) {
      if (!(error instanceof Error) || (error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
      if (!isSpawnLockStale()) {
        return null;
      }
      if (reclaimStaleSpawnLock(token)) {
        return token;
      }
    }
  }
  return null;
}

function reclaimStaleSpawnLock(token: string): boolean {
  let acquiredReclaimDir = false;
  try {
    mkdirSync(BROKER_RECLAIM_LOCK, { mode: 0o700 });
    acquiredReclaimDir = true;
  } catch {
    try {
      if (Date.now() - statSync(BROKER_RECLAIM_LOCK).mtimeMs > 5_000) {
        rmdirSync(BROKER_RECLAIM_LOCK);
      }
    } catch {}
    return false;
  }

  try {
    if (!isSpawnLockStale()) {
      return false;
    }
    try {
      unlinkSync(BROKER_SPAWN_LOCK);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
    }
    writeSpawnLockFile(token);
    return true;
  } catch {
    return false;
  } finally {
    if (acquiredReclaimDir) {
      try { rmdirSync(BROKER_RECLAIM_LOCK); } catch {}
    }
  }
}

function isSpawnLockStale(): boolean {
  if (!existsSync(BROKER_SPAWN_LOCK)) {
    return false;
  }

  try {
    const [pidLine = "", createdAtLine = "0"] = readFileSync(BROKER_SPAWN_LOCK, "utf-8").trim().split("\n");
    const pid = Number.parseInt(pidLine, 10);
    const createdAt = Number.parseInt(createdAtLine, 10);
    // Never preempt a live lock owner based on elapsed time alone.
    if (Number.isSafeInteger(pid) && pid > 0) {
      return !isProcessAlive(pid);
    }
    return !Number.isFinite(createdAt) || Date.now() - createdAt > 10_000;
  } catch {
    // Unreadable lock contents are treated as stale so a new broker can start.
    return true;
  }
}

function releaseSpawnLock(token: string): void {
  try {
    const [, , currentToken = ""] = readFileSync(BROKER_SPAWN_LOCK, "utf-8").trim().split("\n");
    if (currentToken !== token) return;
    unlinkSync(BROKER_SPAWN_LOCK);
  } catch {
    // Another cleanup path may already have removed the lock.
  }
}

async function waitForStartedBroker(targetVersion?: string, timeoutMs = BROKER_START_TIMEOUT_MS): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (isBrokerAcceptable(await probeBrokerHealth(), targetVersion)) {
      return;
    }
    await sleep(50);
  }
  throw new Error("Broker failed to start within timeout");
}

async function waitForBrokerOrReclaim(targetVersion: string | undefined, timeoutMs: number): Promise<"ready" | "reclaim"> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const health = await probeBrokerHealth();
    if (isBrokerAcceptable(health, targetVersion)) {
      return "ready";
    }
    if (!existsSync(BROKER_SPAWN_LOCK) || isSpawnLockStale()) {
      return isBrokerAcceptable(await probeBrokerHealth(), targetVersion) ? "ready" : "reclaim";
    }
    await sleep(50);
  }
  throw new Error("Broker failed to start within timeout");
}
