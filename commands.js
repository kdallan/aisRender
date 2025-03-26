'use strict';
const https = require('https');
const pino = require('pino');
const twilio = require('twilio');
const log = pino({ base: null });

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

// process.env.TWILIO_STUDIO_FLOW_ID || 'FWe2a7c39cffcbe604f2f158b68aae3b19'

async function runTwilioFlow(callSid, flowId, accountSid, authToken) {

    const client = twilio(accountSid, authToken);
    
    try {
        log.info(`Calling Twilio flow: ${callSid}`);
        const execution = await client.studio.v2.flows(flowId).executions(callSid);
        log.info('Flow executed', { executionSid: execution.sid });
        return execution;
    } catch (error) {
        log.error('Failed to call flow', error);
        throw error;
    }
}

async function sayPhraseAndHangup( callSid, phrase, accountSid, authToken ) {

    const client = twilio(accountSid, authToken);
    const VoiceResponse = twilio.twiml.VoiceResponse;

    try {
        log.info(`Saying phrase and hanging up call ${callSid}: "${phrase}"`);
        const twiml = new VoiceResponse();
        twiml.say({ voice: 'Polly.Amy-Neural', language: 'en-US' }, phrase);
        twiml.leave();

        const result = await client.calls(callSid).update({ twiml: twiml.toString() });
        log.info(`Call ${callSid} successfully updated with TwiML`);
        return result;
    } catch (error) {
        log.error(`Failed to update call ${callSid} with TwiML`, error);
        throw error;
    }
}
async function handleHangup(customPhrase) {
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

async function runCommand( command, callSid ) {
    log.info( `Running command: ${command}` );
}

async function handlePhrase( phrase, callSid ) {
    log.info( `Handling phrase: ${phrase}` );
}

module.exports = {
    runCommand,
    handlePhrase
};
