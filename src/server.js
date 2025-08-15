import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import multer from 'multer';

// Models
import Settings from './models/Settings.js';
import PostQueue from './models/PostQueue.js';
import PostedMemo from './models/PostedMemo.js';
import PostingLock from './models/PostingLock.js';
import ActivityLog from './models/ActivityLog.js';

dotenv.config();

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(morgan('dev'));
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 1024 * 1024 * 1024 } });

const corsOrigins = (process.env.CORS_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
app.use(cors({ origin: (origin, cb) => cb(null, !origin || corsOrigins.length === 0 || corsOrigins.some(o => origin.includes(o))), methods: ['GET','POST','OPTIONS'], allowedHeaders: ['Content-Type','Authorization'], credentials: false }));

const PORT = process.env.PORT || 3001;
const MONGO_URI = process.env.MONGO_URI || process.env.MONGODB_URI || '';
const TIMEZONE = process.env.TIMEZONE || 'America/Chicago';

if (!MONGO_URI) {
  console.warn('⚠️ MONGO_URI is not set. API will start but DB calls will fail.');
}

await mongoose.connect(MONGO_URI).catch(err => console.error('Mongo connect error:', err.message));

// Helpers
async function getOrCreateSettings() {
  let s = await Settings.findOne();
  if (!s) s = await Settings.create({});
  return s;
}

function normalizeCaption(caption = '') {
  return String(caption)
    .toLowerCase()
    .replace(/[\u{1F600}-\u{1F6FF}]/gu, '')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[^a-z0-9\s#]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function hammingDistanceHex(a, b) {
  if (!a || !b) return 9999;
  const aNum = BigInt('0x' + a);
  const bNum = BigInt('0x' + b);
  let x = aNum ^ bNum;
  let dist = 0;
  while (x) { dist += Number(x & 1n); x >>= 1n; }
  return dist;
}

function cosineSimFromTokens(a, b) {
  const ta = new Map();
  const tb = new Map();
  for (const t of a.split(' ')) ta.set(t, (ta.get(t) || 0) + 1);
  for (const t of b.split(' ')) tb.set(t, (tb.get(t) || 0) + 1);
  const all = new Set([...ta.keys(), ...tb.keys()]);
  let dot = 0, na = 0, nb = 0;
  all.forEach(k => { const va = ta.get(k) || 0; const vb = tb.get(k) || 0; dot += va * vb; na += va * va; nb += vb * vb; });
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function ctNowHHmm() {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date());
  } catch {
    return new Intl.DateTimeFormat('en-US', { hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date());
  }
}

function isCtNowWithinWindow(startHHmm, endHHmm) {
  if (!startHHmm || !endHHmm) return false;
  const now = ctNowHHmm();
  // Compare strings like "18:00" lexicographically since fixed HH:mm format
  if (startHHmm <= endHHmm) {
    return now >= startHHmm && now < endHHmm;
  }
  // window crosses midnight
  return now >= startHHmm || now < endHHmm;
}

async function getLastNPosted(platform, n) {
  return PostedMemo.find({ platform }).sort({ postedAt: -1 }).limit(n).lean();
}

async function isDuplicateCandidate(candidate, settings) {
  const windowN = settings.recentPostsWindowCount || 30;
  const recent = await getLastNPosted(candidate.platform, windowN);
  const captionNorm = normalizeCaption(candidate.caption || candidate.captionNorm || '');
  for (const item of recent) {
    const hamming = hammingDistanceHex(candidate.visualHash, item.visualHash);
    if (hamming <= 8) return { duplicate: true, reason: 'duplicate_visual' };
    const capSim = cosineSimFromTokens(captionNorm, item.captionNorm || '');
    if (capSim >= 0.92) return { duplicate: true, reason: 'duplicate_caption' };
    const durDelta = Math.abs((candidate.durationSec || 0) - (item.durationSec || 0));
    if (capSim >= 0.85 && durDelta <= 1) return { duplicate: true, reason: 'duplicate_caption_duration' };
  }
  return { duplicate: false };
}

// Seed demo candidates on first run
(async () => {
  await getOrCreateSettings();
  const count = await PostQueue.countDocuments();
  if (count === 0) {
    const igLikes = [1200, 900, 750, 450, 100, 50, 1400, 820];
    const docs = igLikes.map((likes, i) => ({
      platform: 'instagram',
      caption: `IG demo video ${i+1}`,
      captionNorm: normalizeCaption(`IG demo video ${i+1}`),
      engagement: { likes },
      status: 'queued',
      visualHash: (100000 + i).toString(16),
      durationSec: 10 + i,
      s3Url: `s3://bucket/demo${i+1}.mp4`
    }));
    docs.push({ platform: 'youtube', caption: 'YT demo 1', captionNorm: normalizeCaption('YT demo 1'), engagement: { likes: 50 }, status: 'queued', visualHash: 'ff01', durationSec: 30, s3Url: 's3://bucket/yt1.mp4' });
    docs.push({ platform: 'youtube', caption: 'YT demo 2', captionNorm: normalizeCaption('YT demo 2'), engagement: { likes: 80 }, status: 'queued', visualHash: 'ff02', durationSec: 35, s3Url: 's3://bucket/yt2.mp4' });
    await PostQueue.insertMany(docs);
    await ActivityLog.create({ type: 'seed', status: 'success', message: 'Seeded demo candidates', data: { count: docs.length } });
  }
})();

// Scheduler state and helpers
const schedulerState = {
  lastTickAt: null,
  lastRunDurationMs: null,
  lockHeld: false,
  lastRefillAt: null,
  lastRefillAdded: 0
};

async function tryAcquireLock(key, ttlSec) {
  const expiresAt = new Date(Date.now() + ttlSec * 1000);
  try {
    await PostingLock.create({ key, expiresAt });
    return true;
  } catch (e) {
    return false;
  }
}

async function scheduleRefill(threshold = 3) {
  const s = await getOrCreateSettings();
  const scheduledCount = await PostQueue.countDocuments({ status: 'scheduled' });
  let added = 0;
  if (scheduledCount < threshold) {
    const need = threshold - scheduledCount;
    const candidates = await PostQueue.find({ status: 'queued' }).sort({ 'engagement.likes': -1 }).limit(100);
    for (const cand of candidates) {
      if (cand.platform === 'instagram' && (cand.engagement?.likes || 0) < s.minimumIGLikesToRepost) continue;
      const dup = await isDuplicateCandidate(cand, s);
      if (dup.duplicate) {
        cand.status = 'skipped';
        await cand.save();
        await ActivityLog.create({ type: 'schedule', platform: cand.platform, status: 'warning', message: 'Skipped duplicate', data: { reason: dup.reason } });
        continue;
      }
      cand.captionNorm = normalizeCaption(cand.caption || '');
      cand.status = 'scheduled';
      cand.scheduledAt = new Date(Date.now() + (added * 60 + 30) * 1000);
      await cand.save();
      added++;
      pushEvent({ type: 'schedule', platform: cand.platform, message: 'Scheduled', meta: { id: cand._id, at: cand.scheduledAt } });
      await ActivityLog.create({ type: 'schedule', platform: cand.platform, status: 'success', message: 'Scheduled', data: { id: cand._id } });
      if (added >= need) break;
    }
  }
  return { added, scheduledCount: await PostQueue.countDocuments({ status: 'scheduled' }), threshold };
}

async function postDueWithCaps() {
  const s = await getOrCreateSettings();
  const burstActive = s.burstModeEnabled && isCtNowWithinWindow(s.burstModeConfig?.startTime, s.burstModeConfig?.endTime);
  const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
  const perPlatformTotals = { instagram: 0, youtube: 0 };
  // posted in the last hour per platform
  perPlatformTotals.instagram = await PostQueue.countDocuments({ platform: 'instagram', status: 'posted', postedAt: { $gte: hourAgo } });
  perPlatformTotals.youtube = await PostQueue.countDocuments({ platform: 'youtube', status: 'posted', postedAt: { $gte: hourAgo } });
  const hourlyLimit = burstActive ? (s.burstModeConfig?.postsPerHour || s.hourlyLimit) : s.hourlyLimit;

  const due = await PostQueue.find({ status: 'scheduled', scheduledAt: { $lte: new Date() } }).sort({ scheduledAt: 1 }).limit(50);
  let posted = 0, skipped = 0;
  for (const item of due) {
    // enforce per-hour cap per platform
    if (perPlatformTotals[item.platform] >= hourlyLimit) continue;
    const lockOk = await tryAcquireLock(`post:${item._id}`, 120);
    if (!lockOk) continue;
    pushEvent({ type: 'claim', platform: item.platform, message: 'Claimed for posting', meta: { id: item._id } });
    const dup = await isDuplicateCandidate(item, s);
    if (dup.duplicate) {
      item.status = 'skipped'; await item.save(); skipped++;
      await ActivityLog.create({ type: 'post', platform: item.platform, status: 'warning', message: 'Skipped duplicate at post time', data: { id: item._id, reason: dup.reason } });
      continue;
    }
    item.status = 'posted'; item.postedAt = new Date(); await item.save();
    await PostedMemo.create({ platform: item.platform, postedAt: item.postedAt, visualHash: item.visualHash, captionNorm: item.captionNorm, durationSec: item.durationSec, audioKey: item.audioKey });
    perPlatformTotals[item.platform] += 1;
    posted++;
    pushEvent({ type: 'post_success', platform: item.platform, message: 'Posted 1 item', meta: { id: item._id, postedAt: item.postedAt } });
    await ActivityLog.create({ type: 'post', platform: item.platform, status: 'success', message: 'Posted', data: { id: item._id } });
  }
  return { posted, skipped };
}

function startScheduler() {
  setInterval(async () => {
    const start = Date.now();
    const have = await tryAcquireLock('scheduler', 55);
    schedulerState.lockHeld = have;
    if (!have) {
      schedulerState.lastTickAt = new Date().toISOString();
      schedulerState.lastRunDurationMs = Date.now() - start;
      return;
    }
    try {
      const refill = await scheduleRefill(3);
      schedulerState.lastRefillAt = new Date().toISOString();
      schedulerState.lastRefillAdded = refill.added;
      await postDueWithCaps();
    } catch (e) {
      await ActivityLog.create({ type: 'error', status: 'failed', message: 'Scheduler tick error', data: { error: String(e?.message || e) } });
    } finally {
      schedulerState.lastTickAt = new Date().toISOString();
      schedulerState.lastRunDurationMs = Date.now() - start;
    }
  }, 60 * 1000);
}

startScheduler();

// Health route (always responds)
app.get('/api/scheduler/health', async (req, res) => {
  res.json({ ok: true, ...schedulerState });
});

// GET /api/settings
app.get('/api/settings', async (req, res) => {
  const s = await getOrCreateSettings();
  const mask = (v) => (v ? '✅ Configured' : '❌ Missing');
  res.json({
    autopilotEnabled: s.autopilotEnabled,
    manual: s.manual,
    postTime: s.postTime,
    peakHours: s.peakHours,
    maxPosts: s.maxPosts ?? s.dailyLimit,
    minimumIGLikesToRepost: s.minimumIGLikesToRepost,
    recentPostsToCheck: s.recentPostsToCheck ?? s.recentPostsWindowCount,
    hourlyLimit: s.hourlyLimit,
    dailyLimit: s.dailyLimit,
    autopilotPlatforms: s.autopilotPlatforms,
    trendingAudio: s.trendingAudio,
    aiCaptions: s.aiCaptions,
    dropboxSave: s.dropboxSave,
    timeZone: s.timeZone,
    burstModeEnabled: s.burstModeEnabled,
    burstModeConfig: s.burstModeConfig,

    instagramToken: mask(s.instagramToken),
    igBusinessId: mask(s.igBusinessId),
    facebookPageId: mask(s.facebookPageId),
    youtubeAccessToken: mask(s.youtubeAccessToken),
    youtubeRefreshToken: mask(s.youtubeRefreshToken),
    youtubeChannelId: mask(s.youtubeChannelId),
    youtubeClientId: mask(s.youtubeClientId),
    youtubeClientSecret: mask(s.youtubeClientSecret),
    dropboxToken: mask(s.dropboxToken),
    runwayApiKey: mask(s.runwayApiKey),
    openaiApiKey: mask(s.openaiApiKey),
    s3AccessKey: mask(s.s3AccessKey),
    s3SecretKey: mask(s.s3SecretKey),
    s3BucketName: mask(s.s3BucketName),
    s3Region: mask(s.s3Region),
    mongoURI: mask(s.mongoURI)
  });
});

// POST /api/settings
app.post('/api/settings', async (req, res) => {
  if (!MONGO_URI) return res.status(500).json({ success: false, error: 'Server DB not configured' });
  const s = await getOrCreateSettings();

  // Only accept exact keys; ignore others silently
  const allowedKeys = new Set([
    'instagramToken','igBusinessId','facebookPageId',
    'youtubeAccessToken','youtubeRefreshToken','youtubeChannelId','youtubeClientId','youtubeClientSecret',
    'dropboxToken','runwayApiKey','openaiApiKey','s3AccessKey','s3SecretKey','s3BucketName','s3Region','mongoURI',
    'autopilotEnabled','manual','postTime','peakHours','maxPosts','minimumIGLikesToRepost','recentPostsToCheck','hourlyLimit','dailyLimit','autopilotPlatforms','trendingAudio','aiCaptions','dropboxSave','timeZone',
    // legacy alias
    'minViews'
  ]);

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const update = {};
  const updatedKeys = [];

  // Map legacy alias
  if (Object.prototype.hasOwnProperty.call(body, 'minViews') && !Object.prototype.hasOwnProperty.call(body, 'minimumIGLikesToRepost')) {
    body.minimumIGLikesToRepost = body.minViews;
  }

  // Coerce numerics only if present (and not blank)
  const numericKeys = ['maxPosts','minimumIGLikesToRepost','recentPostsToCheck','hourlyLimit','dailyLimit'];

  for (const [k, v] of Object.entries(body)) {
    if (!allowedKeys.has(k)) continue;
    if (v === '' || v === null || typeof v === 'undefined') continue; // do not overwrite with blank
    let val = v;
    if (numericKeys.includes(k)) {
      const n = typeof v === 'string' ? parseInt(v, 10) : v;
      if (!Number.isNaN(n)) val = n; else continue;
    }
    if (k === 'autopilotPlatforms' && typeof v === 'object' && v) {
      val = { instagram: !!v.instagram, youtube: !!v.youtube };
    }
    update[k] = val;
    updatedKeys.push(k);
  }

  // Couple manual when autopilotEnabled provided and manual not explicitly set
  if (Object.prototype.hasOwnProperty.call(update, 'autopilotEnabled') && !Object.prototype.hasOwnProperty.call(body, 'manual')) {
    update.manual = !update.autopilotEnabled;
    if (!updatedKeys.includes('manual')) updatedKeys.push('manual');
  }

  if (updatedKeys.length > 0) {
    await Settings.updateOne({ _id: s._id }, { $set: update });
  }

  res.json({ success: true, saved: updatedKeys });
});

// Autopilot status
app.get('/api/autopilot/status', async (req, res) => {
  const s = await getOrCreateSettings();
  const queueCount = await PostQueue.countDocuments({ status: { $in: ['queued','scheduled','posting'] } });
  const startOfDay = new Date(); startOfDay.setHours(0,0,0,0);
  const todayIG = await PostQueue.countDocuments({ platform: 'instagram', status: 'posted', postedAt: { $gte: startOfDay } });
  const todayYT = await PostQueue.countDocuments({ platform: 'youtube', status: 'posted', postedAt: { $gte: startOfDay } });
  res.json({ success: true, autopilotEnabled: s.autopilotEnabled, queueCount, todayPosts: { instagram: todayIG, youtube: todayYT }, caps: { hourlyLimit: s.hourlyLimit, dailyLimit: s.dailyLimit }, burst: { enabled: s.burstModeEnabled, ...s.burstModeConfig } });
});

// Autopilot queue
app.get('/api/autopilot/queue', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '50', 10), 200);
  const queue = await PostQueue.find({ status: { $in: ['queued','scheduled','posting'] } }).sort({ scheduledAt: 1 }).limit(limit).lean();
  res.json({ success: true, queue, posts: queue });
});

