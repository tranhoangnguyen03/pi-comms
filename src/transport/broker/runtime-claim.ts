import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { sameCwd } from "../cwd.ts";
import { getBrokerPidFilePath, getIntercomDirPath } from "./paths.ts";

declare const __PI_COMMS_PACKAGE_VERSION__: string | undefined;

export const INTERCOM_PACKAGE_VERSION: string = (() => {
  if (typeof __PI_COMMS_PACKAGE_VERSION__ === "string" && __PI_COMMS_PACKAGE_VERSION__.trim()) {
    return __PI_COMMS_PACKAGE_VERSION__.trim();
  }
  try {
    const pkg = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8")) as { version?: unknown };
    return typeof pkg.version === "string" && pkg.version.trim() ? pkg.version.trim() : "0.0.0";
  } catch {
    return "0.0.0";
  }
})();

export interface ParsedSemver {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
}

export function parseSemver(version: string | undefined): ParsedSemver | null {
  if (typeof version !== "string") return null;
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(version.trim());
  if (!match) return null;
  const major = Number(match[1]), minor = Number(match[2]), patch = Number(match[3]);
  if (![major, minor, patch].every(part => Number.isSafeInteger(part) && part >= 0)) return null;
  const prerelease = match[4] ? match[4].split(".") : [];
  if (prerelease.some(part => !part.length)) return null;
  return { major, minor, patch, prerelease };
}

function comparePrerelease(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return 1; // Release has higher precedence than prerelease.
  if (b.length === 0) return -1;
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const left = a[i], right = b[i];
    if (left === undefined) return -1;
    if (right === undefined) return 1;
    if (left === right) continue;
    const leftNum = /^\d+$/.test(left) ? Number(left) : null;
    const rightNum = /^\d+$/.test(right) ? Number(right) : null;
    if (leftNum !== null && rightNum !== null) return leftNum < rightNum ? -1 : 1;
    if (leftNum !== null) return -1; // Numeric identifiers have lower precedence than non-numeric.
    if (rightNum !== null) return 1;
    return left < right ? -1 : 1;
  }
  return 0;
}

export function compareSemver(a: string | undefined, b: string | undefined): number | null {
  const left = parseSemver(a), right = parseSemver(b);
  if (!left || !right) return null;
  if (left.major !== right.major) return left.major < right.major ? -1 : 1;
  if (left.minor !== right.minor) return left.minor < right.minor ? -1 : 1;
  if (left.patch !== right.patch) return left.patch < right.patch ? -1 : 1;
  return comparePrerelease(left.prerelease, right.prerelease);
}

export function isBrokerVersionOlder(runningVersion: string | undefined, targetVersion: string | undefined): boolean {
  if (!parseSemver(targetVersion)) return false;
  if (!runningVersion) return true;
  const cmp = compareSemver(runningVersion, targetVersion);
  return cmp !== null && cmp < 0;
}

export function readBrokerArtifactVersion(brokerURL: URL): string | undefined {
  try {
    const raw = readFileSync(new URL("../../VERSION", brokerURL), "utf8").trim();
    return parseSemver(raw) ? raw : undefined;
  } catch {
    return undefined;
  }
}

/** Clients share this host, so a signal-0 probe tells whether a claimed pid still runs. */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function readBrokerPidMetadata(pidPath: string = getBrokerPidFilePath()): { pid?: number; mtimeMs?: number } {
  try {
    const pid = Number.parseInt(readFileSync(pidPath, "utf8").trim(), 10);
    const mtimeMs = statSync(pidPath).mtimeMs;
    return {
      ...(Number.isSafeInteger(pid) && pid > 0 ? { pid } : {}),
      ...(Number.isFinite(mtimeMs) && mtimeMs > 0 ? { mtimeMs: Math.trunc(mtimeMs) } : {}),
    };
  } catch {
    return {};
  }
}

function readProcessCommandLine(pid: number): string | undefined {
  if (process.platform === "linux") {
    try {
      const raw = readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0+/g, " ").trim();
      if (raw) return raw;
    } catch {
      // Fall through to ps.
    }
  }
  try {
    if (process.platform === "win32") {
      return execFileSync(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", `(Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}").CommandLine`],
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 3000 },
      ).trim();
    }
    return execFileSync("ps", ["-p", String(pid), "-o", "command="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1500,
    }).trim();
  } catch {
    return undefined;
  }
}

function readProcessCwd(pid: number): string | undefined {
  if (process.platform === "linux") {
    try {
      return realpathSync(`/proc/${pid}/cwd`);
    } catch {
      // Fall through to lsof.
    }
  }
  if (process.platform === "win32") return undefined;
  try {
    const out = execFileSync("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1500,
    });
    const line = out.split(/\r?\n/).find(entry => entry.startsWith("n"));
    return line ? line.slice(1).trim() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Verify that `pid` is a live pi-comms broker process for `intercomDir` before sending SIGTERM.
 * Requires the process to be signalable by this user, running `transport/broker/broker.(js|ts)`,
 * and (when process cwd is inspectable) running in `intercomDir`.
 */
export function verifyBrokerProcess(pid: number, intercomDir: string = getIntercomDirPath()): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid) return false;
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  const cmdline = readProcessCommandLine(pid);
  if (!cmdline || !/[\\/]transport[\\/]broker[\\/]broker\.(?:[cm]?js|ts)(?:$|[\s"'\0])/.test(cmdline)) {
    return false;
  }
  const procCwd = readProcessCwd(pid);
  if (procCwd && !sameCwd(procCwd, intercomDir)) {
    return false;
  }
  return true;
}

export function assertNoLiveBroker(pidPath: string): void {
  if (!existsSync(pidPath)) return;
  const { pid } = readBrokerPidMetadata(pidPath);
  if (!pid) return;

  try {
    process.kill(pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
    throw error;
  }
  throw new Error(`Refusing to replace live intercom broker process ${pid}`);
}
