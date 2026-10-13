import { expect } from 'vitest';
import { test } from '@sofia/testkit';
import { getAggregateSummary, getAggregateRowLabel, getAggregateRowFile, getToolFamily, type AnyToolPart } from '../../apps/app/src/lib/tool-aggregate';
const tool = (toolName:string,input:unknown):AnyToolPart => ({type:'dynamic-tool',toolName,toolCallId:toolName,state:'output-available',input,output:'recorded'});
test('mixed recorded and native action families produce narrative summaries and individual action text',()=>{
 const parts=[tool('apply_patch',{filePath:'/work/source.ts'}),tool('read',{filePath:'/work/notes.md'}),tool('bash',{command:'pnpm typecheck'}),tool('websearch',{query:'official documentation'})];
 expect(getAggregateSummary(parts,'past')).toBe('Edited files, read files, ran a command, searched the web');
 expect(getAggregateSummary(parts,'present')).toBe('Editing files, reading files, running a command, searching the web');
 expect(getAggregateRowFile(parts[0]!)).toEqual({verb:'Edited',path:'/work/source.ts'});
 expect(getAggregateRowLabel(parts[2]!)).toBe('Ran pnpm typecheck');
 expect(getAggregateRowLabel(parts[3]!)).toBe('Searched the web for official documentation');
 expect(getToolFamily(parts[3]!)).toBe('web');
 expect(getToolFamily(tool('unknown',{command:'cat notes.md'}))).toBeNull();
 expect(getToolFamily(tool('bash',{command:'cat notes.md'}))).toBe('command');
});