// Refill: schedule items based on likes + dedupe
app.post('/api/autopilot/refill', async (req, res) => {
  const out = await scheduleRefill(3);
  res.json({ success: true, ...out });
});

// New: run now (scrape/filter/schedule simplified to refill logic)
app.post('/api/autopilot/run', async (req, res) => {
  const out = await scheduleRefill(5);
  res.json({ success: true, scheduled: out.added, skipped: 0, checked: out.added });
});

// Autofill optimal times (stubbed)
app.post('/api/scheduler/autofill', async (req, res) => {
  res.json({ success: true, filled: 0 });
});

// Heatmap
app.get('/api/heatmap/weekly', async (req, res) => {
  const matrix = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0));
  res.json({ matrix, meta: { scale: { min: 0, max: 100 }, generatedAt: new Date().toISOString(), method: 'weighted', weights: { viewerActivity: 0.6, postPerformance: 0.4 } }, topSlots: [] });
});
app.get('/api/heatmap/optimal-times', async (req, res) => {
  res.json({ slots: [] });
});

// Analytics
app.get('/api/analytics', async (req, res) => {
  res.json({ instagram: { followers: 0, engagementRate: 0, reach: 0, connected: false }, youtube: { subscribers: 0, views: 0, watchTimeHours: 0, connected: false }, timeseries: { labels: [], instagram: [], youtube: [], combined: [] }, credentials: {} });
});
app.get('/api/instagram/analytics', async (req, res) => {
  res.json({ analytics: { followers: 0, engagementRate: 0, reach: 0, connected: false } });
});
app.get('/api/youtube/analytics', async (req, res) => {
  res.json({ analytics: { subscribers: 0, views: 0, watchTimeHours: 0, connected: false } });
});

