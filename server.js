// Import required modules
const fs = require("fs");
const http = require("http");
const path = require("path");
const WebSocket = require("ws");
const url = require("url");
const { createClient, LiveTranscriptionEvents } = require("@deepgram/sdk");

// Audio buffer utility for decoding base64
const audioBufferPool = {
  decodeBase64(base64String) {
    try {
      if (!base64String) return null;
      return Buffer.from(base64String, "base64");
    } catch (error) {
      logger.error("Error decoding base64", error);
      return null;
    }
  },
  clear() {
    // No resources to clear
  }
};

// Logging system
const logger = {
  info(message, data) {
    console.log(`[INFO] ${message}`, data || "");
  },
  error(message, error) {
    console.error(`[ERROR] ${message}`, error ? error.stack || error : "");
  },
  warn(message, data) {
    console.warn(`[WARN] ${message}`, data || "");
  },
  debug(message, data) {
    if (process.env.DEBUG) {
      console.log(`[DEBUG] ${message}`, data || "");
    }
  },
  trace(message, data) {
    if (process.env.TRACE) {
      console.log(`[TRACE] ${message}`, data || "");
    }
  }
};

// Configuration management
const config = {
  init() {
    require("dotenv").config();
    const requiredEnvVars = [
      "TWILIO_ACCOUNT_SID",
      "TWILIO_AUTH_TOKEN",
      "DEEPGRAM_API_KEY"
    ];
    const missingVars = requiredEnvVars.filter(varName => !process.env[varName]);
    if (missingVars.length > 0) {
      throw new Error(`Missing required environment variables: ${missingVars.join(", ")}`);
    }
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
          model: process.env.DEEPGRAM_MODEL || "nova-2-phonecall",
          language: process.env.DEEPGRAM_LANGUAGE || "en",
          smart_format: true,
          encoding: "mulaw",
          sample_rate: 8000,
          channels: 1,
          multichannel: false,
          no_delay: true,
          interim_results: true,
          endpointing: parseInt(process.env.DEEPGRAM_ENDPOINTING) || 300,
          utterance_end_ms: parseInt(process.env.DEEPGRAM_UTTERANCE_END_MS) || 1000
        },
        // Throttle interval in ms for sending audio packets (default: 50ms)
        throttleInterval: parseInt(process.env.DEEPGRAM_THROTTLE_INTERVAL) || 50
      },
      punctuation: {
        chars: [".", ",", "!", "?", ";", ":"]
      }
    };
  }
};

class TextUtils {
  constructor(config) {
    this.puntuationChars = config.chars;
    // Pre-compile regex patterns for commonly searched words
    this.commandPatterns = {
      hangup: /\b(hangup|hang up)\b/i,
      goodbye: /\b(goodbye|good bye)\b/i
    };
  }

  containsAnyPunctuation(text) {
    if (!text || typeof text !== "string") return false;
    return Array.from(text).some(char => this.puntuationChars.includes(char));
  }

  searchWordInSentence(sentence, word) {
    if (!sentence || !word || typeof sentence !== "string" || typeof word !== "string") {
      return false;
    }
    if (this.commandPatterns[word.toLowerCase()]) {
      return this.commandPatterns[word.toLowerCase()].test(sentence);
    }
    const trimmedSentence = sentence.trim();
    const trimmedWord = word.trim();
    if (!trimmedSentence || !trimmedWord) {
      return false;
    }
    return trimmedSentence.toLowerCase().includes(trimmedWord.toLowerCase());
  }
}

class TwilioService {
  constructor(config) {
    this.config = config;
    this.client = require("twilio")(config.accountSid, config.authToken);
    this.VoiceResponse = require("twilio").twiml.VoiceResponse;
  }

  async hangupCall(callSid) {
    try {
      logger.info(`Initiating hangup for call: ${callSid}`);
      const execution = await this.client.studio.v2
        .flows(this.config.studioFlowId)
        .executions(callSid);
      logger.info("Call hangup executed", { executionSid: execution.sid });
      return execution;
    } catch (error) {
      logger.error("Failed to hangup call", error);
      throw error;
    }
  }
  
