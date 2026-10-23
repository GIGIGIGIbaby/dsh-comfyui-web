import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const bridgeSource = readFileSync(new URL('../bridge.js', import.meta.url), 'utf8');

function loadBridgeForUuidTest({ cryptoValue, randomImpl }) {
  const warnings = [];
  const window = {
    __DSH_COMFYUI_BOOTSTRAP__: { token: 'test-token', bridgeBase: 'https://example.test' },
    __DSH_COMFYUI_BRIDGE_ACTIVE__: false,
    __DSH_BRIDGE_TOKEN__: 'test-token',
    location: { origin: 'https://comfy.test', search: '', href: 'https://comfy.test/' },
    parent: null,
    document: {
      referrer: 'https://dsh.test/',
      visibilityState: 'visible',
      addEventListener() {},
      removeEventListener() {}
    },
    localStorage: {
      getItem() { return null; },
      setItem() {}
    },
    addEventListener() {},
    removeEventListener() {},
    comfyAPI: {},
    crypto: cryptoValue,
    console: { warn(...args) { warnings.push(args); } },
    fetch: async () => ({
      ok: true,
      status: 200,
      async json() {
        return { token: 'test-token', bridgeProtocol: 6, commands: [] };
      },
      async text() {
        return '';
      }
    }),
    EventSource: class {
      constructor() {}
      close() {}
      onopen = null;
      onmessage = null;
      onerror = null;
    },
    setTimeout() { return 0; },
    clearTimeout() {}
  };

  const context = {
    window,
    self: window,
    globalThis: window,
    document: window.document,
    location: window.location,
    console: window.console,
    fetch: window.fetch,
    EventSource: window.EventSource,
    URL,
    URLSearchParams,
    localStorage: window.localStorage,
    crypto: cryptoValue,
    Math: Object.create(Math),
    setTimeout: window.setTimeout,
    clearTimeout: window.clearTimeout
  };

  context.Math.random = randomImpl;

  // Inject before the *last* `})();` — the outer IIFE's own closer. The file contains smaller
  // `(() => …)()` expressions too, and replacing the first match dropped the export in the middle of
  // a switch statement, which only showed up as "window.__test_randomUUID is not a function".
  const cut = bridgeSource.lastIndexOf('})();');
  const patchedSource = bridgeSource.slice(0, cut)
    + 'window.__test_randomUUID = randomUUID; window.__test_randomUUID_state = { warnedWeakUUID };'
    + bridgeSource.slice(cut);

  vm.runInNewContext(patchedSource, context, { filename: 'bridge.js' });
  window.__test_warnings = warnings;
  return window;
}

function makeDeterministicRandom() {
  let seed = 1;
  return () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
}

test('bridge UUID fallback generates valid v4 UUIDs when crypto is unavailable', () => {
  const window = loadBridgeForUuidTest({
    cryptoValue: undefined,
    randomImpl: makeDeterministicRandom()
  });

  const uuid1 = window.__test_randomUUID();
  const uuid2 = window.__test_randomUUID();

  const v4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

  assert.match(uuid1, v4);
  assert.match(uuid2, v4);
  assert.notEqual(uuid1, uuid2);
  assert.equal(window.__test_warnings.length, 1);
});

test('bridge UUID fallback generates valid v4 UUIDs when randomUUID is missing and getRandomValues throws', () => {
  let cryptoCalls = 0;
  const window = loadBridgeForUuidTest({
    cryptoValue: {
      getRandomValues() {
        cryptoCalls++;
        throw new Error('crypto.getRandomValues failed');
      }
    },
    randomImpl: makeDeterministicRandom()
  });

  const uuid1 = window.__test_randomUUID();
  const uuid2 = window.__test_randomUUID();

  const v4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

  assert.match(uuid1, v4);
  assert.match(uuid2, v4);
  assert.notEqual(uuid1, uuid2);
  assert.ok(cryptoCalls > 0, 'the throwing crypto mock must actually be used');
  assert.equal(window.__test_warnings.length, 1);
});

test('bridge UUID prefers native randomUUID without using fallback sources', () => {
  const uuid = '12345678-1234-4234-8234-123456789abc';
  const window = loadBridgeForUuidTest({
    cryptoValue: {
      randomUUID: () => uuid,
      getRandomValues() { throw new Error('unexpected fallback'); }
    },
    randomImpl() { throw new Error('unexpected Math.random'); }
  });
  assert.equal(window.__test_randomUUID(), uuid);
  assert.equal(window.__test_warnings.length, 0);
});

test('bridge UUID uses getRandomValues when native randomUUID is unavailable', () => {
  let calls = 0;
  const window = loadBridgeForUuidTest({
    cryptoValue: {
      getRandomValues(bytes) { bytes.fill(++calls); return bytes; }
    },
    randomImpl() { throw new Error('unexpected Math.random'); }
  });
  const uuid1 = window.__test_randomUUID();
  const uuid2 = window.__test_randomUUID();
  const v4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  assert.match(uuid1, v4);
  assert.match(uuid2, v4);
  assert.notEqual(uuid1, uuid2);
  assert.ok(calls > 0);
  assert.equal(window.__test_warnings.length, 0);
});
