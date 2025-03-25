// Import required modules
const http = require( "http" );
const https = require( "https" );
const WebSocket = require( "ws" );
const TranscriptHistory = require( "./transcripthistory" );
const { addParticipant, TwilioService } = require('./commands');
const DeepgramSTTService = require('./deepgramstt');
const { performance } = require('perf_hooks');
const FastJsonParse = require('fast-json-parse');


require("dotenv").config();

const scamPhrases_1 = [
    { phrase: "hangup", type: "cmd" },
    { phrase: "hang up", type: "cmd" },
    { phrase: "hang on", type: "cmd" }, // Deepgram keeps mis-translating 'hang up' to 'hang on'
    { phrase: "i love you", type: "match" },
    { phrase: "soulmate", type: "match" },
    { phrase: "meant to be", type: "match" },
    { phrase: "help me", type: "match" },
    { phrase: "money for a ticket", type: "match" },
    { phrase: "urgent need", type: "match" },
    { phrase: "wedding plans", type: "match" },
    { phrase: "trust me", type: "match" },
    { phrase: "send me gift cards", type: "match" },
    { phrase: "i need your help", type: "match" },
    { phrase: "guaranteed return", type: "match" },
    { phrase: "risk free", type: "match" },
    { phrase: "act fast", type: "match" },
    { phrase: "limited time opportunity", type: "match" },
    { phrase: "secure your future", type: "match" },
    { phrase: "no risk", type: "match" },
    { phrase: "double your money", type: "match" },
    { phrase: "get rich quick", type: "match" },
    { phrase: "investment portfolio", type: "match" },
    { phrase: "exclusive deal", type: "match" },
    { phrase: "debt forgiveness", type: "match" },
    { phrase: "consolidate your loans", type: "match" },
    { phrase: "low interest rate", type: "match" },
    { phrase: "act now to reduce debt", type: "match" },
    { phrase: "past due payment", type: "match" },
    { phrase: "insurance claim overdue", type: "match" },
    { phrase: "urgent action required", type: "match" },
    { phrase: "policy cancellation", type: "match" },
    { phrase: "pay to reactivate", type: "match" },
    { phrase: "its me your grandson", type: "match" },
    { phrase: "help me out of trouble", type: "match" },
    { phrase: "i need bail money", type: "match" },
    { phrase: "dont tell mom", type: "match" },
    { phrase: "urgent family emergency", type: "match" },
    { phrase: "send money immediately", type: "match" },
    { phrase: "wire transfer needed", type: "match" },
    { phrase: "im in danger", type: "match" },
    { phrase: "please trust me", type: "match" },
    { phrase: "youve won", type: "match" },
    { phrase: "claim your prize", type: "match" },
    { phrase: "pay a fee to collect", type: "match" },
    { phrase: "cash transfer required", type: "match" },
    { phrase: "congratulations youre the winner", type: "match" },
    { phrase: "lottery winnings", type: "match" },
    { phrase: "exclusive prize claim", type: "match" },
    { phrase: "act fast to secure your prize", type: "match" },
    { phrase: "winner notification", type: "match" },
    { phrase: "your computer is at risk", type: "match" },
    { phrase: "remote access required", type: "match" },
    { phrase: "fix your account", type: "match" },
    { phrase: "service renewal", type: "match" },
    { phrase: "subscription fee", type: "match" },
    { phrase: "update your device", type: "match" },
    { phrase: "account locked", type: "match" },
    { phrase: "technical problem detected", type: "match" },
    { phrase: "call this number immediately", type: "match" },
    { phrase: "tax debt", type: "match" },
    { phrase: "unpaid taxes", type: "match" },
    { phrase: "irs agent", type: "match" },
    { phrase: "legal action required", type: "match" },
    { phrase: "arrest warrant issued", type: "match" },
    { phrase: "pay now to avoid penalties", type: "match" },
    { phrase: "urgent tax resolution", type: "match" },
    { phrase: "back taxes owed", type: "match" },
    { phrase: "settlement fee", type: "match" },
    { phrase: "tax relief services", type: "match" }
];

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
            port: process.env.PORT || 8080
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
                endpointing: parseInt(process.env.DEEPGRAM_ENDPOINTING) || 4,
                utterance_end_ms: parseInt(process.env.DEEPGRAM_UTTERANCE_END_MS) || 1000
            },
            throttleInterval: parseInt(process.env.DEEPGRAM_THROTTLE_INTERVAL) || 20
        }
    };
})();