  generateSayAndHangupTwiML(phrase, options = {}) {
    try {
      const twiml = new this.VoiceResponse();
      const voiceOptions = {
        voice: options.voice || "Polly.Amy-Neural",
        language: options.language || "en-US",
        ...options
      };
      twiml.say(voiceOptions, phrase);
      twiml.hangup();
      return twiml.toString();
    } catch (error) {
      logger.error("Error generating TwiML", error);
      const fallbackTwiml = new this.VoiceResponse();
      fallbackTwiml.say("Sorry, an error occurred.");
      fallbackTwiml.hangup();
      return fallbackTwiml.toString();
    }
  }
  
  async sayPhraseAndHangup(callSid, phrase) {
    try {
      if (!callSid) {
        throw new Error("Call SID is required");
      }
      logger.info(`Saying phrase and hanging up call ${callSid}: "${phrase}"`);
      const twiml = this.generateSayAndHangupTwiML(phrase);
      const result = await this.client.calls(callSid)
        .update({ twiml });
      logger.info(`Call ${callSid} successfully updated with TwiML`);
      return result;
    } catch (error) {
      logger.error(`Failed to update call ${callSid} with TwiML`, error);
      throw error;
    }
  }
}

class DeepgramSTTService {
  constructor(config, onTranscript, onUtteranceEnd) {
    this.config = config;
    this.onTranscript = onTranscript;
    this.onUtteranceEnd = onUtteranceEnd;
    this.client = createClient(config.apiKey);
    this.keepAliveInterval = null;
    this.deepgram = null;
    this.isFinals = [];
    
    // Connection state
    this.connected = false;
    this.reconnecting = false;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 5;
    this.reconnectDelay = 1000; // Start with 1 second delay
    
    // New flag to indicate intentional shutdown
    this.manualShutdown = false;
    
    logger.info("STT Service: Initialized Deepgram service");
  }

  connect() {
    try {
      if (this.reconnecting) {
        logger.info(`Reconnecting to Deepgram (attempt ${this.reconnectAttempts + 1}/${this.maxReconnectAttempts})...`);
      } else {
        logger.info("Connecting to Deepgram...");
      }
      this.deepgram = this.client.listen.live(this.config.sttConfig);
      
      // Set up keep-alive interval
      if (this.keepAliveInterval) {
        clearInterval(this.keepAliveInterval);
      }
      this.keepAliveInterval = setInterval(() => {
        if (this.deepgram && this.connected) {
          this.deepgram.keepAlive();
        }
      }, 10 * 1000);
      
      // Set up event listeners
      this._setupEventListeners();
      return this.deepgram;
    } catch (error) {
      logger.error("Failed to connect to Deepgram STT", error);
      this._handleConnectionFailure();
      return null;
    }
  }

