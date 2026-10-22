import test from 'node:test';
import assert from 'node:assert/strict';
import { MCP_TOOLS, nativeToolSchema } from '../lib/tool-definitions.js';

test('native schemas use host identity and attachment references instead of model-supplied sessions or encoded files', () => {
  for (const tool of MCP_TOOLS) {
    const schema = nativeToolSchema(tool);
    assert.equal(schema.properties.sessionId, undefined);
    for (const key of schema.required || []) assert.ok(key in schema.properties);
  }
  const upload = nativeToolSchema(MCP_TOOLS.find(tool => tool.name === 'upload_image'));
  assert.ok(upload.properties.attachmentId); assert.equal(upload.properties.dataBase64, undefined); assert.equal(upload.properties.mediaType, undefined);
  assert.ok(MCP_TOOLS.find(tool => tool.name === 'upload_image').inputSchema.properties.dataBase64);
});

test('graph schemas require fields per action and mutation hints reflect affected data', () => {
  const variants = MCP_TOOLS.find(tool => tool.name === 'edit_graph').inputSchema.properties.operations.items.oneOf;
  assert.deepEqual(variants.find(item => item.properties.op.const === 'connect').required,
    ['op', 'fromNodeId', 'fromSlot', 'toNodeId', 'toSlot']);
  assert.deepEqual(variants.find(item => item.properties.op.const === 'disconnect').required, ['op', 'nodeId', 'toSlot']);
  assert.ok(variants.every(item => item.additionalProperties === false));
  for (const name of ['interrupt', 'cancel_task', 'load_workflow', 'restore_edit', 'save_workflow', 'edit_graph'])
    assert.equal(MCP_TOOLS.find(tool => tool.name === name).annotations.destructiveHint, true);
  assert.equal(MCP_TOOLS.find(tool => tool.name === 'switch_workflow').annotations.idempotentHint, true);
  assert.equal(MCP_TOOLS.find(tool => tool.name === 'new_workflow').annotations.idempotentHint, false);
});

test('list_nodes no longer advertises a writability pre-judgement', () => {
  // R6-8: the removed `writable` field predicted success from the widget kind and was wrong in both
  // directions. The description must not resurrect that promise, and must point at the census instead.
  const listed = MCP_TOOLS.find(tool => tool.name === 'list_nodes');
  assert.doesNotMatch(listed.description, /writable 只说明|writable 是/);
  assert.match(listed.description, /audit\(op=writes\)/);
  assert.match(listed.description, /verified/, 'per-write proof is the only authority');
});
