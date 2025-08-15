import mongoose from 'mongoose';

const PostQueueSchema = new mongoose.Schema({
  platform: { type: String, enum: ['instagram','youtube'], required: true },
  s3Url: { type: String },
  sourceUrl: { type: String },
  caption: { type: String, default: '' },
  captionNorm: { type: String, default: '' },
  engagement: { type: Object, default: { likes: 0, comments: 0, views: 0 } },
  status: { type: String, enum: ['queued','scheduled','posting','posted','failed','skipped'], default: 'queued' },
  scheduledAt: { type: Date, default: null },
  postedAt: { type: Date, default: null },
  visualHash: { type: String, default: null },
  audioKey: { type: String, default: null },
  durationSec: { type: Number, default: null },
  meta: { type: Object, default: {} }
}, { timestamps: true, collection: 'postqueue' });

PostQueueSchema.index({ status: 1, scheduledAt: 1 });
PostQueueSchema.index({ platform: 1, postedAt: -1 });

export default mongoose.models.PostQueue || mongoose.model('PostQueue', PostQueueSchema);