// CallSession - Optimized version with Deepgram data tracking
class CallSession {
    constructor(webSocket, services) {
        this.ws = webSocket;
        this.services = services;
        this.callSid = null;
        this.conferenceName = "";
        this.streamSid = null;
        this.active = true;
        this.hangupInitiated = false;
        this.hasSeenMedia = false;
        
        // Counters and audio handling
        this.receivedPackets = 0;
        this.inboundPackets = 0;
        
        // 1. SEPARATE TRACK PROCESSING - Create separate buffers for each track
        this.audioAccumulator = { inbound: [], outbound: [] };
        this.audioAccumulatorSize = { inbound: 0, outbound: 0 };
        this.lastProcessingTime = { inbound: 0, outbound: 0 };
        this.processingStartTime = { inbound: 0, outbound: 0 };
        
        // 2. ADAPTIVE BUFFER MANAGEMENT - Add parameters
        this.bufferSizeThreshold = { inbound: 2 * 1024, outbound: 2 * 1024 }; // 2 KB initially
        this.flushTimer = { inbound: null, outbound: null };
        this.flushInterval = { 
            inbound: this.services.config.deepgram.throttleInterval,
            outbound: this.services.config.deepgram.throttleInterval
        };
        
        // 4. ERROR RESILIENCE - Add maximum sizes and circuit breaker
        this.MAX_BUFFER_SIZE = 32 * 1024;
        this.consecutiveErrors = { inbound: 0, outbound: 0 };
        this.MAX_CONSECUTIVE_ERRORS = 15;
        
        // 5. PERFORMANCE MONITORING - Enhanced with Deepgram data tracking
        this.metrics = {
            processingTimes: { inbound: [], outbound: [] },
            bufferGrowth: { inbound: [], outbound: [] },
            lastMetricTime: performance.now(),
            delays: { inbound: 0, outbound: 0 },
            // Add Deepgram data tracking
            deepgram: {
                bytesSent: { inbound: 0, outbound: 0 },
                packetsSent: { inbound: 0, outbound: 0 },
                sendRates: { inbound: [], outbound: [] },
                lastSendTime: { inbound: performance.now(), outbound: performance.now() },
                responseTimes: { inbound: [], outbound: [] }
            }
        };
        
        // 6. PREALLOC BUFFERS
        this.audioAccumulator = {
            inbound: Buffer.alloc(this.MAX_BUFFER_SIZE),
            outbound: Buffer.alloc(this.MAX_BUFFER_SIZE)
        };
        
        this.audioAccumulatorOffset = {
            inbound: 0,
            outbound: 0
        };        
        
        this.transcriptHistory = {
            inbound: new TranscriptHistory( scamPhrases_1 ),
            outbound: new TranscriptHistory( scamPhrases_1 )
        };
        
        // Initialize STT services - one for each track
        this.sttService = {
            inbound: new DeepgramSTTService(
                this.services.config.deepgram,
                (transcript, isFinal) => this._handleTranscript(transcript, isFinal, 'inbound'),
                (utterance) => this._handleUtteranceEnd(utterance, 'inbound')
            ),
            outbound: new DeepgramSTTService(
                 this.services.config.deepgram,
                 (transcript, isFinal) => this._handleTranscript(transcript, isFinal, 'outbound'),
                 (utterance) => this._handleUtteranceEnd(utterance, 'outbound')
            )
        };
        
        // Setup WebSocket handlers
        this.ws.on("message", this._handleMessage.bind(this));
        this.ws.on("close", this._handleClose.bind(this));
        this.ws.on("error", (error) => log.error("WebSocket error:", error));
        
        // Setup stats logging with enhanced metrics
        this.statsTimer = setInterval(() => {
            if (this.receivedPackets > 0) {
                // Regular stats
                log.info(`Call stats: total=${this.receivedPackets}, inbound=${this.inboundPackets}`);
                
                // 5. PERFORMANCE MONITORING - Log enhanced metrics
                const now = performance.now();
                const avgProcessingTimeInbound = this._calculateAverage(this.metrics.processingTimes.inbound);
                const avgProcessingTimeOutbound = this._calculateAverage(this.metrics.processingTimes.outbound);
                
                log.info(`Performance metrics: 
          Inbound: buffer=${this.audioAccumulatorSize.inbound} bytes, avgProcessing=${avgProcessingTimeInbound.toFixed(2)}ms, delay=${this.metrics.delays.inbound.toFixed(2)}ms
          Outbound: buffer=${this.audioAccumulatorSize.outbound} bytes, avgProcessing=${avgProcessingTimeOutbound.toFixed(2)}ms, delay=${this.metrics.delays.outbound.toFixed(2)}ms`
                         );
                
                // Log Deepgram stats
                this.logDeepgramStats();
                
                // Reset metrics for next interval
                this.metrics.processingTimes = { inbound: [], outbound: [] };
                this.metrics.bufferGrowth = { inbound: [], outbound: [] };
                this.metrics.lastMetricTime = now;
            }
        }, 30000);
        
        log.info("New call session created with optimized processing and data tracking");
    }
    
