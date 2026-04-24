/**
 * DownloadRegistry
 *
 * Tracks downloads initiated by this extension so the
 * `downloads.onDeterminingFilename` listener can claim them without
 * interfering with downloads started by other extensions.
 *
 * Positive identification only — a download is ours iff it was explicitly
 * tracked by ID, URL, or as a blob URL we created. Never infer ownership
 * from a URL prefix.
 *
 * Loadable via both `importScripts` (service worker) and `require`
 * (Node tests). When loaded via `importScripts`, attaches `DownloadRegistry`
 * to the worker global.
 */
(function (root) {
  class DownloadRegistry {
    constructor() {
      this._byId = new Map();     // downloadId -> { filename, url, isMarkdown, isImage }
      this._byUrl = new Map();    // url -> { filename, isMarkdown, isImage }
      this._blobUrls = new Set(); // blob URLs we created
      this._active = new Map();   // downloadId -> url
    }

    /**
     * Pre-track a URL before calling downloads.download(). Required so
     * onDeterminingFilename can claim the download if Chrome fires the
     * event before download() resolves.
     */
    trackUrl(url, info) {
      if (!url) return;
      this._byUrl.set(url, { ...info });
      if (typeof url === 'string' && url.startsWith('blob:')) {
        this._blobUrls.add(url);
      }
    }

    /**
     * After downloads.download() resolves, move the pre-tracked URL
     * entry into ID-keyed storage.
     */
    promoteUrlToId(url, id) {
      if (!this._byUrl.has(url)) return false;
      const info = this._byUrl.get(url);
      this._byId.set(id, { ...info, url });
      this._byUrl.delete(url);
      this._active.set(id, url);
      return true;
    }

    /**
     * Track directly by ID (used for image downloads where we don't
     * create the source URL and can't pre-track).
     */
    trackId(id, info) {
      this._byId.set(id, { ...info });
      if (info && info.url) this._active.set(id, info.url);
    }

    /**
     * Determine whether a `downloads.onDeterminingFilename` event belongs
     * to us. Returns the filename to suggest, or null.
     *
     * ID tracking wins over URL tracking. A blob URL we own but haven't
     * tracked by URL has no filename and returns null.
     */
    claim(downloadItem) {
      if (!downloadItem) return null;
      const { id, url } = downloadItem;

      if (this._byId.has(id)) {
        const info = this._byId.get(id);
        return info && info.filename ? info.filename : null;
      }
      if (url && this._byUrl.has(url)) {
        const info = this._byUrl.get(url);
        return info && info.filename ? info.filename : null;
      }
      if (url && this._blobUrls.has(url)) {
        const info = this._byUrl.get(url);
        return info && info.filename ? info.filename : null;
      }
      return null;
    }

    /** True if we're currently tracking this download ID. */
    isActive(id) {
      return this._active.has(id);
    }

    /** URL associated with an active download ID, or undefined. */
    getUrl(id) {
      return this._active.get(id);
    }

    /**
     * Drop all tracking for a completed or interrupted download. Safe to
     * call multiple times.
     */
    release(id) {
      const url = this._active.get(id);
      this._active.delete(id);
      const info = this._byId.get(id);
      this._byId.delete(id);
      if (url) {
        this._byUrl.delete(url);
        this._blobUrls.delete(url);
      }
      // If trackId() was used without _active (defensive), clean URL from info.
      if (info && info.url && info.url !== url) {
        this._byUrl.delete(info.url);
        this._blobUrls.delete(info.url);
      }
    }

    /** Test / debug helper. */
    _snapshot() {
      return {
        byId: new Map(this._byId),
        byUrl: new Map(this._byUrl),
        blobUrls: new Set(this._blobUrls),
        active: new Map(this._active),
      };
    }
  }

  root.DownloadRegistry = DownloadRegistry;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = DownloadRegistry;
  }
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this));
