import { expect } from 'vitest';
import { test } from '@sofia/testkit';
import { displayCommand, getAggregateRowLabel, getAggregateSummary, type AnyToolPart } from '../../apps/app/src/lib/tool-aggregate';

let id = 0;
const tool = (toolName: string, input: unknown, state: 'output-available' | 'input-available' = 'output-available'): AnyToolPart =>
  ({ type: 'dynamic-tool', toolName, toolCallId: `call-${++id}`, state, input, output: 'ok' });

test('a run of tool calls summarizes with counts, files counted once', () => {
  const parts = [
    tool('bash', { command: 'pnpm test' }),
    tool('bash', { command: 'pnpm lint' }),
    tool('bash', { command: 'git status' }),
    tool('bash', { command: 'ls' }),
    tool('edit', { filePath: '/repo/a.ts' }),
    tool('edit', { filePath: '/repo/a.ts' }),
    tool('write', { filePath: '/repo/b.ts' }),
  ];
  expect(getAggregateSummary(parts, 'past')).toBe('Edited 2 files, ran 4 commands');
  expect(getAggregateSummary([tool('bash', { command: 'ls' }, 'input-available')], 'present')).toBe('Running a command');
  expect(getAggregateSummary([tool('read', { filePath: '/repo/x.md' }), tool('read', { filePath: '/repo/y.md' })], 'past')).toBe('Read 2 files');
});

test('commands read as typed, without the login-shell wrapper', () => {
  expect(displayCommand(`/bin/zsh -lc 'git status --short'`)).toBe('git status --short');
  expect(displayCommand(`bash -c "echo hi"`)).toBe('echo hi');
  expect(displayCommand(`/bin/zsh -lc 'echo '\\''quoted'\\'''`)).toBe(`echo 'quoted'`);
  expect(displayCommand('pnpm typecheck')).toBe('pnpm typecheck');
  expect(getAggregateRowLabel(tool('bash', { command: `/bin/zsh -lc 'wc -l package.json'` }))).toBe('Ran wc -l package.json');
});
