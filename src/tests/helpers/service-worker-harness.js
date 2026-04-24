/**
 * Service Worker Test Harness
 *
 * Loads the real `service-worker.js` into a Node VM context with mocked
 * `browser`/`chrome` APIs so integration tests exercise production code —
 * not a reimplementation.
 *
 * Capabilities:
 *   - Captures all listener registrations (onDeterminingFilename, onChanged,
 *     onMessage, onCommand, onContextMenuClick, onStorageChanged)
 *   - Exposes a `fire*` API to simulate Chrome dispatching events
 *   - Supports simulating the full download lifecycle
 *
 * Why VM rather than require(): service-worker.js uses importScripts() which
 * is not a Node primitive, and its top-level code registers listeners as
 * side effects. A VM lets us stub importScripts, load the real shared
 * defaults first, then run the real SW code.
 */

const fs = require('fs');
const vm = require('vm');
const path = require('path');

const SRC_DIR = path.resolve(__dirname, '../..');

function createBrowserMock() {
  const listeners = {
    onDeterminingFilename: [],
    downloadsOnChanged: [],
    onMessage: [],
    storageOnChanged: [],
    onCommand: [],
    contextMenusOnClicked: [],
  };

  const calls = {
    downloads: [],
    sendMessage: [],
    executeScript: [],
    contextMenusCreate: [],
  };

  let nextDownloadId = 1;

  const mock = {
    runtime: {
      id: 'test-ext-id',
      lastError: null,
      getPlatformInfo: () => Promise.resolve({ os: 'mac', arch: 'arm64' }),
      getBrowserInfo: () => Promise.resolve({ name: 'test', version: '1.0' }),
      getManifest: () => ({ name: 'MarkSnip', version: 'test', manifest_version: 3 }),
      getURL: (p) => `chrome-extension://test-ext-id/${p}`,
      sendMessage: jest.fn((...args) => {
        calls.sendMessage.push(args);
        return Promise.resolve();
      }),
      onMessage: {
        addListener: (fn) => listeners.onMessage.push(fn),
        removeListener: (fn) => {
          const i = listeners.onMessage.indexOf(fn);
          if (i >= 0) listeners.onMessage.splice(i, 1);
        },
      },
    },
    storage: {
      sync: {
        get: (defaults) => Promise.resolve(defaults),
        set: () => Promise.resolve(),
      },
      local: {
        get: () => Promise.resolve({}),
        set: () => Promise.resolve(),
      },
      onChanged: {
        addListener: (fn) => listeners.storageOnChanged.push(fn),
      },
    },
    contextMenus: {
      create: jest.fn((props, cb) => {
        calls.contextMenusCreate.push(props);
        if (cb) cb();
        return props.id;
      }),
      removeAll: jest.fn(() => Promise.resolve()),
      update: jest.fn(() => Promise.resolve()),
      remove: jest.fn(() => Promise.resolve()),
      onClicked: {
        addListener: (fn) => listeners.contextMenusOnClicked.push(fn),
      },
    },
    commands: {
      onCommand: {
        addListener: (fn) => listeners.onCommand.push(fn),
      },
    },
    downloads: {
      download: jest.fn((opts) => {
        const id = nextDownloadId++;
        calls.downloads.push({ id, ...opts });
        return Promise.resolve(id);
      }),
      onChanged: {
        addListener: (fn) => listeners.downloadsOnChanged.push(fn),
        removeListener: (fn) => {
          const i = listeners.downloadsOnChanged.indexOf(fn);
          if (i >= 0) listeners.downloadsOnChanged.splice(i, 1);
        },
      },
      onDeterminingFilename: {
        addListener: (fn) => listeners.onDeterminingFilename.push(fn),
        removeListener: (fn) => {
          const i = listeners.onDeterminingFilename.indexOf(fn);
          if (i >= 0) listeners.onDeterminingFilename.splice(i, 1);
        },
      },
    },
    tabs: {
      query: () => Promise.resolve([]),
      get: (id) => Promise.resolve({ id, url: 'https://example.com' }),
      sendMessage: jest.fn(() => Promise.resolve()),
      onUpdated: { addListener: () => {}, removeListener: () => {} },
      onRemoved: { addListener: () => {}, removeListener: () => {} },
    },
    scripting: {
      executeScript: jest.fn((inj) => {
        calls.executeScript.push(inj);
        return Promise.resolve([{ result: null }]);
      }),
      insertCSS: jest.fn(() => Promise.resolve()),
    },
    offscreen: {
      createDocument: jest.fn(() => Promise.resolve()),
      closeDocument: jest.fn(() => Promise.resolve()),
      hasDocument: jest.fn(() => Promise.resolve(true)),
    },
    action: {
      setBadgeText: jest.fn(),
      setBadgeBackgroundColor: jest.fn(),
      setIcon: jest.fn(),
    },
  };

  return { mock, listeners, calls };
}

