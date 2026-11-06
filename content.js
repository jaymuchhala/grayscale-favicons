(() => {
  if (window.__grayFavicon || !document.head) return;
  window.__grayFavicon = true;

  const MARK = 'data-gray-favicon';
  let intensity = 100;     // 0..100
  let lift = 50;           // 0..100, raises the black point
  let originalHref = null; // the site's real favicon URL
  let stash = [];          // site <link> nodes we removed (restored at 0%)
  let ours = null;         // our replacement <link>
  let blocked = false;     // the page's CSP refuses our icon
  let fbHref = null;       // site's own icon URL, used by the redirect fallback
  let moCount = 0;         // re-applies triggered by page mutations
  let timer = null;
  let renderId = 0;
  const fetched = new Map(); // href -> data URL

  const iconLinks = () =>
    [...document.querySelectorAll('link[rel~="icon"]')].filter(l => !l.hasAttribute(MARK));

  function pickBest(links) {
    const score = l => {
      const s = (l.getAttribute('sizes') || '').toLowerCase();
      if (s === 'any' || /svg/.test(l.type || '')) return 1000;
      const m = s.match(/(\d+)x\d+/);
      if (!m) return 0;
      const w = +m[1];
      return w >= 32 ? 500 - w : w;
    };
    return links.reduce((a, b) => (score(b) >= score(a) ? b : a));
  }

  const mo = new MutationObserver(() => {
    if (intensity <= 0 || blocked) return;
    if (++moCount > 25) { mo.disconnect(); return; } // page keeps fighting us; give up
    clearTimeout(timer);
    timer = setTimeout(apply, 50);
  });
  const watch = () =>
    mo.observe(document.head, { childList: true, subtree: true, attributes: true, attributeFilter: ['href', 'rel'] });

  async function toGray(href, t) {
    let src = href;
    if (!href.startsWith('data:')) {
      if (!fetched.has(href)) {
        let res = null;
        try { res = await chrome.runtime.sendMessage({ type: 'fetchIcon', url: href }); } catch (e) {}
        fetched.set(href, res && res.dataUrl);
      }
      src = fetched.get(href);
      if (!src) return null;
    }
    const img = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = reject;
      i.src = src;
    }).catch(() => null);
    if (!img) return null;
    const size = 64;
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const ctx = c.getContext('2d');
    ctx.filter = `grayscale(${t})`;
    ctx.drawImage(img, 0, 0, size, size);
    if (lift > 0 && t > 0) {
      // Only raise shades darker than the target grey; lighter shades are untouched.
      const floor = lift * 1.6 * t;
      const d = ctx.getImageData(0, 0, size, size);
      const px = d.data;
      for (let i = 0; i < px.length; i += 4) {
        if (px[i] < floor) px[i] = floor;
        if (px[i + 1] < floor) px[i + 1] = floor;
        if (px[i + 2] < floor) px[i + 2] = floor;
      }
      ctx.putImageData(d, 0, 0);
    }
    return c.toDataURL('image/png');
  }

  function restore() {
    renderId++;
    mo.disconnect();
    if (ours) { ours.remove(); ours = null; }
    stash.forEach(l => document.head.appendChild(l));
    stash = [];
    originalHref = null;
    watch();
  }

  // Fallback for CSP-restricted pages: keep the site's own (allowed) icon URL
  // and have the background redirect that request to our grayscale image.
  async function applyFallback() {
    if (!fbHref) return;
    const id = ++renderId;
    const base = fbHref.split('#')[0];
    let gray = null;
    if (intensity > 0) {
      gray = await toGray(base, intensity / 100);
      if (id !== renderId || !gray) return;
    }
    try {
      await chrome.runtime.sendMessage({ type: 'iconRule', url: base, dataUrl: gray });
    } catch (e) { return; }
    // A new fragment makes Chrome treat it as a new icon URL and re-download it.
    const link = iconLinks().find(l => l.href.split('#')[0] === base);
    if (link) link.setAttribute('href', base + '#gray-' + intensity + '-' + lift);
  }

  async function apply() {
    if (blocked) return applyFallback();
    if (intensity <= 0) return restore();
    if (blocked) return;
    const id = ++renderId;

    // Pick up whatever icon the site currently declares.
    mo.disconnect();
    const links = iconLinks();
    if (links.length) {
      originalHref = pickBest(links).href;
      stash = links;
      links.forEach(l => l.remove());
    } else if (ours && ours.isConnected && ours.getAttribute('href') !== ours.__set) {
      originalHref = ours.href; // site edited our link's href directly
    }
    if (!originalHref) originalHref = new URL('/favicon.ico', location.origin).href;
    watch();

    const dataUrl = await toGray(originalHref, intensity / 100);
    if (id !== renderId) return;
    if (!dataUrl) return restore(); // couldn't process; leave the site's icon alone

    mo.disconnect();
    if (!ours) {
      ours = document.createElement('link');
      ours.rel = 'icon';
      ours.type = 'image/png';
      ours.setAttribute(MARK, '1');
    }
    if (ours.getAttribute('href') !== dataUrl) ours.href = dataUrl;
    ours.__set = dataUrl;
    if (!ours.isConnected) document.head.appendChild(ours);
    watch();
  }

  // Some sites' CSP forbids data: images (even for the favicon). Detect that,
  // put the site's own icon back, and stop trying on this page.
  document.addEventListener('securitypolicyviolation', e => {
    if (e.disposition !== 'enforce') return; // report-only policies (YouTube) don't block anything
    if (!ours || !String(e.violatedDirective).startsWith('img-src')) return;
    if (e.blockedURI !== 'data' && !String(e.blockedURI).startsWith('data:')) return;
    blocked = true;
    fbHref = originalHref;
    restore();
    applyFallback();
  });

  // Check the page's CSP up front; if it forbids data: images, use the fallback
  // directly instead of inserting a data: icon and waiting for the violation.
  const meta = [...document.querySelectorAll('meta[http-equiv]')]
    .filter(m => m.httpEquiv.toLowerCase() === 'content-security-policy')
    .map(m => m.content || '');
  Promise.all([
    chrome.storage.local.get({ intensity: 100, lift: 50 }),
    chrome.runtime.sendMessage({ type: 'cspCheck', meta }).catch(() => null)
  ]).then(([v, csp]) => {
    intensity = v.intensity;
    lift = v.lift;
    if (csp && csp.blocked) {
      blocked = true;
      const links = iconLinks();
      fbHref = links.length ? pickBest(links).href : new URL('/favicon.ico', location.origin).href;
    }
    if (intensity > 0) apply();
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.lift) lift = changes.lift.newValue;
    if (changes.intensity) intensity = changes.intensity.newValue;
    if (changes.intensity || changes.lift) apply();
  });
})();
