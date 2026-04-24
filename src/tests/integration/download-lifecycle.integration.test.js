/**
 * Integration tests: per-download cleanup listener and image download paths.
 *
 * These complement download-filename-conflict.integration.test.js by
 * covering:
 *   - The per-download onChanged listener registered inside
 *     handleDownloadWithBlobUrl / handleImageDownloadsDirectly (this
 *     factory triggers blob cleanup messaging in addition to the shared
 *     handleDownloadChange cleanup)
 *   - Image download tracking (both blob-source and external-URL cases)
 *
 * Both run against the real service-worker.js via the VM harness.
 */

const { loadServiceWorker } = require('../helpers/service-worker-harness');

beforeAll(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'info').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

describe('[integration] per-download cleanup listener (downloadListener factory)', () => {
  test('registers a new listener when a download starts', async () => {
    const sw = loadServiceWorker();
    const before = sw.listeners.downloadsOnChanged.length;

    await sw.fireMessage({
      type: 'service-worker-download',
      blobUrl: 'blob:chrome-extension://test-ext-id/dl-listener-1',
      filename: 'f.md',
      tabId: 1,
    });

    // One additional per-download listener added on top of the global one.
    expect(sw.listeners.downloadsOnChanged.length).toBe(before + 1);
  });

  test('blob: URL cleanup message is sent on complete', async () => {
    const sw = loadServiceWorker();
    const blobUrl = 'blob:chrome-extension://test-ext-id/cleanup-msg';

    await sw.fireMessage({
      type: 'service-worker-download',
      blobUrl,
      filename: 'x.md',
      tabId: 1,
    });
    const id = await sw.browser.downloads.download.mock.results[0].value;

    sw.browser.runtime.sendMessage.mockClear();

    await sw.fireDownloadChanged({
      id,
      state: { current: 'complete' },
    });

    const cleanupCalls = sw.browser.runtime.sendMessage.mock.calls.filter(
      ([m]) => m && m.type === 'cleanup-blob-url' && m.url === blobUrl
    );
    expect(cleanupCalls.length).toBeGreaterThanOrEqual(1);
  });

  test('non-blob URL does NOT trigger cleanup message', async () => {
    const sw = loadServiceWorker();
    const httpsUrl = 'https://cdn.example.com/image.png';

    await sw.fireMessage({
      type: 'track-download-url',
      url: httpsUrl,
      filename: 'img.png',
      isImage: true,
    });

    // Simulate the image download path tracking by ID.
    await sw.fireMessage({
      type: 'download-images',
      imageList: { [httpsUrl]: 'img.png' },
      mdClipsFolder: '',
      title: 'article',
      options: {},
    });
    const id = await sw.browser.downloads.download.mock.results[0].value;

    sw.browser.runtime.sendMessage.mockClear();
    await sw.fireDownloadChanged({ id, state: { current: 'complete' } });

    const cleanupCalls = sw.browser.runtime.sendMessage.mock.calls.filter(
      ([m]) => m && m.type === 'cleanup-blob-url'
    );
    expect(cleanupCalls).toEqual([]);
  });

  test('only fires for matching download id (not others)', async () => {
    const sw = loadServiceWorker();
    await sw.fireMessage({
      type: 'service-worker-download',
      blobUrl: 'blob:chrome-extension://test-ext-id/specific',
      filename: 'only.md',
      tabId: 1,
    });
    const id = await sw.browser.downloads.download.mock.results[0].value;

    sw.browser.runtime.sendMessage.mockClear();

    // Fire for an UNRELATED download — no cleanup should be sent.
    await sw.fireDownloadChanged({
      id: 99999,
      state: { current: 'complete' },
    });

    const cleanupCalls = sw.browser.runtime.sendMessage.mock.calls.filter(
      ([m]) => m && m.type === 'cleanup-blob-url'
    );
    expect(cleanupCalls).toEqual([]);
  });

  test('interrupted state does not trigger per-listener cleanup message (only complete does)', async () => {
    // Deliberate: the per-download listener only reacts to 'complete' —
    // interrupted cleanup is handled by handleDownloadChange via the
    // registry. Lock in current behavior so changes are visible.
    const sw = loadServiceWorker();
    const blobUrl = 'blob:chrome-extension://test-ext-id/interrupt';

    await sw.fireMessage({
      type: 'service-worker-download',
      blobUrl,
      filename: 'int.md',
      tabId: 1,
    });
    const id = await sw.browser.downloads.download.mock.results[0].value;

    sw.browser.runtime.sendMessage.mockClear();
    await sw.fireDownloadChanged({
      id,
      state: { current: 'interrupted' },
      error: { current: 'NETWORK_FAILED' },
    });

    // handleDownloadChange (global) DOES send cleanup for interrupted blob
    // URLs — verify exactly one cleanup message.
    const cleanupCalls = sw.browser.runtime.sendMessage.mock.calls.filter(
      ([m]) => m && m.type === 'cleanup-blob-url' && m.url === blobUrl
    );
    expect(cleanupCalls.length).toBe(1);
  });
});

