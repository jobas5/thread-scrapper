// Runs inside a threads.com tab. Collects posts while scrolling, then reports back.
(() => {
  if (window.__threadScrapper) return; // already injected
  const SEL = 'div[data-pressable-container="true"]';
  const SKIP_TEXT = new Set(['Translate', '·', 'Author', 'Pinned']);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const parseNum = (s) => {
    if (!s) return 0;
    s = String(s).trim().replace(/,/g, '').replace(/\s+/g, '');
    const m = s.match(/^([\d.]+)([KMB])?$/i);
    if (!m) return 0;
    const mul = { K: 1e3, M: 1e6, B: 1e9 }[(m[2] || '').toUpperCase()] || 1;
    return Math.round(parseFloat(m[1]) * mul);
  };

  // true when `node` belongs to a nested post (e.g. a quoted post) rather than `root`
  const inOther = (node, root) => {
    const p = node.parentElement && node.parentElement.closest(SEL);
    return !!p && p !== root;
  };

  // text of a paragraph span, skipping buttons / timestamps / carousel counters nested inside it
  function spanText(span) {
    let out = '';
    const walker = document.createTreeWalker(span, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = walker.nextNode())) {
      let e = n.parentElement, skip = false;
      while (e && e !== span) {
        if (e.getAttribute('role') === 'button' || e.tagName === 'TIME') { skip = true; break; }
        e = e.parentElement;
      }
      if (!skip) out += n.nodeValue;
    }
    return out.replace(/[ \t\u00a0]+/g, ' ').replace(/\s*\b\d+\s*\/\s*\d+\s*$/, '').trim();
  }

  function postText(root) {
    const parts = [];
    for (const s of root.querySelectorAll('span[dir="auto"]')) {
      if (inOther(s, root)) continue;
      const anc = s.parentElement.closest('span[dir="auto"]');
      if (anc && root.contains(anc) && !inOther(anc, root)) continue; // not top-level
      if (s.closest('a') || s.closest('[role="button"]') || s.querySelector('time')) continue;
      const t = spanText(s);
      if (!t || SKIP_TEXT.has(t)) continue;
      parts.push(t);
    }
    return parts.join('\n');
  }

  function parsePost(root, depth = 0) {
    const link = [...root.querySelectorAll('a[href*="/post/"]')].find((a) => !inOther(a, root));
    const path = link ? link.getAttribute('href').split('?')[0] : null;
    const m = path && path.match(/^\/@([^/]+)\/post\/([^/]+)/);
    const timeEl = [...root.querySelectorAll('time[datetime]')].find((t) => !inOther(t, root));

    const counts = {};
    for (const b of root.querySelectorAll('div[role="button"]')) {
      if (inOther(b, root)) continue;
      const title = b.querySelector('svg title');
      if (!title) continue;
      let k = title.textContent.trim().toLowerCase();
      if (k === 'unlike') k = 'like';
      if (['like', 'reply', 'repost', 'share'].includes(k)) counts[k] = parseNum(b.innerText);
    }

    const media = [];
    for (const img of root.querySelectorAll('img')) {
      if (inOther(img, root)) continue;
      const alt = img.getAttribute('alt') || '';
      if (/profile picture/i.test(alt) || img.height < 60) continue;
      media.push({ type: 'image', src: img.currentSrc || img.src, alt });
    }
    for (const v of root.querySelectorAll('video')) {
      if (inOther(v, root)) continue;
      media.push({ type: 'video', src: v.currentSrc || v.src || '', poster: v.poster || '' });
    }

    const links = [];
    for (const a of root.querySelectorAll('a[href^="http"]')) {
      if (inOther(a, root)) continue;
      const href = a.getAttribute('href');
      if (/threads\.(com|net)/.test(href) && !/^https?:\/\/l\.threads/.test(href)) continue;
      if (!links.includes(href)) links.push(href);
    }

    const quoteEl = depth < 1 ? [...root.querySelectorAll(SEL)].find((q) => q.parentElement.closest(SEL) === root) : null;

    return {
      id: m ? m[2] : null,
      username: m ? m[1] : null,
      url: path ? `https://www.threads.com${path}` : null,
      timestamp: timeEl ? timeEl.getAttribute('datetime') : null,
      text: postText(root),
      likes: counts.like || 0,
      replies: counts.reply || 0,
      reposts: counts.repost || 0,
      shares: counts.share || 0,
      media,
      links,
      quoted: quoteEl ? parsePost(quoteEl, depth + 1) : null,
    };
  }

  function collectVisible() {
    return [...document.querySelectorAll(SEL)]
      .filter((r) => !r.parentElement.closest(SEL))
      .map((r) => parsePost(r))
      .filter((p) => p.id);
  }

  let stopped = false;

  async function scrape({ maxPosts = 50, idleRounds = 6, scrollDelay = 1500 } = {}, onProgress = () => {}) {
    stopped = false;
    const seen = new Map();
    let idle = 0;
    const absorb = () => {
      let added = 0;
      for (const p of collectVisible()) {
        if (seen.has(p.id)) {
          // keep the freshest numbers but never lose text we already captured
          const prev = seen.get(p.id);
          if (!prev.text && p.text) seen.set(p.id, { ...prev, ...p });
        } else { seen.set(p.id, p); added++; }
      }
      return added;
    };

    absorb();
    onProgress(seen.size);
    while (!stopped && seen.size < maxPosts && idle < idleRounds) {
      window.scrollTo(0, document.documentElement.scrollHeight);
      await sleep(scrollDelay);
      const added = absorb();
      idle = added ? 0 : idle + 1;
      onProgress(seen.size);
    }
    return [...seen.values()].slice(0, maxPosts);
  }

  window.__threadScrapper = { scrape, stop: () => { stopped = true; }, parsePost, collectVisible };

  if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (msg?.type === 'stop') { stopped = true; sendResponse(true); return; }
      if (msg?.type !== 'start') return;
      sendResponse({ started: true });
      scrape(msg.options, (count) => chrome.runtime.sendMessage({ type: 'progress', jobId: msg.jobId, count }).catch(() => {}))
        .then((posts) => chrome.runtime.sendMessage({ type: 'result', jobId: msg.jobId, posts, pageTitle: document.title }))
        .catch((e) => chrome.runtime.sendMessage({ type: 'error', jobId: msg.jobId, error: String(e?.message || e) }));
    });
  }
})();
