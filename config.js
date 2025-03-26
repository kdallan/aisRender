'use strict';
require('dotenv').config();

module.exports = {
    WANT_MONITORING: process.env.WANT_MONITORING === 'true' || process.env.WANT_MONITORING === '1',
    PORT: parseInt(process.env.PORT) || 10000,
    DEEPGRAM_MODEL: process.env.DEEPGRAM_MODEL || 'nova-3',
    DEEPGRAM_LANGUAGE: process.env.DEEPGRAM_LANGUAGE || 'en-US',
    TWILIO_ACCOUNT_SID: process.env.TWILIO_ACCOUNT_SID,
    TWILIO_AUTH_TOKEN: process.env.TWILIO_AUTH_TOKEN,
    TWILIO_STUDIO_FLOW_ID: process.env.TWILIO_STUDIO_FLOW_ID,
    DEEPGRAM_API_KEY: process.env.DEEPGRAM_API_KEY
};
