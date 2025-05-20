'use strict';
const { Deepgram } = require('@deepgram/sdk');
const pino = require('pino');
const log = pino({ base: null });
const sharedWSS = require('./sharedwss');

/**
 * DeepgramTTSStreamer - Stream Deepgram TTS to any WebSocket
 * across any server instance
 */
class DeepgramTTSStreamer {
    /**
     * Create a new DeepgramTTSStreamer
     * @param {Object} options - Configuration options
     */
    constructor(options = {}) {
        // Configuration
        this.config = {
            apiKey: process.env.DEEPGRAM_API_KEY,
            defaultModel: process.env.DEEPGRAM_TTS_MODEL || 'aura-asteria-en',
            defaultVoice: process.env.DEEPGRAM_TTS_VOICE || 'nova',
            sampleRate: parseInt(process.env.DEEPGRAM_TTS_SAMPLE_RATE || '16000', 10),
            encoding: process.env.DEEPGRAM_TTS_ENCODING || 'linear16',
            logChunks: process.env.DEEPGRAM_LOG_CHUNKS === 'true',
            maxRetries: parseInt(process.env.DEEPGRAM_MAX_RETRIES || '3', 10),
            retryDelay: parseInt(process.env.DEEPGRAM_RETRY_DELAY || '1000', 10),
            ...options,
        };

        if (!this.config.apiKey) {
            throw new Error('DEEPGRAM_API_KEY is required');
        }

        // Initialize Deepgram client
        this.deepgram = new Deepgram(this.config.apiKey);

        log.info(
            {
                model: this.config.defaultModel,
                voice: this.config.defaultVoice,
            },
            'DeepgramTTSStreamer initialized'
        );
    }

    /**
     * Stream TTS to a specific conference participant
     * @param {string} conferenceUUID - Conference identifier
     * @param {string} actor - Actor role ('SUB', 'OPY', 'GDN')
     * @param {string} text - Text to convert to speech
     * @param {Object} options - TTS options
     * @returns {Promise<{success: boolean, error: Error|null, bytesSent: number}>} - Result
     */
    async streamToParticipant(conferenceUUID, actor, text, options = {}) {
        if (!conferenceUUID || !actor || !text) {
            const error = new Error('Missing required parameters');
            log.error({ conferenceUUID, actor }, error.message);
            return { success: false, error, bytesSent: 0 };
        }

        try {
            log.info(
                {
                    conferenceUUID,
                    actor,
                    textLength: text.length,
                },
                'Streaming TTS to participant'
            );

            // Create TTS options by merging defaults with provided options
            const ttsOptions = {
                model: this.config.defaultModel,
                voice: options.voice || (actor === 'SUB' ? 'nova' : this.config.defaultVoice),
                encoding: this.config.encoding,
                sample_rate: this.config.sampleRate,
                container: 'none', // Raw audio
                ...options,
            };

            // Track performance
            const startTime = Date.now();
            let totalBytesSent = 0;
            let chunksProcessed = 0;

            // Determine the appropriate audio track based on actor
            // Subscribers usually hear audio on the inbound track
            // Operators usually hear audio on the outbound track
            const track = actor === 'SUB' ? 'inbound' : 'outbound';

            // Create a TTS stream with retry logic
            let ttsStream = null;
            let retries = 0;

            while (retries <= this.config.maxRetries) {
                try {
                    ttsStream = await this.deepgram.listen.transcribe({
                        type: 'text',
                        stream: true,
                        tts: true,
                        textToSpeech: ttsOptions,
                    });

                    // Stream created successfully
                    break;
                } catch (streamError) {
                    retries++;

                    if (retries > this.config.maxRetries) {
                        throw streamError;
                    }

                    log.warn(
                        {
                            error: streamError.message,
                            conferenceUUID,
                            actor,
                            retry: retries,
                        },
                        'Retrying TTS stream creation'
                    );

                    // Wait before retry
                    await new Promise((resolve) => setTimeout(resolve, this.config.retryDelay));
                }
            }

            if (!ttsStream) {
                throw new Error('Failed to create TTS stream after retries');
            }

            // Set up promise to track completion
            const streamPromise = new Promise((resolve, reject) => {
                // Handle audio data chunks
                ttsStream.on('data', async (audioChunk) => {
                    try {
                        chunksProcessed++;

                        if (this.config.logChunks) {
                            log.debug(
                                {
                                    conferenceUUID,
                                    actor,
                                    chunkSize: audioChunk.length,
                                    chunkNumber: chunksProcessed,
                                },
                                'Received TTS audio chunk'
                            );
                        }

                        // Format the message for your VoiceServer
                        // This matches the format in your original code
                        const message = {
                            event: 'media',
                            media: {
                                track: track,
                                payload: audioChunk.toString('base64'),
                            },
                        };

                        // Send the message through SharedWSS
                        const { success, error } = await sharedWSS.sendToParticipant(
                            conferenceUUID,
                            actor,
                            JSON.stringify(message),
                            false
                        );

                        if (success) {
                            totalBytesSent += audioChunk.length;
                        } else {
                            log.warn(
                                {
                                    error: error?.message,
                                    conferenceUUID,
                                    actor,
                                    chunkNumber: chunksProcessed,
                                },
                                'Failed to send TTS chunk'
                            );
                        }
                    } catch (chunkError) {
                        log.error(
                            {
                                error: chunkError.message,
                                conferenceUUID,
                                actor,
                            },
                            'Error processing TTS chunk'
                        );
                    }
                });

                // Handle stream completion
                ttsStream.on('close', () => {
                    const duration = Date.now() - startTime;
                    log.info(
                        {
                            conferenceUUID,
                            actor,
                            bytesSent: totalBytesSent,
                            chunks: chunksProcessed,
                            durationMs: duration,
                        },
                        'TTS stream completed'
                    );

                    resolve({
                        success: true,
                        error: null,
                        bytesSent: totalBytesSent,
                    });
                });

                // Handle errors
                ttsStream.on('error', (streamError) => {
                    log.error(
                        {
                            error: streamError.message,
                            conferenceUUID,
                            actor,
                        },
                        'TTS stream error'
                    );

                    reject(streamError);
                });
            });

            // Send the text to be synthesized
            ttsStream.send(text);

            // Wait for stream to complete
            try {
                const result = await streamPromise;
                return result;
            } catch (streamError) {
                return {
                    success: false,
                    error: streamError,
                    bytesSent: totalBytesSent,
                };
            } finally {
                // Ensure stream is closed
                try {
                    if (ttsStream && typeof ttsStream.close === 'function') {
                        ttsStream.close();
                    }
                    // eslint-disable-next-line no-unused-vars
                } catch (e) {
                    // Ignore close errors
                }
            }
        } catch (error) {
            log.error(
                {
                    error: error.message,
                    stack: error.stack,
                    conferenceUUID,
                    actor,
                },
                'Error streaming TTS to participant'
            );

            return {
                success: false,
                error,
                bytesSent: 0,
            };
        }
    }

