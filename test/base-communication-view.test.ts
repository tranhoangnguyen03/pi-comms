import test from 'node:test';
import assert from 'node:assert/strict';
import { ACTIVITY_STALE_MS, observationLabel, peerActivity, peerSummary, requestOutcomeLabel, requestNextAction } from '../src/communication-view.ts';
import { modelView } from '../src/model-view.ts';

test('peer activity separates live, stale, absent and unsupported observations', () => {
  const now = Date.UTC(2026, 10, 1, 12);
  const current = peerActivity({ status: 'working', statusReportedAt: now - 1_000 }, now);
  assert.equal(current.activity, 'working');
  assert.equal(current.activityFreshness, 'recent');
  assert.match(current.activityObservedAt!, /^2026-11-01T/);
  assert.match(peerSummary({ presence: 'online', ...current }), /working/);
  const stale = peerActivity({ status: 'idle', statusReportedAt: now - ACTIVITY_STALE_MS - 1 }, now);
  assert.equal(stale.activity, 'unknown');
  assert.equal(stale.activityFreshness, 'stale');
  assert.equal(stale.lastReportedActivity, 'idle');
  assert.match(peerSummary({ presence: 'online', ...stale }), /stale/);
  assert.equal(peerActivity({ status: 'planning', statusReportedAt: now }, now).activityFreshness, 'unknown');
  assert.equal(peerActivity({ status: 'idle', lastActivity: now } as any, now).activityFreshness, 'unknown', 'unrelated broker activity is not status evidence');
  assert.equal(peerActivity({ status: 'idle', statusReportedAt: now + 60_000 }, now).activityFreshness, 'unknown');
  assert.equal(peerActivity(undefined, now).activityFreshness, 'unavailable');
  assert.match(peerSummary({ presence: 'offline', ...current }), /unavailable/);
});

test('one observed-fact vocabulary and outcome guidance keep claims distinct', () => {
  assert.equal(observationLabel({ facts: [{ kind: 'accepted' }] }), 'Accepted by transport');
  assert.equal(observationLabel({ facts: [{ kind: 'queued' }] }), 'Buffered in receiver memory');
  assert.equal(observationLabel({ facts: [{ kind: 'posted' }] }), 'Posted to Pi');
  assert.equal(observationLabel({ facts: [{ kind: 'saved' }] }), 'Observed in native history');
  assert.match(observationLabel({ state: 'unknown' }), /Outcome unknown/);
  assert.equal(requestOutcomeLabel('replied'), requestOutcomeLabel('reply-received'));
  assert.match(requestNextAction('timeout')!, /later reply/);
  assert.match(requestNextAction('unknown')!, /before considering a resend/);
  assert.equal(requestNextAction('replied'), undefined);
});

test('agent projections make peer freshness and request outcomes useful without inferring completion', () => {
  const now = Date.UTC(2026, 10, 1, 12);
  const activity = peerActivity({ status: 'idle', statusReportedAt: now }, now);
  const roster = modelView({ items: [{ id: 'peer-id', name: 'Reviewer', presence: 'online', approved: true, ...activity }] }, () => 'Reviewer');
  assert.match(roster, /Reviewer.*online.*idle/);
  assert.match(roster, /observed 2026-11-01/);
  const wait = modelView({ timeoutSeconds: 60, items: [{ peer: 'peer-id', subject: 'Review', request: 'request-id', outcome: 'timeout' }] }, () => 'Reviewer');
  assert.match(wait, /No reply before wait ended/);
  assert.match(wait, /late reply can still arrive/);
  assert.doesNotMatch(wait, /work complete/i);
});
