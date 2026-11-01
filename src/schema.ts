import { Type, type Static, type TSchema } from 'typebox';
import { Check } from 'typebox/value';

export const Id = Type.String({ pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' });
const Text = Type.String({ minLength: 1, pattern: '\\S' });
const Ref = Type.Object({ uri: Text, label: Text }, { additionalProperties: false });
export const WorkRef = Type.String({ minLength: 1, maxLength: 120, pattern: '\\S' });
const RecipientLabel = Type.String({ minLength: 1, maxLength: 120, pattern: '\\S' });
// Optional data alongside the readable message. The sender chooses the field names;
// pi-comms preserves the object and does not interpret domain-specific claims.
const Structured = Type.Object({}, { additionalProperties: true, description: 'Optional JSON object of machine-readable details, not transport proof.' });
const Report = Type.Object({
  request: Type.String({ ...Id, description: 'Exact original request message ID this colleague is reporting on.' }),
  state: Type.Union([
    Type.Literal('progress'), Type.Literal('needs-input'),
    Type.Literal('blocked'), Type.Literal('complete'),
  ], { description: 'Colleague-reported work state; not work acceptance or runtime evidence.' }),
}, { additionalProperties: false, description: 'Optional work report tied to an existing request in this exchange.' });
export const MessageInput = Type.Object({
  to: Type.Optional(Type.String({ ...Text, description: 'Native session ID or current exact unique name. Use only for a new exchange.' })),
  subject: Type.Optional(Type.String({ ...Text, description: 'Subject required with to; omit for a reply.' })),
  respondTo: Type.Optional(Type.String({ ...Id, description: 'Reusable return handle from an incoming message. Omit to and subject. Lost on runtime reset.' })),
  text: Type.String({ ...Text, description: 'Full message payload.' }),
  workRef: Type.Optional(Type.String({ ...WorkRef, description: 'Optional ticket/work reference for a new exchange; replies inherit it. No access control.' })),
  recipientLabel: Type.Optional(Type.String({ ...RecipientLabel, description: 'Optional role/expertise label for the exact recipient in this exchange. New requests only; sender-supplied context, not authority.' })),
  structured: Type.Optional(Structured),
  report: Type.Optional(Report),
  refs: Type.Optional(Type.Array(Ref, { description: 'Work-product pointers, not uploads.' })),
  corrects: Type.Optional(Type.String({ ...Id, description: 'Your earlier message ID to this same peer, when correcting it.' })),
}, { additionalProperties: false });
export type MessageInput = Static<typeof MessageInput>;
export const AskInput = Type.Object({
  requests: Type.Array(MessageInput, { minItems: 1, maxItems: 30, description: 'Independent requests dispatched before waiting. One question is a one-item array.' }),
  timeoutSeconds: Type.Optional(Type.Number({ minimum: 0.1, maximum: 600, description: 'Per-request reply wait, default 60 seconds; starts after transport acceptance, excluding approval time.' })),
}, { additionalProperties: false });
export type AskInput = Static<typeof AskInput>;
export const PeersInput = Type.Object({ view: Type.Optional(Type.Union([Type.Literal('known'), Type.Literal('all')], { description: 'Default all: approved online, other online, then known offline peers. Known filters to approved peers.' })), cursor: Type.Optional(Id) }, { additionalProperties: false });
export const InspectInput = Type.Object({
  requests: Type.Optional(Type.Array(Id, { minItems: 1, maxItems: 30, description: 'Exact outgoing message IDs: response progress for each request, not task completion.' })),
  message: Type.Optional(Type.String({ ...Id, description: 'Inspect one message and its evidence.' })),
  exchange: Type.Optional(Type.String({ ...Id, description: 'Inspect messages in one exchange.' })),
  peer: Type.Optional(Type.String({ ...Text, description: 'Native ID or current exact unique name; list this peer’s exchanges.' })),
  workRef: Type.Optional(Type.String({ ...WorkRef, description: 'List exchanges for this exact work reference available to this session; not a shared transcript.' })),
  queue: Type.Optional(Type.Literal('self', { description: 'Inspect waiting intake without consuming it.' })),
  outbox: Type.Optional(Type.Literal('self', { description: 'Inspect outgoing operations and observed facts.' })),
  cursor: Type.Optional(Type.String({ ...Id, description: 'Continuation from exchange, peer, queue or outbox inspection.' })),
}, { additionalProperties: false, description: 'No selector returns an overview. Supply at most one selector.' });
export type InspectInput = Static<typeof InspectInput>;
export const EnvelopeSchema = Type.Object({
  id: Id, exchange: Id, subject: Text, text: Text, refs: Type.Array(Ref),
  workRef: Type.Optional(WorkRef), recipientLabel: Type.Optional(RecipientLabel),
  structured: Type.Optional(Structured), report: Type.Optional(Report),
  replyTo: Type.Union([Id, Type.Null()]), corrects: Type.Union([Id, Type.Null()]),
  createdAt: Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}T' }),
}, { additionalProperties: false });
export type Envelope = Static<typeof EnvelopeSchema>;
export const Output = Type.Object({ ok: Type.Boolean(), data: Type.Optional(Type.Unknown()), error: Type.Optional(Type.Object({ code: Type.String(), message: Type.String(), nextAction: Type.String() })), observedAt: Type.String() });
export function validate(schema: TSchema, value: unknown) {
  if (!Check<TSchema, unknown>(schema, value)) throw new Error('INVALID_INPUT');
  if (schema === MessageInput) {
    const input = value as MessageInput;
    if (input.respondTo && (input.to !== undefined || input.subject !== undefined)) throw new Error('INVALID_INPUT: reply routing was combined with new-message routing. For a new message use { to, subject, text }; omit respondTo. For a reply use { respondTo, text } with a real incoming return handle; omit to and subject. refs and corrects are optional; use corrects only for a real earlier message ID. No message was sent for this input.');
    if (!input.respondTo && (!input.to || !input.subject)) throw new Error('INVALID_INPUT: new-message routing requires to and subject. Retry with { to, subject, text }, or reply with { respondTo, text }. refs and corrects are optional; never fabricate IDs. No message was sent for this input.');
    if (input.respondTo && (input.workRef !== undefined || input.recipientLabel !== undefined)) throw new Error('INVALID_INPUT: replies inherit the work reference and cannot assign a recipient label. Use { respondTo, text } without workRef or recipientLabel. No message was sent.');
    if (input.report && !input.respondTo) throw new Error('INVALID_INPUT: a work report must reply to an existing request with { respondTo, text, report: { request, state } }. No message was sent.');
  }
  if (schema === AskInput) for (const request of (value as AskInput).requests) validate(MessageInput, request);
  if (schema === InspectInput) {
    const input = value as InspectInput;
    const selectors = ['message', 'exchange', 'peer', 'workRef', 'queue', 'outbox', 'requests'].filter(key => key in input);
    if (selectors.length > 1 || (input.cursor && (!selectors.length || input.message || input.requests))) throw new Error('INVALID_INPUT: use one selector; cursor requires a paged view');
  }
}
// Below the reused transport's 1 MiB frame bound, including routing metadata.
export const MAX_ENVELOPE_BYTES = 900_000;
export function checkSize(value: unknown, contactContext?: string) {
  if (Buffer.byteLength(JSON.stringify({ content: { text: JSON.stringify(value) }, ...(contactContext ? { contactApproval: { context: contactContext } } : {}) })) > MAX_ENVELOPE_BYTES) throw new Error('INVALID_INPUT: message exceeds 900000 bytes; send a work-product reference instead');
}