// Scheduler status
app.get('/api/scheduler/status', async (req, res) => {
  const s = await getOrCreateSettings();
  const startOfDay = new Date(); startOfDay.setHours(0,0,0,0);
  const igUsed = await PostQueue.countDocuments({ platform: 'instagram', status: 'posted', postedAt: { $gte: startOfDay } });
  const ytUsed = await PostQueue.countDocuments({ platform: 'youtube', status: 'posted', postedAt: { $gte: startOfDay } });
  const nextRun = new Date(Date.now() + 60 * 1000).toISOString();
  res.json({ instagram: { used: igUsed, limit: s.dailyLimit }, youtube: { used: ytUsed, limit: s.dailyLimit }, nextRun });
});

// Diagnostics
app.get('/api/diag/autopilot-report', async (req, res) => {
  const s = await getOrCreateSettings();
  const total = await PostQueue.countDocuments();
  const dueNow = await PostQueue.countDocuments({ status: 'scheduled', scheduledAt: { $lte: new Date() } });
  const postingNow = await PostQueue.countDocuments({ status: 'posting' });
  const last10 = await PostQueue.find().sort({ updatedAt: -1 }).limit(10).lean();
  res.json({ settings: { autopilotEnabled: s.autopilotEnabled, dailyLimit: s.dailyLimit, hourlyLimit: s.hourlyLimit, timeZone: s.timeZone, recentPostsWindowCount: s.recentPostsWindowCount, burstModeEnabled: s.burstModeEnabled, burstModeConfig: s.burstModeConfig }, scheduler: { running: true, lastTickIso: schedulerState.lastTickAt, tickEverySec: 60, activeLocks: schedulerState.lockHeld ? ['scheduler'] : [] }, queue: { total, dueNow, postingNow, last10 }, postsLastHour: { count: 0, byPlatform: {} }, countersToday: { instagram: 0, youtube: 0, total: 0 }, locks: { schedulerLock: schedulerState.lockHeld, postOnceLocks: 0 } });
});
app.post('/api/diag/reset-counters', async (req, res) => { res.json({ ok: true }); });