  _handleConnectionFailure() {
    // Do not reconnect if shutdown was intentional
    if (this.manualShutdown) return;
    
    this.connected = false;
    if (this.reconnectAttempts < this.maxReconnectAttempts) {
      this.reconnecting = true;
      this.reconnectAttempts++;
      const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1);
      logger.info(`Will attempt to reconnect in ${delay}ms...`);
      setTimeout(() => {
        this.connect();
      }, delay);
    } else {
      logger.error(`Failed to reconnect after ${this.maxReconnectAttempts} attempts`);
      this.reconnecting = false;
      this.reconnectAttempts = 0;
    }
  }

  _setupEventListeners() {
    this.deepgram.addListener(LiveTranscriptionEvents.Open, () => {
      logger.info("Deepgram STT connection opened");
      this.connected = true;
      this.reconnecting = false;
      this.reconnectAttempts = 0;
      
      this.deepgram.addListener(LiveTranscriptionEvents.Transcript, (data) => {
        try {
          if (!data.is_final) {
            const transcript = data.channel?.alternatives?.[0]?.transcript;
            if (transcript) {
              this.onTranscript && this.onTranscript(transcript, false);
            }
            return;
          }
          const transcript = data.channel?.alternatives?.[0]?.transcript;
          if (!transcript) return;
          this.isFinals.push(transcript);
          if (data.speech_final) {
            const utterance = this.isFinals.join(" ");
            this.isFinals = [];
            this.onTranscript && this.onTranscript(utterance, true);
          } else {
            this.onTranscript && this.onTranscript(transcript, true);
          }
        } catch (error) {
          logger.error("Error processing transcript data", error);
        }
      });
      
      this.deepgram.addListener(LiveTranscriptionEvents.UtteranceEnd, () => {
        if (this.isFinals.length > 0) {
          const utterance = this.isFinals.join(" ");
          this.isFinals = [];
          this.onUtteranceEnd && this.onUtteranceEnd(utterance);
        }
      });
    });
    
    this.deepgram.addListener(LiveTranscriptionEvents.Close, () => {
      logger.info("Deepgram STT connection closed");
      this.connected = false;
      this._handleConnectionFailure();
    });
    
    this.deepgram.addListener(LiveTranscriptionEvents.Error, (error) => {
      logger.error("Deepgram STT error", error);
      if (!this.connected) {
        this._handleConnectionFailure();
      }
    });
    
    this.deepgram.addListener(LiveTranscriptionEvents.Warning, (warning) => {
      logger.warn("Deepgram STT warning", warning);
    });
  }

  send(audioData) {
    if (!this.connected || !this.deepgram) {
      logger.debug("Not sending audio because connection is not open");
      return;
    }
    if (!audioData || !Buffer.isBuffer(audioData) || audioData.length === 0) return;
    try {
      this.deepgram.send(audioData);
    } catch (error) {
      logger.error("Failed to send audio to Deepgram", error);
      if (error.message && error.message.includes("not open")) {
        this.connected = false;
        this._handleConnectionFailure();
      }
    }
  }

  cleanup() {
    // Set shutdown flag so no reconnects are attempted
    this.manualShutdown = true;
    
    if (this.keepAliveInterval) {
      clearInterval(this.keepAliveInterval);
      this.keepAliveInterval = null;
    }
    if (this.deepgram) {
      try {
        this.deepgram.requestClose();
      } catch (error) {
        logger.error("Error while closing Deepgram connection", error);
      }
      this.deepgram = null;
    }
    this.connected = false;
    this.reconnecting = false;
  }
}

class CallSession {
  constructor(webSocket, appServices) {
    this.ws = webSocket;
    this.services = appServices;
    this.callSid = null;
    this.streamSid = null;
    this.hasSeenMedia = false;
    this.active = true;
    this.hangupInitiated = false; // Flag to track if hangup has been initiated
    
    // Packet counters
    this.receivedPackets = 0; // All packets
    this.inboundPackets = 0;  // Inbound track
    this.outboundPackets = 0; // Outbound track
    this.silencePackets = 0;  // Packets with silence
    
    // For throttling audio packets
    this.lastAudioSent = 0;
    this.throttleInterval = this.services.config.deepgram.throttleInterval;
    
    // Explicitly bind all methods to this instance
    this._handleMessage = this._handleMessage.bind(this);
    this._handleClose = this._handleClose.bind(this);
    this._handleTranscript = this._handleTranscript.bind(this);
    this._handleUtteranceEnd = this._handleUtteranceEnd.bind(this);
    this._handleHangup = this._handleHangup.bind(this);
    this._cleanup = this._cleanup.bind(this);
    
    // Set up Deepgram STT service with callbacks
    this.sttService = new DeepgramSTTService(
      this.services.config.deepgram, 
      this._handleTranscript,
      this._handleUtteranceEnd
    );
    
    // Connect STT service
    this.deepgram = this.sttService.connect();
    
    // Set up WebSocket event handlers
    this.ws.on("message", this._handleMessage);
    this.ws.on("close", this._handleClose);
    this.ws.on("error", (error) => {
      logger.error("WebSocket error:", error);
    });
    
    // Create packet statistics reporting timer
    this.statsTimer = setInterval(() => {
      if (this.receivedPackets > 0) {
        logger.info(`Call statistics: total=${this.receivedPackets}, inbound=${this.inboundPackets}, outbound=${this.outboundPackets}, silence=${this.silencePackets}`);
      }
    }, 10000); // Report every 10 seconds
    
    logger.info("New call session created");
  }

