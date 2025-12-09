import express from 'express';
import morgan from 'morgan';
// import nodemailer from 'nodemailer'; // NodeMailer is no longer used for notifications
import admin from 'firebase-admin';
import pg from 'pg'; // PostgreSQL client

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(morgan('tiny'));

const PORT = process.env.PORT || 10000;
const GEMINI_KEY = process.env.GEMINI_API_KEY;
const INGEST_SECRET = process.env.INGEST_SECRET || '';
const DATABASE_URL = process.env.DATABASE_URL; // NEW: PostgreSQL Connection URL
const FCM_SERVICE_ACCOUNT_B64 = process.env.FCM_SERVICE_ACCOUNT_B64; // NEW: Base64 Firebase Key

function assertAuthorized(req) {
  if (!INGEST_SECRET) return true;
  const h = req.get('X-HillPulse-Key') || req.get('Authorization') || '';
  return h === INGEST_SECRET || h === `Bearer ${INGEST_SECRET}`;
}

// =================================================================
// 🚀 PHASE 1: DATABASE CONNECTION (PostgreSQL)
// =================================================================
const pool = new pg.Pool({
    connectionString: DATABASE_URL,
    // Note: SSL is required for external connections like Render. 
    // You may need to adjust rejectUnauthorized based on your provider's SSL setup.
    ssl: { rejectUnauthorized: false } 
});

async function query(text, params) {
    if (!DATABASE_URL) throw new Error('Missing DATABASE_URL environment variable.');
    return pool.query(text, params);
}

// Ensures the table exists when the server starts
async function ensureDatabaseSchema() {
    try {
        await query(`
            CREATE TABLE IF NOT EXISTS summaries (
                id SERIAL PRIMARY KEY,
                created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
                summary_text TEXT NOT NULL,
                tweet_author TEXT,
                tweet_url TEXT UNIQUE
            );
        `);
        console.log('Database schema checked/created successfully.');
    } catch (e) {
        console.error('ERROR: Could not ensure database schema:', e.message);
    }
}

// Function to save the summary to the database
async function saveSummaryToDB({ summary, author, url }) {
    if (!DATABASE_URL) {
        console.warn('Skipping DB save: DATABASE_URL is not set.');
        return false;
    }
    try {
        // ON CONFLICT DO NOTHING prevents duplicates if the same tweet is ingested twice
        const text = 'INSERT INTO summaries(summary_text, tweet_author, tweet_url) VALUES($1, $2, $3) ON CONFLICT (tweet_url) DO NOTHING RETURNING id';
        const values = [summary, author, url];
        const res = await query(text, values);
        return res.rowCount > 0;
    } catch (e) {
        console.error('DB Insert Failed:', e.message);
        return false;
    }
}


// =================================================================
// 🚀 PHASE 2: PUSH NOTIFICATION (Firebase Admin SDK)
// =================================================================
let fcmInitialized = false;
try {
    if (FCM_SERVICE_ACCOUNT_B64) {
        // Decode the Base64 key to get the JSON object
        const serviceAccountJson = Buffer.from(FCM_SERVICE_ACCOUNT_B64, 'base64').toString('utf8');
        const serviceAccount = JSON.parse(serviceAccountJson);
        
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount),
        });
        fcmInitialized = true;
        console.log('Firebase Admin SDK initialized successfully.');
    } else {
        console.warn('FCM_SERVICE_ACCOUNT_B64 is not set. Push notifications will be disabled.');
    }
} catch (e) {
    console.error('ERROR: Could not initialize Firebase Admin SDK:', e.message);
}


// Function to send a notification via Firebase to a public topic
async function sendFCMNotification({ title, message, url }) {
    if (!fcmInitialized) {
        console.warn('Skipping FCM: Firebase Admin SDK not initialized.');
        return false;
    }
    
    const topic = 'hillpulse_updates'; // The custom mobile app will subscribe to this topic
    
    const notification = {
        notification: {
            title: title || 'The Capitol Wire',
            body: message,
        },
        data: {
            // Send the URL in the data payload for the mobile app to open the tweet
            url: url || '',
        },
        topic: topic,
    };

    try {
        const response = await admin.messaging().send(notification);
        console.log('Successfully sent FCM message:', response);
        return true;
    } catch (e) {
        console.error('FCM Send Failed:', e.message);
        return false;
    }
}

