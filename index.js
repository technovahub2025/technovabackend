/* global process */
import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import helmet from 'helmet'
import rateLimit from 'express-rate-limit'
import fetch from 'node-fetch'
import mongoose from 'mongoose'
import Lead from './models/Lead.js'
import ChatSession from './models/ChatSession.js'
import Groq from 'groq-sdk'
const app = express()
const PORT = process.env.PORT || 3001
const GROQ_API_KEY = process.env.GROQ_API_KEY
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/technovahub'
const GOOGLE_SHEETS_WEBHOOK_URL = process.env.GOOGLE_SHEETS_WEBHOOK_URL || 'https://script.google.com/macros/s/AKfycbyX-5PWB3XYbrEIbJ2hxwHEVoj_d9KRMjmoGFJXI1x9Ccs3YOqY-fGl2VYtpheJ_3gV/exec'


const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY,
})


if (!GROQ_API_KEY) {
  console.error('GROQ_API_KEY is not set. Create a .env file with GROQ_API_KEY=your_key_here')
  process.exit(1)
}

// ─── MongoDB connection ─────────────────────────────────────────────────────
mongoose.connect(MONGODB_URI)
  .then(() => console.log('Connected to MongoDB'))
  .catch((err) => {
    console.error('MongoDB connection failed:', err.message)
    process.exit(1)
  })

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      connectSrc: ["'self'", "https://generativelanguage.googleapis.com", "https://script.google.com", "https://script.googleusercontent.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      imgSrc: ["'self'", "data:", "https:"],
      frameSrc: ["'none'"],
      objectSrc: ["'none'"],
    },
  },
  crossOriginEmbedderPolicy: false,
}))
app.use(
  cors({
    origin: [
       'http://localhost:3000',
    'http://127.0.0.1:3000',
    'http://localhost:3001',
    'http://127.0.0.1:3001',
    'http://localhost:5173',
    'http://127.0.0.1:5173',
    ],
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Origin',
      'X-Requested-With',
      'Content-Type',
      'Accept',
      'Authorization',
    ],
    credentials: true,
  })
)

app.options('*', cors())
app.use(express.json({ limit: '6mb' }))

// ─── Rate limiters ───────────────────────────────────────────────────────────
const chatLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 1000,           // allow 1000 requests per minute
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: 'Too many requests. Please wait a moment and try again.'
  },
})

const leadLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many submissions. Please try again later.' },
})

// ─── Helpers ────────────────────────────────────────────────────────────────
function stripHtml(str) {
  return String(str).replace(/<[^>]*>/g, '').trim()
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
}

function isValidUUID(id) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
}

function normalizeDate(value) {
  const parsed = value ? new Date(value) : null
  return parsed && !Number.isNaN(parsed.getTime()) ? parsed : new Date()
}

async function appendLeadToSheet(payload) {
  if (!GOOGLE_SHEETS_WEBHOOK_URL) return { ok: false, skipped: true }

  const body = new URLSearchParams({
    name: payload.name,
    email: payload.email,
    phone: payload.phone,
    requirement: payload.requirement || '',
    source: payload.source || 'chatbot',
    createdAt: payload.createdAt || new Date().toISOString(),
  })

  const response = await fetch(GOOGLE_SHEETS_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
    body,
  })

  const text = await response.text().catch(() => '')
  return { ok: response.ok, status: response.status, text }
}

// ─── GET /api/health ────────────────────────────────────────────────────────
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() })
})

