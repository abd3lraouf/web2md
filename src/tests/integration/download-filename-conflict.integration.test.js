/**
 * Integration Tests: Download Filename Conflict
 *
 * These tests load the REAL service-worker.js and exercise its production
 * `handleFilenameConflict` listener. They differ from the sibling unit test
 * which reimplements the algorithm inline — here we verify the actual code
 * users run.
 *
 * Assumptions verified against production code:
 *   A1. Listener is registered on browser.downloads.onDeterminingFilename
 *   A2. Unknown downloads never trigger suggest()
 *   A3. HTTPS/data-URI/foreign-blob downloads never trigger suggest()
 *   A4. `track-download-url` message populates tracking for later match
 *   A5. Full handleDownloadWithBlobUrl flow pre-tracks then maps to ID
 *   A6. onChanged complete event cleans up ALL three tracking structures
 *   A7. onChanged interrupted event cleans up ALL three tracking structures
 *   A8. Empty filename in handleDownloadWithBlobUrl falls back to Untitled-<timestamp>.md
 *   A9. Concurrent downloads are tracked independently
 *   A10. After cleanup, the same URL no longer matches (prevents stale hits)
 *   A11. Our own blob URL that was NEVER tracked returns false (positive-ID only)
 *
 * The bug scenario: MarkSnip + another extension both register
 * onDeterminingFilename. Chrome fires the event for every download to
 * every listener. If both call suggest(), Chrome reports a conflict and
 * the download gets the empty "" filename shown in the user's error.
 */

const { loadServiceWorker } = require('../helpers/service-worker-harness');