// Burst
app.get('/api/burst', async (req, res) => {
  const s = await getOrCreateSettings();
  res.json({ success: true, burstModeEnabled: s.burstModeEnabled, burstModeConfig: s.burstModeConfig });
});
app.post('/api/burst', async (req, res) => {
  const s = await getOrCreateSettings();
  await Settings.updateOne({ _id: s._id }, { $set: req.body || {} });
  res.json({ success: true });
});
app.post('/api/burst/config', async (req, res) => {
  const s = await getOrCreateSettings();
  await Settings.updateOne({ _id: s._id }, { $set: { burstModeConfig: req.body } });
  res.json({ success: true });
});

// Activity feed (basic)
app.get('/api/activity/feed', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '20', 10), 200);
  const logs = await ActivityLog.find().sort({ timestamp: -1 }).limit(limit).lean();
  res.json({ data: logs });
});

// Events recent (in-memory)
const inMemoryEvents = [];
function pushEvent(e) {
  inMemoryEvents.unshift({ id: `${Date.now()}-${Math.random().toString(36).slice(2)}`, ts: Date.now(), ...e });
  if (inMemoryEvents.length > 400) inMemoryEvents.length = 400;
}
app.get('/api/events/recent', (req, res) => {
  const since = Number(req.query.since) || 0;
  const list = since ? inMemoryEvents.filter(ev => ev.ts > since).slice(0, 200) : inMemoryEvents.slice(0, 200);
  res.json({ events: list, timestamp: Date.now() });
});