  _handleMessage(message) {
    if (!this.active) return;
    
    try {
      // Log raw message type and size for debugging
      const msgType = typeof message;
      const msgSize = Buffer.isBuffer(message) ? message.length : 
                     (msgType === "string" ? message.length : "unknown");
      logger.debug(`WebSocket message received: type=${msgType}, size=${msgSize}`);
      
      // With 'ws', message can be string or Buffer
      let data;
      let messageText;
      
      // Check if message is a Buffer (binary data) or string
      if (Buffer.isBuffer(message)) {
        try {
          // For binary data, try to convert to string first
          messageText = message.toString("utf8");
          try {
            data = JSON.parse(messageText);
            logger.debug("Successfully parsed binary message as JSON");
          } catch (e) {
            // If it's not valid JSON, log the first part of the message
            const sample = messageText.substring(0, 100);
            logger.debug(`Binary message not valid JSON: ${sample}...`);
            return;
          }
        } catch (e) {
          // If we can't convert to string, log the raw binary data
          const sample = message.length > 20 ? message.slice(0, 20).toString("hex") : message.toString("hex");
          logger.debug(`Binary data (hex): ${sample}...`);
          return;
        }
      } else if (typeof message === "string") {
        // For string data, parse as JSON
        messageText = message;
        try {
          data = JSON.parse(message);
          logger.debug("Successfully parsed string message as JSON");
        } catch (e) {
          logger.debug(`String message not valid JSON: ${message.substring(0, 100)}...`);
          return;
        }
      } else {
        logger.warn(`Received message of unknown type: ${typeof message}`);
        return;
      }
      
      // Debug log the first few messages completely to understand format
      if (!this.hasSeenMedia) {
        logger.debug(`Complete message: ${messageText}`);
      }
      
      switch (data.event) {
        case "connected":
          logger.info("Twilio: Connected event received");
          break;
          
        case "start":
          // Handle different possible structures of the start event
          if (data.start && data.start.callSid) {
            this.callSid = data.start.callSid;
          } else if (data.callSid) {
            this.callSid = data.callSid;
          } else {
            logger.warn("Twilio: Call started but could not find callSid in message", data);
          }
          
          if (this.callSid) {
            logger.info(`Twilio: Call started, SID: ${this.callSid}`);
          }
          break;
          
        case "media":
          if (!this.hasSeenMedia) {
            logger.info("Twilio: First media event received");
            this.hasSeenMedia = true;
            
            // Log detailed media packet info for debugging
            if (data.media) {
              logger.info(`Media packet info: track=${data.media.track}, chunk=${data.media.chunk}, timestamp=${data.media.timestamp}`);
            }
          }
          
          // Increment overall packet count
          this.receivedPackets++;
          
          if (!this.streamSid && data.streamSid) {
            this.streamSid = data.streamSid;
            logger.info(`Twilio: Stream SID: ${this.streamSid}`);
          }
          
          // Process the audio payload
          if (data.media && data.media.payload) {
            // Only process audio from the inbound track (what the caller is saying)
            if (data.media.track === "inbound") {
              this.inboundPackets++;
              
              // Throttle sending audio to Deepgram
              const now = Date.now();
              if (this.lastAudioSent && (now - this.lastAudioSent < this.throttleInterval)) {
                logger.debug("Skipping audio packet to avoid overwhelming Deepgram");
                this.silencePackets++;
                return;
              }
              this.lastAudioSent = now;
              
              try {
                const payload = data.media.payload;
                
                // Check if packet contains audio or just silence (rudimentary)
                const hasAudio = this._hasAudioEnergy(payload);
                
                if (hasAudio) {
                  // Decode the base64 audio data
                  const rawAudio = audioBufferPool.decodeBase64(payload);
                  if (!rawAudio) {
                    logger.warn("Failed to decode audio payload");
                    return;
                  }
                  
                  // Send to speech-to-text service
                  this.sttService.send(rawAudio);
                } else {
                  // Skip silence packets
                  this.silencePackets++;
                }
                
              } catch (error) {
                logger.error("Error processing audio payload", error);
              }
            } else {
              // Track outbound packets separately
              this.outboundPackets++;
              
              // Log first outbound packet for debugging
              if (this.receivedPackets < 5) {
                logger.debug(`Received outbound audio packet, track: ${data.media.track}`);
              }
            }
          } else {
            // Log media without payload
            logger.debug("Received media event without payload");
          }
          break;
          
        case "mark":
          logger.debug("Twilio: Mark event received", data);
          break;
          
        case "close":
          logger.info("Twilio: Close event received", data);
          this._cleanup();
          break;
          
        default:
          logger.debug(`Twilio: Unknown event type: ${data.event}`);
      }
    } catch (error) {
      logger.error("Error processing message", error);
      if (message) {
        const sample = Buffer.isBuffer(message)
          ? `Binary message of length ${message.length}`
          : `Message: ${typeof message === "string" ? message.substring(0, 100) : typeof message}`;
        logger.error(`Message sample: ${sample}`);
      }
    }
  }