// Silence SW logs (they're extensive) while still surfacing errors.
beforeAll(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'info').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('[integration] Download Filename Conflict — production listener', () => {
  // ---------------------------------------------------------------
  // A1. Listener registration
  // ---------------------------------------------------------------
  describe('Listener registration', () => {
    test('registers exactly one onDeterminingFilename listener at load', () => {
      const sw = loadServiceWorker();
      expect(sw.listeners.onDeterminingFilename).toHaveLength(1);
      expect(typeof sw.listeners.onDeterminingFilename[0]).toBe('function');
    });

    test('registers downloads.onChanged listener at load', () => {
      const sw = loadServiceWorker();
      expect(sw.listeners.downloadsOnChanged.length).toBeGreaterThanOrEqual(1);
    });

    test('registers runtime.onMessage listener at load', () => {
      const sw = loadServiceWorker();
      expect(sw.listeners.onMessage).toHaveLength(1);
    });
  });

  // ---------------------------------------------------------------
  // A2, A3, A11. Positive-identification only — no suggest() for foreign
  // ---------------------------------------------------------------
  describe('Foreign downloads — must NOT call suggest()', () => {
    let sw;
    beforeEach(() => { sw = loadServiceWorker(); });

    test.each([
      ['HTTPS URL', { id: 100, url: 'https://example.com/file.pdf' }],
      ['HTTP URL', { id: 101, url: 'http://example.com/doc.md' }],
      ['data: URI', { id: 102, url: 'data:text/plain;base64,SGVsbG8=' }],
      ['file: URL', { id: 103, url: 'file:///Users/a/file.md' }],
      ['foreign extension blob', { id: 104, url: 'blob:chrome-extension://OTHER-EXT/abc' }],
      ['non-extension blob', { id: 105, url: 'blob:https://example.com/xyz' }],
      ['missing url', { id: 106 }],
      ['empty url', { id: 107, url: '' }],
    ])('no suggest() for %s', (_label, item) => {
      const { suggestCalls, returnValue } = sw.fireOnDeterminingFilename(item);
      expect(suggestCalls).toEqual([]);
      expect(returnValue).toBe(false);
    });

    test('OUR blob URL that was never tracked returns false (positive ID only)', () => {
      // Critical: a blob URL that LOOKS like ours but was never tracked
      // must not match. The previous bug matched any blob: prefix.
      const neverTrackedOurs = 'blob:chrome-extension://test-ext-id/never-tracked';
      const { suggestCalls, returnValue } = sw.fireOnDeterminingFilename({
        id: 200,
        url: neverTrackedOurs,
      });
      expect(suggestCalls).toEqual([]);
      expect(returnValue).toBe(false);
    });
  });

  // ---------------------------------------------------------------
  // A4. track-download-url message populates tracking
  // ---------------------------------------------------------------
  describe('track-download-url message flow', () => {
    test('pre-tracking a blob URL makes subsequent onDeterminingFilename match', async () => {
      const sw = loadServiceWorker();
      const blobUrl = 'blob:chrome-extension://test-ext-id/tracked-1';

      await sw.fireMessage({
        type: 'track-download-url',
        url: blobUrl,
        filename: 'downloads/my-article.md',
        isMarkdown: true,
      });

      const { suggestCalls, returnValue } = sw.fireOnDeterminingFilename({
        id: 300,
        url: blobUrl,
      });

      expect(returnValue).toBe(true);
      expect(suggestCalls).toEqual([{
        filename: 'downloads/my-article.md',
        conflictAction: 'uniquify',
      }]);
    });

    test('pre-tracking a non-blob URL also matches by URL', async () => {
      const sw = loadServiceWorker();
      const url = 'https://cdn.example.com/image.png';

      await sw.fireMessage({
        type: 'track-download-url',
        url,
        filename: 'images/img-1.png',
        isImage: true,
      });

      const { suggestCalls, returnValue } = sw.fireOnDeterminingFilename({
        id: 301,
        url,
      });

      expect(returnValue).toBe(true);
      expect(suggestCalls[0].filename).toBe('images/img-1.png');
    });

    test('pre-tracking only affects the exact URL, not siblings', async () => {
      const sw = loadServiceWorker();
      const tracked = 'blob:chrome-extension://test-ext-id/A';
      const other = 'blob:chrome-extension://test-ext-id/B';

      await sw.fireMessage({
        type: 'track-download-url',
        url: tracked,
        filename: 'a.md',
      });

      const hit = sw.fireOnDeterminingFilename({ id: 310, url: tracked });
      const miss = sw.fireOnDeterminingFilename({ id: 311, url: other });

      expect(hit.suggestCalls).toHaveLength(1);
      expect(miss.suggestCalls).toEqual([]);
    });
  });

  // ---------------------------------------------------------------
  // A5. Full handleDownloadWithBlobUrl flow
  // ---------------------------------------------------------------
  describe('service-worker-download (handleDownloadWithBlobUrl) flow', () => {
    test('pre-tracks blob URL, suggests correctly, and maps to download ID', async () => {
      const sw = loadServiceWorker();
      const blobUrl = 'blob:chrome-extension://test-ext-id/sw-download-1';

      // Message simulates offscreen -> SW sending the blob URL for download.
      await sw.fireMessage({
        type: 'service-worker-download',
        blobUrl,
        filename: 'clips/post.md',
        tabId: 42,
        imageList: {},
        mdClipsFolder: 'clips/',
      });

      // Verify downloads.download was actually called with our filename.
      expect(sw.browser.downloads.download).toHaveBeenCalledTimes(1);
      const dlArgs = sw.browser.downloads.download.mock.calls[0][0];
      expect(dlArgs).toMatchObject({
        url: blobUrl,
        filename: 'clips/post.md',
        saveAs: false,
      });

      // After download resolves, markSnipUrls should be cleared for this URL
      // and markSnipDownloads populated for the returned ID. Chrome would
      // then fire onDeterminingFilename — verify suggest() still works.
      const returnedId = await sw.browser.downloads.download.mock.results[0].value;
      const { suggestCalls, returnValue } = sw.fireOnDeterminingFilename({
        id: returnedId,
        url: blobUrl,
      });

      expect(returnValue).toBe(true);
      expect(suggestCalls).toEqual([{
        filename: 'clips/post.md',
        conflictAction: 'uniquify',
      }]);
    });

    test('suggest() is called even if onDeterminingFilename fires before download() resolves', async () => {
      // Race scenario: Chrome fires onDeterminingFilename before the
      // download() promise resolves. The code pre-tracks in markSnipUrls
      // BEFORE calling download(), so this must still match via URL.
      const sw = loadServiceWorker();
      const blobUrl = 'blob:chrome-extension://test-ext-id/race-1';
      const returnedId = 42;

      let raceResult;
      sw.browser.downloads.download.mockImplementationOnce((opts) => {
        // At this moment the URL is tracked in markSnipUrls but ID mapping
        // has not happened yet — suggest() must still work via URL.
        raceResult = sw.fireOnDeterminingFilename({ id: 999, url: opts.url });
        return Promise.resolve(returnedId);
      });

      await sw.fireMessage({
        type: 'service-worker-download',
        blobUrl,
        filename: 'race.md',
        tabId: 1,
      });

      expect(raceResult.returnValue).toBe(true);
      expect(raceResult.suggestCalls[0].filename).toBe('race.md');

      // Post-resolve: tracking should have migrated from URL to ID map.
      // Firing again with the returned ID must still match (now via ID).
      const after = sw.fireOnDeterminingFilename({ id: returnedId, url: blobUrl });
      expect(after.returnValue).toBe(true);
      expect(after.suggestCalls[0].filename).toBe('race.md');
    });
  });

  // ---------------------------------------------------------------
  // A6, A7, A10. Cleanup on completion and interruption
  // ---------------------------------------------------------------
  describe('Cleanup after download lifecycle', () => {
    async function setupAndStartDownload(sw, blobUrl, filename) {
      await sw.fireMessage({
        type: 'service-worker-download',
        blobUrl,
        filename,
        tabId: 1,
      });
      return await sw.browser.downloads.download.mock.results[0].value;
    }

    test('after complete event, same URL no longer matches', async () => {
      const sw = loadServiceWorker();
      const blobUrl = 'blob:chrome-extension://test-ext-id/cleanup-complete';

      const id = await setupAndStartDownload(sw, blobUrl, 'clean.md');

      // Before cleanup: matches
      const before = sw.fireOnDeterminingFilename({ id, url: blobUrl });
      expect(before.returnValue).toBe(true);

      // Simulate Chrome firing the complete event
      await sw.fireDownloadChanged({
        id,
        state: { current: 'complete', previous: 'in_progress' },
      });

      // After cleanup: no longer matches
      const after = sw.fireOnDeterminingFilename({ id, url: blobUrl });
      expect(after.suggestCalls).toEqual([]);
      expect(after.returnValue).toBe(false);
    });

    test('after interrupted event, same URL no longer matches', async () => {
      const sw = loadServiceWorker();
      const blobUrl = 'blob:chrome-extension://test-ext-id/cleanup-interrupt';

      const id = await setupAndStartDownload(sw, blobUrl, 'int.md');

      await sw.fireDownloadChanged({
        id,
        state: { current: 'interrupted', previous: 'in_progress' },
        error: { current: 'USER_CANCELED' },
      });

      const after = sw.fireOnDeterminingFilename({ id, url: blobUrl });
      expect(after.suggestCalls).toEqual([]);
      expect(after.returnValue).toBe(false);
    });

    test('onChanged for unrelated downloads does not affect our tracking', async () => {
      const sw = loadServiceWorker();
      const blobUrl = 'blob:chrome-extension://test-ext-id/stable';

      const id = await setupAndStartDownload(sw, blobUrl, 'stable.md');

      // A completely unrelated download (from another extension) completes.
      await sw.fireDownloadChanged({
        id: 999999,
        state: { current: 'complete' },
      });

      const { returnValue, suggestCalls } = sw.fireOnDeterminingFilename({
        id,
        url: blobUrl,
      });

      expect(returnValue).toBe(true);
      expect(suggestCalls[0].filename).toBe('stable.md');
    });
  });

  // ---------------------------------------------------------------
  // A8. Empty filename fallback
  // ---------------------------------------------------------------
  describe('Empty filename fallback', () => {
    test.each([
      ['empty string', ''],
      ['whitespace only', '   '],
      ['just .md', '.md'],
    ])('handleDownloadWithBlobUrl falls back for %s', async (_label, filename) => {
      const sw = loadServiceWorker();
      await sw.fireMessage({
        type: 'service-worker-download',
        blobUrl: 'blob:chrome-extension://test-ext-id/empty-name',
        filename,
        tabId: 1,
      });

      const dlArgs = sw.browser.downloads.download.mock.calls[0][0];
      expect(dlArgs.filename).toMatch(/^Untitled-\d+\.md$/);
      expect(dlArgs.filename).not.toBe('');
      expect(dlArgs.filename).not.toBe('.md');
    });

    test('valid filename is passed through unchanged', async () => {
      const sw = loadServiceWorker();
      await sw.fireMessage({
        type: 'service-worker-download',
        blobUrl: 'blob:chrome-extension://test-ext-id/valid-name',
        filename: 'ok/file.md',
        tabId: 1,
      });
      const dlArgs = sw.browser.downloads.download.mock.calls[0][0];
      expect(dlArgs.filename).toBe('ok/file.md');
    });
  });

  // ---------------------------------------------------------------
  // A9. Concurrent downloads isolation
  // ---------------------------------------------------------------
  describe('Concurrent downloads', () => {
    test('multiple simultaneous downloads each get their own filename', async () => {
      const sw = loadServiceWorker();

      const downloads = [
        { url: 'blob:chrome-extension://test-ext-id/c-1', filename: 'a.md' },
        { url: 'blob:chrome-extension://test-ext-id/c-2', filename: 'b.md' },
        { url: 'blob:chrome-extension://test-ext-id/c-3', filename: 'c.md' },
      ];

      // Pre-track each (simulating three concurrent in-flight downloads).
      for (const d of downloads) {
        await sw.fireMessage({
          type: 'track-download-url',
          url: d.url,
          filename: d.filename,
          isMarkdown: true,
        });
      }

      downloads.forEach((d, i) => {
        const { suggestCalls, returnValue } = sw.fireOnDeterminingFilename({
          id: 7000 + i,
          url: d.url,
        });
        expect(returnValue).toBe(true);
        expect(suggestCalls[0].filename).toBe(d.filename);
      });
    });

    test('one download completing does not drop tracking for others', async () => {
      const sw = loadServiceWorker();
      const a = 'blob:chrome-extension://test-ext-id/par-a';
      const b = 'blob:chrome-extension://test-ext-id/par-b';

      await sw.fireMessage({ type: 'service-worker-download', blobUrl: a, filename: 'a.md', tabId: 1 });
      const idA = await sw.browser.downloads.download.mock.results[0].value;

      await sw.fireMessage({ type: 'service-worker-download', blobUrl: b, filename: 'b.md', tabId: 1 });
      const idB = await sw.browser.downloads.download.mock.results[1].value;

      // Complete only A
      await sw.fireDownloadChanged({ id: idA, state: { current: 'complete' } });

      // A gone, B still present
      const checkA = sw.fireOnDeterminingFilename({ id: idA, url: a });
      const checkB = sw.fireOnDeterminingFilename({ id: idB, url: b });

      expect(checkA.returnValue).toBe(false);
      expect(checkB.returnValue).toBe(true);
      expect(checkB.suggestCalls[0].filename).toBe('b.md');
    });
  });

  // ---------------------------------------------------------------
  // Reproduction of the exact bug reported
  // ---------------------------------------------------------------
  describe('Bug reproduction: MarkSnip + foreign extension coexistence', () => {
    test('foreign extension download is ignored; our download is suggested — no conflict', async () => {
      const sw = loadServiceWorker();

      // Our tracked download
      const ourUrl = 'blob:chrome-extension://test-ext-id/ours';
      await sw.fireMessage({
        type: 'track-download-url',
        url: ourUrl,
        filename: 'Issues · project.md',
        isMarkdown: true,
      });

      // The "other extension" initiates its download — Chrome fires
      // onDeterminingFilename to ALL extensions, including us.
      const foreignDownload = {
        id: 500,
        url: 'blob:chrome-extension://OTHER-EXT/foreign-blob',
      };
      const foreignResult = sw.fireOnDeterminingFilename(foreignDownload);

      // We must NOT call suggest() — that was the original bug that caused
      // "failed to name the download ''" when both extensions claimed it.
      expect(foreignResult.suggestCalls).toEqual([]);
      expect(foreignResult.returnValue).toBe(false);

      // Our own download still works correctly.
      const ourResult = sw.fireOnDeterminingFilename({ id: 501, url: ourUrl });
      expect(ourResult.returnValue).toBe(true);
      expect(ourResult.suggestCalls[0].filename).toBe('Issues · project.md');
    });

    test('regression: raw blob: prefix check does NOT match (previous buggy behavior)', () => {
      // The original bug used downloadItem.url.startsWith('blob:') which
      // matched any extension's blob URLs. Verify that foreign blob URLs
      // are now rejected even when they look similar to ours.
      const sw = loadServiceWorker();
      const foreignLookalikes = [
        'blob:chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/x',
        'blob:chrome-extension://test-ext-XX/y',  // similar but different ID
        'blob:https://example.com/z',
        'blob:null/w',
      ];
      foreignLookalikes.forEach((url, i) => {
        const { suggestCalls, returnValue } = sw.fireOnDeterminingFilename({
          id: 8000 + i,
          url,
        });
        expect(suggestCalls).toEqual([]);
        expect(returnValue).toBe(false);
      });
    });
  });

  // ---------------------------------------------------------------
  // Defensive: downloadItem.id collisions
  // ---------------------------------------------------------------
  describe('Edge cases', () => {
    test('ID tracking wins over URL tracking when both present', async () => {
      const sw = loadServiceWorker();
      const url = 'blob:chrome-extension://test-ext-id/dual';

      // Start a real download (populates markSnipDownloads with id->filename-A)
      await sw.fireMessage({
        type: 'service-worker-download',
        blobUrl: url,
        filename: 'from-id.md',
        tabId: 1,
      });
      const id = await sw.browser.downloads.download.mock.results[0].value;

      // Now pre-track the SAME URL with a different filename (simulating a
      // race where a new track-download-url arrives for a recycled blob).
      await sw.fireMessage({
        type: 'track-download-url',
        url,
        filename: 'from-url.md',
      });

      const { suggestCalls } = sw.fireOnDeterminingFilename({ id, url });
      // ID tracking (registered first, more reliable) wins.
      expect(suggestCalls[0].filename).toBe('from-id.md');
    });

    test('SW initialization does not throw', () => {
      const sw = loadServiceWorker();
      expect(sw.initError).toBeNull();
    });

    test('when a coexisting extension listener also runs, our listener only claims downloads we tracked', async () => {
      // Chrome dispatches onDeterminingFilename to every extension's
      // listener. We simulate that by manually appending a second
      // "foreign extension" listener to the captured list. Our listener
      // must remain positive-ID only and never steal a foreign download.
      const sw = loadServiceWorker();
      const ours = 'blob:chrome-extension://test-ext-id/coexist';
      await sw.fireMessage({ type: 'track-download-url', url: ours, filename: 'ours.md' });

      let foreignClaimedCount = 0;
      sw.listeners.onDeterminingFilename.push((item, suggest) => {
        foreignClaimedCount++;
        suggest({ filename: 'foreign-wins.md', conflictAction: 'overwrite' });
        return true;
      });

      // Foreign extension's download — our listener must return false,
      // foreign one claims it alone.
      const foreign = sw.fireOnDeterminingFilename({
        id: 900,
        url: 'blob:chrome-extension://OTHER/x',
      });
      const ourSuggests = foreign.suggestCalls.filter(c => c.filename !== 'foreign-wins.md');
      expect(ourSuggests).toEqual([]);
      expect(foreign.returnValues[0]).toBe(false);     // ours
      expect(foreign.returnValues[1]).toBe(true);      // foreign
      expect(foreignClaimedCount).toBe(1);

      // Our download — WE claim it. Foreign extension also claims (real
      // Chrome would resolve the conflict); the important thing is our
      // listener returned true with the right filename.
      const mine = sw.fireOnDeterminingFilename({ id: 901, url: ours });
      const ourMineSuggest = mine.suggestCalls.find(c => c.filename === 'ours.md');
      expect(ourMineSuggest).toEqual({ filename: 'ours.md', conflictAction: 'uniquify' });
      expect(mine.returnValues[0]).toBe(true);
    });

    test('track-download-url with falsy url does not pollute tracking', async () => {
      // Defensive: if the message ever arrives with undefined/empty url,
      // the listener must still not match arbitrary future events.
      const sw = loadServiceWorker();
      await sw.fireMessage({ type: 'track-download-url', url: undefined, filename: 'x.md' });
      await sw.fireMessage({ type: 'track-download-url', url: '', filename: 'y.md' });

      // An event with matching falsy url shape must NOT be claimed.
      const a = sw.fireOnDeterminingFilename({ id: 1001, url: undefined });
      const b = sw.fireOnDeterminingFilename({ id: 1002, url: '' });
      expect(a.suggestCalls).toEqual([]);
      expect(a.returnValue).toBe(false);
      expect(b.suggestCalls).toEqual([]);
      expect(b.returnValue).toBe(false);
    });
  });
});