// ─── POST /api/chat — Proxy to Gemini with SSE streaming + session storage ──
app.post('/api/chat', chatLimiter, async (req, res) => {
  const { contents, sessionId } = req.body

  if (!contents || !Array.isArray(contents)) {
    return res.status(400).json({
      error: 'Invalid request',
      details: 'contents must be a non-empty array.',
    })
  }

  const lastUserContent = contents.filter(c => c.role === 'user').pop()
  const userText = lastUserContent?.parts?.[0]?.text || ''

  if (!userText.trim()) {
    return res.status(400).json({
      error: 'Invalid request',
      details: 'Message must be a non-empty string.',
    })
  }

  if (userText.length > 2000) {
    return res.status(400).json({
      error: 'Invalid request',
      details: 'Message must not exceed 2000 characters.',
    })
  }

  try {
    const messages = contents.map(item => ({
      role: item.role === 'model' ? 'assistant' : item.role,
      content: item.parts?.[0]?.text || '',
    }))

    const completion = await groq.chat.completions.create({
      model: 'llama-3.1-8b-instant',
      messages,
      temperature: 0.7,
    })

    const fullResponse =
      completion.choices?.[0]?.message?.content ||
      'Sorry, I could not generate a response.'

    res.json({
      reply: fullResponse,
    })

    if (sessionId && isValidUUID(sessionId)) {
      await ChatSession.findOneAndUpdate(
        { sessionId },
        {
          $push: {
            messages: {
              $each: [
                { role: 'user', content: userText, at: new Date() },
                { role: 'assistant', content: fullResponse, at: new Date() },
              ],
            },
          },
          $set: { updatedAt: new Date() },
          $setOnInsert: { createdAt: new Date() },
        },
        { upsert: true, new: true }
      )
    }
  } catch (err) {
    console.error('Groq error:', err.message)
    return res.status(500).json({
      error: 'Groq API error. Please try again later.',
    })
  }
})

// ─── GET /api/sessions/:sessionId — Retrieve chat history ────────────────────
app.get('/api/sessions/:sessionId', async (req, res) => {
  const { sessionId } = req.params
  if (!isValidUUID(sessionId)) {
    return res.status(400).json({ error: 'Invalid session ID.' })
  }
  try {
    const session = await ChatSession.findOne({ sessionId })
    if (!session) return res.json({ messages: [] })
    return res.json({ messages: session.messages })
  } catch {
    return res.status(500).json({ error: 'Failed to fetch session.' })
  }
})

// ─── POST /api/leads — Lead capture with MongoDB ────────────────────────────
app.post('/api/leads', leadLimiter, async (req, res) => {
  const errors = {}
  const { name, email, phone, requirement = '', source = 'chatbot', createdAt } = req.body

  const cleanName = stripHtml(name || '')
  if (!cleanName || cleanName.length < 2 || cleanName.length > 50) {
    errors.name = 'Name must be 2-50 characters.'
  }

  const cleanEmail = stripHtml(email || '')
  if (!cleanEmail || !isValidEmail(cleanEmail)) {
    errors.email = 'Enter a valid email address.'
  }

  const cleanPhone = stripHtml(phone || '')
  if (!/^(\+91[\s-]?)?[6-9]\d{9}$/.test(cleanPhone.replace(/[\s-]/g, ''))) {
    errors.phone = 'Enter a valid Indian mobile number.'
  }

  const cleanReq = stripHtml(requirement || '')
  if (cleanReq.length > 1000) {
    errors.requirement = 'Requirement must not exceed 1000 characters.'
  }

  if (Object.keys(errors).length > 0) {
    return res.status(400).json({ errors })
  }

  try {
    const leadPayload = {
      name: cleanName,
      email: cleanEmail,
      phone: cleanPhone,
      requirement: cleanReq,
      source,
      createdAt: normalizeDate(createdAt),
    }

    await Lead.create(leadPayload)

    try {
      const sheetResult = await appendLeadToSheet(leadPayload)
      if (!sheetResult.ok) {
        console.error('Google Sheet webhook returned non-OK response:', sheetResult.status, sheetResult.text)
      } else {
        console.log('Lead appended to Google Sheet:', sheetResult.status)
      }
      return res.status(201).json({
        message: 'Lead saved successfully.',
        sheetSaved: !!sheetResult.ok,
        sheetStatus: sheetResult.status,
      })
    } catch (sheetErr) {
      console.error('Failed to append lead to Google Sheet:', sheetErr.message)
    }

    return res.status(201).json({
      message: 'Lead saved successfully.',
      sheetSaved: false,
    })
  } catch (err) {
    console.error('Failed to save lead:', err.message)
    return res.status(500).json({ error: 'Failed to save lead. Please try again.' })
  }
})

// ─── GET /api/leads/count ───────────────────────────────────────────────────
app.get('/api/leads/count', async (_req, res) => {
  try {
    const count = await Lead.countDocuments()
    return res.json({ count })
  } catch {
    return res.status(500).json({ error: 'Failed to count leads.' })
  }
})

// ─── Start server ────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`TechnovaHub server running on http://localhost:${PORT}`);
});