describe('[integration] image downloads', () => {
  test('handleImageDownloads pre-tracks blob-source images', async () => {
    const sw = loadServiceWorker();
    const imgBlob = 'blob:chrome-extension://test-ext-id/img-1';

    await sw.fireMessage({
      type: 'download-images',
      imageList: { [imgBlob]: 'picture.png' },
      mdClipsFolder: 'clips/',
      title: 'article/',
      options: {},
    });

    // The download API call should target the blob URL with the image
    // path as filename.
    const dlArgs = sw.browser.downloads.download.mock.calls[0][0];
    expect(dlArgs.url).toBe(imgBlob);
    expect(dlArgs.filename).toContain('picture.png');
    expect(dlArgs.saveAs).toBe(false);

    // onDeterminingFilename should now claim this URL with the correct
    // filename — exercising the image-tracking path end-to-end.
    const id = await sw.browser.downloads.download.mock.results[0].value;
    const { returnValue, suggestCalls } = sw.fireOnDeterminingFilename({
      id,
      url: imgBlob,
    });
    expect(returnValue).toBe(true);
    expect(suggestCalls[0].filename).toContain('picture.png');
    expect(suggestCalls[0].conflictAction).toBe('uniquify');
  });

  test('handleImageDownloads tracks external (non-blob) images by ID', async () => {
    const sw = loadServiceWorker();
    const imgUrl = 'https://cdn.example.com/photo.jpg';

    await sw.fireMessage({
      type: 'download-images',
      imageList: { [imgUrl]: 'photo.jpg' },
      mdClipsFolder: '',
      title: 'post',
      options: {},
    });

    const id = await sw.browser.downloads.download.mock.results[0].value;

    // Firing onDeterminingFilename for the returned ID must claim it.
    const { returnValue, suggestCalls } = sw.fireOnDeterminingFilename({
      id,
      url: imgUrl,
    });
    expect(returnValue).toBe(true);
    expect(suggestCalls[0].filename).toContain('photo.jpg');
  });

  test('image download completion cleans up tracking', async () => {
    const sw = loadServiceWorker();
    const imgBlob = 'blob:chrome-extension://test-ext-id/img-cleanup';

    await sw.fireMessage({
      type: 'download-images',
      imageList: { [imgBlob]: 'pic.png' },
      mdClipsFolder: '',
      title: 'art',
      options: {},
    });

    const id = await sw.browser.downloads.download.mock.results[0].value;

    // Before cleanup: claimed
    expect(sw.fireOnDeterminingFilename({ id, url: imgBlob }).returnValue).toBe(true);

    await sw.fireDownloadChanged({ id, state: { current: 'complete' } });

    // After cleanup: not claimed
    const after = sw.fireOnDeterminingFilename({ id, url: imgBlob });
    expect(after.returnValue).toBe(false);
    expect(after.suggestCalls).toEqual([]);
  });

  test('multiple images in one batch are each tracked independently', async () => {
    const sw = loadServiceWorker();
    const images = {
      'blob:chrome-extension://test-ext-id/m-1': 'a.png',
      'blob:chrome-extension://test-ext-id/m-2': 'b.png',
      'https://cdn.example.com/c.png': 'c.png',
    };

    await sw.fireMessage({
      type: 'download-images',
      imageList: images,
      mdClipsFolder: '',
      title: 'gallery',
      options: {},
    });

    const results = sw.browser.downloads.download.mock.results;
    expect(results).toHaveLength(3);

    const ids = await Promise.all(results.map(r => r.value));
    const urls = Object.keys(images);

    urls.forEach((url, i) => {
      const { returnValue, suggestCalls } = sw.fireOnDeterminingFilename({
        id: ids[i],
        url,
      });
      expect(returnValue).toBe(true);
      expect(suggestCalls[0].filename).toContain(images[url]);
    });
  });

  test('one failed image download does not break the rest', async () => {
    const sw = loadServiceWorker();
    // First download throws; second succeeds.
    sw.browser.downloads.download
      .mockImplementationOnce(() => Promise.reject(new Error('blocked')))
      .mockImplementationOnce(() => Promise.resolve(101));

    await sw.fireMessage({
      type: 'download-images',
      imageList: {
        'blob:chrome-extension://test-ext-id/fail-1': 'fail.png',
        'blob:chrome-extension://test-ext-id/ok-2': 'ok.png',
      },
      mdClipsFolder: '',
      title: 'mixed',
      options: {},
    });

    // Second image must still be claimable.
    const { returnValue, suggestCalls } = sw.fireOnDeterminingFilename({
      id: 101,
      url: 'blob:chrome-extension://test-ext-id/ok-2',
    });
    expect(returnValue).toBe(true);
    expect(suggestCalls[0].filename).toContain('ok.png');
  });
});
