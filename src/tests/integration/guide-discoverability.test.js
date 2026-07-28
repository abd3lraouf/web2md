const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const optionsHtml = fs.readFileSync(
  path.join(__dirname, '../../options/options.html'),
  'utf8'
);

const manifestJson = JSON.parse(fs.readFileSync(
  path.join(__dirname, '../../manifest.json'),
  'utf8'
));

describe('Guide discoverability — options', () => {
  let dom;

  beforeEach(() => {
    dom = new JSDOM(optionsHtml, { url: 'https://example.com/options/options.html' });
  });

  afterEach(() => dom.window.close());

  test('options sidebar has a User Guide link', () => {
    const guideLink = dom.window.document.getElementById('open-guide-link');
    expect(guideLink).not.toBeNull();
    expect(guideLink.getAttribute('href')).toBe('/guide/guide.html');
    expect(guideLink.getAttribute('target')).toBe('_blank');
    expect(guideLink.textContent).toMatch(/User Guide/i);
  });
});

describe('Guide discoverability — manifest', () => {
  test('guide page is not registered as a web_accessible_resource', () => {
    const resources = manifestJson.web_accessible_resources || [];
    const guideResource = resources.find(r =>
      r.resources && r.resources.includes('guide/guide.html')
    );
    expect(guideResource).toBeUndefined();
  });

  test('page context script is only exposed to page schemes', () => {
    const resources = manifestJson.web_accessible_resources || [];
    const pageContextResource = resources.find(r =>
      r.resources && r.resources.includes('contentScript/pageContext.js')
    );

    expect(pageContextResource).toBeDefined();
    expect(pageContextResource.matches).toEqual(['<all_urls>']);
  });
});
