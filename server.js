// Import required modules
const fs = require("fs");
const http = require("http");
const path = require("path");
const WebSocket = require('ws');
const url = require('url');
const { createClient, LiveTranscriptionEvents } = require("@deepgram/sdk");

// Audio buffer utility for decoding base64
const audioBufferPool = {
  decodeBase64(base64String) {
    try {
      if (!base64String) return null;
      return Buffer.from(base64String, 'base64');
    } catch (error) {
      logger.error("Error decoding base64", error);
      return null;
    }
  },
  
  // Clear resources
  clear() {
    // No resources to clear
  }
};

// Logging system
const logger = {
  info(message, data) {
    console.log(`[INFO] ${message}`, data ? data : '');
  },
  error(message, error) {
    console.error(`[ERROR] ${message}`, error);
  },
  warn(message, data) {
    console.warn(`[WARN] ${message}`, data ? data : '');
  },
  debug(message, data) {
    if (process.env.DEBUG) {
      console.log(`[DEBUG] ${message}`, data ? data : '');
    }
  },
  trace(message, data) {
    if (process.env.TRACE) {
      console.log(`[TRACE] ${message}`, data ? data : '');
    }
  }
};

// Configuration management
const config = {
  // Load configuration with validation and defaults
  init() {
    // Load environment variables
    require("dotenv").config();
    
    // Validate required environment variables
    const requiredEnvVars = ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'DEEPGRAM_API_KEY'];
    const missingVars = requiredEnvVars.filter(varName => !process.env[varName]);
    
    if (missingVars.length > 0) {
      throw new Error(`Missing required environment variables: ${missingVars.join(', ')}`);
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
                        'wss://api.deepgram.com/v1/speak?encoding=mulaw&sample_rate=8000&container=none',
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
        }
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
    if (!text || typeof text !== 'string') return false;
    return Array.from(text).some(char => this.puntuationChars.includes(char));
  }

  searchWordInSentence(sentence, word) {
    if (!sentence || !word || typeof sentence !== 'string' || typeof word !== 'string') {
      return false;
    }
    
    // Use pre-compiled patterns for known commands (much faster)
    if (this.commandPatterns[word.toLowerCase()]) {
      return this.commandPatterns[word.toLowerCase()].test(sentence);
    }
    
    // Fallback to standard search for other words
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
    this.VoiceResponse = require('twilio').twiml.VoiceResponse;
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
  
  /**
   * Generate TwiML to say a phrase and then hang up
   * @param {string} phrase - The text to say before hanging up
   * @param {Object} options - Options for voice, language, etc.
   * @returns {string} TwiML response as a string
   */
  generateSayAndHangupTwiML(phrase, options = {}) {
    try {
      const twiml = new this.VoiceResponse();
      
      // Set default options
      const voiceOptions = {
        voice: options.voice || 'Polly.Amy-Neural', // Using a neural voice
        language: options.language || 'en-US',
        ...options
      };
      
      // Add the Say verb with the phrase
      twiml.say(voiceOptions, phrase);
      
      // Add the Hangup verb
      twiml.hangup();
      
      return twiml.toString();
    } catch (error) {
      logger.error("Error generating TwiML", error);
      
      // Return a simple TwiML in case of error
      const fallbackTwiml = new this.VoiceResponse();
      fallbackTwiml.say('Sorry, an error occurred.');
      fallbackTwiml.hangup();
      return fallbackTwiml.toString();
    }
  }
  
  /**
   * Update an ongoing call with new TwiML instructions
   * @param {string} callSid - The SID of the call to update
   * @param {string} phrase - The phrase to say before hanging up
   * @returns {Promise} - Promise resolving to call update result
   */
  async sayPhraseAndHangup(callSid, phrase) {
    try {
      if (!callSid) {
        throw new Error("Call SID is required");
      }
      
      logger.info(`Saying phrase and hanging up call ${callSid}: "${phrase}"`);
      
      // Generate the TwiML
      const twiml = this.generateSayAndHangupTwiML(phrase);
      
      // Update the call with the new TwiML
      const result = await this.client.calls(callSid)
        .update({
          twiml: twiml
        });
      
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
    this.connected = false;
    
    // Attempt to reconnect with exponential backoff
    if (this.reconnectAttempts < this.maxReconnectAttempts) {
      this.reconnecting = true;
      this.reconnectAttempts++;
      
      // Calculate delay with exponential backoff (1s, 2s, 4s, 8s, etc.)
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
          // Process interim results immediately, prioritizing real-time output
          if (!data.is_final) {
            const transcript = data.channel?.alternatives?.[0]?.transcript;
            if (transcript) {
              // Immediately call handler for interim results
              this.onTranscript && this.onTranscript(transcript, false);
            }
            return;
          }
          
          // For final transcripts
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

  // Send audio data directly to Deepgram
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
      
      // If we have a connection error, attempt to reconnect
      if (error.message && error.message.includes('not open')) {
        this.connected = false;
        this._handleConnectionFailure();
      }
    }
  }

  cleanup() {
    if (this.keepAliveInterval) {
      clearInterval(this.keepAliveInterval);
      this.keepAliveInterval = null;
    }
    
    // Remove all event listeners
    if (this.deepgram) {
      try {
        // Close the connection
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
    this.receivedPackets = 0; // Counter for received packets
    
    // Explicitly bind all methods to this instance
    this._handleMessage = this._handleMessage.bind(this);
    this._handleClose = this._handleClose.bind(this);
    this._handleTranscript = this._handleTranscript.bind(this);
    this._handleUtteranceEnd = this._handleUtteranceEnd.bind(this);
    this._handleHangup = this._handleHangup.bind(this);
    this._cleanup = this._cleanup.bind(this);
    
    // Set up speech-to-text service with callbacks
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
        logger.info(`Call statistics: received ${this.receivedPackets} packets`);
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
                     (msgType === 'string' ? message.length : 'unknown');
      logger.debug(`WebSocket message received: type=${msgType}, size=${msgSize}`);
      
      // With 'ws', message can be string or Buffer
      let data;
      let messageText;
      
      // Check if message is a Buffer (binary data) or string
      if (Buffer.isBuffer(message)) {
        try {
          // For binary data, try to convert to string first
          messageText = message.toString('utf8');
          try {
            data = JSON.parse(messageText);
            logger.debug(`Successfully parsed binary message as JSON`);
          } catch (e) {
            // If it's not valid JSON, log the first part of the message
            const sample = messageText.substring(0, 100);
            logger.debug(`Binary message not valid JSON: ${sample}...`);
            return;
          }
        } catch (e) {
          // If we can't convert to string, log the raw binary data
          const sample = message.length > 20 ? message.slice(0, 20).toString('hex') : message.toString('hex');
          logger.debug(`Binary data (hex): ${sample}...`);
          return;
        }
      } else if (typeof message === 'string') {
        // For string data, parse as JSON
        messageText = message;
        try {
          data = JSON.parse(message);
          logger.debug(`Successfully parsed string message as JSON`);
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
          
          this.receivedPackets++;
          
          if (!this.streamSid && data.streamSid) {
            this.streamSid = data.streamSid;
            logger.info(`Twilio: Stream SID: ${this.streamSid}`);
          }
          
          // Process the audio payload
          if (data.media && data.media.payload) {
            // Only process audio from the inbound track (what the caller is saying)
            if (data.media.track === "inbound") {
              try {
                const payload = data.media.payload;
                
                // Decode the base64 audio data
                const rawAudio = audioBufferPool.decodeBase64(payload);
                if (!rawAudio) {
                  logger.warn("Failed to decode audio payload");
                  return;
                }
                
                // Send to speech-to-text service
                this.sttService.send(rawAudio);
                
              } catch (error) {
                logger.error("Error processing audio payload", error);
              }
            } else {
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
      // Log a sample of the message for debugging
      if (message) {
        const sample = Buffer.isBuffer(message) 
          ? `Binary message of length ${message.length}` 
          : `Message: ${typeof message === 'string' ? message.substring(0, 100) : typeof message}`;
        logger.error(`Message sample: ${sample}`);
      }
    }
  }

  _handleClose() {
    logger.info("Twilio: Connection closed");
    this._cleanup();
  }

  _handleTranscript(transcript, isFinal) {
    if (!this.active || this.hangupInitiated) return; // Don't process if hangup already initiated
    
    try {
      // Always log with INFO level for visibility, whether interim or final
      if (isFinal) {
        logger.info(`Deepgram STT: [Final] ${transcript}`);
      } else {
        // Show interim results at INFO level so they're always visible
        logger.info(`Deepgram STT: [Interim] ${transcript}`);
      }
      
      // Process all transcripts in real-time, even interim results
      // Check for hangup command in the transcript
      if (this.services.textUtils.searchWordInSentence(transcript, "hangup") || 
          this.services.textUtils.searchWordInSentence(transcript, "hang up")) {
        logger.info("Hangup command detected in transcript");
        
        // Say a goodbye message before hanging up
        this._handleHangup("Thank you for calling. Goodbye.");
      }
      
      // Check for goodbye command with custom message
      else if (this.services.textUtils.searchWordInSentence(transcript, "goodbye")) {
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
      // Process the complete utterance
      // This could include sending to a TTS service or other processing
    } catch (error) {
      logger.error("Error handling utterance end", error);
    }
  }

  async _handleHangup(customPhrase) {
    if (!this.active || !this.callSid || this.hangupInitiated) return;
    
    try {
      // Set the flag to prevent multiple hangup calls
      this.hangupInitiated = true;
      
      logger.info(`Initiating hangup for call ${this.callSid}${customPhrase ? ` with message: "${customPhrase}"` : ''}`);
      
      // If a custom phrase is provided, say it before hanging up
      if (customPhrase) {
        await this.services.twilioService.sayPhraseAndHangup(this.callSid, customPhrase);
      } else {
        // Otherwise use the standard hangup flow
        await this.services.twilioService.hangupCall(this.callSid);
      }
    } catch (error) {
      logger.error("Failed to hang up call", error);
      // Reset the flag if the hangup fails, so we can try again
      this.hangupInitiated = false;
    }
  }

  _cleanup() {
    if (!this.active) return;
    
    try {
      this.active = false;
      this.hangupInitiated = false; // Reset the hangup flag for any future use of this object
      
      // Stop statistics timer
      if (this.statsTimer) {
        clearInterval(this.statsTimer);
        this.statsTimer = null;
      }
      
      // Clean up STT service
      if (this.sttService) {
        this.sttService.cleanup();
        this.sttService = null;
      }
      
      // Make sure to terminate the websocket if still open
      if (this.ws) {
        try {
          if (this.ws.readyState === WebSocket.OPEN) {
            this.ws.terminate();
          }
          this.ws.removeAllListeners(); // Remove all event listeners
        } catch (err) {
          logger.error("Error terminating WebSocket", err);
        }
        this.ws = null;
      }
      
      logger.info(`Call session cleaned up, Call SID: ${this.callSid || 'unknown'}, processed ${this.receivedPackets} packets`);
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
    
    // Set up HTTP server
    this.httpServer = http.createServer(this._handleHttpRequest.bind(this));
    
    // Set WebSocket options for the server
    const wsOptions = {
      server: this.httpServer,
      // The following options are important for handling Twilio's WebSocket streams
      perMessageDeflate: false, // Disable compression for better voice streaming performance
      maxPayload: 65536, // 64KB max message size to handle audio chunks
      // Allow binary frames directly
      handleProtocols: () => true
    };
    
    // Set up WebSocket server using 'ws' package
    this.wsServer = new WebSocket.Server(wsOptions);
    
    // Set up WebSocket handlers
    this._setupWebSocketHandlers();
    
    // Call sessions map
    this.sessions = new Map();
    
    // Server state
    this.isShuttingDown = false;
  }

  _handleHttpRequest(req, res) {
    // Simple HTTP routing handler
    const { pathname } = url.parse(req.url);
    
    if (pathname === '/') {
      // Root path - send simple status response
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('aiShield Monitor');
    } else {
      // 404 for any other path
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
    }
  }

  _setupWebSocketHandlers() {
    this.wsServer.on('connection', (ws, req) => {
      logger.info("New WebSocket connection established");
      
      // Debug the WebSocket connection
      logger.info(`WebSocket connection headers: ${JSON.stringify(req.headers['sec-websocket-protocol'] || 'none')}`);
      
      // Debug raw message handler to trace all incoming data
      ws._socket.on('data', (data) => {
        logger.debug(`Raw WebSocket data received: ${data.length} bytes`);
      });
      
      // Create a new call session for this connection
      const session = new CallSession(ws, this.services);
      
      // Use a unique ID for the session based on socket information
      const remoteAddress = req.socket.remoteAddress;
      const remotePort = req.socket.remotePort;
      const sessionId = `${remoteAddress}:${remotePort}`;
      
      this.sessions.set(sessionId, session);
      
      // Remove the session when the connection closes
      ws.on('close', (code, reason) => {
        logger.info(`WebSocket closed with code ${code}, reason: ${reason || 'none'}`);
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
      
      // Close all active sessions
      for (const session of this.sessions.values()) {
        session._cleanup();
      }
      
      // Clear the session map
      this.sessions.clear();
      
      // Clear the buffer pool
      audioBufferPool.clear();
      
      // Close the WebSocket server with a timeout
      const closeTimeout = setTimeout(() => {
        logger.warn("WebSocket server close timed out, forcing exit");
        this.httpServer.close();
      }, 5000);
      
      this.wsServer.close(() => {
        clearTimeout(closeTimeout);
        logger.info("WebSocket server closed");
        
        // Then close the HTTP server
        this.httpServer.close(() => {
          logger.info("HTTP server closed");
        });
      });
    } catch (error) {
      logger.error("Error stopping server", error);
    }
  }
}

// Handle process termination
process.on('SIGINT', () => {
  logger.info("Received SIGINT signal, shutting down gracefully");
  if (server) {
    server.stop();
  }
  setTimeout(() => {
    logger.info("Forcing exit after timeout");
    process.exit(0);
  }, 5000);
});

process.on('SIGTERM', () => {
  logger.info("Received SIGTERM signal, shutting down gracefully");
  if (server) {
    server.stop();
  }
  setTimeout(() => {
    logger.info("Forcing exit after timeout");
    process.exit(0);
  }, 5000);
});

process.on('uncaughtException', (error) => {
  logger.error("Uncaught exception", error);
  if (server) {
    server.stop();
  }
  process.exit(1);
});

// Start the server
const server = new VoiceServer();
server.start();
