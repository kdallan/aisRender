'use strict';
const https = require('https');
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

function createPOSTOptions(restFunction, accountSid, authToken, postData) {
    return {
        hostname: 'createconference-2381.twil.io',
        path: '/' + restFunction,
        // hostname: 'postman-echo.com',
        // path: '/post',
        method: 'POST',
        headers: {
            Authorization: 'Bearer ' + `${accountSid}:${authToken}`,
            'Content-Type': 'application/x-www-form-urlencoded',
            'Content-Length': Buffer.byteLength(postData),
        },
    };
}

function sendPOSTrequest(options, postData) {
    const req = https.request(options, (res) => {
        let data = '';

        res.on('data', (chunk) => {
            data += chunk;
        });

        res.on('end', () => {
            console.log('Response:', data);
        });
    });

    req.on('error', (e) => {
        console.error(`Request error: ${e.message}`);
    });

    req.write(postData);
    req.end();
}

function addParticipant(phoneNumber, conferenceName, accountSid, authToken) {
    const postData = `phoneNumber=${encodeURIComponent(phoneNumber)}&conferenceName=${encodeURIComponent(
        conferenceName
    )}`;
    const options = createPOSTOptions('add-participant', accountSid, authToken, postData);
    return sendPOSTrequest(options, postData);
}

// TwilioService
class TwilioService {
    constructor(config) {
        this.config = config;
        this.client = require('twilio')(config.accountSid, config.authToken);
        this.VoiceResponse = require('twilio').twiml.VoiceResponse;
    }

    async runTwilioFlow(callSid) {
        try {
            log.info(`Calling Twilio flow: ${callSid}`);
            const execution = await this.client.studio.v2.flows(this.config.studioFlowId).executions(callSid);
            log.info('Flow executed', { executionSid: execution.sid });
            return execution;
        } catch (error) {
            log.error('Failed to call flow', error);
            throw error;
        }
    }

    async sayPhraseAndHangup(callSid, phrase) {
        if (!callSid) throw new Error('Call SID is required');

        try {
            log.info(`Saying phrase and hanging up call ${callSid}: "${phrase}"`);
            const twiml = new this.VoiceResponse();
            twiml.say({ voice: 'Polly.Amy-Neural', language: 'en-US' }, phrase);
            twiml.leave();

            const result = await this.client.calls(callSid).update({ twiml: twiml.toString() });
            log.info(`Call ${callSid} successfully updated with TwiML`);
            return result;
        } catch (error) {
            log.error(`Failed to update call ${callSid} with TwiML`, error);
            throw error;
        }
    }
}

module.exports = {
    addParticipant,
    TwilioService,
};
