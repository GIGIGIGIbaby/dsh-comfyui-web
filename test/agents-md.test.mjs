import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import { MCP_TOOLS } from '../lib/tool-definitions.js';

const ROOT = new URL('..', import.meta.url);
const TICK = String.fromCharCode(96);

const DOCS = [
  { file: 'AGENTS.md', other: 'AGENTS.en.md', label: 'zh' },
  { file: 'AGENTS.en.md', other: 'AGENTS.md', label: 'en' },
];

const READ = file => readFile(new URL(file, ROOT), 'utf8');

// Only the numbered sections (§1-§4) are instructions for this branch. The header
// table and the appendix talk about a follow-up PR series, so they may name tools
// that are not registered here yet.
async function current(file) {
  const text = await READ(file);
  const from = text.indexOf('## §1');
  const to = text.search(/## (附录|Appendix)/);
  return text.slice(from === -1 ? 0 : from, to === -1 ? text.length : to);
}

const SKELETON = {
  zh: ['## §1 先读什么', '## §2 「装好了」的判据', '## §3 改完 / 装完的规矩', '## §4 给用户的一段提示词'],
  en: ['## §1 What to read first', '## §2 When it counts as installed',
    '## §3 Rules after you change or install something', '## §4 A prompt to hand the user'],
};

const RULES = {
  zh: [/刷新(ComfyUI)?页面/, /重启\s*dsh/, /三处同步/, /占位\s*token/, /npm test/],
  en: [/page must reload|page has to be reloaded/, /must be restarted/, /three places/, /placeholder token/, /npm test/],
};

for (const { file, other, label } of DOCS) {
  test(file + ': keeps the section skeleton an agent is told to follow', async () => {
    const text = await READ(file);
    for (const heading of SKELETON[label]) assert.ok(text.includes(heading), 'missing section: ' + heading);
  });

  test(file + ': links to its translation, and the translation links back', async () => {
    const text = await READ(file);
    assert.ok(text.includes('](' + other + ')'), 'no link to ' + other);
    const twin = await READ(other);
    assert.ok(twin.includes('](' + file + ')'), other + ' does not link back to ' + file);
  });

  test(file + ': only names tools that are actually registered', async () => {
    const registered = new Set(MCP_TOOLS.map(tool => tool.name));
    const body = await current(file);
    // The three calls the prose tells an agent to make. Keep this list explicit:
    // it is the contract, and a rename in lib/tool-definitions.js should break it.
    for (const name of ['server_info', 'list_nodes', 'update_nodes']) {
      assert.ok(body.includes(name), 'the guide no longer mentions ' + name);
      assert.ok(registered.has(name), 'the guide names ' + name + ', which is not a registered tool');
    }
  });

  test(file + ': does not send an agent after unregistered tools', async () => {
    const registered = new Set(MCP_TOOLS.map(tool => tool.name));
    const body = await current(file);
    for (const pending of ['doctor', 'audit', 'lease', 'note_workflow']) {
      if (registered.has(pending)) continue;
      const asTool = body.split(TICK + pending).length - 1;
      assert.equal(asTool, 0, 'the body tells an agent to call ' + pending + ', which is not registered on this branch');
    }
  });

  test(file + ': keeps the rules that cost people the most time', async () => {
    const body = await current(file);
    for (const rule of RULES[label]) {
      assert.match(body, rule, 'a rule that costs people time was dropped: ' + rule);
    }
  });

  test(file + ': points at files that exist in this repository', async () => {
    const body = await current(file);
    // Ordered so that "lib/foo.js" is captured whole, never as a bare "foo.js".
    const paths = new Set(body.match(/(?:lib\/)?[a-z][a-z0-9-]*\.js\b/g) || []);
    assert.ok(paths.size >= 3, 'the reading list lost its file references');
    for (const path of paths) {
      await assert.doesNotReject(() => access(new URL(path, ROOT)),
        file + ' points at ' + path + ', which does not exist');
    }
  });

  test(file + ': stays free of the plugin it was modelled on', async () => {
    assert.doesNotMatch(await READ(file), /blender/i, 'the document must not mention the other plugin');
  });
}

test('both translations name the same set of source files', async () => {
  const paths = async file => new Set((await current(file)).match(/(?:lib\/)?[a-z][a-z0-9-]*\.js\b/g) || []);
  const [zh, en] = await Promise.all([paths('AGENTS.md'), paths('AGENTS.en.md')]);
  assert.deepEqual([...en].sort(), [...zh].sort(), 'the translations disagree about which files to read first');
});
