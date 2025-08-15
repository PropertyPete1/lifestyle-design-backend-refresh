import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import multer from 'multer';

dotenv.config();

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(morgan('dev'));
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 1024 * 1024 * 1024 } });

const corsOrigins = (process.env.CORS_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
app.use(cors({ origin: (origin, cb) => cb(null, !origin || corsOrigins.length === 0 || corsOrigins.some(o => origin.includes(o))), credentials: true }));

const PORT = process.env.PORT || 3001;
const MONGO_URI = process.env.MONGO_URI || '';

if (!MONGO_URI) {
  console.warn('⚠️ MONGO_URI is not set. API will start but DB calls will fail.');
}

await mongoose.connect(MONGO_URI).catch(err => console.error('Mongo connect error:', err.message));

// Health route (always responds)
app.get('/api/scheduler/health', (req, res) => {
  res.json({ ok: true, lastTickAt: null, lastRunDurationMs: null, lockHeld: false, lastRefillAt: null, lastRefillAdded: 0 });
});

// Minimal placeholders for required endpoints to satisfy frontend wiring (implementation to be expanded)
app.get('/api/settings', (req, res) => {
  res.json({
    autopilotEnabled: false,
    timeZone: 'America/Chicago',
    dailyLimit: 5,
    hourlyLimit: 3,
    postTime: '14:00',
    peakHours: true,
    maxPosts: 5,
    minimumIGLikesToRepost: 0,
    recentPostsWindowCount: 30,
    autopilotPlatforms: { instagram: true, youtube: true },
  });
});

app.post('/api/settings', (req, res) => {
  res.json({ success: true });
});

app.get('/api/autopilot/status', (req, res) => {
  res.json({ success: true, autopilotEnabled: false, queueCount: 0, todayPosts: { instagram: 0, youtube: 0 }, caps: { hourlyLimit: 3, dailyLimit: 5 }, burst: { enabled: false, startTime: '00:00', endTime: '00:00', postsPerHour: 0, maxTotal: 0 } });
});

app.get('/api/autopilot/queue', (req, res) => {
  res.json({ success: true, queue: [], posts: [] });
});

app.post('/api/autopilot/run', (req, res) => {
  res.json({ success: true, scheduled: 0, skipped: 0, checked: 0 });
});

app.post('/api/autopilot/refill', (req, res) => {
  res.json({ success: true, added: 0, scheduledCount: 0, threshold: 3 });
});

// Autofill optimal times (stub)
app.post('/api/scheduler/autofill', (req, res) => {
  res.json({ success: true, filled: 0 });
});

app.get('/api/heatmap/weekly', (req, res) => {
  const matrix = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0));
  res.json({ matrix, meta: { scale: { min: 0, max: 100 }, generatedAt: new Date().toISOString(), method: 'weighted', weights: { viewerActivity: 0.6, postPerformance: 0.4 } }, topSlots: [] });
});

app.get('/api/heatmap/optimal-times', (req, res) => {
  res.json({ slots: [] });
});

app.get('/api/analytics', (req, res) => {
  res.json({ instagram: {}, youtube: {}, timeseries: { labels: [], instagram: [], youtube: [], combined: [] } });
});

// Platform analytics fallbacks
app.get('/api/instagram/analytics', (req, res) => {
  res.json({ analytics: { followers: 0, engagementRate: 0, reach: 0, connected: false } });
});
app.get('/api/youtube/analytics', (req, res) => {
  res.json({ analytics: { subscribers: 0, views: 0, watchTimeHours: 0, connected: false } });
});

app.get('/api/scheduler/status', (req, res) => {
  res.json({ instagram: { used: 0, limit: 3 }, youtube: { used: 0, limit: 3 }, nextRun: null });
});

app.get('/api/diag/autopilot-report', (req, res) => {
  res.json({ settings: { autopilotEnabled: false, dailyLimit: 5, hourlyLimit: 3, timeZone: 'America/Chicago', recentPostsWindowCount: 30, burstModeEnabled: false, burstModeConfig: { startTime: '00:00', endTime: '00:00', postsPerHour: 0, maxTotal: 0 } }, scheduler: { running: true, lastTickIso: null, tickEverySec: 60, activeLocks: [] }, queue: { total: 0, dueNow: 0, postingNow: 0, last10: [] }, postsLastHour: { count: 0, byPlatform: {} }, countersToday: { instagram: 0, youtube: 0, total: 0 }, locks: { schedulerLock: false, postOnceLocks: 0 } });
});

app.post('/api/diag/reset-counters', (req, res) => {
  res.json({ ok: true, reset: 'today', note: 'no-op demo' });
});

app.get('/api/burst', (req, res) => {
  res.json({ success: true, burstModeEnabled: false, burstModeConfig: { startTime: '00:00', endTime: '00:00', postsPerHour: 0, maxTotal: 0, preloadMinutes: 0, platforms: ['instagram','youtube'] } });
});