  _handleClose() {
    logger.info("Twilio: Connection closed");
    this._cleanup();
  }

  _handleTranscript(transcript, isFinal) {
    if (!this.active || this.hangupInitiated) return;
    try {
      logger.info(`Deepgram STT: [${isFinal ? "Final" : "Interim"}] ${transcript}`);
      if (
        this.services.textUtils.searchWordInSentence(transcript, "hangup") ||
        this.services.textUtils.searchWordInSentence(transcript, "hang up")
      ) {
        logger.info("Hangup command detected in transcript");
        this._handleHangup("Thank you for calling. Goodbye.");
      } else if (this.services.textUtils.searchWordInSentence(transcript, "goodbye")) {
        logger.info("Goodbye command detected in transcript");
        this._handleHangup("We appreciate your call. Have a great day!");
      }
    } catch (error) {
      logger.error("Error handling transcript", error);
    }
  }

  _handleUtteranceEnd(utterance) {
    if (!this.active) return;
    try {
      logger.info(`Complete utterance: ${utterance}`);
    } catch (error) {
      logger.error("Error handling utterance end", error);
    }
  }

  async _handleHangup(customPhrase) {
    if (!this.active || !this.callSid || this.hangupInitiated) return;
    try {
      this.hangupInitiated = true;
      logger.info(`Initiating hangup for call ${this.callSid}${customPhrase ? ` with message: "${customPhrase}"` : ""}`);
      if (customPhrase) {
        await this.services.twilioService.sayPhraseAndHangup(this.callSid, customPhrase);
      } else {
        await this.services.twilioService.hangupCall(this.callSid);
      }
    } catch (error) {
      logger.error("Failed to hang up call", error);
      this.hangupInitiated = false;
    }
  }

  _hasAudioEnergy(base64Payload) {
    try {
      const binary = Buffer.from(base64Payload, "base64");
      if (binary.length < 10) return true;
      let nonSilenceCount = 0;
      const packetLength = binary.length;
      const samplePositions = [
        0,
        Math.floor(packetLength * 0.1),
        Math.floor(packetLength * 0.2),
        Math.floor(packetLength * 0.3),
        Math.floor(packetLength * 0.4),
        Math.floor(packetLength * 0.5),
        Math.floor(packetLength * 0.6),
        Math.floor(packetLength * 0.7),
        Math.floor(packetLength * 0.8),
        Math.floor(packetLength * 0.9)
      ];
      for (const position of samplePositions) {
        for (let i = 0; i < 5; i++) {
          const index = position + i;
          if (index < packetLength) {
            const byte = binary[index];
            if (byte !== 0x7F && byte !== 0xFF) {
              nonSilenceCount++;
            }
          }
        }
      }
      return nonSilenceCount > 2;
    } catch (error) {
      logger.debug("Error checking audio energy, processing anyway", error);
      return true;
    }
  }

