const axios = require('axios');
const config = require('../client/src/config/config');

async function checkNgrokConnection() {
  try {
    const response = await axios.get(`${config.API_URL}/api/health`);
    console.log('Ngrok connection status:', response.status === 200 ? 'OK' : 'Failed');
  } catch (error) {
    console.error('Ngrok connection error:', error.message);
  }
}

checkNgrokConnection();
