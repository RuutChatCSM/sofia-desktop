import { expect } from 'vitest';
import { test } from '@sofia/testkit';
import {
  createReasoningClock,
  formatThoughtDuration,
  isLongReasoning,
  reasoningLabel,
} from '../../apps/app/src/components/chat/reasoning-presentation';

test('thinking header reads "Thinking…" live and "Thought for Ns" once settled', () => {
  expect(reasoningLabel({ isStreaming: true, durationMs: null })).toBe('Thinking…');
  expect(reasoningLabel({ isStreaming: false, durationMs: 12_300 })).toBe('Thought for 12s');
  expect(reasoningLabel({ isStreaming: false, durationMs: 200 })).toBe('Thought for 1s');
  expect(reasoningLabel({ isStreaming: false, durationMs: 95_000 })).toBe('Thought for 1m 35s');
  // Restored history was never seen running: no invented duration.
  expect(reasoningLabel({ isStreaming: false, durationMs: null })).toBe('Thought');
  expect(formatThoughtDuration(59_600)).toBe('1m 0s');
});

test('a reasoning phase is timed across packet gaps and never for history', () => {
  const clock = createReasoningClock();
  expect(clock('phase', true, 1_000)).toBeNull();
  // A gap between two packets reads as settled for a moment...
  expect(clock('phase', false, 2_000)).toBe(1_000);
  // ...and resuming keeps timing the same phase instead of freezing at 1s.
  expect(clock('phase', true, 3_000)).toBeNull();
  expect(clock('phase', false, 6_000)).toBe(5_000);
  // Settled re-renders keep the frozen duration.
  expect(clock('phase', false, 60_000)).toBe(5_000);
  expect(clock('restored', false, 1_000)).toBeNull();
});

test('only long settled reasoning is capped behind "Show more"', () => {
  expect(isLongReasoning('A short thought.')).toBe(false);
  expect(isLongReasoning('word '.repeat(400))).toBe(true);
  expect(isLongReasoning(Array.from({ length: 15 }, (_, i) => `step ${i}`).join('\n'))).toBe(true);
  expect(isLongReasoning(Array.from({ length: 14 }, (_, i) => `step ${i}`).join('\n'))).toBe(false);
});
