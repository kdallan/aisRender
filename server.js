// Import required modules
const http = require("http");
const WebSocket = require("ws");
const url = require("url");
const { createClient, LiveTranscriptionEvents } = require("@deepgram/sdk");
require("dotenv").config();

// Simplified logger
const log = {
  info: (msg, data) => console.log(`${msg}`, data || ""),
  error: (msg, err) => console.error(`[ERROR] ${msg}`, err || ""),
  warn: (msg, data) => console.warn(`[WARN] ${msg}`, data || ""),
  debug: (msg, data) => process.env.DEBUG && console.log(`[DEBUG] ${msg}`, data || "")
};

// Configuration
const config = (() => {
  // Check required environment variables
  ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "DEEPGRAM_API_KEY"].forEach(varName => {
    if (!process.env[varName]) throw new Error(`Missing required environment variable: ${varName}`);
  });
  
  return {
    server: {
      port: parseInt(process.env.HTTP_SERVER_PORT) || 8080
    },
    twilio: {
      accountSid: process.env.TWILIO_ACCOUNT_SID,
      authToken: process.env.TWILIO_AUTH_TOKEN,
      studioFlowId: process.env.TWILIO_STUDIO_FLOW_ID || "FWe2a7c39cffcbe604f2f158b68aae3b19"
    },
    deepgram: {
      apiKey: process.env.DEEPGRAM_API_KEY,
      ttsWebsocketURL: process.env.DEEPGRAM_TTS_WS_URL || 
        "wss://api.deepgram.com/v1/speak?encoding=mulaw&sample_rate=8000&container=none",
      sttConfig: {
        model: process.env.DEEPGRAM_MODEL || "nova-3", // "nova-2-phonecall",
        language: process.env.DEEPGRAM_LANGUAGE || "en",
        encoding: "mulaw",
        sample_rate: 8000,
        channels: 1,
        no_delay: true,
        interim_results: true,
        endpointing: parseInt(process.env.DEEPGRAM_ENDPOINTING) || 8,
        utterance_end_ms: parseInt(process.env.DEEPGRAM_UTTERANCE_END_MS) || 1000
      },
      throttleInterval: parseInt(process.env.DEEPGRAM_THROTTLE_INTERVAL) || 25
    },
    commands: {
      hangup: /\b(hangup|hang up)\b/i,
      goodbye: /\b(goodbye|good bye)\b/i
    }
  };
})();

// TwilioService
class TwilioService {
  constructor(config) {
    this.config = config;
    this.client = require("twilio")(config.accountSid, config.authToken);
    this.VoiceResponse = require("twilio").twiml.VoiceResponse;
  }
  
  async hangupCall(callSid) {
    try {
      log.info(`Initiating hangup for call: ${callSid}`);
      const execution = await this.client.studio.v2
        .flows(this.config.studioFlowId)
        .executions(callSid);
      log.info("Call hangup executed", { executionSid: execution.sid });
      return execution;
    } catch (error) {
      log.error("Failed to hangup call", error);
      throw error;
    }
  }
  
  async sayPhraseAndHangup(callSid, phrase) {
    if (!callSid) throw new Error("Call SID is required");
    
    try {
      log.info(`Saying phrase and hanging up call ${callSid}: "${phrase}"`);
      const twiml = new this.VoiceResponse();
      twiml.say({ voice: "Polly.Amy-Neural", language: "en-US" }, phrase);
      twiml.hangup();
      
      const result = await this.client.calls(callSid).update({ twiml: twiml.toString() });
      log.info(`Call ${callSid} successfully updated with TwiML`);
      return result;
    } catch (error) {
      log.error(`Failed to update call ${callSid} with TwiML`, error);
      throw error;
    }
  }
}

// DeepgramSTTService
class DeepgramSTTService {
  constructor(config, onTranscript, onUtteranceEnd) {
    this.config = config;
    this.onTranscript = onTranscript;
    this.onUtteranceEnd = onUtteranceEnd;
    this.client = createClient(config.apiKey);
    this.deepgram = null;
    this.isFinals = [];
    this.connected = false;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 5;
    this.reconnectDelay = 1000;
    this.isShuttingDown = false;
    this.keepAliveInterval = null;
    
    this.connect();
  }
  
