import mongoose from 'mongoose';

const BurstConfigSchema = new mongoose.Schema({
  startTime: { type: String, default: '00:00' },
  endTime: { type: String, default: '00:00' },
  postsPerHour: { type: Number, default: 0 },
  maxTotal: { type: Number, default: 0 },
  preloadMinutes: { type: Number, default: 0 },
  platforms: { type: [String], default: ['instagram', 'youtube'] }
}, { _id: false });

const SettingsSchema = new mongoose.Schema({
  autopilotEnabled: { type: Boolean, default: false },
  manual: { type: Boolean, default: true },
  dailyLimit: { type: Number, default: 5 },
  hourlyLimit: { type: Number, default: 3 },
  timeZone: { type: String, default: 'America/Chicago' },
  postTime: { type: String, default: '14:00' },
  peakHours: { type: Boolean, default: true },
  // UI mirrors and additional fields
  maxPosts: { type: Number, default: 5 },
  repostDelay: { type: Number, default: 1 },
  minimumIGLikesToRepost: { type: Number, default: 0 },
  // Last-N window (primary)
  recentPostsToCheck: { type: Number, default: 30 },
  // Back-compat fields still present in code paths
  recentPostsWindowCount: { type: Number, default: 30 },
  visualSimilarityRecentPosts: { type: Number, default: 30 },
  visualSimilarityDays: { type: Number, default: 30 },
  autopilotPlatforms: { type: Object, default: { instagram: true, youtube: true } },
  trendingAudio: { type: Boolean, default: true },
  aiCaptions: { type: Boolean, default: true },
  dropboxSave: { type: Boolean, default: false },
  burstModeEnabled: { type: Boolean, default: false },
  burstModeConfig: { type: BurstConfigSchema, default: {} },
  scrapeLimit: { type: Number, default: 500 },
  // Credentials
  instagramToken: String,
  igBusinessId: String,
  facebookPageId: String,
  youtubeAccessToken: String,
  youtubeRefreshToken: String,
  youtubeChannelId: String,
  youtubeClientId: String,
  youtubeClientSecret: String,
  openaiApiKey: String,
  s3AccessKey: String,
  s3SecretKey: String,
  s3BucketName: String,
  s3Region: String,
  mongoURI: String,
  dropboxToken: String,
  runwayApiKey: String
}, { timestamps: true, collection: 'settings' });

export default mongoose.models.Settings || mongoose.model('Settings', SettingsSchema);
