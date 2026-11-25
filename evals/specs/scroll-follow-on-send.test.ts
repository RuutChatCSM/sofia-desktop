import { expect } from 'vitest';
import { test } from '@sofia/testkit';
import { shouldFollowSentMessage } from '../../apps/app/src/react-app/domains/session/surface/scroll-intent';

const mark = (latestId: string | null, count: number, sessionId = 'task-a') => ({ sessionId, latestId, count });

test('sending a message returns a scrolled-up reader to the tail', () => {
  expect(shouldFollowSentMessage(mark('u2', 2), mark('u3', 3))).toBe(true);
});

test('history, id reconciliation and session switches never move the reader', () => {
  // First history load of a task.
  expect(shouldFollowSentMessage(null, mark('u9', 9))).toBe(false);
  expect(shouldFollowSentMessage(mark(null, 0), mark('u9', 9))).toBe(false);
  // Older history paged in above: more messages, same latest one.
  expect(shouldFollowSentMessage(mark('u9', 9), mark('u9', 20))).toBe(false);
  // A pending message taking its server id: new latest id, same count.
  expect(shouldFollowSentMessage(mark('pending-1', 3), mark('u3', 3))).toBe(false);
  // Opening another task.
  expect(shouldFollowSentMessage(mark('u2', 2), mark('b5', 5, 'task-b'))).toBe(false);
});