    // Helper for calculating averages
    _calculateAverage(array) {
        return array.length > 0 ? array.reduce((a, b) => a + b, 0) / array.length : 0;
    }
    
    // Helper for formatting bytes
    _formatBytes(bytes) {
        if (bytes < 1024) return `${bytes} B`;
        if (bytes < 1048576) return `${(bytes / 1024).toFixed(2)} KB`;
        return `${(bytes / 1048576).toFixed(2)} MB`;
    }
    
    // New method to log detailed Deepgram stats
    logDeepgramStats() {
        // Calculate average send rates
        const calcAvgRate = (rates) => rates.length > 0 
        ? rates.reduce((sum, rate) => sum + rate, 0) / rates.length 
        : 0;
        
        const inboundAvgRate = calcAvgRate(this.metrics.deepgram.sendRates.inbound);
        const outboundAvgRate = calcAvgRate(this.metrics.deepgram.sendRates.outbound);
        
        // Log comprehensive Deepgram stats
        log.info(`Deepgram data transfer stats:
      Inbound: ${this._formatBytes(this.metrics.deepgram.bytesSent.inbound)} total (${this.metrics.deepgram.packetsSent.inbound} packets, avg ${inboundAvgRate.toFixed(2)} B/s)
      Outbound: ${this._formatBytes(this.metrics.deepgram.bytesSent.outbound)} total (${this.metrics.deepgram.packetsSent.outbound} packets, avg ${outboundAvgRate.toFixed(2)} B/s)
      Current rate (inbound): ${this._formatBytes(inboundAvgRate)} per second
      Current rate (outbound): ${this._formatBytes(outboundAvgRate)} per second
    `);
        
        // Reset rate tracking (but keep totals)
        this.metrics.deepgram.sendRates = { inbound: [], outbound: [] };
    }
    
    // 3. IMPROVED TIMER LOGIC - Track-specific flush timer management
    stopFlushTimer(track) {
        if (this.flushTimer[track]) {
            clearTimeout(this.flushTimer[track]);
            this.flushTimer[track] = null;
        }    
    }
    
    startFlushTimer(track) {
        // Cancel the previous timer, if any        
        this.stopFlushTimer(track);
        
        if (this.isShuttingDown) {
            return;
        }
        
        // 3. IMPROVED TIMER LOGIC - Adaptive interval based on processing time
        const baseInterval = this.flushInterval[track];
        const processingTime = this.lastProcessingTime[track];
        let interval = baseInterval;
        
        // If processing is taking longer, increase the interval
        if (processingTime > baseInterval) {
            interval = Math.min(processingTime * 1.5, 200); // Cap at 200ms
            this.metrics.delays[track] = processingTime - baseInterval;
        } else {
            interval = Math.max(baseInterval - 5, 10); // Try to catch up, but not too fast
            this.metrics.delays[track] = 0;
        }
        
        // Schedule the timer
        this.flushTimer[track] = setTimeout(() => {
            this.flushAudioBuffer(track);
        }, interval);
    }
    