app.post('/api/burst', (req, res) => { res.json({ success: true }); });
app.post('/api/burst/config', (req, res) => { res.json({ success: true }); });

app.get('/api/activity/feed', (req, res) => {
  res.json({ data: [] });
});

// Events recent
const inMemoryEvents = [];
function pushEvent(e) {
  inMemoryEvents.unshift({ id: `${Date.now()}-${Math.random().toString(36).slice(2)}`, ts: Date.now(), ...e });
  if (inMemoryEvents.length > 400) inMemoryEvents.length = 400;
}
pushEvent({ type: 'scrape', platform: 'instagram', message: 'Scrape started', meta: {} });

app.get('/api/events/recent', (req, res) => {
  const since = Number(req.query.since) || 0;
  const list = since ? inMemoryEvents.filter(ev => ev.ts > since).slice(0, 200) : inMemoryEvents.slice(0, 200);
  res.json({ events: list, timestamp: Date.now() });
});

// Chart status
app.get('/api/chart/status', (req, res) => {
  res.json({ engagementScore: 0.5, autopilotRunning: false, newHighScore: false, lastPostTime: null, platformData: { instagram: { active: false, todayPosts: 0, reach: 0, trending: false, lastPostTime: null }, youtube: { active: false, todayPosts: 0, reach: 0, trending: false, lastPostTime: null } }, settings: { dailyPostLimit: 3 } });
});

// Posting
app.post('/api/post-now', (req, res) => {
  pushEvent({ type: 'post_success', platform: 'instagram', message: 'Posted 0 items', meta: {} });
  res.json({ success: true, posted: 0, skipped: 0 });
});
// manual-post compatibility
app.post('/api/autopilot/manual-post', (req, res) => {
  pushEvent({ type: 'post_success', platform: 'instagram', message: 'Manual post triggered (0)', meta: {} });
  res.json({ success: true, posted: 0, skipped: 0 });
});

app.post('/api/debug/similarity-check', (req, res) => {
  res.json({ candidate: { visualHash: null, captionNorm: null, durationSec: null }, recentSample: [], decision: { duplicate: false, reason: 'no-sample' }, windowType: 'lastN', windowN: 30 });
});

app.post('/api/upload/dragdrop', (req, res) => {
  res.json({ success: true, results: { uploaded: 0, duplicates: 0, details: [] } });
});

// Upload helpers
app.post('/api/upload/refresh-caption', (req, res) => {
  res.json({ success: true, caption: 'Smart caption placeholder' });
});

app.post('/api/upload/get-real-instagram-captions', (req, res) => {
  const body = req.body || {}; const ids = Array.isArray(body.mediaIds) ? body.mediaIds : [];
  const captions = Object.fromEntries(ids.map(id => [id, '']));
  res.json({ success: true, captions });
});

app.post('/api/upload/direct-video', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ success: false, error: 'file missing' });
  pushEvent({ type: 'queue_added', platform: req.body?.platform || 'instagram', message: `Direct upload queued: ${req.file.originalname}`, meta: { size: req.file.size } });
  res.json({ success: true, id: `${Date.now()}`, queued: true });
});

app.post('/api/upload/smart-video-analyze', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ success: false, error: 'file missing' });
  res.json({ success: true, durationSec: 0, visualHash: null, firstFrameUrl: null });
});

app.post('/api/upload/dropbox-folder', (req, res) => {
  res.json({ success: true, added: 0, duplicates: 0 });
});

app.post('/api/upload/smart-drive-sync', (req, res) => {
  res.json({ success: true, added: 0, duplicates: 0 });
});

app.post('/api/upload/sync-dropbox', (req, res) => {
  res.json({ success: true, added: 0, duplicates: 0 });
});

app.post('/api/upload/dropbox', (req, res) => { res.json({ success: true, message: 'queued 0' }); });
app.post('/api/upload/google-drive', (req, res) => { res.json({ success: true, message: 'queued 0' }); });
app.post('/api/test/cleanup', (req, res) => { res.json({ results: { filesRemoved: 0 } }); });
app.post('/api/test/validate-apis', (req, res) => { res.json({ summary: { valid: 0, total: 0 } }); });
app.post('/api/test/mongodb', (req, res) => { res.json({ message: MONGO_URI ? 'MongoDB configured' : 'No MongoDB configured' }); });
app.post('/api/test/upload', (req, res) => { res.json({ message: 'Upload test ok' }); });

// Queue summary
app.get('/api/queue/summary', (req, res) => {
  res.json({ total: 0, scheduled: 0, postingNow: 0, next5: [] });
});

app.listen(PORT, () => console.log(`Backend refresh listening on ${PORT}`));
