'use strict';
const uWS = require('uWebSockets.js');
const TranscriptHistory = require('./transcripthistory');
const { handlePhrase, playAudio, callConnect } = require('./commands');
const DeepgramSTTService = require('./deepgramstt');
const { performance } = require('perf_hooks');
const simdjson = require('simdjson'); // Fast/lazy parsing
const { randomUUID } = require('crypto'); // Import randomUUID for session ids
const { scamPhrasesOPY, scamPhrasesSUB, scamPhrasesGDN } = require('./scamphrases');
const { FastBuffer } = require('./fastbuffer');
const { formatBytes, calculateAverage } = require('./utils');
const pino = require('pino');
const log = pino({ base: null });
const { PORT, WANT_MONITORING } = require('./config');
const { TextDecoder } = require('util');
const sidDatabase = require('./database');

require('dotenv').config();

const TRACK_INBOUND = 'inbound';
const TRACK_OUTBOUND = 'outbound';
const INITIAL_THROTTLE_INTERVAL = 20;

const ChallengeStatus = Object.freeze({
    NONE: 0,
    PLAYINGAUDIO: 1,
    TIMEDRESPONSE: 2,
    FAILED: 3,
});

function inInitialChallengeStatus(status) {
    return status === ChallengeStatus.PLAYINGAUDIO || status === ChallengeStatus.TIMEDRESPONSE;
}

const CHALLENGE_TIMEOUT = 10 * 1000;

// Helper function for simdjson lazyParse
function getValueOrDefault(parsedDoc, path, defaultValue) {
    try {
        return parsedDoc.valueForKeyPath(path);
    } catch {
        return defaultValue;
    }
}

/**
 * Check whether a given name appears in a sentence.
 * Supports matching "First" or "First Last", case-insensitive.
 *
 * @param {string} sentence – the text to search
 * @param {string} firstName – the first name to find
 * @param {string} [lastName] – optional last name for full-name match
 * @returns {boolean}
 */
function findNameInSentence(sentence, firstName, lastName) {
    // Validate inputs
    if (typeof sentence !== 'string' || !sentence.trim()) return false;
    if (typeof firstName !== 'string' || !firstName.trim()) return false;
    if (lastName != null && (typeof lastName !== 'string' || !lastName.trim())) return false;

    // Pre-trimmed values
    const fn = firstName.trim();
    const ln = lastName?.trim();

    // Escape helper lifted outside if reused elsewhere
    const escapeRegExp = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    // Build pattern: use Unicode-aware word boundaries (\p{L}) if your engine supports it
    const namePattern = ln
        ? `(?<!\\p{L})${escapeRegExp(fn)}[ ]+${escapeRegExp(ln)}(?!\\p{L})`
        : `(?<!\\p{L})${escapeRegExp(fn)}(?!\\p{L})`;

    let regex;
    try {
        // Add 'u' flag for Unicode if available in your target environment
        regex = new RegExp(namePattern, 'iu');
    } catch {
        return false;
    }

    return regex.test(sentence);
}

function passedChallenge(sentence) {
    return findNameInSentence(sentence, 'kevin');
}

