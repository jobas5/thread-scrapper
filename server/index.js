import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const DB_FILE = path.join(DATA_DIR, 'jobs.json');
const PORT = Number(process.env.PORT || 3000);

fs.mkdirSync(DATA_DIR, { recursive: true });

// ---------- persistence ----------
let jobs = [];
try {
  jobs = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  // anything that was mid-flight when the server died goes back to the queue
  for (const j of jobs) if (j.status === 'running') j.status = 'queued';
} catch {
  jobs = [];
}
let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.writeFileSync(DB_FILE, JSON.stringify(jobs, null, 2));
  }, 100);
}

// ---------- extension heartbeat ----------
let lastPing = 0;
const extensionOnline = () => Date.now() - lastPing < 10_000;

// ---------- app ----------
const app = express();
app.use(express.json({ limit: '50mb' }));
app.use((req, res, next) => {
  // the extension's service worker talks to us cross-origin
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.use(express.static(path.join(ROOT, 'public')));

const publicJob = (j) => ({ ...j, posts: undefined, postCount: j.posts?.length || 0 });
const findJob = (id) => jobs.find((j) => j.id === id);

function normalizeUrl(input) {
  let s = String(input || '').trim();
  if (!s) throw new Error('URL is required');
  if (s.startsWith('@')) s = `https://www.threads.com/${s}`;
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  const u = new URL(s);
  if (!/(^|\.)threads\.(com|net)$/i.test(u.hostname)) throw new Error('Only threads.com URLs are supported');
  u.hostname = 'www.threads.com';
  return u.toString();
}

// ----- UI endpoints -----
app.get('/api/status', (req, res) => {
  res.json({ extensionOnline: extensionOnline(), queued: jobs.filter((j) => j.status === 'queued').length });
});

app.get('/api/jobs', (req, res) => {
  res.json(jobs.slice().reverse().map(publicJob));
});

app.post('/api/jobs', (req, res) => {
  try {
    const url = normalizeUrl(req.body.url);
    const maxPosts = Math.max(1, Math.min(5000, Number(req.body.maxPosts) || 50));
    const job = {
      id: crypto.randomBytes(6).toString('hex'),
      url,
      maxPosts,
      closeTab: req.body.closeTab !== false,
      background: req.body.background === true,
      status: 'queued',
      progress: 0,
      error: null,
      createdAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
      posts: [],
    };
    jobs.push(job);
    save();
    res.status(201).json(publicJob(job));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get('/api/jobs/next', (req, res) => {
  // polled by the extension; also doubles as the heartbeat
  lastPing = Date.now();
  const job = jobs.find((j) => j.status === 'queued');
  if (!job) return res.json(null);
  job.status = 'running';
  job.startedAt = new Date().toISOString();
  save();
  job.lastActivity = Date.now();
  res.json({ id: job.id, url: job.url, maxPosts: job.maxPosts, closeTab: job.closeTab, background: job.background });
});

app.get('/api/jobs/:id', (req, res) => {
  const job = findJob(req.params.id);
  if (!job) return res.sendStatus(404);
  res.json(job);
});

app.delete('/api/jobs/:id', (req, res) => {
  const i = jobs.findIndex((j) => j.id === req.params.id);
  if (i === -1) return res.sendStatus(404);
  jobs.splice(i, 1);
  save();
  res.sendStatus(204);
});

app.post('/api/jobs/:id/cancel', (req, res) => {
  const job = findJob(req.params.id);
  if (!job) return res.sendStatus(404);
  if (job.status === 'queued') { job.status = 'cancelled'; job.finishedAt = new Date().toISOString(); save(); }
  res.json(publicJob(job));
});

// ----- extension endpoints -----
app.post('/api/jobs/:id/progress', (req, res) => {
  lastPing = Date.now();
  const job = findJob(req.params.id);
  if (!job) return res.sendStatus(404);
  job.progress = Number(req.body.count) || 0;
  job.lastActivity = Date.now();
  res.sendStatus(204);
});

app.post('/api/jobs/:id/result', (req, res) => {
  lastPing = Date.now();
  const job = findJob(req.params.id);
  if (!job) return res.sendStatus(404);
  job.posts = Array.isArray(req.body.posts) ? req.body.posts : [];
  job.progress = job.posts.length;
  job.pageTitle = req.body.pageTitle || null;
  job.status = 'done';
  job.finishedAt = new Date().toISOString();
  save();
  res.sendStatus(204);
});

app.post('/api/jobs/:id/error', (req, res) => {
  lastPing = Date.now();
  const job = findJob(req.params.id);
  if (!job) return res.sendStatus(404);
  job.error = String(req.body.error || 'Unknown error');
  job.status = 'failed';
  job.finishedAt = new Date().toISOString();
  save();
  res.sendStatus(204);
});

// ----- export -----
function toCsv(posts) {
  const cols = ['id', 'username', 'timestamp', 'url', 'text', 'likes', 'replies', 'reposts', 'shares', 'media', 'quoted_username', 'quoted_text', 'quoted_url'];
  const esc = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const rows = posts.map((p) => [
    p.id, p.username, p.timestamp, p.url, p.text, p.likes, p.replies, p.reposts, p.shares,
    (p.media || []).map((m) => m.src).join(' '),
    p.quoted?.username, p.quoted?.text, p.quoted?.url,
  ].map(esc).join(','));
  return '﻿' + [cols.join(','), ...rows].join('\r\n');
}

app.get('/api/jobs/:id/export', (req, res) => {
  const job = findJob(req.params.id);
  if (!job) return res.sendStatus(404);
  const base = `threads-${(job.url.match(/@([^/?]+)/) || [])[1] || 'export'}-${job.id}`;
  if (req.query.format === 'csv') {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${base}.csv"`);
    return res.send(toCsv(job.posts));
  }
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', `attachment; filename="${base}.json"`);
  res.send(JSON.stringify({ url: job.url, scrapedAt: job.finishedAt, posts: job.posts }, null, 2));
});

// a running job whose extension went silent is failed so the queue never blocks
const STALL_MS = 3 * 60_000;
setInterval(() => {
  for (const j of jobs) {
    if (j.status === "running" && Date.now() - (j.lastActivity || 0) > STALL_MS) {
      j.status = "failed";
      j.error = "No response from the extension for 3 minutes";
      j.finishedAt = new Date().toISOString();
      save();
    }
  }
}, 15_000);

app.listen(PORT, () => {
  console.log(`Thread scrapper running at http://localhost:${PORT}`);
  console.log(`Load the extension from ${path.join(ROOT, 'extension')} (chrome://extensions, Developer mode, Load unpacked)`);
});
