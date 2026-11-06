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

// Pages whose CSP forbids data: images can't show the grayscale icon. For those
// sites a session rule resends the site's own policy with data: added to img-src,
// so the icon swap works from the next load on. Policies with nonces change on
// every load and can't be copied, so those sites are left alone.
const parse = p => p.split(';').map(d => d.trim()).filter(Boolean);
const dirName = d => d.split(/\s+/)[0].toLowerCase();

const blocksData = policy => policy.split(',').some(p => {
  const dirs = parse(p);
  const d = dirs.find(x => dirName(x) === 'img-src') || dirs.find(x => dirName(x) === 'default-src');
  return !!d && !d.toLowerCase().split(/\s+/).includes('data:');
});

const withData = d => d.split(/\s+/).filter(t => t.toLowerCase() !== "'none'").concat('data:').join(' ');

const allowData = header => header.split(',').map(p => {
  if (!blocksData(p)) return p.trim();
  const dirs = parse(p);
  const i = dirs.findIndex(x => dirName(x) === 'img-src');
  if (i >= 0) dirs[i] = withData(dirs[i]);
  else dirs.push(withData('img-src' + dirs.find(x => dirName(x) === 'default-src').slice('default-src'.length)));
  return dirs.join('; ');
}).join(', ');

const ruleIdFor = s => {
  let h = 0;
  for (const c of s) h = (h * 31 + c.codePointAt(0)) >>> 0;
  return (h % 900000) + 1;
};

async function syncRule(origin, header) {
  const key = 'rule:' + origin;
  const id = ruleIdFor(origin);
  const stored = (await chrome.storage.session.get(key))[key];
  if (!header || /'nonce-/i.test(header)) {
    if (stored) {
      await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [id] });
      await chrome.storage.session.remove(key);
    }
    return false; // blocked, nothing to do
  }
  const patched = allowData(header);
  if (stored === patched) return true; // this response already got the patched policy
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [id],
    addRules: [{
      id,
      priority: 1,
      action: { type: 'modifyHeaders', responseHeaders: [{ header: 'content-security-policy', operation: 'set', value: patched }] },
      condition: { urlFilter: '|' + origin + '/', resourceTypes: ['main_frame', 'sub_frame'] }
    }]
  });
  await chrome.storage.session.set({ [key]: patched });
  return false; // takes effect on the next load
}

chrome.webRequest.onHeadersReceived.addListener(d => {
  if (d.tabId < 0) return;
  const header = (d.responseHeaders || [])
    .filter(h => h.name.toLowerCase() === 'content-security-policy')
    .map(h => h.value || '').join(', ');
  const tabKey = 'csp:' + d.tabId + ':' + d.frameId;
  if (!blocksData(header)) { chrome.storage.session.set({ [tabKey]: false }); return; }
  syncRule(new URL(d.url).origin, header)
    .catch(() => false)
    .then(ok => chrome.storage.session.set({ [tabKey]: !ok }));
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
