// Import required modules
const fs = require("fs");
const http = require("http");
const path = require("path");
const WebSocketServer = require("websocket").server;
const HttpDispatcher = require("httpdispatcher");
const WebSocket = require('ws');
const { createClient, LiveTranscriptionEvents } = require("@deepgram/sdk");

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
  }
};

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
  }

  connect() {
    try {
      this.deepgram = this.client.listen.live(this.config.sttConfig);
      
      // Set up keep-alive interval
      if (this.keepAliveInterval) {
        clearInterval(this.keepAliveInterval);
      }
      
      this.keepAliveInterval = setInterval(() => {
        if (this.deepgram) {
          this.deepgram.keepAlive();
        }
      }, 10 * 1000);

      // Set up event listeners
      this._setupEventListeners();
      
      logger.info("Deepgram STT service connected");
      return this.deepgram;
    } catch (error) {
      logger.error("Failed to connect to Deepgram STT", error);
      this.cleanup();
      throw error;
    }
  }

  _setupEventListeners() {
    this.deepgram.addListener(LiveTranscriptionEvents.Open, this._handleOpen.bind(this));
    this.deepgram.addListener(LiveTranscriptionEvents.Close, this._handleClose.bind(this));
    this.deepgram.addListener(LiveTranscriptionEvents.Error, this._handleError.bind(this));
    this.deepgram.addListener(LiveTranscriptionEvents.Warning, this._handleWarning.bind(this));
    this.deepgram.addListener(LiveTranscriptionEvents.Metadata, this._handleMetadata.bind(this));
  }

  _handleOpen() {
    logger.info("Deepgram STT connection opened");
    
    this.deepgram.addListener(LiveTranscriptionEvents.Transcript, (data) => {
      const transcript = data.channel.alternatives[0].transcript;
      if (transcript === "") return;
      
      if (data.is_final) {
        this.isFinals.push(transcript);
        if (data.speech_final) {
          const utterance = this.isFinals.join(" ");
          this.isFinals = [];
          logger.info(`Deepgram STT: [Speech Final] ${utterance}`);
          
          if (this.onTranscript) {
            this.onTranscript(utterance, true);
          }
        } else {
          // Log and process each final segment
          logger.debug(`Deepgram STT: [Is Final] ${transcript}`);
          
          if (this.onTranscript) {
            this.onTranscript(transcript, true);
          }
        }
      } else {
        // Log and process all interim results
        logger.debug(`Deepgram STT: [Interim Result] ${transcript}`);
        
        if (this.onTranscript) {
          this.onTranscript(transcript, false);
        }
      }
    });

    this.deepgram.addListener(LiveTranscriptionEvents.UtteranceEnd, (data) => {
      if (this.isFinals.length > 0) {
        logger.info("Deepgram STT: [Utterance End]");
        const utterance = this.isFinals.join(" ");
        this.isFinals = [];
        
        if (this.onUtteranceEnd) {
          this.onUtteranceEnd(utterance);
        }
      }
    });
  }

  _handleClose() {
    logger.info("Deepgram STT connection closed");
    this.cleanup();
  }

  _handleError(error) {
    logger.error("Deepgram STT error", error);
  }

  _handleWarning(warning) {
    logger.warn("Deepgram STT warning", warning);
  }

  _handleMetadata(metadata) {
    logger.debug("Deepgram STT metadata", metadata);
  }

  send(audioData) {
    try {
      if (this.deepgram) {
        this.deepgram.send(audioData);
      }
    } catch (error) {
      logger.error("Failed to send audio to Deepgram", error);
    }
  }

  cleanup() {
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
  }
}

class DeepgramTTSService {
  constructor(config) {
    this.config = config;
    this.ws = null;
  }

  connect() {
    try {
      const options = {
        headers: {
          Authorization: `Token ${this.config.apiKey}`
        }
      };
      
      this.ws = new WebSocket(this.config.ttsWebsocketURL, options);
      
      this.ws.on('open', () => {
        logger.info('Deepgram TTS: Connected');
      });
      
      this.ws.on('message', (data) => {
        // Handle incoming TTS data
        logger.debug('Deepgram TTS: Received data');
      });
      
      this.ws.on('close', () => {
        logger.info('Deepgram TTS: Disconnected');
        this.ws = null;
      });
      
      this.ws.on('error', (error) => {
        logger.error('Deepgram TTS: Error', error);
      });
      
      return this.ws;
    } catch (error) {
      logger.error("Failed to connect to Deepgram TTS", error);
      throw error;
    }
  }

  send(text) {
    try {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(text);
        return true;
      } else {
        logger.warn("Deepgram TTS: WebSocket not connected, reconnecting...");
        this.connect();
        return false;
      }
    } catch (error) {
      logger.error("Failed to send text to Deepgram TTS", error);
      return false;
    }
  }

  close() {
    if (this.ws) {
      try {
        this.ws.close();
      } catch (error) {
        logger.error("Error closing Deepgram TTS connection", error);
      }
      this.ws = null;
    }
  }
}

class TextUtils {
  constructor(config) {
    this.puntuationChars = config.chars;
  }

  containsAnyPunctuation(text) {
    if (!text || typeof text !== 'string') return false;
    return Array.from(text).some(char => this.puntuationChars.includes(char));
  }