    accumulateAudio(buffer, track) {
        // Get current offset
        let currentOffset = this.audioAccumulatorOffset[track];
        
        // If there isn’t enough room for the new buffer, flush first.
        if (currentOffset + buffer.length > this.MAX_BUFFER_SIZE) {
            log.warn(`${track} accumulator full, flushing before appending new data`);
            this.flushAudioBuffer(track);
            currentOffset = this.audioAccumulatorOffset[track]; // Should be 0 after flush.
        }
        
        // Copy the incoming buffer into the preallocated buffer at the current offset.
        buffer.copy(this.audioAccumulator[track], currentOffset);
        this.audioAccumulatorOffset[track] = currentOffset + buffer.length;
        
        // Track metrics, e.g., buffer growth, if needed:
        this.metrics.bufferGrowth[track].push(buffer.length);
        
        // Adjust the threshold based on processing time as before...
        const processingTime = this.lastProcessingTime[track];
        if (processingTime > 0) {
            if (processingTime < 10) {
                this.bufferSizeThreshold[track] = Math.max(1024, this.bufferSizeThreshold[track] - 128);
            } else if (processingTime > 50) {
                this.bufferSizeThreshold[track] = Math.min(8 * 1024, this.bufferSizeThreshold[track] + 256);
            }
        }
        
        // Flush if threshold exceeded.
        if (this.audioAccumulatorOffset[track] >= this.bufferSizeThreshold[track]) {
            this.flushAudioBuffer(track);
            return;
        }
        
        // Start the flush timer if not already running.
        if (!this.flushTimer[track]) {
            this.startFlushTimer(track);
        }
    }    
    
    flushAudioBuffer(track) {
        // Stop any existing flush timer.
        this.stopFlushTimer(track);
        
        const currentOffset = this.audioAccumulatorOffset[track];
        if (currentOffset > 0) {
            // Slice the preallocated buffer from 0 to the current offset.
            const combinedBuffer = this.audioAccumulator[track].slice(0, currentOffset);
            const bufferSize = combinedBuffer.length;
            const sttService = this.sttService[track];
            const deepgramMetrics = this.metrics.deepgram;
            const currentTime = performance.now();
            
            // Record processing start time.
            this.processingStartTime[track] = currentTime;
            
            try {
                if (sttService && sttService.connected) {
                    const timeSinceLastSend = currentTime - deepgramMetrics.lastSendTime[track];
                    
                    // Send the pre-sliced buffer.
                    sttService.send(combinedBuffer);
                    
                    deepgramMetrics.bytesSent[track] += bufferSize;
                    deepgramMetrics.packetsSent[track]++;
                    
                    if (timeSinceLastSend > 0) {
                        const sendRate = bufferSize / (timeSinceLastSend / 1000);
                        deepgramMetrics.sendRates[track].push(sendRate);
                    }
                    deepgramMetrics.lastSendTime[track] = currentTime;
                    
                    // Reset error counter.
                    this.consecutiveErrors[track] = 0;
                } else {
                    log.warn(`STT service not connected for ${track} track, buffered ${currentOffset} bytes`);
                    if (bufferSize > 64 * 1024) {
                        this.consecutiveErrors[track]++;
                    }
                }
            } catch (error) {
                log.error(`Error sending ${track} audio to Deepgram`, error);
                this.consecutiveErrors[track]++;
            } finally {
                // Reset the offset to 0 – no need to create a new Buffer.
                this.audioAccumulatorOffset[track] = 0;
                
                const processingTime = performance.now() - this.processingStartTime[track];
                this.lastProcessingTime[track] = processingTime;
                this.metrics.processingTimes[track].push(processingTime);
                this.metrics.deepgram.responseTimes[track].push(processingTime);
            }
            
            if (this.consecutiveErrors[track] >= this.MAX_CONSECUTIVE_ERRORS) {
                log.error(`Circuit breaker triggered for ${track} track after ${this.consecutiveErrors[track]} errors`);
                if (sttService) {
                    sttService.cleanup();
                    this.sttService[track] = new DeepgramSTTService(
                        this.services.config.deepgram,
                        (transcript, isFinal) => this._handleTranscript(transcript, isFinal, track),
                        (utterance) => this._handleUtteranceEnd(utterance, track)
                    );
                }
                this.consecutiveErrors[track] = 0;
            }
        }
        
        // Restart flush timer if session is still active.
        if (this.active && !this.isShuttingDown) {
            this.startFlushTimer(track);
        }
    }
    
