/**
 * Unit tests for DownloadRegistry — the state container extracted from
 * service-worker.js. Tests the real production module via require().
 */

const DownloadRegistry = require('../../background/download-registry');

describe('DownloadRegistry', () => {
  let r;
  beforeEach(() => { r = new DownloadRegistry(); });

  describe('trackUrl', () => {
    test('tracks a blob URL in both internal maps', () => {
      const url = 'blob:chrome-extension://ext/a';
      r.trackUrl(url, { filename: 'a.md', isMarkdown: true });
      const snap = r._snapshot();
      expect(snap.byUrl.get(url)).toMatchObject({ filename: 'a.md', isMarkdown: true });
      expect(snap.blobUrls.has(url)).toBe(true);
    });

    test('tracks a non-blob URL without adding to blob set', () => {
      const url = 'https://example.com/x.png';
      r.trackUrl(url, { filename: 'x.png', isImage: true });
      const snap = r._snapshot();
      expect(snap.byUrl.has(url)).toBe(true);
      expect(snap.blobUrls.has(url)).toBe(false);
    });

    test('is a no-op for falsy url (defensive)', () => {
      r.trackUrl(undefined, { filename: 'x.md' });
      r.trackUrl('', { filename: 'y.md' });
      r.trackUrl(null, { filename: 'z.md' });
      const snap = r._snapshot();
      expect(snap.byUrl.size).toBe(0);
      expect(snap.blobUrls.size).toBe(0);
    });

    test('overwrites previous tracking for same URL', () => {
      const url = 'blob:chrome-extension://ext/a';
      r.trackUrl(url, { filename: 'first.md' });
      r.trackUrl(url, { filename: 'second.md' });
      expect(r.claim({ id: 1, url })).toBe('second.md');
    });
  });

  describe('promoteUrlToId', () => {
    test('moves info from URL-keyed to ID-keyed storage', () => {
      const url = 'blob:chrome-extension://ext/a';
      r.trackUrl(url, { filename: 'a.md' });
      const moved = r.promoteUrlToId(url, 42);
      expect(moved).toBe(true);
      const snap = r._snapshot();
      expect(snap.byUrl.has(url)).toBe(false);
      expect(snap.byId.get(42)).toMatchObject({ filename: 'a.md', url });
      expect(snap.active.get(42)).toBe(url);
    });

    test('returns false and is a no-op if URL not tracked', () => {
      const moved = r.promoteUrlToId('blob:chrome-extension://ext/ghost', 99);
      expect(moved).toBe(false);
      expect(r._snapshot().byId.size).toBe(0);
    });

    test('preserves blobUrls membership after promotion', () => {
      // Rationale: a late onDeterminingFilename with just the URL should
      // still resolve via the blob set even after promotion. The current
      // impl keeps the blob URL in `_blobUrls` on promotion; verify.
      const url = 'blob:chrome-extension://ext/a';
      r.trackUrl(url, { filename: 'a.md' });
      r.promoteUrlToId(url, 42);
      expect(r._snapshot().blobUrls.has(url)).toBe(true);
    });
  });

  describe('trackId', () => {
    test('registers download info directly by ID', () => {
      r.trackId(7, { filename: 'img.png', isImage: true, url: 'https://e.com/img.png' });
      const snap = r._snapshot();
      expect(snap.byId.get(7)).toMatchObject({ filename: 'img.png', isImage: true });
      expect(snap.active.get(7)).toBe('https://e.com/img.png');
    });

    test('info without url still tracks but does not set active entry', () => {
      r.trackId(8, { filename: 'x.md' });
      const snap = r._snapshot();
      expect(snap.byId.has(8)).toBe(true);
      expect(snap.active.has(8)).toBe(false);
    });
  });

  describe('claim', () => {
    test('returns filename for ID-tracked download', () => {
      r.trackId(1, { filename: 'a.md', url: 'blob:chrome-extension://ext/a' });
      expect(r.claim({ id: 1, url: 'blob:chrome-extension://ext/a' })).toBe('a.md');
    });

    test('returns filename for URL-tracked download', () => {
      const url = 'blob:chrome-extension://ext/b';
      r.trackUrl(url, { filename: 'b.md' });
      expect(r.claim({ id: 999, url })).toBe('b.md');
    });

    test('returns null for untracked download', () => {
      expect(r.claim({ id: 1, url: 'https://e.com/x.pdf' })).toBeNull();
      expect(r.claim({ id: 2, url: 'blob:chrome-extension://OTHER/x' })).toBeNull();
    });

    test('returns null when entry exists but filename is missing', () => {
      r.trackId(1, { filename: null });
      expect(r.claim({ id: 1 })).toBeNull();
    });

    test('returns null for blob URL in set but not in byUrl (edge case)', () => {
      // Can only happen after promotion cleaned byUrl. After promotion the
      // byId entry takes over, so claim via ID works. If someone fires
      // onDeterminingFilename for the URL alone without the ID, the
      // blobUrls fallback finds byUrl empty -> null. Verify.
      const r2 = new DownloadRegistry();
      r2.trackUrl('blob:x/y', { filename: 'x.md' });
      r2.promoteUrlToId('blob:x/y', 5);
      r2._snapshot().byUrl.delete('blob:x/y'); // already gone, defensive
      // With a stale-URL-only item (no ID match):
      expect(r2.claim({ id: 9999, url: 'blob:x/y' })).toBeNull();
    });

    test('ID tracking wins over URL tracking', () => {
      const url = 'blob:chrome-extension://ext/dual';
      r.trackId(1, { filename: 'from-id.md', url });
      r.trackUrl(url, { filename: 'from-url.md' });
      expect(r.claim({ id: 1, url })).toBe('from-id.md');
    });

    test('handles null/undefined downloadItem', () => {
      expect(r.claim(null)).toBeNull();
      expect(r.claim(undefined)).toBeNull();
    });

    test('handles missing url on downloadItem', () => {
      r.trackId(1, { filename: 'a.md' });
      expect(r.claim({ id: 1 })).toBe('a.md');
    });
  });

  describe('release', () => {
    test('clears all tracking for a completed download', () => {
      const url = 'blob:chrome-extension://ext/x';
      r.trackUrl(url, { filename: 'x.md' });
      r.promoteUrlToId(url, 10);
      r.release(10);

      const snap = r._snapshot();
      expect(snap.byId.has(10)).toBe(false);
      expect(snap.byUrl.has(url)).toBe(false);
      expect(snap.blobUrls.has(url)).toBe(false);
      expect(snap.active.has(10)).toBe(false);
    });

    test('is safe to call multiple times', () => {
      r.trackId(1, { filename: 'a.md', url: 'u' });
      r.release(1);
      expect(() => r.release(1)).not.toThrow();
      expect(() => r.release(999)).not.toThrow();
    });

    test('releasing one download does not affect others', () => {
      r.trackId(1, { filename: 'a.md', url: 'u1' });
      r.trackId(2, { filename: 'b.md', url: 'u2' });
      r.release(1);
      expect(r.claim({ id: 2, url: 'u2' })).toBe('b.md');
    });

    test('releasing an ID-only entry (no url) cleans byId', () => {
      r.trackId(5, { filename: 'x.md' });
      r.release(5);
      expect(r._snapshot().byId.has(5)).toBe(false);
    });
  });

  describe('isActive / getUrl', () => {
    test('isActive reflects promoted/tracked state', () => {
      r.trackUrl('u', { filename: 'x.md' });
      expect(r.isActive(1)).toBe(false);
      r.promoteUrlToId('u', 1);
      expect(r.isActive(1)).toBe(true);
      r.release(1);
      expect(r.isActive(1)).toBe(false);
    });

    test('getUrl returns tracked URL', () => {
      r.trackId(2, { filename: 'y.md', url: 'https://e.com' });
      expect(r.getUrl(2)).toBe('https://e.com');
      expect(r.getUrl(999)).toBeUndefined();
    });
  });

  describe('concurrent downloads', () => {
    test('100 concurrent tracked downloads remain isolated', () => {
      for (let i = 0; i < 100; i++) {
        r.trackUrl(`blob:x/${i}`, { filename: `f-${i}.md` });
        r.promoteUrlToId(`blob:x/${i}`, 1000 + i);
      }
      for (let i = 0; i < 100; i++) {
        expect(r.claim({ id: 1000 + i, url: `blob:x/${i}` })).toBe(`f-${i}.md`);
      }
      // Release half, verify remaining are intact.
      for (let i = 0; i < 50; i++) r.release(1000 + i);
      for (let i = 0; i < 50; i++) {
        expect(r.claim({ id: 1000 + i })).toBeNull();
      }
      for (let i = 50; i < 100; i++) {
        expect(r.claim({ id: 1000 + i, url: `blob:x/${i}` })).toBe(`f-${i}.md`);
      }
    });
  });
});