// --- Gemini with retry --- (Keeping original code)
async function callGeminiSummary({ text, author, url }) {
  if (!GEMINI_KEY) throw new Error('Missing GEMINI_API_KEY');
  const endpoint = `https://generativelanguage.googleapis.com/v1/models/gemini-2.5-flash-lite:generateContent?key=${encodeURIComponent(GEMINI_KEY)}`;

  const prompt = `Summarize this tweet for Hill comms staff in 6–17 words. Aim for around 180 characters. Use shorthand and abbreviations when clear. Be factual and neutral. Always start with @username: ...`;

  const body = { contents: [{ role: "user", parts: [{ text: `${prompt}\n\nTweet text: ${text}\nTweet author: @${author}\nTweet URL: ${url}` }] }] };

  const MAX_RETRIES = 5;
  let attempt = 0;
  let lastErr;

  while (attempt <= MAX_RETRIES) {
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      if (res.status === 503) throw new Error('Gemini overload 503');
      if (!res.ok) {
        const t = await res.text().catch(() => '');
        throw new Error(`Gemini error ${res.status}: ${t}`);
      }
      const data = await res.json();
      const out = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
      return out.trim();
    } catch (err) {
      lastErr = err;
      attempt++;
      if (attempt <= MAX_RETRIES) {
        const delay = 8000; // 8 seconds between each retry
        console.warn(`Gemini attempt ${attempt} failed (${err.message}). Retrying in ${delay / 1000}s...`);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  throw new Error(`Gemini failed after ${MAX_RETRIES + 1} attempts: ${lastErr?.message}`);
}

// --- Tweet fetch helper --- (Keeping original code)
async function fetchTweetText(url) {
  if (!url) return '';
  try {
    const oEmbedUrl = `https://publish.twitter.com/oembed?omit_script=1&hide_thread=1&url=${encodeURIComponent(url)}`;
    const r1 = await fetch(oEmbedUrl);
    if (r1.ok) {
      const data = await r1.json();
      const html = data.html || '';
      const match = html.match(/<p[^>]*>(.*?)<\/p>/);
      if (match) {
        return match[1].replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'"); 
      }
    }
    const syndUrl = `https://cdn.syndication.twimg.com/widgets/tweet?url=${encodeURIComponent(url)}`;
    const r2 = await fetch(syndUrl);
    if (r2.ok) {
      const data2 = await r2.json();
      if (data2.text) return data2.text;
    }
  } catch (err) {
    console.error('Tweet fetch failed:', err.message);
  }
  return '';
}

// =================================================================
// 🚀 ENDPOINTS
// =================================================================
app.get('/', (_req, res) => res.send('HillPulse v2.0.0 running with Gemini, Postgres & FCM'));

// --- The core ingestion route (UPDATED) ---
app.post('/ingest', async (req, res) => {
  try {
    if (!assertAuthorized(req)) return res.status(401).json({ ok: false, error: 'Unauthorized' });
    const body = req.body || {};
    const tweet = body.data || {};
    const url = tweet.url || '';

    let author = tweet.author;
    if (!author && url) {
      const match = url.match(/x\.com\/([^\/]+)\//);
      if (match && match[1]) author = match[1];
    }

    let text = tweet.text || '';
    if (!text && url) text = await fetchTweetText(url);
    if (!text) return res.status(400).json({ ok: false, error: 'Missing tweet text' });

    const summary = await callGeminiSummary({ text, author, url });
    
    // --- NEW LOGIC: Save to DB and Send FCM ---
    const saved = await saveSummaryToDB({ summary, author, url });
    const pushed = await sendFCMNotification({ title: 'The Capitol Wire', message: summary, url });
    // --- END NEW LOGIC ---

    res.json({ ok: true, summary, saved, pushed });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// --- NEW ROUTE: Historical Feed for the Custom App ---
app.get('/feed', async (_req, res) => {
    try {
        const result = await query('SELECT summary_text, tweet_author, tweet_url, created_at FROM summaries ORDER BY created_at DESC LIMIT 50');
        // Return only the rows (the feed items)
        res.json({ ok: true, feed: result.rows });
    } catch (e) {
        console.error('Feed Retrieval Failed:', e.message);
        res.status(500).json({ ok: false, error: e.message });
    }
});


// =================================================================
// 🚀 SERVER START
// =================================================================
app.listen(PORT, () => {
    console.log('Server listening on', PORT);
    ensureDatabaseSchema(); // Ensure DB is set up when the server starts
});
