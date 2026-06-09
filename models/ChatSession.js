import mongoose from 'mongoose'

const chatSessionSchema = new mongoose.Schema({
  sessionId: { type: String, index: true, unique: true, required: true },
  messages: [{
    role:    { type: String, required: true },
    content: { type: String, required: true },
    at:      { type: Date, default: Date.now },
  }],
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
})

export default mongoose.model('ChatSession', chatSessionSchema)