class CallSession {
    constructor(sessionId) {
        this.sessionId = sessionId;
        this.callSid = null;
        this.conferenceUUID = '';
        this.active = true;
        this.receivedPackets = 0;
        this.inboundPackets = 0;
        this.decoder = new TextDecoder('utf-8');
        this.processingCommand = false;
        this.lastCommandTime = null;

        this.audioBuffer = {
            inbound: new FastBuffer(2 * 1024),
            outbound: new FastBuffer(2 * 1024),
        };

        this.processingStartTime = { inbound: 0, outbound: 0 };
        this.lastProcessingTime = { inbound: 0, outbound: 0 };

        // ADAPTIVE BUFFER MANAGEMENT
        this.bufferSizeThreshold = { inbound: 512, outbound: 512 };
        this.flushTimer = { inbound: null, outbound: null };
        this.flushInterval = {
            inbound: INITIAL_THROTTLE_INTERVAL,
            outbound: INITIAL_THROTTLE_INTERVAL,
        };

        // ERROR RESILIENCE - Add maximum sizes and circuit breaker
        this.consecutiveErrors = { inbound: 0, outbound: 0 };
        this.MAX_CONSECUTIVE_ERRORS = 15;

        this.transcriptHistory = {
            inbound: null,
            outbound: null,
        };

        // Initialize STT services - one for each track
        this.sttService = {
            inbound: new DeepgramSTTService(
                (transcript, isFinal) => this.#handleTranscript(transcript, isFinal, TRACK_INBOUND),
                (utterance) => this.#handleUtteranceEnd(utterance, TRACK_INBOUND)
            ),
            outbound: new DeepgramSTTService(
                (transcript, isFinal) => this.#handleTranscript(transcript, isFinal, TRACK_OUTBOUND),
                (utterance) => this.#handleUtteranceEnd(utterance, TRACK_OUTBOUND)
            ),
        };

        if (WANT_MONITORING) {
            this.audioAccumulatorSize = { inbound: 0, outbound: 0 };
            this.metrics = {
                processingTimes: { inbound: [], outbound: [] },
                bufferGrowth: { inbound: [], outbound: [] },
                lastMetricTime: performance.now(),
                delays: { inbound: 0, outbound: 0 },
                deepgram: {
                    bytesSent: { inbound: 0, outbound: 0 },
                    packetsSent: { inbound: 0, outbound: 0 },
                    sendRates: { inbound: [], outbound: [] },
                    lastSendTime: { inbound: performance.now(), outbound: performance.now() },
                    responseTimes: { inbound: [], outbound: [] },
                },
            };

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

                    this.#logDeepgramStats();

                    // Reset metrics for next interval
                    this.metrics.processingTimes = { inbound: [], outbound: [] };
                    this.metrics.bufferGrowth = { inbound: [], outbound: [] };
                    this.metrics.lastMetricTime = now;
                }
            }, 30000);
        }
    }

    #logDeepgramStats() {
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

    #startChallengeTimer(lengthInMs) {
        this.#stopChallengeTimer();
        this.challengeStatus = ChallengeStatus.TIMEDRESPONSE;
        this.challengeTimer = setTimeout(() => {
            this.#challengeTimedOut();
        }, lengthInMs);
    }

    #stopChallengeTimer() {
        if (this.challengeTimer) {
            clearTimeout(this.challengeTimer);
            this.challengeTimer = null;
        }
    }

    #stopMemoryMonitor() {
        if (this.memoryMonitor) {
            clearInterval(this.memoryMonitor);
            this.memoryMonitor = null;
        }
    }

    #stopStatsTimer() {
        if (this.statsTimer) {
            clearInterval(this.statsTimer);
            this.statsTimer = null;
        }
    }

    #stopFlushTimer(track) {
        if (this.flushTimer[track]) {
            clearTimeout(this.flushTimer[track]);
            this.flushTimer[track] = null;
        }
    }

    #startFlushTimer(track) {
        // Cancel the previous timer, if any
        this.#stopFlushTimer(track);

        if (!this.active || this.isShuttingDown) {
            return;
        }

        // Adaptive interval based on processing time
        const baseInterval = this.flushInterval[track];
        const processingTime = this.lastProcessingTime[track];
        let interval = baseInterval;

        // Track historical performance for more stable adjustments
        if (!this.processingTimeHistory) {
            this.processingTimeHistory = { inbound: [], outbound: [] };
            this.processingTimeHistoryMaxLength = 5; // Keep track of last 5 processing times
        }

        // Add current processing time to history
        if (processingTime > 0) {
            this.processingTimeHistory[track].push(processingTime);
            // Keep history at desired length
            if (this.processingTimeHistory[track].length > this.processingTimeHistoryMaxLength) {
                this.processingTimeHistory[track].shift();
            }
        }

        // Calculate average processing time from history for more stable adjustments
        const avgProcessingTime =
            this.processingTimeHistory[track].length > 0
                ? this.processingTimeHistory[track].reduce((sum, time) => sum + time, 0) /
                  this.processingTimeHistory[track].length
                : processingTime;

        // If processing is taking longer, increase the interval proportionally
        if (avgProcessingTime > baseInterval) {
            // The adjustment factor (1.25) provides some headroom
            // The cap (60ms) prevents excessive delays
            interval = Math.min(avgProcessingTime * 1.25, 60);
        } else if (avgProcessingTime > 0) {
            // If processing is faster, decrease interval proportionally to the speed difference
            // This creates a more adaptive response instead of a fixed reduction
            const speedRatio = avgProcessingTime / baseInterval;
            const reductionFactor = 1 - speedRatio; // How much faster we're processing

            // Apply a proportional reduction, more reduction for faster processing
            // but with diminishing returns to prevent oscillation
            const reduction = baseInterval * reductionFactor * 0.5; // 0.5 dampening factor
            interval = Math.max(baseInterval - reduction, 10); // Minimum 10ms
        }

        if (WANT_MONITORING) {
            if (avgProcessingTime > baseInterval) {
                this.metrics.delays[track] = avgProcessingTime - baseInterval;
            } else {
                this.metrics.delays[track] = 0;
            }
        }

        this.flushTimer[track] = setTimeout(() => {
            this.#flushAudioBuffer(track);
        }, interval);
    }

    #accumulateAudio(buffer, track) {
        let growthMetric;
        if (WANT_MONITORING) {
            growthMetric = this.metrics.bufferGrowth[track];
            growthMetric.push(buffer.length);
            this.audioAccumulatorSize[track] += buffer.length;
        }

        let audioBuffer = this.audioBuffer[track];
        audioBuffer.append(buffer);

        // Adjust the flush size threshold based on previous processing time.
        const pTime = this.lastProcessingTime[track];
        if (pTime > 0) {
            if (pTime < 10) {
                this.bufferSizeThreshold[track] = Math.max(128, this.bufferSizeThreshold[track] - 32);
            } else if (pTime > 50) {
                this.bufferSizeThreshold[track] = Math.min(768, this.bufferSizeThreshold[track] + 64);
            }
        }

        if (audioBuffer.length() >= this.bufferSizeThreshold[track]) {
            this.#flushAudioBuffer(track);
            return;
        }

        if (!this.flushTimer[track]) {
            this.#startFlushTimer(track);
        }
    }

    #flushAudioBuffer(track) {
        this.#stopFlushTimer(track);

        let audioBuffer = this.audioBuffer[track];
        if (0 === audioBuffer.length()) {
            this.#startFlushTimer(track);
            return;
        }

        const audioBufferCombined = audioBuffer.getBuffer();
        const bufferSize = audioBufferCombined.length;
        const sttService = this.sttService[track];
        const now = performance.now();
        this.processingStartTime[track] = now;

        let deepgramMetrics, delta;
        if (WANT_MONITORING) {
            deepgramMetrics = this.metrics.deepgram;
            delta = now - deepgramMetrics.lastSendTime[track];
        }

        try {
            if (sttService?.connected) {
                sttService.send(audioBufferCombined);

                if (WANT_MONITORING) {
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
                log.warn(`STT service not connected for ${track} track, buffered ${bufferSize} bytes`);
                if (bufferSize > 32 * 1024) {
                    this.consecutiveErrors[track]++;
                }
            }
        } catch (err) {
            log.error(`Error sending ${track} audio to Deepgram`, err);
            this.consecutiveErrors[track]++;
        } finally {
            audioBuffer.reset();

            const procTime = performance.now() - this.processingStartTime[track];
            this.lastProcessingTime[track] = procTime;

            if (WANT_MONITORING) {
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
                    (transcript, isFinal) => this.#handleTranscript(transcript, isFinal, track),
                    (utterance) => this.#handleUtteranceEnd(utterance, track)
                );
            }
            this.consecutiveErrors[track] = 0;
        }

        this.#startFlushTimer(track);
    }

    // Ok, this is just handling the audioFinished event for now. TODO: make the event body JSON
    // eslint-disable-next-line no-unused-vars
    handlePUTEvent(event, audioId) {
        if (this.challengeStatus === ChallengeStatus.PLAYINGAUDIO) {
            this.#startChallengeTimer(CHALLENGE_TIMEOUT);
        }
    }

    // eslint-disable-next-line no-unused-vars
    handleMessage(message, isBinary) {
        // PUBLIC METHOD
        if (!this.active) return;

        let data;
        try {
            // uWS always gives ArrayBuffer.  Need to convert to string.
            // lazyParse = good speedup
            data = simdjson.lazyParse(this.decoder.decode(message));

            let event = data.valueForKeyPath('event');

            // Optimization. 'media' is by far the most common event. Check first.
            if (event === 'media') {
                this.receivedPackets++;
                let payload = data.valueForKeyPath('media.payload'); // Not optional
                let track = data.valueForKeyPath('media.track'); // Not optional

                // Create transcript history on the fly
                if (!this.transcriptHistory[track]) {
                    this.transcriptHistory[track] = new TranscriptHistory(
                        this.actor === 'SUB' ? scamPhrasesSUB : this.actor === 'GDN' ? scamPhrasesGDN : scamPhrasesOPY
                    );
                }

                if (track === TRACK_INBOUND || track === TRACK_OUTBOUND) {
                    this.inboundPackets++;
                    this.#accumulateAudio(Buffer.from(payload, 'base64'), track);
                }
                return;
            }

            switch (event) {
                case 'connected':
                    log.info('Twilio: Connected event received');
                    break;

                case 'start':
                    this.callSid = getValueOrDefault(data, 'start.callSid', null); // Optional
                    log.info(`Twilio: Call started, SID: ${this.callSid}`);
                    this.conferenceUUID = getValueOrDefault(data, 'start.customParameters.conferenceUUID', ''); // Optional
                    log.info(`  Conference name: ${this.conferenceUUID}`);
                    this.actor = getValueOrDefault(data, 'start.customParameters.actor', ''); // Optional: 'SUB', 'OPY', 'GDN'
                    log.info(`  Actor: ${this.actor}`);
                    this.guardianSID = ''; // Get this from 'addGuardian' event. If actor is 'GDN', callSID is the guardianSID
                    this.challengeStatus = ChallengeStatus.NONE;
                    this.challengeTimer = null;

                    sidDatabase.set(this.conferenceUUID, this.actor, this.callSid);

                    // Fire off the challenge audio
                    if ('OPY' == this.actor) {
                        this.challengeStatus = ChallengeStatus.PLAYINGAUDIO;
                        playAudio(this.callSid, null, 'sayChallengeCaller', this.sessionId)
                            .then((result) => {
                                console.log('=== RAW CONSOLE LOG ===', result);
                                console.log('=== STRINGIFIED ===', JSON.stringify(result));
                                console.log('=== TYPE ===', typeof result);

                                log.info(`[${this.actor}] playAudio result: ${result}`);

                                let duration = 12;
                                const dataString = result.data; // Get the string from the 'data' property
                                if (dataString && typeof dataString === 'string') {
                                    try {
                                        const dataObject = JSON.parse(dataString); // Parse the JSON string
                                        duration = dataObject?.audioDuration ?? 12;
                                    } catch (err) {
                                        log.info(`error: ${err}`);
                                    }
                                }

                                log.info(`Duration: "${duration}" seconds`);

                                this.#startChallengeTimer(duration * 1000 + CHALLENGE_TIMEOUT);
                            })
                            .catch((error) => {
                                log.error(`[${this.actor}] handleTranscript: error:`, error);
                            })
                            .finally(() => {});
                    }

                    break;

                case 'close':
                    log.info('Twilio: Close event received');
                    this.cleanup();
                    break;
            }
        } catch (error) {
            log.error('Error processing message', error);
        }
    }

    #challengeTimedOut() {
        log.info(`[${this.actor}] Challenge timed out`);
        this.challengeStatus = ChallengeStatus.FAILED;

        playAudio(this.callSid, null, 'sayExplainRejection', this.sessionId);
    }

    #processReturnedCommandJSON(result, track) {
        log.info(`processReturnedCommandJSON`);
        if (!result) {
            log.error(`processReturnedCommandJSON: null result`);
            return;
        }

        let command = result.action;
        if (!command) {
            log.error(`processReturnedCommandJSON: missing action`);
            return;
        }

        let json = null;
        try {
            json = JSON.parse(result.data); // Not using the shared simdjson here
            if (json) {
                log.info(`processReturnedCommandJSON: json:`, json);
            }
        } catch {
            log.info(`processReturnedCommandJSON: no data`);
        }

        if (result.remove) {
            const cmd = 'cmd:' + command;
            log.info(`Removing ${cmd}`);
            this.transcriptHistory[track].removeCommand(cmd);
        }
    }

    #handleChallengeResponse(track) {
        log.info(`[${this.actor}] Challenge response received`);
        const history = this.transcriptHistory[track];
        const words = history.flatten(2);

        if (passedChallenge(words)) {
            playAudio(this.callSid, null, 'sayConnectingCall', this.sessionId);

            log.info(`[${this.actor}] Challenge passed`);
            this.#stopChallengeTimer();
            this.challengeStatus = ChallengeStatus.NONE;

            const number = '+12063498679'; // TODO - use 'Account' database number
            // const number = '+16784852385'; // Katy's number
            callConnect(this.callSid, this.conferenceUUID, number, 'SUB');
        }
    }

    #handleTranscript(transcript, isFinal, track) {
        if (!this.active || !this.transcriptHistory[track]) return;

        log.info(`[${track}][${isFinal ? 'Final' : 'Interim'}][${this.actor}] ${transcript}`);

        const history = this.transcriptHistory[track];
        history.push(transcript, isFinal);

        if (inInitialChallengeStatus(this.challengeStatus)) {
            this.#handleChallengeResponse(track);
            return;
        }

        let hit = history.findScamPhrases();
        if (hit !== null) {
            history.reset();

            if (this.processingCommand) {
                log.info(`[${this.actor}] Ignoring scam phrase hit while processing command: ${hit}`);
                return;
            }

            this.processingCommand = true;
            let now = performance.now();
            if (this.lastCommandTime && now - this.lastCommandTime < 4000) {
                log.info(`[${this.actor}] Ignoring scam phrase hit due to cooldown: ${hit}`);
                this.processingCommand = false;
                return;
            }

            this.lastCommandTime = now;
            log.info(`[${this.actor}] handleTranscript: : timestamping command`);

            handlePhrase(hit, track, this.callSid, this.conferenceUUID)
                .then((result) => {
                    log.info(`[${this.actor}] handleTranscript: result:`, result);
                    this.#processReturnedCommandJSON(result, track);
                })
                .catch((error) => {
                    log.error(`[${this.actor}] handleTranscript: error:`, error);
                })
                .finally(() => {
                    this.processingCommand = false;
                });
        }
    }

    #handleUtteranceEnd(utterance, track) {
        if (this.active) log.info(`[${track}] Complete utterance: ${utterance}`);
    }

    #clearAllTimers() {
        this.#stopMemoryMonitor();
        this.#stopStatsTimer();
        this.#stopFlushTimer(TRACK_INBOUND);
        this.#stopFlushTimer(TRACK_OUTBOUND);
        this.#stopChallengeTimer();
    }

    cleanup() {
        // PUBLIC METHOD
        if (!this.active) return;

        if (WANT_MONITORING) {
            // Log final Deepgram stats before cleanup
            if (this.metrics.deepgram.packetsSent.inbound > 0 || this.metrics.deepgram.packetsSent.outbound > 0) {
                log.info(`Final Deepgram stats for call ${this.callSid || 'unknown'}:`);
                this.#logDeepgramStats();
            }
        }

        this.active = false;
        this.isShuttingDown = true;

        this.#clearAllTimers();

        let stt = this.sttService;
        const directions = [TRACK_INBOUND, TRACK_OUTBOUND];
        for (const direction of directions) {
            if (stt?.[direction]) {
                stt[direction].cleanup();
                stt[direction] = null;
            }
        }

        log.info(
            `Call session cleaned up, Call SID: ${this.callSid || 'unknown'}, processed ${this.receivedPackets} packets`
        );
    }
}

