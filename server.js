require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const admin = require('firebase-admin');

const app = express();
const PORT = process.env.PORT || 10000;

// Middleware
app.use(cors());
app.use(express.json());

// 1. Database Connection (PostgreSQL)
// Relies on DATABASE_URL env var from Render
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

// 2. Firebase Admin SDK Setup
// Relies on FIREBASE_SERVICE_ACCOUNT env var (JSON string) or file path
const serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT 
  ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT) 
  : null;

if (serviceAccount) {
  try {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
    console.log('Firebase Admin initialized successfully');
  } catch (error) {
    console.error('Error initializing Firebase Admin:', error);
  }
} else {
  console.warn("WARNING: Firebase Admin not initialized. Missing FIREBASE_SERVICE_ACCOUNT.");
}

// Initialize DB Table (Basic Migration)
const initDb = async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS summaries (
        id SERIAL PRIMARY KEY,
        summary_text TEXT NOT NULL,
        tweet_author TEXT NOT NULL,
        tweet_url TEXT NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log('Database table "summaries" verified');
  } catch (err) {
    console.error('DB Init Error:', err);
  }
};
initDb();

// 3. GET /feed Endpoint
// Returns the 50 most recent summaries
app.get('/feed', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT summary_text, tweet_author, tweet_url, created_at FROM summaries ORDER BY created_at DESC LIMIT 50'
    );
    
    // Return format matches client expectation
    res.json({
      ok: true,
      feed: result.rows
    });
  } catch (error) {
    console.error('Feed Error:', error);
    res.status(500).json({ ok: false, error: 'Internal Server Error' });
  }
});

// 4. POST /ingest Endpoint
// Used by Chrome Extension to push new content
app.post('/ingest', async (req, res) => {
  const authHeader = req.headers.authorization;
  
  // Validate Bearer Token
  if (!authHeader || !authHeader.startsWith('Bearer ') || authHeader.split(' ')[1] !== process.env.INGEST_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { summary_text, tweet_author, tweet_url } = req.body;

  if (!summary_text || !tweet_author || !tweet_url) {
    return res.status(400).json({ error: 'Missing required fields: summary_text, tweet_author, tweet_url' });
  }

  try {
    // A. Insert into Database
    const insertQuery = `
      INSERT INTO summaries (summary_text, tweet_author, tweet_url, created_at)
      VALUES ($1, $2, $3, NOW())
      RETURNING *
    `;
    const result = await pool.query(insertQuery, [summary_text, tweet_author, tweet_url]);
    const savedItem = result.rows[0];

    // B. Send Firebase Notification
    if (admin.apps.length) {
      const message = {
        topic: 'hillpulse_updates',
        notification: {
          title: 'The Capitol Wire',
          body: summary_text,
        },
        data: {
          url: tweet_url,
          // deep link or click action data
        },
      };

      try {
        await admin.messaging().send(message);
        console.log('FCM Notification sent for:', tweet_author);
      } catch (fcmError) {
        console.error('FCM Send Error:', fcmError);
        // Continue execution, do not fail the ingest request if FCM fails
      }
    }

    res.json({ ok: true, item: savedItem });

  } catch (error) {
    console.error('Ingest Error:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
