import test from "node:test";
import assert from "node:assert/strict";
import { fork, type ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, isAbsolute } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";

// This is a real broker/process test, NOT a PiG or native human-dialog test.
// A child has its own OS process, PI_CODING_AGENT_DIR and socket connection.
if (process.env.PI_COMMS_CROSS_HOME_CHILD === "1") {
  const { IntercomClient } = await import("../src/transport/broker/client.ts");
  const { connect } = await import("../src/transport/start.ts");
  const client = new IntercomClient();
  client.on("error", () => undefined);
  client.on("message", (from, message, approval) => {
    client.sendMessageReceipt({ messageId: message.id, status: "receiver_received", timestamp: Date.now() });
    process.send?.({ type: "incoming", from: from.id, id: message.id, text: message.content.text, approval });
  });
  client.on("disconnected", () => process.send?.({ type: "disconnected" }));
  const brokerPath = process.env.PI_COMMS_TEST_BROKER
    ?? fileURLToPath(new URL("../dist/transport/broker/broker.js", import.meta.url));
  const id = process.env.PI_COMMS_TEST_SESSION_ID!;
  const now = Date.now();
  const registration = {
    name: process.env.PI_COMMS_TEST_NAME ?? "Reviewer",
    cwd: process.cwd(), model: process.env.PI_COMMS_TEST_MODEL ?? "fixture-model",
    pid: process.pid, startedAt: now, lastActivity: now, acknowledgesReceipts: true,
  };
  process.on("message", async (request: any) => {
    const { requestId, operation } = request;
    try {
      let data: unknown;
      if (operation === "list") data = await client.listSessions();
      else if (operation === "send") {
        data = await client.sendExact(request.to, request.epoch, {
          messageId: request.messageId, text: request.text,
        }, request.approval ? { context: request.approval } : undefined);
      } else if (operation === "close") {
        await client.disconnect();
        data = true;
      } else throw new Error("Unknown worker operation");
      process.send?.({ type: "result", requestId, data });
    } catch (error) {
      process.send?.({ type: "result", requestId, error: String(error) });
    }
  });
  try {
    await connect(id, registration, client, pathToFileURL(brokerPath));
    process.send?.({ type: "ready", id: client.sessionId, agentDir: process.env.PI_CODING_AGENT_DIR,
      brokerDir: process.env.PI_COMMS_BROKER_DIR ?? null });
  } catch (error) {
    process.send?.({ type: "failure", error: String(error) });
    process.exitCode = 1;
  }
} else {
  type Worker = {
    child: ChildProcess;
    id: string;
    call: (operation: string, input?: Record<string, unknown>) => Promise<any>;
    incoming: any[];
    events: any[];
    stop: () => Promise<void>;
  };
  const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
  const eventually = async (predicate: () => boolean | Promise<boolean>, label: string) => {
    const deadline = Date.now() + 10000;
    while (!(await predicate())) {
      if (Date.now() > deadline) throw new Error("Timed out: " + label);
      await sleep(25);
    }
  };
  async function worker(home: string, sharedDir: string | null, name = "Reviewer", id = randomUUID(), model = "model-a"): Promise<Worker> {
    mkdirSync(home, { recursive: true });
    const env = { ...process.env, PI_COMMS_CROSS_HOME_CHILD: "1", PI_CODING_AGENT_DIR: home,
      PI_COMMS_TEST_SESSION_ID: id, PI_COMMS_TEST_NAME: name, PI_COMMS_TEST_MODEL: model };
    if (sharedDir) env.PI_COMMS_BROKER_DIR = sharedDir;
    else delete env.PI_COMMS_BROKER_DIR;
    const child = fork(fileURLToPath(import.meta.url), [], {
      execArgv: ["--import", "tsx"], env, stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    const incoming: any[] = [], events: any[] = [], pending = new Map<string, { resolve: (value: any) => void; reject: (error: Error) => void }>();
    let stderr = "";
    child.stderr?.on("data", b => { stderr += b.toString(); });
    child.on("message", (message: any) => {
      events.push(message);
      if (message.type === "incoming") incoming.push(message);
      if (message.type === "result") {
        const p = pending.get(message.requestId);
        if (p) {
          pending.delete(message.requestId);
          if (message.error) p.reject(new Error(message.error));
          else p.resolve(message.data);
        }
      }
    });
    const ready = new Promise<void>((resolve, reject) => {
      const onMessage = (m: any) => {
        if (m.type === "ready") { child.off("message", onMessage); resolve(); }
        if (m.type === "failure") { child.off("message", onMessage); reject(new Error(m.error)); }
      };
      child.on("message", onMessage);
      child.once("exit", code => reject(new Error("Worker exited " + code + ": " + stderr)));
    });
    await ready;
    const call = (operation: string, input: Record<string, unknown> = {}): Promise<any> =>
      new Promise((resolve, reject) => {
        const requestId = randomUUID();
        pending.set(requestId, { resolve, reject });
        child.send?.({ requestId, operation, ...input }, error => {
          if (error) { pending.delete(requestId); reject(error); }
        });
      });
    const stop = async () => {
      if (child.exitCode !== null) return;
      await call("close").catch(() => undefined);
      child.kill("SIGTERM");
      await eventually(() => child.exitCode !== null || child.signalCode !== null, "worker exit");
    };
    return { child, id, call, incoming, events, stop };
  }
  const brokerPid = (dir: string) => Number(readFileSync(join(dir, "broker.pid"), "utf8"));
  const stopBroker = async (dir: string) => {
    let pid: number;
    try { pid = brokerPid(dir); } catch { return; }
    try { process.kill(pid, "SIGTERM"); } catch {}
    await eventually(() => {
      try { process.kill(pid, 0); return false; } catch { return true; }
    }, "broker process exit").catch(() => undefined);
  };
  const sendTo = async (sender: Worker, target: Worker, text: string, approval?: string) => {
    const live = (await sender.call("list")).find((p: any) => p.id === target.id);
    assert.ok(live?.endpointEpoch, "must resolve exact live endpoint and epoch");
    const messageId = randomUUID();
    const result = await sender.call("send", { to: target.id, epoch: live.endpointEpoch,
      messageId, text, approval });
    return { result, messageId };
  };

  test("separate processes and private homes share real broker; exact IDs route despite duplicate names", async () => {
    const root = mkdtempSync(join(tmpdir(), "pc-shared-procs-"));
    const shared = join(root, "shared broker");
    const homes = [join(root, "native"), join(root, "pig-a"), join(root, "pig-b")];
    const clients: Worker[] = [];
    try {
      assert.ok(isAbsolute(shared));
      const a = await worker(homes[0], shared, "Main Pi", randomUUID(), "model-main"); clients.push(a);
      const firstPid = brokerPid(shared);
      const b = await worker(homes[1], shared, "Specialist", randomUUID(), "model-b"); clients.push(b);
      const c = await worker(homes[2], shared, "Specialist", randomUUID(), "model-c"); clients.push(c);
      assert.equal(brokerPid(shared), firstPid, "one broker reused, not forked per home");
      assert.notEqual(a.id, b.id); assert.notEqual(b.id, c.id);
      const roster = await a.call("list");
      assert.deepEqual(new Set([a.id, b.id, c.id]), new Set(roster.map((p: any) => p.id)));
      assert.equal(roster.filter((p: any) => p.name === "Specialist").length, 2);
      assert.notEqual(roster.find((p: any) => p.id === b.id).model,
        roster.find((p: any) => p.id === c.id).model);

      const task = await sendTo(a, b, "Review the retry path", "Approved first contact");
      assert.equal(task.result.delivered, true);
      await eventually(() => b.incoming.length === 1, "initial assignment");
      assert.deepEqual({ from: b.incoming[0].from, approval: b.incoming[0].approval },
        { from: a.id, approval: { context: "Approved first contact" } });
      assert.equal(c.incoming.length, 0, "similar name must not receive the task");
      const question = await sendTo(b, a, "Clarify: retry only reads?");
      assert.equal(question.result.delivered, true);
      await eventually(() => a.incoming.length === 1, "clarification");
      const answer = await sendTo(a, b, "Yes: only reads");
      assert.equal(answer.result.delivered, true);
      const final = await sendTo(b, a, "Finding: a write retry could duplicate side effects");
      assert.equal(final.result.delivered, true);
      await eventually(() => a.incoming.length === 2 && b.incoming.length === 2, "result round trip");
      assert.equal(a.incoming[1].text, "Finding: a write retry could duplicate side effects");
      assert.equal(c.incoming.length, 0);
      await b.stop(); clients.splice(clients.indexOf(b), 1);
      assert.equal((await a.call("list")).some((p: any) => p.id === b.id), false);
      const replacement = await worker(homes[1], shared, "Specialist", randomUUID(), "model-b"); clients.push(replacement);
      assert.notEqual(replacement.id, b.id);
      assert.equal((await a.call("list")).some((p: any) => p.id === b.id), false,
        "never retarget stale native ID to same-named replacement");
    } finally {
      await Promise.all(clients.map(c => c.stop()));
      await stopBroker(shared); rmSync(root, { recursive: true, force: true });
    }
  });

  test("no override retains per-home broker isolation", async () => {
    const root = mkdtempSync(join(tmpdir(), "pc-default-procs-"));
    const aDir = join(root, "a"), bDir = join(root, "b");
    const clients: Worker[] = [];
    try {
      const a = await worker(aDir, null, "A"); clients.push(a);
      const b = await worker(bDir, null, "B"); clients.push(b);
      assert.notEqual(brokerPid(join(aDir, "comms")), brokerPid(join(bDir, "comms")));
      assert.deepEqual((await a.call("list")).map((p: any) => p.id), [a.id]);
      assert.deepEqual((await b.call("list")).map((p: any) => p.id), [b.id]);
    } finally {
      await Promise.all(clients.map(c => c.stop()));
      await Promise.all([aDir, bDir].map(d => stopBroker(join(d, "comms"))));
      rmSync(root, { recursive: true, force: true });
    }
  });
}
