import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NoteStore, normalizeTarget } from '../lib/notes.js';

const store = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-comfy-notes-'));
  return { dir, notes: await new NoteStore(join(dir, 'usage-notes.json')).start() };
};

test('a bare node type and an explicit prefix land on the same key', () => {
  assert.equal(normalizeTarget('KSampler'), 'node:KSampler');
  assert.equal(normalizeTarget('node:KSampler'), 'node:KSampler');
  assert.equal(normalizeTarget('workflows/demo.json'), 'workflow:workflows/demo.json');
  assert.equal(normalizeTarget('demo.json'), 'workflow:demo.json');
  assert.equal(normalizeTarget('  '), null, 'an empty target is refused rather than silently keyed under ""');
});

test('notes dedupe, keep newest last, and cap at five', async () => {
  const { notes } = await store();
  const target = 'node:AICG3DPromptSegmentSplit';
  await notes.add(target, 'first');
  const again = await notes.add(target, 'first');
  assert.equal(again.deduplicated, true, 'the same line must not accumulate');
  assert.deepEqual(again.notes, ['first']);
  for (const line of ['second', 'third', 'fourth', 'fifth', 'sixth']) await notes.add(target, line);
  const { notes: capped } = await notes.add(target, 'seventh');
  assert.equal(capped.length, 5, 'it is a note list, not a log');
  assert.equal(capped.at(-1), 'seventh', 'the newest line is the one that survives');
  assert.equal(capped.includes('first'), false, 'the oldest line is the one that goes');
});

test('notes survive a restart and collapse whitespace', async () => {
  const { dir, notes } = await store();
  await notes.add('node:KSampler', '  write   the\nshadow doc  ');
  const reopened = await new NoteStore(join(dir, 'usage-notes.json')).start();
  assert.deepEqual(reopened.read('KSampler'), ['write the shadow doc']);
  const raw = JSON.parse(await readFile(join(dir, 'usage-notes.json'), 'utf8'));
  assert.equal(raw.version, 1);
});

test('relevant() answers with the active workflow plus only the types asked for', async () => {
  const { notes } = await store();
  await notes.add('workflow:workflows/demo.json', 'this graph needs the H3 pack loaded first');
  await notes.add('node:KSampler', 'steps above 30 times out on this box');
  await notes.add('node:AICG3DPromptSegmentSplit', 'write it through globalThis.AICG3D_H3.setPromptText');
  const found = notes.relevant({ workflowPath: 'workflows/demo.json', types: ['KSampler'] });
  assert.deepEqual(found.map(item => item.target), ['workflow:workflows/demo.json', 'node:KSampler'],
    'an unrelated node type must not ride along and push the useful line out of the reply');
  assert.deepEqual(notes.relevant({ workflowPath: 'workflows/other.json', types: ['Unknown'] }), []);
});

test('an empty note is refused with the sentence to write instead', async () => {
  const { notes } = await store();
  await assert.rejects(notes.add('node:KSampler', '   '), /note 不能为空/);
  await assert.rejects(notes.add('', 'x'), /note 需要 target/);
});
