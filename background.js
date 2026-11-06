// Fetches favicons on behalf of content scripts (avoids CORS / tainted canvas).
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== 'fetchIcon') return;
  (async () => {
    try {
      const res = await fetch(msg.url, { credentials: 'include', cache: 'force-cache' });
      if (!res.ok) throw new Error('bad status ' + res.status);
      let type = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
      if (type.includes('html')) throw new Error('not an image');
      if (!type.startsWith('image/')) {
        const path = new URL(msg.url).pathname.toLowerCase();
        type = path.endsWith('.svg') ? 'image/svg+xml'
             : path.endsWith('.png') ? 'image/png'
             : path.endsWith('.jpg') || path.endsWith('.jpeg') ? 'image/jpeg'
             : 'image/x-icon';
      }
      const bytes = new Uint8Array(await res.arrayBuffer());
      let bin = '';
      for (let i = 0; i < bytes.length; i += 0x8000) {
        bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      }
      sendResponse({ dataUrl: `data:${type};base64,${btoa(bin)}` });
    } catch (e) {
      sendResponse({ dataUrl: null });
    }
  })();
  return true; // async response
});

// Apply to tabs that were already open when the extension was installed.
chrome.runtime.onInstalled.addListener(async () => {
  const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
  for (const t of tabs) {
    chrome.scripting.executeScript({ target: { tabId: t.id }, files: ['content.js'] }).catch(() => {});
  }
});

// Read each page's CSP header before its content script runs, so pages that
// forbid data: images go straight to the fallback with no CSP error.
const blocksData = policy => policy.split(',').some(p => {
  const dirs = new Map();
  for (const d of p.split(';')) {
    const [name, ...src] = d.trim().toLowerCase().split(/\s+/);
    if (name && !dirs.has(name)) dirs.set(name, src);
  }
  const src = dirs.get('img-src') || dirs.get('default-src');
  return !!src && !src.includes('data:');
});

chrome.webRequest.onHeadersReceived.addListener(d => {
  if (d.tabId < 0) return;
  const blocked = (d.responseHeaders || [])
    .some(h => h.name.toLowerCase() === 'content-security-policy' && blocksData(h.value || ''));
  chrome.storage.session.set({ ['csp:' + d.tabId + ':' + d.frameId]: blocked });
}, { urls: ['http://*/*', 'https://*/*'], types: ['main_frame', 'sub_frame'] }, ['responseHeaders']);

chrome.tabs.onRemoved.addListener(tabId => {
  chrome.storage.session.get(null).then(all => {
    const keys = Object.keys(all).filter(k => k.startsWith('csp:' + tabId + ':'));
    if (keys.length) chrome.storage.session.remove(keys);
  });
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== 'cspCheck') return;
  const meta = msg.meta || [];
  const key = 'csp:' + sender.tab?.id + ':' + sender.frameId;
  chrome.storage.session.get(key).then(v => sendResponse({ blocked: !!v[key] || meta.some(blocksData) }));
  return true;
});

// Session-only redirect rules used by the CSP fallback: requests for a site's own
// icon URL get answered with our grayscale image. No page headers are modified.
const ruleIdFor = url => {
  let h = 0;
  for (const c of url) h = (h * 31 + c.codePointAt(0)) >>> 0;
  return (h % 900000) + 1;
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== 'iconRule') return;
  (async () => {
    try {
      const id = ruleIdFor(msg.url);
      const addRules = msg.dataUrl ? [{
        id,
        priority: 1,
        action: { type: 'redirect', redirect: { url: msg.dataUrl } },
        condition: {
          urlFilter: '|' + msg.url + '|',
          resourceTypes: ['image', 'other'],
          excludedInitiatorDomains: [chrome.runtime.id]
        }
      }] : [];
      await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [id], addRules });
      sendResponse({ ok: true });
    } catch (e) {
      sendResponse({ ok: false });
    }
  })();
  return true;
});
