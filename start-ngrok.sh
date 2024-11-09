#!/bin/bash

# Load environment variables
source .env

# Start ngrok and capture the public URL
ngrok_output=$(ngrok http ${PORT:-3001} --log=stdout > ngrok.log &)
sleep 5

# Extract the ngrok URL from the log file
ngrok_url=$(grep -o 'https://[^[:space:]]*\.ngrok-free\.app' ngrok.log | head -n 1)

# Update the environment files
sed -i "s|REACT_APP_API_URL=.*|REACT_APP_API_URL=$ngrok_url|" ../client/.env

echo "Ngrok started with URL: $ngrok_url"