  connect() {
    if (this.isShuttingDown) return;
    
    try {
      log.info(this.reconnectAttempts > 0 
        ? `Reconnecting to Deepgram (attempt ${this.reconnectAttempts + 1}/${this.maxReconnectAttempts})...`
        : "Connecting to Deepgram...");
      
      this.deepgram = this.client.listen.live(this.config.sttConfig);
      
      if (this.keepAliveInterval) clearInterval(this.keepAliveInterval);
      this.keepAliveInterval = setInterval(() => {
        if (this.deepgram && this.connected) this.deepgram.keepAlive();
      }, 10000);
      
      this._setupEventListeners();
      return this.deepgram;
    } catch (error) {
      log.error("Failed to connect to Deepgram STT", error);
      this._handleConnectionFailure();
      return null;
    }
  }
  
  _handleConnectionFailure() {
    this.connected = false;
    if (this.reconnectAttempts < this.maxReconnectAttempts) {
      this.reconnectAttempts++;
      const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1);
      log.info(`Will attempt to reconnect in ${delay}ms...`);
      setTimeout(() => this.connect(), delay);
    } else {
      log.error(`Failed to reconnect after ${this.maxReconnectAttempts} attempts`);
      this.reconnectAttempts = 0;
    }
  }
  
  _setupEventListeners() {
    // Open event
    this.deepgram.addListener(LiveTranscriptionEvents.Open, () => {
      log.info("Deepgram STT connection opened");
      this.connected = true;
      this.reconnectAttempts = 0;
      
      // Transcript event
      this.deepgram.addListener(LiveTranscriptionEvents.Transcript, (data) => {
        const transcript = data.channel?.alternatives?.[0]?.transcript;
        if (!transcript) return;
        
        if (!data.is_final) {
          this.onTranscript?.(transcript, false);
          return;
        }
        
        this.isFinals.push(transcript);
        if (data.speech_final) {
          this.onTranscript?.(this.isFinals.join(" "), true);
          this.isFinals = [];
        } else {
          this.onTranscript?.(transcript, true);
        }
      });
      
      // Utterance end event
      this.deepgram.addListener(LiveTranscriptionEvents.UtteranceEnd, () => {
        if (this.isFinals.length > 0) {
          this.onUtteranceEnd?.(this.isFinals.join(" "));
          this.isFinals = [];
        }
      });
    });
    
    // Error and close events
    this.deepgram.addListener(LiveTranscriptionEvents.Close, () => {
      log.info("Deepgram STT connection closed");
      this.connected = false;
      this._handleConnectionFailure();
    });
    
    this.deepgram.addListener(LiveTranscriptionEvents.Error, (error) => {
      log.error("Deepgram STT error", error);
      if (!this.connected) this._handleConnectionFailure();
    });
    
    this.deepgram.addListener(LiveTranscriptionEvents.Warning, (warning) => {
      log.warn("Deepgram STT warning", warning);
    });
  }
  
  send(audioData) {
    if (!this.connected || !this.deepgram || !audioData || !Buffer.isBuffer(audioData) || audioData.length === 0) return;
    
    try {
      this.deepgram.send(audioData);
    } catch (error) {
      log.error("Failed to send audio to Deepgram", error);
      if (error.message?.includes("not open")) {
        this.connected = false;
        this._handleConnectionFailure();
      }
    }
  }
  
  cleanup() {
    this.isShuttingDown = true;
    
    if (this.keepAliveInterval) {
      clearInterval(this.keepAliveInterval);
      this.keepAliveInterval = null;
    }
    
    if (this.deepgram) {
      try {
        this.deepgram.requestClose();
      } catch (error) {
        log.error("Error while closing Deepgram connection", error);
      }
      this.deepgram = null;
    }
    
    this.connected = false;
  }
}