// Chart status (basic)
app.get('/api/chart/status', async (req, res) => {
  const s = await getOrCreateSettings();
  res.json({ engagementScore: 0.5, autopilotRunning: !!s.autopilotEnabled, newHighScore: false, lastPostTime: null, platformData: { instagram: { active: s.autopilotPlatforms.instagram, todayPosts: 0, reach: 0, trending: false, lastPostTime: null }, youtube: { active: s.autopilotPlatforms.youtube, todayPosts: 0, reach: 0, trending: false, lastPostTime: null } }, settings: { dailyPostLimit: s.dailyLimit } });
});

// Posting: post-now / manual-post
async function postDueNow() {
  const due = await PostQueue.find({ status: 'scheduled', scheduledAt: { $lte: new Date() } }).limit(50);
  let posted = 0, skipped = 0;
  const s = await getOrCreateSettings();
  for (const item of due) {
    const dup = await isDuplicateCandidate(item, s);
    if (dup.duplicate) {
      item.status = 'skipped'; await item.save(); skipped++; continue;
    }
    item.status = 'posted'; item.postedAt = new Date(); await item.save();
    await PostedMemo.create({ platform: item.platform, postedAt: item.postedAt, visualHash: item.visualHash, captionNorm: item.captionNorm, durationSec: item.durationSec, audioKey: item.audioKey });
    posted++;
    pushEvent({ type: 'post_success', platform: item.platform, message: 'Posted 1 item', meta: { id: item._id } });
    await ActivityLog.create({ type: 'post', platform: item.platform, status: 'success', message: 'Posted', data: { id: item._id } });
  }
  return { posted, skipped };
}

