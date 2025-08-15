import mongoose from 'mongoose';

const PostedMemoSchema = new mongoose.Schema({
  platform: { type: String, enum: ['instagram','youtube'], required: true },
  postedAt: { type: Date, required: true },
  visualHash: { type: String, default: null },
  captionNorm: { type: String, default: '' },
  audioKey: { type: String, default: null },
  durationSec: { type: Number, default: null }
}, { timestamps: true, collection: 'postedmemo' });

PostedMemoSchema.index({ platform: 1, postedAt: -1 });
PostedMemoSchema.index({ platform: 1, visualHash: 1, postedAt: -1 });

export default mongoose.models.PostedMemo || mongoose.model('PostedMemo', PostedMemoSchema);