  _cleanup() {
    if (!this.active) return;
    try {
      this.active = false;
      this.hangupInitiated = false;
      if (this.statsTimer) {
        clearInterval(this.statsTimer);
        this.statsTimer = null;
      }
      if (this.sttService) {
        this.sttService.cleanup();
        this.sttService = null;
      }
      if (this.ws) {
        try {
          if (this.ws.readyState === WebSocket.OPEN) {
            this.ws.terminate();
          }
          this.ws.removeAllListeners();
        } catch (err) {
          logger.error("Error terminating WebSocket", err);
        }
        this.ws = null;
      }
      logger.info(`Call session cleaned up, Call SID: ${this.callSid || "unknown"}, processed ${this.receivedPackets} packets`);
    } catch (error) {
      logger.error("Error during session cleanup", error);
    }
  }
}

class VoiceServer {
  constructor() {
    this.config = config.init();
    this.services = {
      config: this.config,
      twilioService: new TwilioService(this.config.twilio),
      textUtils: new TextUtils(this.config.punctuation)
    };
    this.httpServer = http.createServer(this._handleHttpRequest.bind(this));
    const wsOptions = {
      server: this.httpServer,
      perMessageDeflate: false,
      maxPayload: 65536,
      handleProtocols: () => true
    };
    this.wsServer = new WebSocket.Server(wsOptions);
    this._setupWebSocketHandlers();
    this.sessions = new Map();
    this.isShuttingDown = false;
  }

  _handleHttpRequest(req, res) {
    const { pathname } = url.parse(req.url);
    if (pathname === "/") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("aiShield Monitor");
    } else {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not Found");
    }
  }

  _setupWebSocketHandlers() {
    this.wsServer.on("connection", (ws, req) => {
      logger.info("New WebSocket connection established");
      logger.info(`WebSocket connection headers: ${JSON.stringify(req.headers["sec-websocket-protocol"] || "none")}`);
      ws._socket.on("data", (data) => logger.debug(`Raw WebSocket data received: ${data.length} bytes`));
      const session = new CallSession(ws, this.services);
      const remoteAddress = req.socket.remoteAddress;
      const remotePort = req.socket.remotePort;
      const sessionId = `${remoteAddress}:${remotePort}`;
      this.sessions.set(sessionId, session);
      ws.on("close", (code, reason) => {
        logger.info(`WebSocket closed with code ${code}, reason: ${reason || "none"}`);
        this.sessions.delete(sessionId);
        logger.info(`Session ${sessionId} removed`);
      });
    });
  }

  start() {
    try {
      this.httpServer.listen(this.config.server.port, () => {
        logger.info(`Server listening on port ${this.config.server.port}`);
      });
    } catch (error) {
      logger.error("Failed to start server", error);
      process.exit(1);
    }
  }

  stop() {
    try {
      this.isShuttingDown = true;
      for (const session of this.sessions.values()) {
        session._cleanup();
      }
      this.sessions.clear();
      audioBufferPool.clear();
      const closeTimeout = setTimeout(() => {
        logger.warn("WebSocket server close timed out, forcing exit");
        this.httpServer.close();
      }, 5000);
      this.wsServer.close(() => {
        clearTimeout(closeTimeout);
        logger.info("WebSocket server closed");
        this.httpServer.close(() => {
          logger.info("HTTP server closed");
        });
      });
    } catch (error) {
      logger.error("Error stopping server", error);
    }
  }
}

process.on("SIGINT", () => {
  logger.info("Received SIGINT signal, shutting down gracefully");
  if (server) {
    server.stop();
  }
  setTimeout(() => {
    logger.info("Forcing exit after timeout");
    process.exit(0);
  }, 5000);
});

process.on("SIGTERM", () => {
  logger.info("Received SIGTERM signal, shutting down gracefully");
  if (server) {
    server.stop();
  }
  setTimeout(() => {
    logger.info("Forcing exit after timeout");
    process.exit(0);
  }, 5000);
});

process.on("uncaughtException", (error) => {
  logger.error("Uncaught exception", error);
  if (server) {
    server.stop();
  }
  process.exit(1);
});

const server = new VoiceServer();
server.start();
