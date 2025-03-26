'use strict';
const uWS = require('uWebSockets.js');
const us_listen_socket_close = uWS.us_listen_socket_close;
const TranscriptHistory = require('./transcripthistory');
const { addParticipant, TwilioService } = require('./commands');
const DeepgramSTTService = require('./deepgramstt');
const { performance } = require('perf_hooks');
const simdjson = require('simdjson'); // Fast/lazy parsing
const { randomUUID } = require('crypto'); // Import randomUUID for session ids
const scamPhrases = require('./scamphrases');
const pino = require('pino');
const log = pino({
    extreme: true,
    base: null,
    level: false,
    // No formatters - more reliable when removing fields
    serializers: {
        time: (time) => time,
        msg: (msg) => msg
    }
});

require('dotenv').config();

const TRACK_INBOUND = 'inbound';
const TRACK_OUTBOUND = 'outbound';

// Configuration
const config = (() => {
    // Check required environment variables
    ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'DEEPGRAM_API_KEY'].forEach((varName) => {
        if (!process.env[varName]) throw new Error(`Missing required environment variable: ${varName}`);
    });

    return {
        server: {
            port: process.env.PORT || 8080,
        },
        twilio: {
            accountSid: process.env.TWILIO_ACCOUNT_SID,
            authToken: process.env.TWILIO_AUTH_TOKEN,
            studioFlowId: process.env.TWILIO_STUDIO_FLOW_ID || 'FWe2a7c39cffcbe604f2f158b68aae3b19',
        },
        deepgram: {
            apiKey: process.env.DEEPGRAM_API_KEY,
            ttsWebsocketURL:
                process.env.DEEPGRAM_TTS_WS_URL ||
                'wss://api.deepgram.com/v1/speak?encoding=mulaw&sample_rate=8000&container=none',
            sttConfig: {
                model: process.env.DEEPGRAM_MODEL || 'nova-3', // "nova-2-phonecall",
                language: process.env.DEEPGRAM_LANGUAGE || 'en-US',
                encoding: 'mulaw',
                sample_rate: 8000,
                channels: 1,
                no_delay: true,
                speech_final: true,
                interim_results: true,
                endpointing: parseInt(process.env.DEEPGRAM_ENDPOINTING) || 5,
                utterance_end_ms: parseInt(process.env.DEEPGRAM_UTTERANCE_END_MS) || 1000,
            },
            throttleInterval: parseInt(process.env.DEEPGRAM_THROTTLE_INTERVAL) || 20,
        },
    };
})();

// Helper function for simdjson lazyParse
function getValueOrDefault(parsedDoc, path, defaultValue) {
    try {
        return parsedDoc.valueForKeyPath(path);
    } catch {
        return defaultValue;
    }
}

function calculateAverage(array) {
    return array.length > 0 ? array.reduce((a, b) => a + b, 0) / array.length : 0;
}

function formatBytes(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1048576) return `${(bytes / 1024).toFixed(2)} KB`;
    return `${(bytes / 1048576).toFixed(2)} MB`;
}

