import mongoose from 'mongoose';

const PostingLockSchema = new mongoose.Schema({
  key: { type: String, unique: true },
  expiresAt: { type: Date, index: { expires: 0 } }
}, { timestamps: true, collection: 'postinglocks' });

export default mongoose.models.PostingLock || mongoose.model('PostingLock', PostingLockSchema);