    /**
     * Broadcast TTS to multiple participants in a conference
     * @param {string} conferenceUUID - Conference identifier
     * @param {Array<string>} actors - List of actors to receive the message
     * @param {string} text - Text to convert to speech
     * @param {Object} options - TTS options
     * @returns {Promise<Object>} - Results by actor
     */
    async broadcastToConference(conferenceUUID, actors, text, options = {}) {
        if (!conferenceUUID || !actors || !Array.isArray(actors) || !text) {
            const error = new Error('Missing required parameters for broadcast');
            log.error({ conferenceUUID, actorCount: actors?.length }, error.message);
            return { success: false, error, results: {} };
        }

        const results = {};
        let overallSuccess = true;

        log.info(
            {
                conferenceUUID,
                actors,
                textLength: text.length,
            },
            'Broadcasting TTS to conference'
        );

        // Stream to each actor
        for (const actor of actors) {
            try {
                const result = await this.streamToParticipant(conferenceUUID, actor, text, options);

                results[actor] = result;

                if (!result.success) {
                    overallSuccess = false;
                }
            } catch (error) {
                log.error(
                    {
                        error: error.message,
                        conferenceUUID,
                        actor,
                    },
                    'Error broadcasting to participant'
                );

                results[actor] = {
                    success: false,
                    error,
                    bytesSent: 0,
                };
                overallSuccess = false;
            }
        }

        return {
            success: overallSuccess,
            results,
        };
    }

    /**
     * Play a predefined alert to participants
     * @param {string} conferenceUUID - Conference identifier
     * @param {string} alertType - Type of alert
     * @param {Object} options - Alert options
     * @returns {Promise<Object>} - Results by actor
     */
    async playAlert(conferenceUUID, alertType, options = {}) {
        // Define alert types with default messages and target actors
        const alerts = {
            recording: {
                message: 'This call is being recorded for quality assurance purposes.',
                actors: ['SUB', 'OPY'],
            },
            timeout: {
                message: 'This call will end in one minute due to inactivity.',
                actors: ['SUB', 'OPY', 'GDN'],
            },
            operator_joined: {
                message: 'An operator has joined the call.',
                actors: ['SUB'],
            },
            guardian_joined: {
                message: 'A guardian has joined the call.',
                actors: ['SUB', 'OPY'],
            },
            on_hold: {
                message: 'You have been placed on hold.',
                actors: ['SUB'],
            },
            resumed: {
                message: 'Your call has been resumed.',
                actors: ['SUB'],
            },
        };

        // Validate alert type
        if (!alerts[alertType]) {
            const error = new Error(`Unknown alert type: ${alertType}`);
            log.error({ conferenceUUID, alertType }, error.message);
            return { success: false, error, results: {} };
        }

        // Get alert configuration
        const alert = alerts[alertType];

        // Use custom message if provided
        const message = options.message || alert.message;

        // Use custom actors list if provided, otherwise use default
        const actors = options.actors || alert.actors;

        // Broadcast the alert
        return this.broadcastToConference(conferenceUUID, actors, message, options);
    }
}

module.exports = new DeepgramTTSStreamer();