function createSandbox(mock) {
  let blobCounter = 0;
  return {
    browser: mock,
    chrome: mock,
    console,
    URL: {
      createObjectURL: jest.fn(() => `blob:chrome-extension://test-ext-id/blob-${++blobCounter}`),
      revokeObjectURL: jest.fn(),
    },
    Blob: class Blob {
      constructor(parts, opts) {
        this.parts = parts;
        this.type = (opts && opts.type) || '';
      }
    },
    Map,
    Set,
    Promise,
    Array,
    Date,
    Object,
    Error,
    JSON,
    Math,
    Symbol,
    RegExp,
    Number,
    String,
    Boolean,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    globalThis: null,
  };
}

/**
 * Load the real service-worker.js in a VM with mocked browser APIs.
 *
 * @returns {{
 *   listeners: object,
 *   browser: object,
 *   calls: object,
 *   fireMessage: (message: object, sender?: object) => Promise<any>,
 *   fireOnDeterminingFilename: (item: object) => { suggestCalls: Array, returnValue: any },
 *   fireDownloadChanged: (delta: object) => Promise<void>,
 *   sandbox: object,
 * }}
 */
function loadServiceWorker() {
  const { mock, listeners, calls } = createBrowserMock();
  const sandbox = createSandbox(mock);
  sandbox.globalThis = sandbox;

  const context = vm.createContext(sandbox);

  // Load DownloadRegistry first (SW instantiates it at top level)
  const registryCode = fs.readFileSync(path.join(SRC_DIR, 'background/download-registry.js'), 'utf8');
  vm.runInContext(registryCode, context, { filename: 'background/download-registry.js' });

  // Load shared defaults (defines defaultOptions, getOptions)
  const sharedDefaults = fs.readFileSync(path.join(SRC_DIR, 'shared/default-options.js'), 'utf8');
  vm.runInContext(sharedDefaults, context, { filename: 'shared/default-options.js' });

  // Load context-menus helper (defines createMenus)
  const ctxMenus = fs.readFileSync(path.join(SRC_DIR, 'shared/context-menus.js'), 'utf8');
  try {
    vm.runInContext(ctxMenus, context, { filename: 'shared/context-menus.js' });
  } catch (e) {
    // Context menu creation errors are non-fatal for the tests we care about.
  }

  // Load service-worker.js with importScripts stubbed out (we loaded the
  // relevant shared scripts manually above; moment/mime/polyfill aren't
  // needed for download-conflict tests).
  let swCode = fs.readFileSync(path.join(SRC_DIR, 'service-worker.js'), 'utf8');

  // Guard: if the SW stops calling importScripts, the stub silently does
  // nothing and our shared-defaults load covers the gap — but if it starts
  // using a DIFFERENT importScripts shape the regex won't catch, we want
  // to fail loudly.
  if (!/^\s*importScripts\s*\(/m.test(swCode)) {
    throw new Error('service-worker.js no longer starts with importScripts(); update harness');
  }
  swCode = swCode.replace(/^\s*importScripts\s*\([\s\S]*?\);\s*$/m, '/* importScripts stubbed */');

  let initError = null;
  try {
    vm.runInContext(swCode, context, { filename: 'service-worker.js' });
  } catch (e) {
    // Some top-level init may throw (e.g., context menu creation). We
    // surface this to tests so silent regressions in SW init are visible.
    initError = e;
  }

  if (listeners.onDeterminingFilename.length === 0) {
    throw new Error('Service worker failed to register onDeterminingFilename listener');
  }
  if (listeners.onMessage.length === 0) {
    throw new Error('Service worker failed to register onMessage listener');
  }
  if (listeners.downloadsOnChanged.length === 0) {
    throw new Error('Service worker failed to register downloads.onChanged listener');
  }

  /** Fire a runtime message to the SW's registered handler. */
  async function fireMessage(message, sender = {}) {
    const handler = listeners.onMessage[0];
    const sendResponse = jest.fn();
    const result = handler(message, sender, sendResponse);
    if (result && typeof result.then === 'function') await result;
    return sendResponse.mock.calls;
  }

  /**
   * Fire a downloads.onDeterminingFilename event against ALL registered
   * listeners (production registers one, but we call all for safety) and
   * collect any suggest() calls.
   */
  function fireOnDeterminingFilename(downloadItem) {
    const suggestCalls = [];
    const suggest = (arg) => suggestCalls.push(arg);
    const returnValues = [];
    for (const fn of listeners.onDeterminingFilename) {
      returnValues.push(fn(downloadItem, suggest));
    }
    // Convenience for the single-listener case production uses today.
    return { suggestCalls, returnValue: returnValues[returnValues.length - 1], returnValues };
  }

  /** Fire a downloads.onChanged event to all registered listeners. */
  async function fireDownloadChanged(delta) {
    // Snapshot — listeners may mutate on completion
    const snapshot = [...listeners.downloadsOnChanged];
    for (const fn of snapshot) {
      await fn(delta);
    }
  }

  return {
    listeners,
    browser: mock,
    calls,
    sandbox,
    initError,
    fireMessage,
    fireOnDeterminingFilename,
    fireDownloadChanged,
  };
}

module.exports = { loadServiceWorker };