  searchWordInSentence(sentence, word) {
    if (!sentence || !word || typeof sentence !== 'string' || typeof word !== 'string') {
      return false;
    }
    
    const trimmedSentence = sentence.trim();
    const trimmedWord = word.trim();
    
    if (!trimmedSentence || !trimmedWord) {
      return false;
    }
    
    return trimmedSentence.toLowerCase().includes(trimmedWord.toLowerCase());
  }
}

class CallSession {
  constructor(connection, appServices) {
    this.connection = connection;
    this.services = appServices;
    this.callSid = null;
    this.streamSid = null;
    this.hasSeenMedia = false;
    this.active = true;
    
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
    this.connection.on("message", this._handleMessage);
    this.connection.on("close", this._handleClose);
    
    logger.info("New call session created");
  }

  _handleMessage(message) {
    if (!this.active) return;
    
    try {
      if (message.type === "utf8") {
        const data = JSON.parse(message.utf8Data);
        
        // Log the first few messages completely to understand their structure
        if (!this.hasSeenMedia) {
          logger.debug("Twilio message structure:", JSON.stringify(data));
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
            }
            
            if (!this.streamSid && data.streamSid) {
              this.streamSid = data.streamSid;
              logger.info(`Twilio: Stream SID: ${this.streamSid}`);
            }
            
            // Process the audio payload
            if (data.media && data.media.payload) {
            	if (data.media.track === "inbound") {
            		const rawAudio = Buffer.from(data.media.payload, 'base64');
              		this.sttService.send(rawAudio);
                }      
            } else {
              logger.debug("Twilio: Received media event without payload");
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
      } else if (message.type === "binary") {
        logger.warn("Twilio: Binary message received (not supported)");
      }
    } catch (error) {
      logger.error("Error processing message", error);
    }
  }

  _handleClose() {
    logger.info("Twilio: Connection closed");
    this._cleanup();
  }

  _handleTranscript(transcript, isFinal) {
    if (!this.active) return;
    
    try {
      // Always log all transcripts, including interim results
      if (isFinal) {
        logger.info(`Deepgram STT: [Final] ${transcript}`);
      } else {
        logger.info(`Deepgram STT: [Interim] ${transcript}`);
      }
      
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
      
      // Additional transcript processing could go here
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
  	logger.info( "_handleHangup" );
      
    if (!this.active) {
    	logger.info( "!this.active" );
     	return;
    }
    
    if (!this.callSid) {
    	logger.info( "!this.callSid" );
        return;
    }
    
    try {
      // If a custom phrase is provided, say it before hanging up
      if (customPhrase) {
        logger.info(`Saying custom phrase before hanging up call ${this.callSid}: "${customPhrase}"`);
        await this.services.twilioService.sayPhraseAndHangup(this.callSid, customPhrase);
      } else {
        // Otherwise use the standard hangup flow
        await this.services.twilioService.hangupCall(this.callSid);
      }
      
      logger.info(`Initiated hangup for call ${this.callSid}`);
    } catch (error) {
      logger.error("Failed to hang up call", error);
    }
  }

  _cleanup() {
    if (!this.active) return;
    
    try {
      this.active = false;
      
      // Clean up STT service
      if (this.sttService) {
        this.sttService.cleanup();
      }
      
      logger.info(`Call session cleaned up, Call SID: ${this.callSid}`);
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
    
    // Set up HTTP server and dispatcher
    this.dispatcher = new HttpDispatcher();
    this.httpServer = http.createServer(this._handleHttpRequest.bind(this));
    
    // Set up WebSocket server
    this.wsServer = new WebSocketServer({
      httpServer: this.httpServer,
      autoAcceptConnections: true,
    });
    
    // Set up routes
    this._setupRoutes();
    
    // Set up WebSocket handlers
    this._setupWebSocketHandlers();
    
    // Call sessions map
    this.sessions = new Map();
  }

  _setupRoutes() {
    this.dispatcher.onGet("/", (req, res) => {
      logger.debug('GET / received');
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('aiShield Monitor');
    });
    
    this.dispatcher.onError((req, res) => {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
    });
  }

  _setupWebSocketHandlers() {
    this.wsServer.on("connect", (connection) => {
      logger.info("New WebSocket connection established");
      
      // Create a new call session for this connection
      const session = new CallSession(connection, this.services);
      
      // Store the session with a unique ID (could use connection ID or generated UUID)
      const sessionId = connection.socket._peername.port; // Using port as a simple unique ID
      this.sessions.set(sessionId, session);
      
      // Remove the session when the connection closes
      connection.on("close", () => {
        this.sessions.delete(sessionId);
        logger.info(`Session ${sessionId} removed`);
      });
    });
  }

  _handleHttpRequest(request, response) {
    try {
      this.dispatcher.dispatch(request, response);
    } catch (error) {
      logger.error("Error handling HTTP request", error);
      response.writeHead(500, { 'Content-Type': 'text/plain' });
      response.end('Internal Server Error');
    }
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
      // Close all active sessions
      for (const session of this.sessions.values()) {
        session._cleanup();
      }
      
      // Close the HTTP server
      this.httpServer.close(() => {
        logger.info("Server stopped");
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
