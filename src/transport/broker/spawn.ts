import { spawn } from "child_process";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { fileURLToPath } from "url";
import net from "net";
import { randomUUID } from "crypto";
import { createMessageReader, writeMessage } from "./framing.ts";
import {
  ensureIntercomRuntimeDir,
  getAgentDirPath,
  getBrokerConnectTarget,
  getIntercomDirPath,
  INTERCOM_PROTOCOL_NAME,
  INTERCOM_PROTOCOL_VERSION,
  INTERCOM_RUNTIME_FILE_MODE,
  restrictIntercomRuntimeFile,
  type BrokerConnectTarget,
} from "./paths.ts";

const INTERCOM_DIR = getIntercomDirPath();
const BROKER_PID = join(INTERCOM_DIR, "broker.pid");
const BROKER_SPAWN_LOCK = join(INTERCOM_DIR, "broker.spawn.lock");
const BROKER_STARTUP_STDERR_LIMIT = 4_000;

type BrokerLaunchSpec = {
  command: string;
  args: string[];
  captureStartupStderr: boolean;
};

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

  if (await isBrokerRunning()) {
    return;
  }

  const ownsLock = acquireSpawnLock();
  if (!ownsLock) {
    await waitForBroker();
    return;
  }

  try {
    if (await isBrokerRunning()) {
      return;
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
      waitForBroker().then(() => {
        cleanup();
        resolve();
      }, (error) => {
        cleanup();
        const startupError = toError(error);
        reject(brokerStartupError(startupError.message, startupError));
      });
    });
  } finally {
    releaseSpawnLock();
  }
}

/**
 * A reachable socket is not necessarily a compatible pi-comms broker. Do not
 * replace its path just because the health protocol differs: the other process
 * may be running with a missing or stale PID file.
 */
type BrokerProbe = "healthy" | "occupied" | "unreachable";

async function isBrokerRunning(): Promise<boolean> {
  const result = await probeBroker();
  if (result === "healthy") return true;
  if (result === "occupied") {
    throw new Error(
      `An existing process is listening at the pi-comms broker endpoint in ${INTERCOM_DIR}, ` +
      "but it does not answer the supported health protocol. Stop that process, " +
      "then restart the participating Pi sessions with the same compatible pi-comms build. " +
      "The existing socket was not removed.",
    );
  }

  if (!existsSync(BROKER_PID)) return false;
  try {
    const pid = Number.parseInt(readFileSync(BROKER_PID, "utf-8").trim(), 10);
    if (!Number.isSafeInteger(pid) || pid <= 0) return false;
    process.kill(pid, 0);
    throw new Error(
      `pi-comms broker process ${pid} is still running but its endpoint in ${INTERCOM_DIR} ` +
      "does not respond. Stop/restart this broker before connecting; refusing to replace it.",
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    if (error instanceof Error && error.message.includes("refusing to replace")) throw error;
    if ((error as NodeJS.ErrnoException).code === "EPERM") {
      throw new Error("Cannot replace a broker owned by another process/user; stop it first.");
    }
    return false;
  }
}

function connectToBrokerTarget(target: BrokerConnectTarget): net.Socket {
  return typeof target === "string"
    ? net.connect(target)
    : net.connect({ host: target.host, port: target.port });
}

function probeBroker(): Promise<BrokerProbe> {
  return new Promise((resolve) => {
    let target: BrokerConnectTarget;
    try {
      target = getBrokerConnectTarget();
    } catch {
      resolve("unreachable");
      return;
    }

    const socket = connectToBrokerTarget(target);
    const requestId = randomUUID();
    const expectedStateId = typeof target === "string" ? undefined : target.stateId;
    let settled = false;
    let connected = false;
    const finish = (state: BrokerProbe) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.off("connect", onConnect);
      socket.off("error", onError);
      socket.off("data", reader);
      socket.destroy();
      resolve(state);
    };
    const onConnect = () => {
      connected = true;
      try {
        writeMessage(socket, {
          type: "health",
          requestId,
          ...(expectedStateId ? { stateId: expectedStateId } : {}),
        });
      } catch {
        finish("occupied");
      }
    };
    const onError = () => finish(connected ? "occupied" : "unreachable");
    const reader = createMessageReader((message) => {
      finish(isBrokerHealthOkMessage(message, requestId) ? "healthy" : "occupied");
    }, () => finish("occupied"));
    socket.on("connect", onConnect);
    socket.on("error", onError);
    socket.on("data", reader);
    const timeout = setTimeout(() => finish(connected ? "occupied" : "unreachable"), 1000);
  });
}

function acquireSpawnLock(): boolean {
  const maxRetries = 5;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      writeFileSync(BROKER_SPAWN_LOCK, `${process.pid}\n${Date.now()}\n`, {
        flag: "wx",
        mode: INTERCOM_RUNTIME_FILE_MODE,
      });
      restrictIntercomRuntimeFile(BROKER_SPAWN_LOCK);
      return true;
    } catch (error) {
      if (!(error instanceof Error) || (error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
      if (isSpawnLockStale()) {
        try {
          unlinkSync(BROKER_SPAWN_LOCK);
        } catch {
          // If we can't delete the stale lock, retry a few times before giving up
        }
        continue;
      }
      return false;
    }
  }
  return false;
}

function isSpawnLockStale(): boolean {
  if (!existsSync(BROKER_SPAWN_LOCK)) {
    return false;
  }

  try {
    const [pidLine = "", createdAtLine = "0"] = readFileSync(BROKER_SPAWN_LOCK, "utf-8").trim().split("\n");
    const pid = Number.parseInt(pidLine, 10);
    const createdAt = Number.parseInt(createdAtLine, 10);
    const ageMs = Date.now() - createdAt;

    if (Number.isFinite(pid)) {
      try {
        process.kill(pid, 0);
      } catch {
        // The process that created the lock is gone.
        return true;
      }
    }

    return !Number.isFinite(createdAt) || ageMs > 10_000;
  } catch {
    // Unreadable lock contents are treated as stale so a new broker can start.
    return true;
  }
}

function releaseSpawnLock(): void {
  try {
    unlinkSync(BROKER_SPAWN_LOCK);
  } catch {
    // Another cleanup path may already have removed the lock.
  }
}

async function waitForBroker(timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await isBrokerRunning()) {
      return;
    }
    await sleep(100);
  }
  throw new Error("Broker failed to start within timeout");
}