// CallSession
class CallSession {
  constructor(webSocket, services) {
    this.ws = webSocket;
    this.services = services;
    this.callSid = null;
    this.streamSid = null;
    this.active = true;
    this.hangupInitiated = false;
    this.hasSeenMedia = false;
    
    // Counters and audio handling
    this.receivedPackets = 0;
    this.inboundPackets = 0;
    this.silencePackets = 0;
    this.audioAccumulator = [];
    this.audioAccumulatorSize = 0;
    this.bufferSizeThreshold = 2 * 1024; // 2 KB
    this.flushTimer = null;
    this.flushInterval = this.services.config.deepgram.throttleInterval;
    
    // Initialize STT service
    this.sttService = new DeepgramSTTService(
      this.services.config.deepgram,
      this._handleTranscript.bind(this),
      this._handleUtteranceEnd.bind(this)
    );
    
    // Setup WebSocket handlers
    this.ws.on("message", this._handleMessage.bind(this));
    this.ws.on("close", this._handleClose.bind(this));
    this.ws.on("error", (error) => log.error("WebSocket error:", error));
    
    // Setup stats logging
    this.statsTimer = setInterval(() => {
      if (this.receivedPackets > 0) {
        log.info(`Call stats: total=${this.receivedPackets}, inbound=${this.inboundPackets}, silence=${this.silencePackets}`);
      }
    }, 10000);
    
    log.info("New call session created");
  }
  
  // Audio buffer management
  stopFlushTimer() {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }    
  }
  
  startFlushTimer() {
    // Cancel the previous timer, if any        
    this.stopFlushTimer();
    
    if (this.isShuttingDown) {
      return;
    }
            
    // Schedule the timer
    this.flushTimer = setTimeout(() => {
      this.flushAudioBuffer();
    }, this.flushInterval);
  }
  
  flushAudioBuffer() {
    this.stopFlushTimer();

    if (this.audioAccumulatorSize > 0) {
      const combinedBuffer = Buffer.concat(this.audioAccumulator);
      if (this.sttService?.connected) {
        log.debug(`Flushing ${this.audioAccumulator.length} buffers, total size: ${combinedBuffer.length} bytes`);
        this.sttService.send(combinedBuffer);
        this.audioAccumulator = [];
        this.audioAccumulatorSize = 0;
      }
    }
    
    this.startFlushTimer();
  }
  
  accumulateAudio(buffer) {
    this.audioAccumulator.push(buffer);
    this.audioAccumulatorSize += buffer.length;
    
    if (this.audioAccumulatorSize >= this.bufferSizeThreshold) {
      this.flushAudioBuffer();
    } else if (!this.flushTimer) {
      this.startFlushTimer();
    }
  }
  
  _hasAudioEnergy(base64Payload, threshold = 0.2, mulawThreshold = 0x68) {
    try {
      const binary = Buffer.from(base64Payload, "base64");
      if (binary.length < 10) return true;
      
      let nonSilenceCount = 0;
      const samples = Math.ceil(binary.length / 8);
      
      for (let i = 0; i < binary.length; i += 8) {
        if (binary[i] < mulawThreshold) nonSilenceCount++;
      }
      
      return nonSilenceCount / samples > threshold;
    } catch {
      return true;
    }
  }
  
  // Message handling
  _handleMessage(message) {
    if (!this.active) return;
    
    let data;
    try {
      // Parse message into JSON
      if (Buffer.isBuffer(message)) {
        data = JSON.parse(message.toString("utf8"));
      } else if (typeof message === "string") {
        data = JSON.parse(message);
      } else {
        return;
      }
      
      // Process by event type
      switch (data.event) {
        case "connected":
          log.info("Twilio: Connected event received");
          break;
          
        case "start":
          this.callSid = data.start?.callSid || data.callSid;
          if (this.callSid) {
            log.info(`Twilio: Call started, SID: ${this.callSid}`);
          }
          break;
          
        case "media":
          this.receivedPackets++;
          
          // Handle first media packet
          if (!this.hasSeenMedia) {
            this.hasSeenMedia = true;
            log.info("Twilio: First media event received");
          }
          
          // Track stream SID
          if (!this.streamSid && data.streamSid) {
            this.streamSid = data.streamSid;
            log.info(`Twilio: Stream SID: ${this.streamSid}`);
          }
          
          // Process audio payload
          if (data.media?.payload) {
            if (data.media.track === "inbound" || data.media.track === "outbound") {
              this.inboundPackets++;
              const payload = data.media.payload;
              
              // Skip processing if it's silence
              const STRIP_SILENCE = false;
              if (!STRIP_SILENCE || this._hasAudioEnergy(payload)) {
                const rawAudio = Buffer.from(payload, "base64");
                this.accumulateAudio(rawAudio);
              } else {
                this.silencePackets++;
              }
            }
          }
          break;
          
        case "close":
          log.info("Twilio: Close event received");
          this._cleanup();
          break;
      }
    } catch (error) {
      log.error("Error processing message", error);
    }
  }
  
  // Transcript handling
  _handleTranscript(transcript, isFinal) {
    if (!this.active || this.hangupInitiated) return;
    
    log.info(isFinal ? `[Final] ${transcript}` : transcript);
    
    // Check for commands in transcript
    if (config.commands.hangup.test(transcript)) {
      log.info("Hangup command detected in transcript");
      this._handleHangup("Thank you for calling. Goodbye.");
    } else if (config.commands.goodbye.test(transcript)) {
      log.info("Goodbye command detected in transcript");
      this._handleHangup("We appreciate your call. Have a great day!");
    }
  }
  
  _handleUtteranceEnd(utterance) {
    if (this.active) log.info(`Complete utterance: ${utterance}`);
  }
  
  // Call control
  async _handleHangup(customPhrase) {
    if (!this.active || !this.callSid || this.hangupInitiated) return;
    
    try {
      this.hangupInitiated = true;
      log.info(`Initiating hangup for call ${this.callSid}${customPhrase ? ` with message: "${customPhrase}"` : ""}`);
      
      if (customPhrase) {
        await this.services.twilioService.sayPhraseAndHangup(this.callSid, customPhrase);
      } else {
        await this.services.twilioService.hangupCall(this.callSid);
      }
    } catch (error) {
      log.error("Failed to hang up call", error);
      this.hangupInitiated = false;
    }
  }
  
  _handleClose() {
    log.info("Twilio: Connection closed");
    this._cleanup();
  }
  
  _cleanup() {
    if (!this.active) return;
    
    this.active = false;
    this.hangupInitiated = false;
    
    // Clear timers
    if (this.statsTimer) {
      clearInterval(this.statsTimer);
      this.statsTimer = null;
    }
    
    this.stopFlushTimer();
    
    // Clean up services
    if (this.sttService) {
      this.sttService.cleanup();
      this.sttService = null;
    }
    
    // Close WebSocket
    if (this.ws) {
      try {
        if (this.ws.readyState === WebSocket.OPEN) {
          this.ws.terminate();
        }
        this.ws.removeAllListeners();
      } catch (err) {
        log.error("Error terminating WebSocket", err);
      }
      this.ws = null;
    }
    
    log.info(`Call session cleaned up, Call SID: ${this.callSid || "unknown"}, processed ${this.receivedPackets} packets`);
  }
}