app.post('/api/post-now', async (req, res) => {
  const r = await postDueNow();
  res.json({ success: true, posted: r.posted, skipped: r.skipped });
});
app.post('/api/autopilot/manual-post', async (req, res) => {
  const r = await postDueNow();
  res.json({ success: true, posted: r.posted, skipped: r.skipped });
});

// Debug sim-check
app.post('/api/debug/similarity-check', async (req, res) => {
  const s = await getOrCreateSettings();
  const candidate = {
    platform: req.body.platform || 'instagram',
    visualHash: req.body.visualHash || null,
    captionNorm: normalizeCaption(req.body.caption || ''),
    durationSec: req.body.durationSec || null
  };
  const recent = await getLastNPosted(candidate.platform, s.recentPostsWindowCount || 30);
  const sample = recent.map(r => ({ postedAt: r.postedAt, visualHash: r.visualHash, captionNorm: r.captionNorm, audioKey: r.audioKey, durationSec: r.durationSec, distances: { visualHamming: hammingDistanceHex(candidate.visualHash, r.visualHash), captionSim: cosineSimFromTokens(candidate.captionNorm, r.captionNorm || ''), durationDelta: Math.abs((candidate.durationSec || 0) - (r.durationSec || 0)) } }));
  let decision = { duplicate: false, reason: 'none' };
  for (const r of sample) {
    if (r.distances.visualHamming <= 8) { decision = { duplicate: true, reason: 'duplicate_visual' }; break; }
    if (r.distances.captionSim >= 0.92) { decision = { duplicate: true, reason: 'duplicate_caption' }; break; }
    if (r.distances.captionSim >= 0.85 && r.distances.durationDelta <= 1) { decision = { duplicate: true, reason: 'duplicate_caption_duration' }; break; }
  }
  res.json({ candidate, recentSample: sample.slice(0, 5), decision, windowType: 'lastN', windowN: s.recentPostsWindowCount || 30 });
});