    // Message handling
    _handleMessage(message) {
        if (!this.active) return;
        
        let data, parsed;
        try {
            // Parse message into JSON
            if (Buffer.isBuffer(message)) {
                parsed = FastJsonParse(message.toString("utf8"));
            } else if (typeof message === "string") {
                parsed = FastJsonParse(message);
            } else {
                return;
            }
            
            if( parsed.err ) {
            	return;
            }
             
    		data = parsed.value;
            
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
                
                this.conferenceName = data.start?.customParameters?.conferenceName;
                if( this.conferenceName ) {
                    log.info(`\tConference name: ${this.conferenceName}`);
                }
                
                log.info("JSON:", JSON.stringify(data, null, 2));                
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
                    // 1. SEPARATE TRACK PROCESSING - Handle tracks separately
                    if (data.media.track === "inbound" || data.media.track === "outbound") {
                        this.inboundPackets++;
                        const payload = data.media.payload;
                        const track = data.media.track;
                        
                        const rawAudio = Buffer.from(payload, "base64");
                        this.accumulateAudio(rawAudio, track);
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
    
    // Transcript handling - now includes track information
    _handleTranscript(transcript, isFinal, track) {
        if (!this.active || this.hangupInitiated) return;
        
        log.info(`[${track}][${isFinal ? 'Final' : 'Interim'}] ${transcript}`);
        
        this.transcriptHistory[ track ].push( transcript );
        
        let hit = this.transcriptHistory[ track ].findScamPhrases();
        if( hit !== null ) {    
            log.info("Scam phrase: " + JSON.stringify( hit, null, 2 ));
            this._handleHangup("Scam phrase detected. Goodbye.");
        }
    }
    
    _handleUtteranceEnd(utterance, track) {
        if (this.active) log.info(`[${track}] Complete utterance: ${utterance}`);
    }
    
    // Call control
    async _handleHangup(customPhrase) {
        if (!this.active || !this.callSid || this.hangupInitiated) return;
        
        try {
            
            this.hangupInitiated = true;
            log.info(`Initiating hangup for call ${this.callSid}${customPhrase ? ` with message: "${customPhrase}"` : ""}`);
            
            await this.services.twilioService.sayPhraseAndHangup(this.callSid, customPhrase);
            
        } catch (error) {
            
            log.error("Failed to hang up call", error);
        }
    }
    
    _handleClose() {
        log.info("Twilio: Connection closed");
        this._cleanup();
    }
    
    _cleanup() {
        if (!this.active) return;
        
        // Log final Deepgram stats before cleanup
        if (this.metrics.deepgram.packetsSent.inbound > 0 || this.metrics.deepgram.packetsSent.outbound > 0) {
            log.info(`Final Deepgram stats for call ${this.callSid || 'unknown'}:`);
            this.logDeepgramStats();
        }
        
        this.active = false;
        this.hangupInitiated = false;
        this.isShuttingDown = true;
        
        // Clear timers
        if (this.statsTimer) {
            clearInterval(this.statsTimer);
            this.statsTimer = null;
        }
        
        // Stop flush timers for both tracks
        this.stopFlushTimer('inbound');
        this.stopFlushTimer('outbound');
        
        // Clean up services for both tracks
        if (this.sttService && this.sttService.inbound) {
            this.sttService.inbound.cleanup();
            this.sttService.inbound = null;
        }
        
        if (this.sttService && this.sttService.outbound) {
            this.sttService.outbound.cleanup();
            this.sttService.outbound = null;
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
            // Use the WHATWG URL API, passing a base URL based on the request
            const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
            if (parsedUrl.pathname === "/") {
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
