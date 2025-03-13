const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');

// Create express app and HTTP server
const app = express();
const server = http.createServer(app);

// Serve static files
app.use(express.static('public'));

// Status endpoint for health checks
app.get('/status', (req, res) => {
  res.json({ 
    connections: wss.clients.size,
    time: new Date().toISOString() 
  });
});

// Create WebSocket server
const wss = new WebSocketServer({ server });

// Log active connections
setInterval(() => {
  console.log(`Active connections: ${wss.clients.size}`);
}, 30000);

// Handle WebSocket connections
wss.on('connection', (ws, req) => {
  console.log('New WebSocket connection established');
  
  // Send welcome message
  ws.send(JSON.stringify({ 
    type: 'welcome', 
    message: 'Connected to WebSocket server!',
    time: new Date().toISOString() 
  }));
  
  // Handle messages
  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      console.log('Received:', data);
      
      if (data.type === 'ping') {
        ws.send(JSON.stringify({ 
          type: 'pong', 
          timestamp: Date.now(),
          message: 'Server received your ping!'
        }));
        console.log('Received ping from client');
      }
    } catch (e) {
      console.log('Received (raw):', message.toString());
    }
  });
  
  // Handle disconnection
  ws.on('close', () => {
    console.log('WebSocket connection closed');
  });
});

// Create public directory for static files
const fs = require('fs');
if (!fs.existsSync('public')){
  fs.mkdirSync('public');
}

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log('WebSocket server ready');
});