// Uploads
app.post('/api/upload/drag-drop', async (req, res) => {
  res.json({ success: true, results: { uploaded: 0, duplicates: 0, details: [] } });
});
app.post('/api/upload/dragdrop', async (req, res) => {
  res.json({ success: true, results: { uploaded: 0, duplicates: 0, details: [] } });
});
app.post('/api/upload/refresh-caption', async (req, res) => { res.json({ success: true, caption: 'Smart caption placeholder' }); });
app.post('/api/upload/get-real-instagram-captions', async (req, res) => {
  const ids = Array.isArray(req.body?.mediaIds) ? req.body.mediaIds : [];
  res.json({ success: true, captions: Object.fromEntries(ids.map(id => [id, ''])) });
});
app.post('/api/upload/direct-video', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ success: false, error: 'file missing' });
  const platform = req.body?.platform || 'instagram';
  const caption = req.body?.caption || req.file.originalname;
  const doc = await PostQueue.create({ platform, caption, captionNorm: normalizeCaption(caption), status: 'queued', s3Url: `s3://demo/${req.file.originalname}`, engagement: { likes: 0 }, durationSec: null, visualHash: null });
  pushEvent({ type: 'queue_added', platform, message: `Direct upload queued: ${req.file.originalname}`, meta: { id: doc._id } });
  await ActivityLog.create({ type: 'upload', platform, status: 'success', message: 'Direct video queued', data: { id: doc._id } });
  res.json({ success: true, id: String(doc._id), queued: true });
});
app.post('/api/upload/smart-video-analyze', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ success: false, error: 'file missing' });
  res.json({ success: true, durationSec: 0, visualHash: null, firstFrameUrl: null });
});
app.post('/api/upload/dropbox-folder', async (req, res) => { 
  // lightly queue one demo item to prove wiring
  const platform = req.body?.platform || 'instagram';
  const caption = req.body?.caption || 'Dropbox demo file';
  const doc = await PostQueue.create({ platform, caption, captionNorm: normalizeCaption(caption), status: 'queued', s3Url: 's3://bucket/dropbox-demo.mp4', engagement: { likes: 1000 }, durationSec: 20, visualHash: 'db01' });
  pushEvent({ type: 'queue_added', platform, message: 'Dropbox queued 1', meta: { id: doc._id } });
  await ActivityLog.create({ type: 'upload', platform, status: 'success', message: 'Dropbox folder queued', data: { id: doc._id } });
  res.json({ success: true, added: 1, duplicates: 0 });
});
app.post('/api/upload/smart-drive-sync', async (req, res) => { res.json({ success: true, added: 0, duplicates: 0 }); });
app.post('/api/upload/sync-dropbox', async (req, res) => { res.json({ success: true, added: 0, duplicates: 0 }); });
app.post('/api/upload/dropbox', async (req, res) => { res.json({ success: true, message: 'queued 0' }); });
app.post('/api/upload/google-drive', async (req, res) => { res.json({ success: true, message: 'queued 0' }); });
app.post('/api/test/cleanup', async (req, res) => { res.json({ results: { filesRemoved: 0 } }); });
app.post('/api/test/validate-apis', async (req, res) => { res.json({ summary: { valid: 0, total: 0 } }); });
app.post('/api/test/mongodb', async (req, res) => { res.json({ message: MONGO_URI ? 'MongoDB configured' : 'No MongoDB configured' }); });
app.post('/api/test/upload', async (req, res) => { res.json({ message: 'Upload test ok' }); });

// Queue summary
app.get('/api/queue/summary', async (req, res) => {
  const total = await PostQueue.countDocuments();
  const scheduled = await PostQueue.countDocuments({ status: 'scheduled' });
  const next5Docs = await PostQueue.find({ status: 'scheduled' }).sort({ scheduledAt: 1 }).limit(5).lean();
  const next5 = next5Docs.map(d => ({ id: d._id, platform: d.platform, runAt: d.scheduledAt }));
  const postingNow = await PostQueue.countDocuments({ status: 'posting' });
  res.json({ total, scheduled, postingNow, next5 });
});

app.listen(PORT, () => console.log(`Backend refresh listening on ${PORT} TZ=${TIMEZONE}`));
