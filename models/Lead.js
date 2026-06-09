import mongoose from 'mongoose'

const leadSchema = new mongoose.Schema({
  name:        { type: String, required: true },
  email:       { type: String, required: true },
  phone:       { type: String, required: true },
  requirement: { type: String, default: '' },
  createdAt:   { type: Date, default: Date.now },
})

export default mongoose.model('Lead', leadSchema)