// VoiceServer
class VoiceServer {
  constructor() {
    this.services = {
      config,
      twilioService: new TwilioService(config.twilio)
    };
    
    this.httpServer = http.createServer((req, res) => {
      if (url.parse(req.url).pathname === "/") {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("aiShield Monitor");
      } else {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not Found");
      }
    });
    
    this.wsServer = new WebSocket.Server({ server: this.httpServer });
    this.sessions = new Map();
    this.isShuttingDown = false;
    
    this.wsServer.on("connection", (ws, req) => {
      const sessionId = `${req.socket.remoteAddress}:${req.socket.remotePort}`;
      log.info(`New WebSocket connection established from ${sessionId}`);
      
      const session = new CallSession(ws, this.services);
      this.sessions.set(sessionId, session);
      
      ws.on("close", () => {
        this.sessions.delete(sessionId);
        log.info(`Session ${sessionId} removed`);
      });
    });
  }
  
  start() {
    this.httpServer.listen(config.server.port, () => {
      log.info(`Server listening on port ${config.server.port}`);
    });
  }
  
  stop() {
    this.isShuttingDown = true;
    
    // Cleanup all sessions
    for (const session of this.sessions.values()) {
      session._cleanup();
    }
    this.sessions.clear();
    
    // Close servers with timeout
    const closeTimeout = setTimeout(() => {
      log.warn("Server shutdown timed out, forcing exit");
      this.httpServer.close();
    }, 5000);
    
    this.wsServer.close(() => {
      clearTimeout(closeTimeout);
      log.info("WebSocket server closed");
      this.httpServer.close(() => {
        log.info("HTTP server closed");
      });
    });
  }
}

// Process termination handling
const gracefulShutdown = (signal) => {
  log.info(`Received ${signal} signal, shutting down gracefully`);
  if (server) server.stop();
  setTimeout(() => process.exit(0), 5000);
};

process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("uncaughtException", (error) => {
  log.error("Uncaught exception", error);
  if (server) server.stop();
  process.exit(1);
});

// Start the server
const server = new VoiceServer();
server.start();
