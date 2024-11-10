const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const { google } = require('googleapis');
const admin = require('firebase-admin');
const NodeCache = require('node-cache');
require('dotenv').config();

const app = express();

// Add after imports
if (!process.env.FIREBASE_CREDENTIALS || 
    !process.env.GOOGLE_CREDENTIALS || 
    !process.env.GOOGLE_SHEET_ID) {
  console.error('Missing required environment variables. Please check your .env file.');
  console.error('Required variables: FIREBASE_CREDENTIALS, GOOGLE_CREDENTIALS, GOOGLE_SHEET_ID');
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

let sheets;
let spreadsheetId;

try {
  // Initialize Google Sheets API
  const auth = new google.auth.GoogleAuth({
    credentials: JSON.parse(process.env.GOOGLE_CREDENTIALS),
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });

  sheets = google.sheets({ version: 'v4', auth });
  spreadsheetId = process.env.GOOGLE_SHEET_ID;

  // Initialize Firebase Admin
  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_CREDENTIALS))
    });
  }

  console.log('Successfully initialized Google Sheets and Firebase');
} catch (error) {
  console.error('Initialization Error:', error);
  console.error('Error details:', error.message);
  process.exit(1);
}

// Add authentication middleware
const authenticateToken = async (req, res, next) => {
  try {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
      return res.status(401).json({ error: 'No token provided' });
    }

    const decodedToken = await admin.auth().verifyIdToken(token);
    req.user = {
      email: decodedToken.email,
      displayName: decodedToken.name || decodedToken.email.split('@')[0],
      uid: decodedToken.uid
    };
    next();
  } catch (error) {
    console.error('Auth Error:', error);
    res.status(403).json({ error: 'Invalid token' });
  }
};

async function updateUserBalanceSheet(userData) {
  try {
    console.log('Attempting to update sheet for user:', userData.email);
    
    // Get existing data
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: 'User-Balance!A2:G',
      valueRenderOption: 'UNFORMATTED_VALUE'
    });

    const existingData = response.data.values || [];
    const userIndex = existingData.findIndex(row => row[1] === userData.email);

    const newRow = [
      userData.displayName || '',
      userData.email,
      userData.phoneNumber || '',
      0, // Initial deposit
      0, // Initial PNL%
      0, // Initial Total Earnings
      0  // Initial Balance
    ];

    if (userIndex === -1) {
      // Add new user
      const appendResponse = await sheets.spreadsheets.values.append({
        spreadsheetId,
        range: 'User-Balance!A2:G',
        valueInputOption: 'USER_ENTERED',
        insertDataOption: 'INSERT_ROWS',
        resource: {
          values: [newRow]
        }
      });
      
      console.log('Sheet update response:', appendResponse.data);
    }
  } catch (error) {
    console.error('Error updating sheet:', error);
    throw new Error(`Failed to update sheet: ${error.message}`);
  }
}

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
    
    // Update user data in Google Sheet
    await updateUserBalanceSheet({
      displayName: decodedToken.name,
      email: decodedToken.email,
      phoneNumber: decodedToken.phone_number
    });

    // Create a custom token for the client
    const customToken = await admin.auth().createCustomToken(decodedToken.uid);
    
    res.json({ token: customToken, user: decodedToken });
  } catch (error) {
    console.error('Google login error:', error);
    res.status(500).json({ error: 'Failed to authenticate with Google' });
  }
});

// Add this after your existing endpoints
app.get('/api/wallet-data', authenticateToken, async (req, res) => {
  try {
    const userEmail = req.user.email;
    
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: 'User-Balance!A2:G',
      valueRenderOption: 'UNFORMATTED_VALUE'
    });

    if (!response.data.values) {
      return res.json({ 
        userEmail,
        balance: 0, 
        earnings: 0 
      });
    }

    const userData = response.data.values.find(row => row[1] === userEmail);
    
    const result = {
      userEmail,
      balance: parseFloat(userData?.[6] || 0),
      earnings: parseFloat(userData?.[5] || 0)
    };

    res.json(result);
  } catch (error) {
    console.error('Wallet Data Error:', error);
    res.status(500).json({ error: 'Failed to fetch wallet data' });
  }
});

// Add this new endpoint for email/password signup
app.post('/api/signup', authenticateToken, async (req, res) => {
  try {
    const { email, displayName, phoneNumber } = req.body;
    
    // Verify the token matches the user data
    if (req.user.email !== email) {
      return res.status(403).json({
        success: false,
        message: 'Token email does not match provided email'
      });
    }

    // Add user to Google Sheet
    await updateUserBalanceSheet({
      email,
      displayName,
      phoneNumber,
      uid: req.user.uid
    });

    res.status(200).json({
      success: true,
      message: 'User created successfully'
    });
  } catch (error) {
    console.error('Signup error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      details: error.message
    });
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

// Add this after your routes
app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(err.status || 500).json({
    error: process.env.NODE_ENV === 'production' 
      ? 'Internal server error' 
      : err.message,
    details: process.env.NODE_ENV === 'development' ? err.stack : undefined
  });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`API URL: http://localhost:${PORT}`);
});
