const ngrok = require('ngrok');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

async function startNgrok() {
  try {
    await ngrok.kill();

    const url = process.env.NGROK_URL || await ngrok.connect({
      addr: process.env.PORT || 3001,
      authtoken: process.env.NGROK_AUTH_TOKEN,
      region: 'us',
      onStatusChange: status => {
        console.log('Ngrok Status:', status);
      },
      onLogEvent: log => {
        console.log('Ngrok Log:', log);
      },
      proto: 'http',
      host_header: `localhost:${process.env.PORT || 3001}`
    });

    console.log('Ngrok started with URL:', url);

    // Update client config
    const configPath = path.join(__dirname, '..', 'client', '.env');
    let envContent = fs.readFileSync(configPath, 'utf8');
    envContent = envContent.replace(
      /REACT_APP_API_URL=.*/,
      `REACT_APP_API_URL=${url}`
    );
    fs.writeFileSync(configPath, envContent);

    // Create a health check endpoint
    require('http').createServer((req, res) => {
      res.writeHead(200);
      res.end('Ngrok tunnel is running');
    }).listen(parseInt(process.env.PORT || 3001) + 1);

  } catch (error) {
    console.error('Error starting ngrok:', error);
    process.exit(1);
  }
}

process.on('SIGTERM', async () => {
  await ngrok.kill();
  process.exit(0);
});

startNgrok();
