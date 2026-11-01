import test from 'node:test';
import assert from 'node:assert/strict';
import { Check } from 'typebox/value';
import { MessageInput, AskInput, validate } from '../src/schema.ts';

const reply = { respondTo: '12345678-1234-1234-1234-123456789abc', text: 'Findings' };
const send = { to: 'Reviewer', subject: 'Review', text: 'Findings' };
const tools = [
  { name: 'comms_message', description: 'Send or reply', parameters: MessageInput },
  { name: 'comms_ask', description: 'Ask peers', parameters: AskInput },
];
function checkSchemas(schemas: any[]) {
  const [message, ask] = schemas;
  assert.deepEqual(message.required, ['text']);
  assert.deepEqual(ask.properties.requests.items.required, ['text']);
  for (const input of [send, reply]) {
    assert.ok(Check(message, input));
    assert.ok(Check(ask, { requests: [input] }));
  }
}

test('serialized and provider-facing schemas preserve minimal sends and replies', async () => {
  checkSchemas(JSON.parse(JSON.stringify(tools)).map((tool: any) => tool.parameters));
  const { convertTools } = await import('../node_modules/@earendil-works/pi-ai/dist/api/google-shared.js');
  for (const legacy of [false, true]) {
    checkSchemas(convertTools(tools, legacy)![0].functionDeclarations.map((d: any) => d.parameters ?? d.parametersJsonSchema));
  }
  const { convertResponsesTools } = await import('../node_modules/@earendil-works/pi-ai/dist/api/openai-responses-shared.js');
  checkSchemas(convertResponsesTools(tools).map((d: any) => d.parameters));
});

test('OpenAI completions outbound payload preserves optional fields without network access', async () => {
  const { stream } = await import('../node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js');
  for (const supportsStrictMode of [undefined, true]) {
    let captured = false;
    const result = await stream({
      id: 'schema-fixture', name: 'Schema fixture', api: 'openai-completions', provider: '9-router',
      baseUrl: 'http://127.0.0.1:1/v1', reasoning: false, input: ['text'],
      ...(supportsStrictMode ? { compat: { supportsStrictMode } } : {}),
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 100,
    }, { messages: [{ role: 'system', content: 'Schema test', toolsAdded: tools, timestamp: 0 }, { role: 'user', content: 'Test', timestamp: 0 }] }, {
      apiKey: 'non-secret-test-key',
      onPayload(payload: any) {
        checkSchemas(payload.tools.map((t: any) => t.function.parameters));
        assert.ok(payload.tools.every((t: any) => t.function.strict === (supportsStrictMode ? false : undefined)));
        captured = true;
        throw new Error('SCHEMA_CAPTURE_COMPLETE');
      },
      fetch: async () => { throw new Error('NETWORK_MUST_NOT_BE_USED'); },
    }).result();
    assert.ok(captured, result.errorMessage);
    assert.match(result.errorMessage!, /SCHEMA_CAPTURE_COMPLETE/);
  }
});

test('routing failures provide minimal recovery and optional correction IDs stay optional', () => {
  for (const input of [send, reply, { ...reply, corrects: reply.respondTo }]) validate(MessageInput, input);
  for (const routing of [{ to: send.to }, { subject: send.subject }, send]) {
    assert.throws(() => validate(MessageInput, { ...reply, ...routing }), /For a new message use \{ to, subject, text \}; omit respondTo\. For a reply use \{ respondTo, text \} with a real incoming return handle; omit to and subject.*No message was sent for this input/);
  }
  for (const input of [{ text: 'Findings' }, { to: send.to, text: 'Findings' }, { subject: send.subject, text: 'Findings' }]) {
    assert.throws(() => validate(MessageInput, input), /new-message routing requires to and subject/);
  }
  assert.throws(() => validate(AskInput, { requests: [send, { ...reply, to: send.to }] }), /reply routing was combined/);
});
