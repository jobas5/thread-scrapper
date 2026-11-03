// Service worker: polls the local server for jobs, runs them in a tab, reports results.
const DEFAULT_SERVER = 'http://localhost:3000';
const POLL_MS = 2500;
const STALL_MS = 90_000;

let current = null; // { id, tabId, count, lastActivity, closeTab }
let online = false;

async function serverUrl() {
  const { serverUrl } = await chrome.storage.local.get('serverUrl');
  return serverUrl || DEFAULT_SERVER;
}

async function post(path, body) {
  const base = await serverUrl();
  const r = await fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  if (!r.ok) throw new Error(`${path} -> ${r.status}`);
}

function waitForLoad(tabId, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { chrome.tabs.onUpdated.removeListener(onUpd); reject(new Error('Page load timed out')); }, timeoutMs);
    function onUpd(id, info) {
      if (id === tabId && info.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(onUpd);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(onUpd);
  });
}

async function runJob(job) {
  const tab = await chrome.tabs.create({ url: job.url, active: !job.background });
  current = { id: job.id, tabId: tab.id, count: 0, lastActivity: Date.now(), closeTab: job.closeTab };
  try {
    await waitForLoad(tab.id);
    await new Promise((r) => setTimeout(r, 2500)); // let the feed hydrate
    const url = (await chrome.tabs.get(tab.id)).url || '';
    if (/\/login/.test(url)) throw new Error('Threads redirected to the login page. Sign in to Threads in this Chrome first.');
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['scraper.js'] });
    await chrome.tabs.sendMessage(tab.id, { type: 'start', jobId: job.id, options: { maxPosts: job.maxPosts } });
  } catch (e) {
    await finish({ error: String(e?.message || e) });
  }
}

async function finish({ posts, pageTitle, error }) {
  if (!current) return;
  const { id, tabId, closeTab } = current;
  current = null;
  try {
    if (error) await post(`/api/jobs/${id}/error`, { error });
    else await post(`/api/jobs/${id}/result`, { posts, pageTitle });
  } catch (e) {
    console.error('report failed', e);
  }
  if (closeTab) chrome.tabs.remove(tabId).catch(() => {});
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'status') { sendResponse({ online, job: current ? { id: current.id, count: current.count } : null }); return; }
  if (!current || msg?.jobId !== current.id) return;
  current.lastActivity = Date.now();
  if (msg.type === 'progress') { current.count = msg.count; post(`/api/jobs/${current.id}/progress`, { count: msg.count }).catch(() => {}); }
  else if (msg.type === 'result') finish({ posts: msg.posts, pageTitle: msg.pageTitle });
  else if (msg.type === 'error') finish({ error: msg.error });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (current && current.tabId === tabId) finish({ error: 'Tab was closed before the scrape finished' });
});

async function poll() {
  try {
    if (current) {
      if (Date.now() - current.lastActivity > STALL_MS) await finish({ error: 'Scrape stalled (no progress for 90s)' });
      return;
    }
    const base = await serverUrl();
    const r = await fetch(`${base}/api/jobs/next`);
    online = r.ok;
    if (!r.ok) return;
    const job = await r.json();
    if (job) await runJob(job);
  } catch {
    online = false;
  }
}

// keep the worker alive while polling; the alarm restarts it if Chrome ever suspends it
setInterval(() => { chrome.runtime.getPlatformInfo(); poll(); }, POLL_MS);
chrome.alarms.create('poll', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(poll);
poll();