// VoiceServer (uWebSockets.js Version)
class VoiceServer {
    constructor() {
        this.sessions = new Map();
        this.isShuttingDown = false;
        this.listenSocket = null; // Keep track of the listen socket for closing.

        if (WANT_MONITORING) {
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
            // Webhook endpoint for external events (only audioFinished for now)
            .put('/callStatus', (res, req) => {
                log.info(`PUT callStatus`);
                // Parse the raw query string: "action=audioPlayDone&audioId=xxxxxx&sessionId=yyyyyy"
                const rawQuery = req.getQuery();
                const params = new URLSearchParams(rawQuery);

                const action = params.get('action');
                const audioId = params.get('audioId');
                const sessionId = params.get('sessionId');

                res.writeHeader('Content-Type', 'application/json');

                // Validate presence of all three parameters
                if (!action || !audioId || !sessionId) {
                    res.writeStatus('400 Bad Request');
                    return res.end(JSON.stringify({ error: 'Missing action, audioId, or sessionId in query string' }));
                }

                // Dispatch into your handler (you can look up the session by sessionId here)
                log.info(`Webhook PUT received: sessionId=${sessionId}, action=${action}, audioId=${audioId}`);

                const session = this.sessions.get(sessionId);
                if (!session) {
                    res.writeStatus('400 Bad Request');
                    return res.end(JSON.stringify({ error: 'Invalid sessionId' }));
                }

                session.handlePUTEvent(action, audioId);

                res.writeStatus('200 OK');
                return res.end(JSON.stringify({ status: 'received' }));
            })
            .ws('/*', {
                /* Options */
                compression: uWS.DISABLED,
                maxPayloadLength: 32 * 1024,
                idleTimeout: 300,
                maxBackpressure: 1 * 1024 * 1024,

                /* Handlers */
                upgrade: (res, req, context) => {
                    // Safely pull whatever headers you need:
                    const hostHeader = req.getHeader('host') || ''; // "example.com:443"
                    const originHeader = req.getHeader('Origin') || '';

                    log.info( `host: ${hostHeader}`);
                    log.info( `origin: ${originHeader}`);

                    const authToken = req.getHeader('authorization'); // maybe you have one

                    // Pass them through to the WebSocket user-data bucket:
                    res.upgrade(
                        { hostHeader, authToken },
                        req.getHeader('sec-websocket-key'),
                        req.getHeader('sec-websocket-protocol'),
                        req.getHeader('sec-websocket-extensions'),
                        context
                    );
                },
                open: (ws) => {
                    const sessionId = randomUUID();

                    ws.sessionId = sessionId; // Store sessionId on the ws object!
                    log.info(`New WebSocket connection established from ${sessionId}`);

                    const session = new CallSession(sessionId);
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
                // eslint-disable-next-line no-unused-vars
                close: (ws, code, message) => {
                    const session = this.sessions.get(ws.sessionId);
                    if (session) {
                        session.cleanup();
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
            .listen('0.0.0.0', PORT, (listenSocket) => {
                if (listenSocket) {
                    this.listenSocket = listenSocket; // Store the listen socket.
                    log.info(`Server listening on port ${PORT}`);
                } else {
                    log.error(`Failed to start server on port ${PORT}`); // Better error handling
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
            session.cleanup();
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

// Ensure database connection is established before starting the server
// --- Asynchronous Setup using IIAFE ---
(async () => {
    try {
        log.info('Attempting initial sidDatabase at module level...');
        await sidDatabase.connect();
        log.info('sidDatabase connected and ready (module level setup).');
    } catch (error) {
        log.error('FATAL: Failed to connect to sidDatabase:', error);
        process.exit(1);
    }
})(); // Note the () at the end to immediately invoke the function

// Start the server
const server = new VoiceServer();
server.start();
