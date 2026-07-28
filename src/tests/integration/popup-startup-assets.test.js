const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

describe('Popup startup assets (lite)', () => {
  test('popup HTML loads only essential scripts and stylesheets', () => {
    const popupHtml = fs.readFileSync(
      path.join(__dirname, '../../popup/popup.html'),
      'utf8'
    );
    const dom = new JSDOM(popupHtml, {
      url: 'https://example.com/popup/popup.html'
    });
    const document = dom.window.document;

    const stylesheetHrefs = Array.from(document.querySelectorAll('link[rel="stylesheet"]'))
      .map((link) => link.getAttribute('href'));

    expect(stylesheetHrefs).toContain('popup.css');
    // CodeMirror and theme stylesheets must not be loaded
    expect(stylesheetHrefs).not.toContain('lib/codemirror.css');
    expect(stylesheetHrefs).not.toContain('lib/marked.min.js');

    const scriptHrefs = Array.from(document.querySelectorAll('script[src]'))
      .map((script) => script.getAttribute('src'));

    expect(scriptHrefs).toContain('popup.js');
    expect(scriptHrefs).toContain('../browser-polyfill.min.js');
    expect(scriptHrefs).toContain('../shared/default-options.js');

    // Heavy dependencies that must NOT be loaded
    expect(scriptHrefs).not.toContain('lib/codemirror.js');
    expect(scriptHrefs).not.toContain('../notifications/notification-host.js');
    expect(scriptHrefs).not.toContain('lib/marked.min.js');
    expect(scriptHrefs).not.toContain('theme-bootstrap.js');
  });

  test('popup has the essential lite UI elements', () => {
    const popupHtml = fs.readFileSync(
      path.join(__dirname, '../../popup/popup.html'),
      'utf8'
    );
    const dom = new JSDOM(popupHtml);
    const document = dom.window.document;

    expect(document.getElementById('container')).not.toBeNull();
    expect(document.getElementById('editor')).not.toBeNull();
    expect(document.getElementById('copyBtn')).not.toBeNull();
    expect(document.getElementById('sendChatgpt')).not.toBeNull();
    expect(document.getElementById('sendClaude')).not.toBeNull();
    expect(document.getElementById('sendPerplexity')).not.toBeNull();
    expect(document.getElementById('themeToggle')).not.toBeNull();
    expect(document.getElementById('titleInput')).not.toBeNull();
    expect(document.getElementById('modeSelection')).not.toBeNull();
    expect(document.getElementById('modeDocument')).not.toBeNull();
    expect(document.getElementById('customTargets')).not.toBeNull();
  });

  test('popup does NOT have removed feature elements', () => {
    const popupHtml = fs.readFileSync(
      path.join(__dirname, '../../popup/popup.html'),
      'utf8'
    );
    const dom = new JSDOM(popupHtml);
    const document = dom.window.document;

    // Download / Obsidian / Batch / Library / Reader / Highlighter removed
    expect(document.getElementById('download')).toBeNull();
    expect(document.getElementById('sendToObsidian')).toBeNull();
    expect(document.getElementById('batchProcess')).toBeNull();
    expect(document.getElementById('libraryViewToggle')).toBeNull();
    expect(document.getElementById('toggleReader')).toBeNull();
    expect(document.getElementById('toggleHighlighter')).toBeNull();
    expect(document.getElementById('splitBtnWrap')).toBeNull();
    expect(document.getElementById('pickElement')).toBeNull();
    expect(document.getElementById('downloadImages')).toBeNull();
  });
});
