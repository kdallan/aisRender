// Import required modules
const http = require( "http" );
const https = require( "https" );
const uWS = require('uWebSockets.js');
const us_listen_socket_close = uWS.us_listen_socket_close;
const TranscriptHistory = require( "./transcripthistory" );
const { addParticipant, TwilioService } = require('./commands');
const DeepgramSTTService = require('./deepgramstt');
const { performance } = require('perf_hooks');
const simdjson = require('simdjson');
const { randomUUID } = require('crypto'); // Import randomUUID

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
                endpointing: parseInt(process.env.DEEPGRAM_ENDPOINTING) || 5,
                utterance_end_ms: parseInt(process.env.DEEPGRAM_UTTERANCE_END_MS) || 1000
            },
            throttleInterval: parseInt(process.env.DEEPGRAM_THROTTLE_INTERVAL) || 20
        }
    };
})();

// Helper function for simdjson lazyParse
function getValueOrDefault( parsedDoc, path, defaultValue ) {
    try {
        return parsedDoc.valueForKeyPath( path );
    } catch (error) {
        return defaultValue;
    }
}

// CallSession - Optimized version with Deepgram data tracking
class CallSession {
    constructor(webSocket, services) {
        this.ws = webSocket;
        this.services = services;
        this.callSid = null;
        this.conferenceName = "";
        this.active = true;
        this.hangupInitiated = false;
        
        // Cache the buffer to decode "base64" into        
        this.decodeBuffer = Buffer.alloc( 4 * 1024 );
        
        // Counters and audio handling
        this.receivedPackets = 0;
        this.inboundPackets = 0;
        
        // SEPARATE TRACK PROCESSING - Create separate buffers for each track
        this.audioAccumulator = { inbound: [], outbound: [] };
        this.audioAccumulatorSize = { inbound: 0, outbound: 0 };
        this.lastProcessingTime = { inbound: 0, outbound: 0 };
        this.processingStartTime = { inbound: 0, outbound: 0 };
        
        // ADAPTIVE BUFFER MANAGEMENT - Add parameters
        this.bufferSizeThreshold = { inbound: 2 * 1024, outbound: 2 * 1024 }; // 2 KB initially
        this.flushTimer = { inbound: null, outbound: null };
        this.flushInterval = { 
            inbound: this.services.config.deepgram.throttleInterval,
            outbound: this.services.config.deepgram.throttleInterval
        };
        
        // ERROR RESILIENCE - Add maximum sizes and circuit breaker
        this.MAX_BUFFER_SIZE = 32 * 1024;
        this.consecutiveErrors = { inbound: 0, outbound: 0 };
        this.MAX_CONSECUTIVE_ERRORS = 15;
        
        if ( process.env.WANT_MONITORING ) {            
            // PERFORMANCE MONITORING - Enhanced with Deepgram data tracking
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
        }
        
        // PREALLOC BUFFERS
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
        
        if( process.env.WANT_MONITORING ) {
            // Setup stats logging with enhanced metrics
            this.statsTimer = setInterval(() => {
                if (this.receivedPackets > 0) {
                    // Regular stats
                    log.info(`Call stats: total=${this.receivedPackets}, inbound=${this.inboundPackets}`);
                    
                    // PERFORMANCE MONITORING - Log enhanced metrics
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
        }
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
    
    // Log detailed Deepgram stats
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

	stopStatsTimer()
	{    
        if (this.statsTimer) {
            clearInterval(this.statsTimer);
            this.statsTimer = null;
        }
    }
    
    // IMPROVED TIMER LOGIC - Track-specific flush timer management
    stopFlushTimer(track) {
        if (this.flushTimer[track]) {
            clearTimeout(this.flushTimer[track]);
            this.flushTimer[track] = null;
        }    
    }
    
    startFlushTimer(track) {
        // Cancel the previous timer, if any        
        this.stopFlushTimer(track);
        
        if ( !this.active || this.isShuttingDown) {
            return;
        }
        
        // IMPROVED TIMER LOGIC - Adaptive interval based on processing time
        const baseInterval = this.flushInterval[track];
        const processingTime = this.lastProcessingTime[track];
        let interval = baseInterval;
        
        // If processing is taking longer, increase the interval
        const processingTakingLonger = processingTime > baseInterval;
        if ( processingTakingLonger ) {
            interval = Math.min(processingTime * 1.5, 200); // Cap at 200ms
        } else {
            interval = Math.max(baseInterval - 5, 10); // Try to catch up, but not too fast
        }
        
        if ( process.env.WANT_MONITORING ) {            
        	if ( processingTakingLonger ) {
            	this.metrics.delays[track] = processingTime - baseInterval;
        	} else {
            	this.metrics.delays[track] = 0;
        	}
        }           
        
        // Schedule the timer
        this.flushTimer[track] = setTimeout(() => {
            this.flushAudioBuffer(track);
        }, interval);
    }
    
    accumulateAudio(buffer, track) {
        // Cache frequently accessed values.
        const bufLen = buffer.length;
        let offset = this.audioAccumulatorOffset[track];
        const maxSize = this.MAX_BUFFER_SIZE;
        const accumulator = this.audioAccumulator[track];
        
        let growthMetric;        
        if ( process.env.WANT_MONITORING ) {            
        	growthMetric = this.metrics.bufferGrowth[track];
        }   
        
        // If the new data would exceed the maximum buffer size, flush immediately.
        if ((offset + bufLen) > maxSize) {
            log.warn(`${track} accumulator full, flushing before appending new data`);
            this.flushAudioBuffer(track);
            offset = this.audioAccumulatorOffset[track]; // Should be reset (usually 0) after flush.
        }
        
        // Copy the incoming data into the preallocated buffer.
        buffer.copy(accumulator, offset);
        offset += bufLen;
        this.audioAccumulatorOffset[track] = offset;
        
        if ( process.env.WANT_MONITORING ) {            
	        // Record buffer growth.
	        growthMetric.push(bufLen);
        }   
        
        // Adjust the flush threshold based on previous processing time.
        const pTime = this.lastProcessingTime[track];
        if (pTime > 0) {
            if (pTime < 10) {
                this.bufferSizeThreshold[track] = Math.max(1024, this.bufferSizeThreshold[track] - 128);
            } else if (pTime > 50) {
                this.bufferSizeThreshold[track] = Math.min(8 * 1024, this.bufferSizeThreshold[track] + 256);
            }
        }
        
        // Flush immediately if the current offset exceeds the dynamic threshold.
        if (offset >= this.bufferSizeThreshold[track]) {
            this.flushAudioBuffer(track);
            return;
        }
        
        // If no flush timer is active, start one.
        if (!this.flushTimer[track]) {
            this.startFlushTimer(track);
        }
    }
    
    flushAudioBuffer(track) {
        // Immediately stop any running flush timer.
        this.stopFlushTimer(track);
        
        const offset = this.audioAccumulatorOffset[track];
        if( 0 === offset ) {
        	this.startFlushTimer(track);
         	return;   
        }
        	
        // Cache frequently used variables locally.
        const accumulator = this.audioAccumulator[track];
        const combinedBuffer = accumulator.slice(0, offset);
        const bufferSize = combinedBuffer.length;
        const sttService = this.sttService[track];
        const now = performance.now();
        this.processingStartTime[track] = now;
        
		let deepgramMetrics, delta;
        if ( process.env.WANT_MONITORING ) {            
			deepgramMetrics = this.metrics.deepgram;
			delta = now - deepgramMetrics.lastSendTime[track];            
        }
                
        try {
            if (sttService && sttService.connected) {

                sttService.send(combinedBuffer);
                
        		if ( process.env.WANT_MONITORING ) {
                	deepgramMetrics.bytesSent[track] += bufferSize;
                	deepgramMetrics.packetsSent[track]++;
                	if (delta > 0) {
                    	deepgramMetrics.sendRates[track].push(bufferSize / (delta / 1000));
                	}
                	deepgramMetrics.lastSendTime[track] = now;
                 }                   
                
                // Reset error count on successful send.
                this.consecutiveErrors[track] = 0;
                
            } else {
                log.warn(`STT service not connected for ${track} track, buffered ${offset} bytes`);
                if (bufferSize > 64 * 1024) {
                    this.consecutiveErrors[track]++;
                }
            }
        } catch (err) {
            log.error(`Error sending ${track} audio to Deepgram`, err);
            this.consecutiveErrors[track]++;
        } finally {
            // Reset the accumulator offset.
            this.audioAccumulatorOffset[track] = 0;
            const procTime = performance.now() - this.processingStartTime[track];
            this.lastProcessingTime[track] = procTime;
            
	        if ( process.env.WANT_MONITORING ) {            
    	        this.metrics.processingTimes[track].push(procTime);
        	    this.metrics.deepgram.responseTimes[track].push(procTime);
             }   
        }
        
        // Circuit breaker: if error count is too high, reset the STT service.
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
        
        this.startFlushTimer(track);
    }
    
    // Message handling (uWebSockets.js Version)
    handleMessage(message, isBinary) {
        if (!this.active) return;

        let data;
        try {
             // uWS always gives ArrayBuffer.  Need to convert to string.
            const messageString = Buffer.from(message).toString('utf8');
            data = simdjson.lazyParse(messageString);

            let event = data.valueForKeyPath("event");

            switch (event) {
                case "media":
                  this.decodeBuffer
                    this.receivedPackets++;

                    let payload = data.valueForKeyPath("media.payload"); // Not optional
                    let track = data.valueForKeyPath("media.track"); // Not optional

                    if (track === "inbound" || track === "outbound") {
                        this.inboundPackets++;

                        // Decode base64 payload.
                        const bytesWritten = this.decodeBuffer.write( payload, 0, "base64" );
                        const audioBuffer = this.decodeBuffer.slice( 0, bytesWritten );
                        this.accumulateAudio(audioBuffer, track);
                    }
                    break;

                case "connected":
                    log.info("Twilio: Connected event received");
                    break;

                case "start":
                    this.callSid = getValueOrDefault(data, "start.callSid", null); // Optional
                    log.info(`Twilio: Call started, SID: ${this.callSid}`);
                    this.conferenceName = getValueOrDefault(data, "start.customParameters.conferenceName", ""); // Optional
                    log.info(`\tConference name: ${this.conferenceName}`);
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
        
        const history = this.transcriptHistory[ track ];
        history.push( transcript );
        
        let hit = history.findScamPhrases();
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
    
    _cleanup() {
        if (!this.active) return;
        
        if ( process.env.WANT_MONITORING ) {            
            // Log final Deepgram stats before cleanup
            if (this.metrics.deepgram.packetsSent.inbound > 0 || this.metrics.deepgram.packetsSent.outbound > 0) {
                log.info(`Final Deepgram stats for call ${this.callSid || 'unknown'}:`);
                this.logDeepgramStats();
            }
            
        	this.stopStatsTimer();            
        }
        
        this.active = false;
        this.hangupInitiated = false;
        this.isShuttingDown = true;
        
        this.stopFlushTimer('inbound');
        this.stopFlushTimer('outbound');
        
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
                // uWebSockets.js uses end() to close a connection
                // 1000 is the normal closure code
                // You can provide a reason string as the second parameter
                this.ws.end(1000, "Session cleanup");
            } catch (err) {
                log.error("Error closing WebSocket", err);
            }
            this.ws = null;
        }
        
        log.info(`Call session cleaned up, Call SID: ${this.callSid || "unknown"}, processed ${this.receivedPackets} packets`);
    }
}

// VoiceServer (uWebSockets.js Version)
class VoiceServer {
    constructor() {
        this.services = {
            config,
            twilioService: new TwilioService(config.twilio)
        };

        this.sessions = new Map();
        this.isShuttingDown = false;
        this.listenSocket = null; // Keep track of the listen socket for closing.

        this.app = uWS.App().ws('/*', {
            /* Options */
            compression: uWS.SHARED_COMPRESSOR,
            maxPayloadLength: 16 * 1024 * 1024,
            idleTimeout: 60,
            maxBackpressure: 1024,

            /* Handlers */
            open: (ws, req) => {
				const sessionId = randomUUID();

                ws.sessionId = sessionId; // Store sessionId on the ws object!
                log.info(`New WebSocket connection established from ${sessionId}`);

                const session = new CallSession(ws, this.services);
                this.sessions.set(sessionId, session);
            },
            message: (ws, message, isBinary) => {
                // Get the session using the stored sessionId.
                const session = this.sessions.get(ws.sessionId);
                if (session) {
                    session.handleMessage(message, isBinary); // Pass isBinary for consistency
                } else {
                    log.warn(`Received message for unknown session: ${ws.sessionId}`);
                }
            },
            drain: (ws) => {
                log.warn(`WebSocket backpressure: ${ws.sessionId}, bufferedAmount: ${ws.getBufferedAmount()}`);
                // You might want to add pause/resume logic in CallSession.
            },
            close: (ws, code, message) => {
                const session = this.sessions.get(ws.sessionId);
                if(session) {
                    session._cleanup();
                }
                this.sessions.delete(ws.sessionId);  // Ensure session is removed.
                log.info(`Session ${ws.sessionId} removed`);
            }
        }).any('/*', (res, req) => { // HTTP fallback
            const parsedUrl = new URL(req.getUrl(), `http://${req.getHeader('host')}`);
             if (parsedUrl.pathname === "/") {
                res.writeHeader("Content-Type", "text/plain");
                res.end("aiShield Monitor");
            } else {
                res.writeHeader("Content-Type", "text/plain");
                res.writeStatus('404 Not Found'); // Use writeStatus
                res.end("Not Found");
            }
        }).listen(config.server.port, (listenSocket) => {
            if (listenSocket) {
                this.listenSocket = listenSocket; // Store the listen socket.
                log.info(`Server listening on port ${config.server.port}`);
            } else {
                log.error(`Failed to start server on port ${config.server.port}`); // Better error handling
            }
        });
    }

    start() {
        // uWS handles listen in the constructor, so start is not strictly necessary.
        // However, it's good practice to keep it for consistency and potential future changes.
    }

    stop() {
        this.isShuttingDown = true;

        // Cleanup all sessions
        for (const session of this.sessions.values()) {
            session._cleanup();
        }
        this.sessions.clear();

        // Use us_listen_socket_close to gracefully close the server.
        if (this.listenSocket) {
            uWS.us_listen_socket_close(this.listenSocket);
            this.listenSocket = null; // Clear the listen socket
            log.info("uWebSocket.js server closed");
        }
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
    
    // Close all active WebSockets with an error code
    if (server && server.sessions) {
        for (const session of server.sessions.values()) {
            if (session.ws) {
                try {
                    session.ws.end(1011, "Server encountered a critical error");
                } catch (err) {
                    // Log but continue closing others
                }
            }
        }
    }
    
    if (server) server.stop();
    process.exit(1);
});

// Start the server
const server = new VoiceServer();
server.start();
