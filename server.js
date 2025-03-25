// Import required modules
const http = require("http");
const https = require("https");
const WebSocket = require("ws");
const TranscriptHistory = require("./transcripthistory");  // Keep the original implementation
const { addParticipant, TwilioService } = require('./commands');
const DeepgramSTTService = require('./deepgramstt');
const { performance } = require('perf_hooks');
const simdjson = require('simdjson');

require("dotenv").config();

const NODE_ENV = process.env.NODE_ENV || 'development';
const IS_PRODUCTION = NODE_ENV === 'production';

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
                model: process.env.DEEPGRAM_MODEL || "nova-3", 
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
            },
            // Enhanced performance metrics
            heap: {
                lastUsed: process.memoryUsage().heapUsed,
                measurements: []
            },
            callDuration: 0,
            lastActivityTime: performance.now(),
            throughput: {
                inbound: { bytes: 0, lastTimestamp: performance.now() },
                outbound: { bytes: 0, lastTimestamp: performance.now() }
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
        
        // Using the original TranscriptHistory implementation
        this.transcriptHistory = {
            inbound: new TranscriptHistory(scamPhrases_1),
            outbound: new TranscriptHistory(scamPhrases_1)
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
        
        // Track memory usage periodically
        this.memoryMonitorInterval = setInterval(() => {
            if (this.active) {
                const heap = process.memoryUsage().heapUsed;
                const delta = heap - this.metrics.heap.lastUsed;
                
                if (this.metrics.heap.measurements.length >= 10) {
                    this.metrics.heap.measurements.shift();
                }
                
                this.metrics.heap.measurements.push({
                    time: performance.now(),
                    heap,
                    delta
                });
                
                this.metrics.heap.lastUsed = heap;
                
                // Check for concerning memory growth
                const totalGrowth = this.metrics.heap.measurements.reduce((sum, m) => sum + m.delta, 0);
                if (totalGrowth > 50 * 1024 * 1024) { // 50MB growth is concerning
                    log.warn(`High memory growth detected: ${(totalGrowth / 1024 / 1024).toFixed(2)}MB growth`);
                    
                    // Suggest garbage collection if available
                    if (global.gc) {
                        try {
                            global.gc();
                            log.info("Manual garbage collection triggered");
                        } catch (e) {
                            // Ignore if not available
                        }
                    }
                }
            }
        }, 30000); // Every 30 seconds
        
        // Add a flag to track last activity time
        this.lastActivity = Date.now();
        
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
    
    // Method to track throughput
    trackThroughput(bytes, direction) {
        const now = performance.now();
        const throughput = this.metrics.throughput[direction];
        
        throughput.bytes += bytes;
        
        const elapsed = now - throughput.lastTimestamp;
        if (elapsed > 5000) { // Update every 5 seconds
            const bytesPerSecond = throughput.bytes / (elapsed / 1000);
            throughput.rate = bytesPerSecond;
            throughput.bytes = 0;
            throughput.lastTimestamp = now;
            
            // Only log if there's significant throughput
            if (bytesPerSecond > 10000) { // 10KB/s
                log.debug(`${direction} throughput: ${(bytesPerSecond / 1024).toFixed(2)} KB/s`);
            }
        }
        
        // Update last activity time
        this.lastActivity = Date.now();
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
    
    // Optimized accumulateAudio method
    accumulateAudio(buffer, track) {
        // Early return if shutting down
        if (this.isShuttingDown) return;
        
        // Direct variable access instead of property lookups in hot path
        const bufLen = buffer.length;
        const offset = this.audioAccumulatorOffset[track];
        const accumulator = this.audioAccumulator[track];
        const threshold = this.bufferSizeThreshold[track];
        const maxSize = this.MAX_BUFFER_SIZE;
        
        // Check if buffer needs flushing before adding new data
        if (offset + bufLen > maxSize) {
            this.flushAudioBuffer(track);
            // After flush, offset should be 0
            buffer.copy(accumulator, 0);
            this.audioAccumulatorOffset[track] = bufLen;
            
            // Record buffer growth with less overhead
            if (this.metrics.bufferGrowth[track].length < 100) { // Limit array size
                this.metrics.bufferGrowth[track].push(bufLen);
            }
            
            // Start timer if needed
            if (!this.flushTimer[track] && !this.isShuttingDown) {
                this.startFlushTimer(track);
            }
            return;
        }
        
        // Fast path: copy buffer and update offset
        buffer.copy(accumulator, offset);
        this.audioAccumulatorOffset[track] = offset + bufLen;
        
        // Record buffer growth with less overhead
        if (this.metrics.bufferGrowth[track].length < 100) { // Limit array size
            this.metrics.bufferGrowth[track].push(bufLen);
        }
        
        // Track throughput
        this.trackThroughput(bufLen, track);
        
        // Dynamic threshold adjustment
        const pTime = this.lastProcessingTime[track];
        if (pTime > 0) {
            if (pTime < 10) {
                // Processing is fast, decrease threshold
                this.bufferSizeThreshold[track] = Math.max(1024, threshold - 128);
            } else if (pTime > 50) {
                // Processing is slow, increase threshold
                this.bufferSizeThreshold[track] = Math.min(8 * 1024, threshold + 256);
            }
        }
        
        // Flush if threshold reached
        if (offset + bufLen >= threshold) {
            this.flushAudioBuffer(track);
            return;
        }
        
        // Start timer if needed
        if (!this.flushTimer[track] && !this.isShuttingDown) {
            this.startFlushTimer(track);
        }
    }
    
    // Optimized flushAudioBuffer method
    flushAudioBuffer(track) {
        // Immediately stop any running flush timer
        this.stopFlushTimer(track);
        
        const offset = this.audioAccumulatorOffset[track];
        if (offset <= 0) {
            // No data to flush, just restart timer if needed
            if (this.active && !this.isShuttingDown) {
                this.startFlushTimer(track);
            }
            return;
        }
        
        // Cache frequently used variables locally
        const accumulator = this.audioAccumulator[track];
        const sttService = this.sttService[track];
        const now = performance.now();
        this.processingStartTime[track] = now;
        
        try {
            if (sttService && sttService.connected) {
                // Create a slice view instead of copying the buffer
                const view = accumulator.subarray(0, offset);
                
                // Send the buffered data
                sttService.send(view);
                
                // Update metrics
                const deepgramMetrics = this.metrics.deepgram;
                deepgramMetrics.bytesSent[track] += offset;
                deepgramMetrics.packetsSent[track]++;
                
                const delta = now - deepgramMetrics.lastSendTime[track];
                if (delta > 0) {
                    // Keep rate history limited to prevent array growth
                    const rates = deepgramMetrics.sendRates[track];
                    if (rates.length >= 100) rates.shift();
                    rates.push(offset / (delta / 1000));
                }
                deepgramMetrics.lastSendTime[track] = now;
                
                // Reset error count on successful send
                this.consecutiveErrors[track] = 0;
            } else {
                // Service not connected
                if (offset > 64 * 1024) {
                    this.consecutiveErrors[track]++;
                }
            }
        } catch (err) {
            this.consecutiveErrors[track]++;
            
            // Only log errors occasionally to reduce overhead
            if (this.consecutiveErrors[track] % 5 === 1) {
                log.error(`Error sending ${track} audio to Deepgram`, err);
            }
        } finally {
            // Reset the accumulator offset
            this.audioAccumulatorOffset[track] = 0;
            
            // Update timing metrics with limits to prevent array growth
            const procTime = performance.now() - this.processingStartTime[track];
            this.lastProcessingTime[track] = procTime;
            
            const processingTimes = this.metrics.processingTimes[track];
            if (processingTimes.length >= 100) processingTimes.shift();
            processingTimes.push(procTime);
            
            const responseTimes = this.metrics.deepgram.responseTimes[track];
            if (responseTimes.length >= 100) responseTimes.shift();
            responseTimes.push(procTime);
        }
        
        // Circuit breaker: if error count is too high, reset the STT service
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
        
        // Restart the flush timer if the session is still active
        if (this.active && !this.isShuttingDown) {
            this.startFlushTimer(track);
        }
    }
    
    // Optimized message handling
    _handleMessage(message) {
        if (!this.active) return;
        
        try {
            // Fast path for Buffer messages (most common case)
            let jsonStr;
            if (Buffer.isBuffer(message)) {
                // Skip toString for media events (use simdjson directly)
                const firstByte = message[0];
                
                // Quick check if this looks like a JSON object with media event
                // '{' character is 123 in ASCII
                if (firstByte === 123) {
                    // Fast path: check for media event
                    if (message.length > 10 && 
                        message[2] === 101 && // 'e'
                        message[3] === 118 && // 'v'
                        message[4] === 101 && // 'e'
                        message[5] === 110 && // 'n'
                        message[6] === 116 && // 't'
                        message[8] === 109 && // 'm'
                        message[9] === 101 && // 'e'
                        message[10] === 100   // 'd'
                    ) {
                        // This is likely a media event, process directly
                        const data = simdjson.parse(message);
                        if (data.event === "media") {
                            this.receivedPackets++;
                            
                            // Media setup on first packet
                            if (!this.hasSeenMedia) {
                                this.hasSeenMedia = true;
                            }
                            
                            // Set stream SID if needed
                            if (!this.streamSid && data.streamSid) {
                                this.streamSid = data.streamSid;
                            }
                            
                            // Process media payload - fast path
                            const { media } = data;
                            if (media && media.payload) {
                                const { payload, track } = media;
                                if (track === "inbound" || track === "outbound") {
                                    this.inboundPackets++;
                                    // Use Buffer.from with encoding for better performance
                                    this.accumulateAudio(Buffer.from(payload, "base64"), track);
                                }
                            }
                            return; // Early return after processing media
                        }
                    }
                }
                
                // Slower path for non-media JSON messages
                jsonStr = message.toString('utf8');
            } else if (typeof message === 'string') {
                jsonStr = message;
            } else {
                return; // Not a valid message format
            }
            
            // Parse JSON for non-media events
            const data = simdjson.parse(jsonStr);
            
            // Handle by event type
            switch (data.event) {
                case "connected":
                    // No need to log every connected event
                    break;
                    
                case "start":
                    this.callSid = data.start?.callSid || data.callSid;
                    this.conferenceName = data.start?.customParameters?.conferenceName;
                    if (this.callSid) {
                        log.info(`Twilio: Call started, SID: ${this.callSid}${this.conferenceName ? 
                               `, Conference: ${this.conferenceName}` : ''}`);
                    }
                    break;
                    
                case "close":
                    this._cleanup();
                    break;
                    
                default:
                    // Ignore other events
                    break;
            }
        } catch (error) {
            // Only log genuine errors, not expected parsing issues
            if (!(error.message && error.message.includes("Unexpected token"))) {
                log.error("Error processing message", error);
            }
        }
    }
    
    // Transcript handling - process both interim and final results
    _handleTranscript(transcript, isFinal, track) {
        if (!this.active || this.hangupInitiated) return;
        
        // Log all transcripts, including interim ones
        log.info(`[${track}][${isFinal ? 'Final' : 'Interim'}] ${transcript}`);
        
        // Push all transcripts to history (interim and final)
        this.transcriptHistory[track].push(transcript);
        
        // Check for scam phrases in all transcripts
        let hit = this.transcriptHistory[track].findScamPhrases();
        if (hit !== null) {    
            log.info("Scam phrase: " + JSON.stringify(hit, null, 2));
            this._handleHangup("Scam phrase detected. Goodbye.");
        }
        
        // Update last activity time
        this.lastActivity = Date.now();
    }
    
    _handleUtteranceEnd(utterance, track) {
        if (this.active) {
            log.info(`[${track}] Complete utterance: ${utterance}`);
            this.lastActivity = Date.now();
        }
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
        
        // Clear memory monitor interval
        if (this.memoryMonitorInterval) {
            clearInterval(this.memoryMonitorInterval);
            this.memoryMonitorInterval = null;
        }
        
        // Log final memory metrics
        const currentHeap = process.memoryUsage().heapUsed;
        const initialHeap = this.metrics.heap.lastUsed - this.metrics.heap.measurements.reduce((sum, m) => sum + m.delta, 0);
        const growth = currentHeap - initialHeap;
        
        log.info(`Memory metrics for call ${this.callSid || 'unknown'}:
            Initial heap: ${(initialHeap / 1024 / 1024).toFixed(2)}MB
            Final heap: ${(currentHeap / 1024 / 1024).toFixed(2)}MB
            Growth: ${(growth / 1024 / 1024).toFixed(2)}MB
        `);
        
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

// VoiceServer with optimizations
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
        
        // Optimize event listeners - use noServer mode for better performance
        this.wsServer = new WebSocket.Server({ 
            noServer: true,
            perMessageDeflate: {
                zlibDeflateOptions: {
                    // Optimize for speed vs compression ratio
                    level: 1,
                    memLevel: 7
                }
            }
        });
        
        // Optimize HTTP server with proper headers
        this.httpServer.on('upgrade', (request, socket, head) => {
            // Validate the WebSocket upgrade request here if needed
            this.wsServer.handleUpgrade(request, socket, head, (ws) => {
                this.wsServer.emit('connection', ws, request);
            });
        });
        
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
        
        // Session cleanup interval to handle orphaned sessions
        this.cleanupInterval = setInterval(() => {
            const now = Date.now();
            this.sessions.forEach((session, id) => {
                if (!session.active || (now - session.lastActivity > 300000)) { // 5 minutes
                    session._cleanup();
                    this.sessions.delete(id);
                    log.info(`Cleaned up inactive session ${id}`);
                }
            });
        }, 60000); // Check every minute
        
        // Optimize Node.js runtime
        this._optimizeRuntime();
    }
    
    _optimizeRuntime() {
        // Increase max listeners to prevent memory leaks warnings
        this.httpServer.setMaxListeners(100);
        this.wsServer.setMaxListeners(100);
        
        // Set TCP keep-alive for persistent connections
        this.httpServer.keepAliveTimeout = 65000; // slightly higher than default ALB idle timeout
        this.httpServer.headersTimeout = 66000; // slightly higher than keepAliveTimeout
        
        if (IS_PRODUCTION) {
            // Disable debugging in production for better performance
            Error.stackTraceLimit = 10; // Reduce stack trace size
            
            // Enable GC optimization hints if supported
            if (global.gc) {
                // Schedule periodic GC to prevent spikes
                setInterval(() => {
                    try {
                        global.gc();
                    } catch (e) {
                        // Ignore if not available
                    }
                }, 30000); // Every 30 seconds
            }
        }
    }
    
    start() {
        this.httpServer.listen(config.server.port, () => {
            log.info(`Server listening on port ${config.server.port}`);
        });
    }
    
    stop() {
        this.isShuttingDown = true;
        
        // Clear the cleanup interval
        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval);
            this.cleanupInterval = null;
        }
        
        // Create an array of promises for each session cleanup
        const cleanupPromises = [];
        for (const session of this.sessions.values()) {
            cleanupPromises.push(new Promise(resolve => {
                session._cleanup();
                resolve();
            }));
        }
        
        // Clear sessions after cleanup
        Promise.all(cleanupPromises).then(() => {
            this.sessions.clear();
            log.info("All sessions cleaned up");
        });
        
        // Close servers with improved timeout handling
        const wsClosePromise = new Promise(resolve => {
            this.wsServer.close(() => {
                log.info("WebSocket server closed");
                resolve();
            });
        });
        
        const httpClosePromise = new Promise(resolve => {
            this.httpServer.close(() => {
                log.info("HTTP server closed");
                resolve();
            });
        });
        
        // Force close after timeout
        const forceClosePromise = new Promise(resolve => {
            setTimeout(() => {
                log.warn("Server shutdown timed out, forcing exit");
                resolve();
            }, 5000);
        });
        
        // Race between normal close and forced close
        return Promise.race([
            Promise.all([wsClosePromise, httpClosePromise]),
            forceClosePromise
        ]);
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
