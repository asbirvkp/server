const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const { google } = require('googleapis');
const admin = require('firebase-admin');
const NodeCache = require('node-cache');
require('dotenv').config();

const app = express();

// Add after imports
if (!process.env.FIREBASE_PROJECT_ID || 
    !process.env.GOOGLE_CREDENTIALS || 
    !process.env.GOOGLE_SHEET_ID) {
  console.error('Missing required environment variables');
  process.exit(1);
}

// CORS configuration
const corsOptions = {
  origin: [
    'http://localhost:3000',
    'https://slateblue-hummingbird-423694.hostingersite.com'
  ],
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
  maxAge: 86400 // 24 hours
};

app.use(cors(corsOptions));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Add these headers to all responses
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (corsOptions.origin.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  
  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }
  next();
});

// Add before any routes
app.use((req, res, next) => {
  res.setHeader('Content-Type', 'application/json');
  next();
});

// Add this before your routes
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
  next();
});

// Add this before your routes
app.options('*', cors(corsOptions));

// Add this after the imports, before app initialization
const cache = new NodeCache({ stdTTL: 30 }); // 30 seconds default TTL

// Initialize Firebase Admin
const serviceAccount = {
  "type": "service_account",
  "project_id": "realmworld-369",
  "private_key_id": process.env.FIREBASE_PRIVATE_KEY_ID,
  "private_key": process.env.FIREBASE_PRIVATE_KEY,
  "client_email": process.env.FIREBASE_CLIENT_EMAIL,
  "client_id": process.env.FIREBASE_CLIENT_ID,
  "auth_uri": "https://accounts.google.com/o/oauth2/auth",
  "token_uri": "https://oauth2.googleapis.com/token",
  "auth_provider_x509_cert_url": "https://www.googleapis.com/oauth2/v1/certs",
  "client_x509_cert_url": process.env.FIREBASE_CLIENT_CERT_URL,
  "universe_domain": "googleapis.com"
};

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://realmworld-369-default-rtdb.firebaseio.com"
});

// Add authentication middleware
const authenticateToken = async (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    console.log('No token provided');
    return res.status(401).json({ error: 'No token provided' });
  }

  try {
    const decodedToken = await admin.auth().verifyIdToken(token);
    req.user = decodedToken;
    console.log('Token verified successfully:', decodedToken.uid);
    next();
  } catch (error) {
    console.error('Token verification error:', error);
    return res.status(403).json({ error: 'Invalid token' });
  }
};

// Initialize Google Sheets
const auth = new google.auth.GoogleAuth({
  credentials: JSON.parse(process.env.GOOGLE_CREDENTIALS),
  scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly']
});

const sheets = google.sheets({ version: 'v4', auth });
const spreadsheetId = process.env.GOOGLE_SHEET_ID;

// Test endpoint
app.get('/', (req, res) => {
  res.json({ message: 'Server is running!' });
});

// Verify token endpoint
app.get('/api/verify-token', authenticateToken, (req, res) => {
  res.json({ success: true, user: req.user });
});

// Performance data endpoint
app.get('/api/performance-data', authenticateToken, async (req, res) => {
  try {
    const cachedData = cache.get('performance-data');
    if (cachedData) {
      return res.json(cachedData);
    }

    if (!sheets) {
      await initializeGoogleSheets();
    }

    const range = 'Trade-History!H1:N1';
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range,
      valueRenderOption: 'UNFORMATTED_VALUE'
    });

    if (!response.data || !response.data.values || !response.data.values[0]) {
      if (cachedData) {
        return res.json(cachedData);
      }
      throw new Error('No data found in spreadsheet');
    }

    const values = response.data.values[0];
    const formattedResult = {
      thisWeek: (parseFloat(values[0] || 0)).toFixed(2),
      lastWeek: (parseFloat(values[2] || 0)).toFixed(2),
      monthly: Math.round(parseFloat(values[4] || 0)),
      yearly: Math.round(parseFloat(values[6] || 0))
    };

    cache.set('performance-data', formattedResult, 30);
    res.json(formattedResult);
  } catch (error) {
    console.error('Performance Data Error:', error);
    const cachedData = cache.get('performance-data');
    if (cachedData) {
      return res.json(cachedData);
    }
    res.status(500).json({ error: error.message || 'Failed to fetch performance data' });
  }
});

// Trade history endpoint
app.get('/api/trade-history', authenticateToken, async (req, res) => {
  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: 'Trade-History!B2:E',
      valueRenderOption: 'UNFORMATTED_VALUE',
      dateTimeRenderOption: 'FORMATTED_STRING'
    });

    if (!response.data.values) {
      return res.json([]);
    }

    // Process and validate each row
    const trades = response.data.values
      .filter(row => row.length >= 4) // Ensure row has all required fields
      .map(row => {
        const timestamp = row[0];
        const symbol = row[1]?.toString() || 'GOLD';
        const direction = row[2]?.toString() || 'BUY';
        const pnl = parseFloat(row[3] || 0);

        return {
          timestamp,
          symbol,
          direction,
          pnl: isNaN(pnl) ? 0 : pnl
        };
      })
      .filter(trade => 
        trade.timestamp && // Ensure timestamp exists
        trade.symbol &&    // Ensure symbol exists
        trade.direction && // Ensure direction exists
        typeof trade.pnl === 'number' // Ensure PNL is a number
      )
      .reverse(); // Most recent trades first

    console.log('Processed trades:', trades.length);
    res.json(trades);

  } catch (error) {
    console.error('Trade History Error:', error);
    res.status(500).json({ 
      error: 'Failed to fetch trade history',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// PNL data endpoint
app.get('/api/pnl-data', authenticateToken, async (req, res) => {
  try {
    await new Promise(resolve => setTimeout(resolve, 1000));

    const response = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: 'Trade-History!B2:E',
      valueRenderOption: 'UNFORMATTED_VALUE',
      dateTimeRenderOption: 'FORMATTED_STRING'
    });

    if (!response.data.values) {
      return res.json([]);
    }

    const trades = response.data.values
      .filter(row => row[0] && row[3] !== undefined)
      .map(row => ({
        date: row[0],
        pnl: parseFloat(row[3] || 0).toFixed(2)
      }))
      .slice(-20);

    res.json(trades);
  } catch (error) {
    console.error('PNL Data Error:', error);
    const status = error.code === 429 ? 429 : 500;
    const message = error.code === 429 ? 'Rate limit exceeded' : 'Internal server error';
    res.status(status).json({ error: message });
  }
});

// Add this after your existing endpoints
app.post('/api/login/google', async (req, res) => {
  try {
    const { idToken } = req.body;
    if (!idToken) {
      return res.status(400).json({ error: 'No ID token provided' });
    }

    // Verify the Google ID token
    const decodedToken = await admin.auth().verifyIdToken(idToken);
    console.log('Decoded token:', decodedToken);

    // Create a custom token for the client
    const customToken = await admin.auth().createCustomToken(decodedToken.uid);
    
    res.json({ token: customToken, user: decodedToken });
  } catch (error) {
    console.error('Google login error:', error);
    res.status(500).json({ error: 'Failed to authenticate with Google' });
  }
});

// Add this error handling middleware at the end before app.listen
app.use((err, req, res, next) => {
  console.error('Global error:', err);
  
  if (!res.headersSent) {
    res.status(err.status || 500).json({ 
      error: process.env.NODE_ENV === 'production' 
        ? 'Internal Server Error' 
        : err.message,
      status: err.status || 500
    });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`API URL: http://localhost:${PORT}`);
});