class CallSession {
    constructor(services) {
        this.services = services;
        this.callSid = null;
        this.conferenceName = '';
        this.active = true;
        this.hangupInitiated = false;
        this.receivedPackets = 0;
        this.inboundPackets = 0;
        this.MAX_BUFFER_SIZE = 32 * 1024;

        // SEPARATE TRACK PROCESSING - Create separate buffers for each track
        this.audioAccumulator = {
            inbound: Buffer.alloc(this.MAX_BUFFER_SIZE),
            outbound: Buffer.alloc(this.MAX_BUFFER_SIZE),
        };

        this.audioAccumulatorOffset = {
            inbound: 0,
            outbound: 0,
        };

        this.audioAccumulatorSize = { inbound: 0, outbound: 0 };
        this.lastProcessingTime = { inbound: 0, outbound: 0 };
        this.processingStartTime = { inbound: 0, outbound: 0 };

        // ADAPTIVE BUFFER MANAGEMENT - Add parameters
        this.bufferSizeThreshold = { inbound: 2 * 1024, outbound: 2 * 1024 }; // 2 KB initially
        this.flushTimer = { inbound: null, outbound: null };
        this.flushInterval = {
            inbound: this.services.config.deepgram.throttleInterval,
            outbound: this.services.config.deepgram.throttleInterval,
        };

        // ERROR RESILIENCE - Add maximum sizes and circuit breaker
        this.consecutiveErrors = { inbound: 0, outbound: 0 };
        this.MAX_CONSECUTIVE_ERRORS = 15;

        if (process.env.WANT_MONITORING) {
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
                    responseTimes: { inbound: [], outbound: [] },
                },
            };
        }

        this.transcriptHistory = {
            inbound: new TranscriptHistory(scamPhrases),
            outbound: new TranscriptHistory(scamPhrases),
        };

        // Initialize STT services - one for each track
        this.sttService = {
            inbound: new DeepgramSTTService(
                this.services.config.deepgram,
                (transcript, isFinal) => this._handleTranscript(transcript, isFinal, TRACK_INBOUND),
                (utterance) => this._handleUtteranceEnd(utterance, TRACK_INBOUND)
            ),
            outbound: new DeepgramSTTService(
                this.services.config.deepgram,
                (transcript, isFinal) => this._handleTranscript(transcript, isFinal, TRACK_OUTBOUND),
                (utterance) => this._handleUtteranceEnd(utterance, TRACK_OUTBOUND)
            ),
        };

        if (process.env.WANT_MONITORING) {
            this.statsTimer = setInterval(() => {
                if (this.receivedPackets > 0) {
                    log.info(`Call stats: total=${this.receivedPackets}, inbound=${this.inboundPackets}`);

                    const now = performance.now();
                    const avgProcessingTimeInbound = calculateAverage(this.metrics.processingTimes.inbound);
                    const avgProcessingTimeOutbound = calculateAverage(this.metrics.processingTimes.outbound);

                    log.info(`Performance metrics: 
              Inbound: buffer=${
                  this.audioAccumulatorSize.inbound
              } bytes, avgProcessing=${avgProcessingTimeInbound.toFixed(
                        2
                    )}ms, delay=${this.metrics.delays.inbound.toFixed(2)}ms
              Outbound: buffer=${
                  this.audioAccumulatorSize.outbound
              } bytes, avgProcessing=${avgProcessingTimeOutbound.toFixed(
                        2
                    )}ms, delay=${this.metrics.delays.outbound.toFixed(2)}ms`);

                    this.logDeepgramStats();

                    // Reset metrics for next interval
                    this.metrics.processingTimes = { inbound: [], outbound: [] };
                    this.metrics.bufferGrowth = { inbound: [], outbound: [] };
                    this.metrics.lastMetricTime = now;
                }
            }, 30000);
        }
    }

    logDeepgramStats() {
        // Calculate average send rates
        const calcAvgRate = (rates) =>
            rates.length > 0 ? rates.reduce((sum, rate) => sum + rate, 0) / rates.length : 0;

        const inboundAvgRate = calcAvgRate(this.metrics.deepgram.sendRates.inbound);
        const outboundAvgRate = calcAvgRate(this.metrics.deepgram.sendRates.outbound);

        log.info(`Deepgram data transfer stats:
      Inbound: ${formatBytes(this.metrics.deepgram.bytesSent.inbound)} total (${
            this.metrics.deepgram.packetsSent.inbound
        } packets, avg ${inboundAvgRate.toFixed(2)} B/s)
      Outbound: ${formatBytes(this.metrics.deepgram.bytesSent.outbound)} total (${
            this.metrics.deepgram.packetsSent.outbound
        } packets, avg ${outboundAvgRate.toFixed(2)} B/s)
      Current rate (inbound): ${formatBytes(inboundAvgRate)} per second
      Current rate (outbound): ${formatBytes(outboundAvgRate)} per second`);

        // Reset rate tracking (but keep totals)
        this.metrics.deepgram.sendRates = { inbound: [], outbound: [] };
    }

    stopMemoryMonitor() {
        if (this.memoryMonitor) {
            clearInterval(this.memoryMonitor);
            this.memoryMonitor = null;
        }
    }

    stopStatsTimer() {
        if (this.statsTimer) {
            clearInterval(this.statsTimer);
            this.statsTimer = null;
        }
    }

    stopFlushTimer(track) {
        if (this.flushTimer[track]) {
            clearTimeout(this.flushTimer[track]);
            this.flushTimer[track] = null;
        }
    }

    startFlushTimer(track) {
        // Cancel the previous timer, if any
        this.stopFlushTimer(track);

        if (!this.active || this.isShuttingDown) {
            return;
        }

        // Adaptive interval based on processing time
        const baseInterval = this.flushInterval[track];
        const processingTime = this.lastProcessingTime[track];
        let interval = baseInterval;

        // If processing is taking longer, increase the interval
        const processingTakingLonger = processingTime > baseInterval;
        if (processingTakingLonger) {
            interval = Math.min(processingTime * 1.25, 100); // Cap at 100ms
        } else {
            interval = Math.max(baseInterval - 5, 10); // Try to catch up, but not too fast
        }

        if (process.env.WANT_MONITORING) {
            if (processingTakingLonger) {
                this.metrics.delays[track] = processingTime - baseInterval;
            } else {
                this.metrics.delays[track] = 0;
            }
        }

        this.flushTimer[track] = setTimeout(() => {
            this.flushAudioBuffer(track);
        }, interval);
    }

    accumulateAudio(buffer, track) {
        const bufLen = buffer.length;
        let offset = this.audioAccumulatorOffset[track];
        const maxSize = this.MAX_BUFFER_SIZE;
        const accumulator = this.audioAccumulator[track];

        let growthMetric;
        if (process.env.WANT_MONITORING) {
            growthMetric = this.metrics.bufferGrowth[track];
        }

        // If the new data would exceed the maximum buffer size, flush immediately.
        if (offset + bufLen > maxSize) {
            log.warn(`${track} accumulator full, flushing before appending new data`);
            this.flushAudioBuffer(track);
            offset = this.audioAccumulatorOffset[track]; // Should be reset (usually 0) after flush.
        }

        // Copy the incoming data into the preallocated buffer.
        buffer.copy(accumulator, offset);
        offset += bufLen;
        this.audioAccumulatorOffset[track] = offset;

        if (process.env.WANT_MONITORING) {
            growthMetric.push(bufLen);
        }

        // Adjust the flush threshold based on previous processing time.
        const pTime = this.lastProcessingTime[track];
        if (pTime > 0) {
            if (pTime < 10) {
                this.bufferSizeThreshold[track] = Math.max(512, this.bufferSizeThreshold[track] - 128);
            } else if (pTime > 50) {
                this.bufferSizeThreshold[track] = Math.min(6 * 1024, this.bufferSizeThreshold[track] + 256);
            }
        }

        // Flush immediately if the current offset exceeds the dynamic threshold.
        if (offset >= this.bufferSizeThreshold[track]) {
            this.flushAudioBuffer(track);
            return;
        }

        if (!this.flushTimer[track]) {
            this.startFlushTimer(track);
        }
    }

    flushAudioBuffer(track) {
        this.stopFlushTimer(track);

        const offset = this.audioAccumulatorOffset[track];
        if (0 === offset) {
            this.startFlushTimer(track);
            return;
        }

        const accumulator = this.audioAccumulator[track];
        const combinedBuffer = accumulator.slice(0, offset);
        const bufferSize = combinedBuffer.length;
        const sttService = this.sttService[track];
        const now = performance.now();
        this.processingStartTime[track] = now;

        let deepgramMetrics, delta;
        if (process.env.WANT_MONITORING) {
            deepgramMetrics = this.metrics.deepgram;
            delta = now - deepgramMetrics.lastSendTime[track];
        }

        try {
            if (sttService && sttService.connected) {
                sttService.send(combinedBuffer);

                if (process.env.WANT_MONITORING) {
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
                if (bufferSize > 32 * 1024) {
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

            if (process.env.WANT_MONITORING) {
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

    handleMessage(message, isBinary) {
        if (!this.active) return;

        let data;
        try {
            // uWS always gives ArrayBuffer.  Need to convert to string.
            // lazyParse = good speedup
            data = simdjson.lazyParse(Buffer.from(message).toString('utf8'));

            let event = data.valueForKeyPath('event');

            switch (event) {
                case 'media':
                    {
                        this.receivedPackets++;
                        let payload = data.valueForKeyPath('media.payload'); // Not optional
                        let track = data.valueForKeyPath('media.track'); // Not optional

                        if (track === TRACK_INBOUND || track === TRACK_OUTBOUND) {
                            this.inboundPackets++;
                            this.accumulateAudio(Buffer.from(payload, 'base64'), track);
                        }
                    }
                    break;

                case 'connected':
                    log.info('Twilio: Connected event received');
                    break;

                case 'start':
                    this.callSid = getValueOrDefault(data, 'start.callSid', null); // Optional
                    log.info(`Twilio: Call started, SID: ${this.callSid}`);
                    this.conferenceName = getValueOrDefault(data, 'start.customParameters.conferenceName', ''); // Optional
                    log.info(`\tConference name: ${this.conferenceName}`);
                    break;

                case 'close':
                    log.info('Twilio: Close event received');
                    this._cleanup();
                    break;
            }
        } catch (error) {
            log.error('Error processing message', error);
        }
    }

    _handleTranscript(transcript, isFinal, track) {
        if (!this.active || this.hangupInitiated) return;

        log.info(`[${track}][${isFinal ? 'Final' : 'Interim'}] ${transcript}`);

        const history = this.transcriptHistory[track];
        history.push(transcript);

        let hit = history.findScamPhrases();
        if (hit !== null) {
            log.info('Scam phrase: ' + JSON.stringify(hit, null, 2));
            this._handleHangup('Scam phrase detected. Goodbye.');
        }
    }

    _handleUtteranceEnd(utterance, track) {
        if (this.active) log.info(`[${track}] Complete utterance: ${utterance}`);
    }

    async _handleHangup(customPhrase) {
        if (!this.active || !this.callSid || this.hangupInitiated) return;

        try {
            this.hangupInitiated = true;
            log.info(
                `Initiating hangup for call ${this.callSid}${customPhrase ? ` with message: "${customPhrase}"` : ''}`
            );

            await this.services.twilioService.sayPhraseAndHangup(this.callSid, customPhrase);
        } catch (error) {
            log.error('Failed to hang up call', error);
        }
    }

    _clearAllTimers() {
        this.stopMemoryMonitor();
        this.stopStatsTimer();
        this.stopFlushTimer(TRACK_INBOUND);
        this.stopFlushTimer(TRACK_OUTBOUND);
    }

    _cleanup() {
        if (!this.active) return;

        if (process.env.WANT_MONITORING) {
            // Log final Deepgram stats before cleanup
            if (this.metrics.deepgram.packetsSent.inbound > 0 || this.metrics.deepgram.packetsSent.outbound > 0) {
                log.info(`Final Deepgram stats for call ${this.callSid || 'unknown'}:`);
                this.logDeepgramStats();
            }
        }

        this.active = false;
        this.hangupInitiated = false;
        this.isShuttingDown = true;

        this._clearAllTimers();

        if (this.sttService && this.sttService.inbound) {
            this.sttService.inbound.cleanup();
            this.sttService.inbound = null;
        }

        if (this.sttService && this.sttService.outbound) {
            this.sttService.outbound.cleanup();
            this.sttService.outbound = null;
        }

        log.info(
            `Call session cleaned up, Call SID: ${this.callSid || 'unknown'}, processed ${this.receivedPackets} packets`
        );
    }
}

// VoiceServer (uWebSockets.js Version)
class VoiceServer {
    constructor() {
        this.services = {
            config,
            twilioService: new TwilioService(config.twilio),
        };

        this.sessions = new Map();
        this.isShuttingDown = false;
        this.listenSocket = null; // Keep track of the listen socket for closing.

        if (process.env.WANT_MONITORING) {
            this.memoryMonitor = setInterval(() => {
                const memoryUsage = process.memoryUsage();

                log.info(`Memory Usage:
                    RSS: ${formatBytes(memoryUsage.rss)}
                    Heap Total: ${formatBytes(memoryUsage.heapTotal)}
                    Heap Used: ${formatBytes(memoryUsage.heapUsed)}
                    External: ${formatBytes(memoryUsage.external)}
                    Sessions: ${this.sessions?.size}`);

                // Alert on potential memory leaks
                if (memoryUsage.heapUsed > 1.5 * 1024 * 1024 * 1024) {
                    // 1.5GB
                    log.warn('Potential memory leak detected: Heap usage exceeding threshold');
                }
            }, 60000);
        }

        this.app = uWS
            .App()
            .ws('/*', {
                /* Options */
                compression: uWS.DISABLED,
                maxPayloadLength: 32 * 1024,
                idleTimeout: 300,
                maxBackpressure: 1 * 1024 * 1024,

                /* Handlers */
                open: (ws, req) => {
                    const sessionId = randomUUID();

                    ws.sessionId = sessionId; // Store sessionId on the ws object!
                    log.info(`New WebSocket connection established from ${sessionId}`);

                    const session = new CallSession(this.services);
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
                },
                close: (ws, code, message) => {
                    const session = this.sessions.get(ws.sessionId);
                    if (session) {
                        session._cleanup();
                    }
                    this.sessions.delete(ws.sessionId); // Ensure session is removed.
                    log.info(`Session ${ws.sessionId} removed`);
                },
            })
            .any('/*', (res, req) => {
                // HTTP fallback
                const parsedUrl = new URL(req.getUrl(), `http://${req.getHeader('host')}`);
                if (parsedUrl.pathname === '/') {
                    res.writeHeader('Content-Type', 'text/plain');
                    res.end('aiShield Monitor');
                } else {
                    res.writeHeader('Content-Type', 'text/plain');
                    res.writeStatus('404 Not Found'); // Use writeStatus
                    res.end('Not Found');
                }
            })
            .listen('0.0.0.0', config.server.port, (listenSocket) => {
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
            log.info('uWebSocket.js server closed');
        }
    }
}

// Process termination handling
const gracefulShutdown = (signal) => {
    log.info(`Received ${signal} signal, shutting down gracefully`);
    if (server) server.stop();
    setTimeout(() => process.exit(0), 5000);
};

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('uncaughtException', (error) => {
    log.error('Uncaught exception', error);
    if (server) server.stop();
    process.exit(1);
});

// Start the server
const server = new VoiceServer();
server.start();
