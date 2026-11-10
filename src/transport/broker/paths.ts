import { chmodSync, mkdirSync, readFileSync } from "fs";
import { isAbsolute, join, resolve } from "path";
import { homedir } from "os";

export const INTERCOM_DIR_MODE = 0o700;
export const INTERCOM_RUNTIME_FILE_MODE = 0o600;
export const INTERCOM_TCP_HOST = "127.0.0.1";
export const INTERCOM_PROTOCOL_NAME = "pi-comms";
export const INTERCOM_PROTOCOL_VERSION = 1;

export interface BrokerTcpEndpoint {
  transport: "tcp";
  host: string;
  port: number;
  stateId?: string;
}

export type BrokerConnectTarget = string | BrokerTcpEndpoint;

function sanitizePipeSegment(value: string): string {
  return value
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase() || "default";
}

export function getAgentDirPath(
  env: NodeJS.ProcessEnv = process.env,
  homeDir: string = homedir(),
  cwd: string = process.cwd(),
): string {
  const configured = env.PI_CODING_AGENT_DIR?.trim();
  if (!configured) {
    return join(homeDir, ".pi/agent");
  }

  return isAbsolute(configured) ? configured : resolve(cwd, configured);
}

/** Opt-in same-user broker address shared by independently installed Pi/PiG homes.
 * The host's own PI_CODING_AGENT_DIR remains the owner of its sessions and keys.
 */
export function getIntercomDirPath(
  agentDir: string = getAgentDirPath(),
  env: NodeJS.ProcessEnv = process.env,
): string {
  const override = env.PI_COMMS_BROKER_DIR?.trim();
  if (override) {
    if (!isAbsolute(override)) throw Error("PI_COMMS_BROKER_DIR must be an absolute path");
    return resolve(override);
  }
  return join(agentDir, "comms");
}

export function shouldUseWindowsTcpTransport(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (platform !== "win32") {
    return false;
  }

  const transport = env.PI_COMMS_TRANSPORT?.trim().toLowerCase();
  if (transport === "tcp") {
    return true;
  }

  const legacyOptIn = env.PI_COMMS_TCP?.trim().toLowerCase();
  return legacyOptIn === "1" || legacyOptIn === "true";
}

export function getBrokerPortFilePath(intercomDir: string = getIntercomDirPath()): string {
  return join(intercomDir, "broker.port.json");
}

export function getBrokerPidFilePath(intercomDir: string = getIntercomDirPath()): string {
  return join(intercomDir, "broker.pid");
}

export function getBrokerSocketPath(
  platform: NodeJS.Platform = process.platform,
  agentDir: string = getAgentDirPath(),
  env: NodeJS.ProcessEnv = process.env,
): string {
  const dir = getIntercomDirPath(agentDir, env);
  if (platform === "win32") {
    return `\\\\.\\pipe\\pi-comms-${sanitizePipeSegment(dir)}`;
  }

  return join(dir, "broker.sock");
}

export function getBrokerConnectTarget(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  intercomDir: string = getIntercomDirPath(getAgentDirPath(env), env),
): BrokerConnectTarget {
  if (shouldUseWindowsTcpTransport(platform, env)) {
    const endpointFile = getBrokerPortFilePath(intercomDir);
    const raw = readFileSync(endpointFile, "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error(`Invalid intercom TCP endpoint at ${endpointFile}: expected a JSON object`);
    }
    const endpoint = parsed as Record<string, unknown>;
    if (
      endpoint.transport !== "tcp"
      || endpoint.host !== INTERCOM_TCP_HOST
      || typeof endpoint.port !== "number"
      || !Number.isSafeInteger(endpoint.port)
      || endpoint.port <= 0
      || endpoint.port > 65535
      || typeof endpoint.stateId !== "string"
      || endpoint.stateId.length === 0
    ) {
      throw new Error(`Invalid intercom TCP endpoint at ${endpointFile}`);
    }
    return { transport: "tcp", host: endpoint.host, port: endpoint.port, stateId: endpoint.stateId };
  }

  return getBrokerSocketPath(platform, getAgentDirPath(env), env);
}

export function getBrokerListenTarget(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): BrokerConnectTarget {
  if (shouldUseWindowsTcpTransport(platform, env)) {
    return { transport: "tcp", host: INTERCOM_TCP_HOST, port: 0 };
  }

  return getBrokerSocketPath(platform, getAgentDirPath(env));
}

export function ensureIntercomRuntimeDir(
  intercomDir: string = getIntercomDirPath(),
  platform: NodeJS.Platform = process.platform,
): void {
  mkdirSync(intercomDir, { recursive: true, mode: INTERCOM_DIR_MODE });
  if (platform !== "win32") {
    chmodSync(intercomDir, INTERCOM_DIR_MODE);
  }
}

export function restrictIntercomRuntimeFile(
  filePath: string,
  platform: NodeJS.Platform = process.platform,
): void {
  if (platform !== "win32") {
    chmodSync(filePath, INTERCOM_RUNTIME_FILE_MODE);
  }
}
