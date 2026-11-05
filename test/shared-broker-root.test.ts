import assert from "node:assert/strict";
import { test } from "node:test";
import {
  getAgentDirPath, getIntercomDirPath, getBrokerSocketPath,
  getBrokerConnectTarget, getBrokerListenTarget,
} from "../src/transport/broker/paths.ts";

test("default broker remains agent-home scoped", () => {
  const env = { PI_CODING_AGENT_DIR: "/tmp/reviewer-a" };
  assert.equal(getAgentDirPath(env), "/tmp/reviewer-a");
  assert.equal(getIntercomDirPath("/tmp/reviewer-a", env), "/tmp/reviewer-a/comms");
  assert.equal(getBrokerConnectTarget("linux", env), "/tmp/reviewer-a/comms/broker.sock");
});

test("explicit shared broker leaves individual agent dirs untouched", () => {
  const root = "/tmp/pi-comms-shared";
  const a = { PI_CODING_AGENT_DIR: "/tmp/reviewer-a", PI_COMMS_BROKER_DIR: root };
  const b = { PI_CODING_AGENT_DIR: "/tmp/engineer-b", PI_COMMS_BROKER_DIR: root };
  assert.notEqual(getAgentDirPath(a), getAgentDirPath(b));
  assert.equal(getIntercomDirPath(getAgentDirPath(a), a), root);
  assert.equal(getBrokerConnectTarget("linux", a), root + "/broker.sock");
  assert.equal(getBrokerListenTarget("linux", b), root + "/broker.sock");
  assert.equal(getBrokerSocketPath("win32", getAgentDirPath(a), a),
    getBrokerSocketPath("win32", getAgentDirPath(b), b));
});

test("reject relative shared broker path rather than making it cwd-dependent", () => {
  const env = { PI_CODING_AGENT_DIR: "/tmp/reviewer-a", PI_COMMS_BROKER_DIR: "../shared" };
  assert.throws(() => getIntercomDirPath(getAgentDirPath(env), env), /absolute path/);
  assert.throws(() => getBrokerConnectTarget("linux", env), /absolute path/);
});
