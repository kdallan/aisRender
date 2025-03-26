'use strict';
const https = require('https');
const pino = require('pino');
const twilio = require('twilio');
const log = pino({ base: null });
const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN } = require('./config');

function createPOSTOptions(restFunction, postData) {
    return {
        hostname: 'createconference-2381.twil.io',
        path: '/' + restFunction,
        method: 'POST',
        headers: {
            Authorization: 'Bearer ' + `${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`,
            'Content-Type': 'application/x-www-form-urlencoded',
            'Content-Length': Buffer.byteLength(postData),
        },
    };
}

function sendPOSTrequest(options, postData) {
    return new Promise((resolve, reject) => {
        const req = https.request(options, (res) => {
            let data = '';

            res.on('data', (chunk) => {
                data += chunk;
            });

            res.on('end', () => {
                log.info('POST Response:', data);
                resolve(data);
            });
        });

        req.on('error', (e) => {
            log.error(`Request error: ${e.message}`);
            reject(e);
        });

        req.write(postData);
        req.end();
    });
}

async function addParticipant(phoneNumber, conferenceName) {
    if (!phoneNumber || !conferenceName) {
        log.error('Phone number and conference name are required');
        return { success: false, action: 'error', message: 'Phone number and conference name are required' };
    }

    log.info(`Adding participant ${phoneNumber} to conference "${conferenceName}"`);

    const postData = `phoneNumber=${encodeURIComponent(phoneNumber)}&conferenceName=${encodeURIComponent(
        conferenceName
    )}`;

    try {
        const options = createPOSTOptions('add-participant', postData);
        const response = await sendPOSTrequest(options, postData);
        return {
            success: true,
            action: 'addParticipant',
            message: `Participant ${phoneNumber} added to conference`,
            data: response,
        };
    } catch (error) {
        log.error(`Failed to add participant ${phoneNumber} to conference`, error);
        return {
            success: false,
            action: 'error',
            message: `Failed to add participant: ${error.message}`,
        };
    }
}

function getTwilioClient() {
    return twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
}

async function sayPhraseAndHangup(callSid, phrase) {
    if (!callSid) {
        log.error('Call SID is required');
        return { success: false, action: 'error', message: 'Call SID is required' };
    }

    const client = getTwilioClient();
    const VoiceResponse = twilio.twiml.VoiceResponse;

    try {
        log.info(`Saying phrase and hanging up call ${callSid}: "${phrase}"`);
        const twiml = new VoiceResponse();
        twiml.say({ voice: 'Polly.Amy-Neural', language: 'en-US' }, phrase);
        twiml.leave();

        const result = await client.calls(callSid).update({ twiml: twiml.toString() });
        log.info(`Call ${callSid} successfully updated with TwiML`);
        return {
            success: true,
            action: 'hangup',
            message: `Call ${callSid} updated with phrase and hangup instruction`,
            data: result,
        };
    } catch (error) {
        log.error(`Failed to update call ${callSid} with TwiML`, error);
        return {
            success: false,
            action: 'error',
            message: `Failed to update call: ${error.message}`,
        };
    }
}

async function handlePhrase(phrase, track, callSid, conferenceName) {
    if (!phrase) {
        log.error('Phrase is required');
        return { success: false, action: 'error', message: 'Phrase is required' };
    }

    try {
        // Check if phrase has a type property that's a command
        const cmdstr = phrase.type;

        if (cmdstr && cmdstr.startsWith('cmd:')) {
            const cmd = cmdstr.slice(4);

            if (cmd === 'hangup') {
                const signOff = phrase.signOff || 'Scam detected. Goodbye';
                const result = await sayPhraseAndHangup(callSid, signOff);
                return {
                    ...result,
                    message: 'Hangup command processed',
                    originalPhrase: phrase,
                };
            } else if (cmd === 'addParticipant') {
                if (!conferenceName) {
                    log.error('Conference name is required for addParticipant command');
                    return {
                        success: false,
                        action: 'error',
                        message: 'Conference name required for addParticipant command',
                        originalPhrase: phrase,
                    };
                }
                // Hardcoded Guardian phone number. TODO: get from DB
                const result = await addParticipant('+12063498679', conferenceName);
                return {
                    ...result,
                    message: 'Participant added through command',
                    originalPhrase: phrase,
                };
            } else {
                log.warn(`Unknown command: ${cmd}`);
                return {
                    success: false,
                    action: 'unknownCommand',
                    message: `Unknown command: ${cmd}`,
                    originalPhrase: phrase,
                };
            }
        }

        // If we get here, either it wasn't a command or wasn't a recognized command
        log.info(`Phrase not a recognized command: ${JSON.stringify(phrase)}`);
        const result = await sayPhraseAndHangup(callSid, 'Scam detected. Goodbye');
        return {
            ...result,
            action: 'defaultHangup',
            message: 'Default hangup executed for unrecognized command',
            originalPhrase: phrase,
        };
    } catch (error) {
        log.error('Error handling phrase', error);
        return {
            success: false,
            action: 'error',
            message: `Error handling phrase: ${error.message}`,
            originalPhrase: phrase,
        };
    }
}

// Example usage:
// const phrase = { phrase: 'hangup', type: 'cmd:hangup', signOff: 'Caller hanging up. Goodbye' };
//
// handlePhrase(phrase, track, callSid, conferenceName).then(result => {
//     if (result.action === 'hangup' || result.action === 'defaultHangup') {
//         // The call was hung up, do something...
//     }
// });

module.exports = {
    handlePhrase,
};
