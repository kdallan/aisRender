'use strict';
const { createClient, LiveTranscriptionEvents } = require('@deepgram/sdk');
const pino = require('pino');
const log = pino({ base: null });
const { DEEPGRAM_API_KEY } = require('./config');

// DeepgramSTTService
class DeepgramSTTService {
    constructor(onTranscript, onUtteranceEnd) {
        this.sttConfig = {
            model: 'nova-3',
            language: 'en-US',
            encoding: 'mulaw',
            sample_rate: 8000,
            channels: 1,
            no_delay: true,
            speech_final: true,
            interim_results: true,
            endpointing: 5,
            utterance_end_ms: 1000,
        };

        this.onTranscript = onTranscript;
        this.onUtteranceEnd = onUtteranceEnd;
        this.client = createClient(DEEPGRAM_API_KEY);
        this.deepgram = null;
        this.isFinals = new Array( 32 );
        this.isFinals.length = 0; // Need to initialize the array to avoid undefined values
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
            log.info(
                this.reconnectAttempts > 0
                    ? `Reconnecting to Deepgram (attempt ${this.reconnectAttempts + 1}/${this.maxReconnectAttempts})...`
                    : 'Connecting to Deepgram...'
            );

            this.deepgram = this.client?.listen?.live(this.sttConfig);

            if (this.keepAliveInterval) {
                clearInterval(this.keepAliveInterval);
            }

            this.keepAliveInterval = setInterval(() => {
                if (this.deepgram && this.connected) this.deepgram.keepAlive();
            }, 10000);

            this.#setupEventListeners();
            return this.deepgram;
        } catch (error) {
            log.error('Failed to connect to Deepgram STT', error);
            this.#handleConnectionFailure();
            return null;
        }
    }

    #handleConnectionFailure() {
        this.connected = false;

        if (this.isShuttingDown) return; // Don't try to reconnect if we're shutting down

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

    #setupEventListeners() {
        let dg = this.deepgram;
        if (!dg) return;

        dg.addListener(LiveTranscriptionEvents.Open, () => {
            log.info('DeepgramSTTService:Open - connection opened');
            this.connected = true;
            this.reconnectAttempts = 0;

            dg.addListener(LiveTranscriptionEvents.Transcript, (data) => {
                const transcript = data?.channel?.alternatives?.[0]?.transcript;
                if (!transcript) return;

                if (!data.is_final) {
                    this.onTranscript?.(transcript, false);
                    return;
                }

                let finals = this.isFinals;
                finals.push(transcript);

                if (data.speech_final) {
                    this.onTranscript?.(finals.join(' '), true);
                    this.isFinals.length = 0; // Zero length to reuse the array
                } else {
                    this.onTranscript?.(transcript, true);
                }
            });

            dg.addListener(LiveTranscriptionEvents.UtteranceEnd, () => {
                let finals = this.isFinals;
                if (finals.length > 0) {
                    this.onUtteranceEnd?.(finals.join(' '));
                    this.isFinals.length = 0; // Zero length to reuse the array
                }
            });
        });

        dg.addListener(LiveTranscriptionEvents.Close, () => {
            log.info('DeepgramSTTService:Close - connection closed');
            this.connected = false;
            this.#handleConnectionFailure();
        });

        dg.addListener(LiveTranscriptionEvents.Error, (error) => {
            log.error('DeepgramSTTService:Error - ', error);
            if (!this.connected) this.#handleConnectionFailure();
        });

        dg.addListener(LiveTranscriptionEvents.Warning, (warning) => {
            log.warn('DeepgramSTTService:Warning - ', warning);
        });
    }

    send(audioData) { // PUBLIC METHOD
        if (!this.connected || this.isShuttingDown) return;

        if (!audioData || !Buffer.isBuffer(audioData) || audioData.length === 0) {
            log.warn('DeepgramSTTService:send - no audio data');
            return;
        }

        let dg = this.deepgram;
        if (!dg) return;

        try {
            dg.send(audioData);
        } catch (error) {
            log.error('DeepgramSTTService:send - failed to send: ', error);
            if (error.message?.includes('not open')) {
                this.connected = false;
                this.#handleConnectionFailure();
            }
        }
    }

    cleanup() { // PUBLIC METHOD
        this.isShuttingDown = true;
        this.connected = false;

        let keepalive = this.keepAliveInterval;
        if (keepalive) {
            clearInterval(keepalive);
            this.keepAliveInterval = null;
        }

        let dg = this.deepgram;
        if (!dg) return;

        try {
            dg.requestClose();
        } catch (error) {
            log.error('DeepgramSTTService:cleanup: ', error);
        }

        this.deepgram = null;
    }
}

module.exports = DeepgramSTTService;
