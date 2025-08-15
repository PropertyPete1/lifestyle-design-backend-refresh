import mongoose from 'mongoose';

const ActivityLogSchema = new mongoose.Schema({
  type: { type: String, required: true },
  platform: { type: String, default: null },
  status: { type: String, default: 'info' },
  message: { type: String, default: '' },
  data: { type: Object, default: {} },
  timestamp: { type: Date, default: () => new Date() }
}, { collection: 'activitylogs' });

ActivityLogSchema.index({ timestamp: -1 });

export default mongoose.models.ActivityLog || mongoose.model('ActivityLog', ActivityLogSchema);
