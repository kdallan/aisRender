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
                log.info(`POST Response [${res.statusCode}]:`, data);
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
    const verb = 'addParticipant';
    if (!phoneNumber || !conferenceName) {
        const msg = `Phone number and conference name are required`;
        log.error(verb + ': ' + msg);
        return { success: false, action: verb, message: msg };
    }

    log.info(`${verb} ${phoneNumber} "${conferenceName}"`);

    const postData = `phoneNumber=${encodeURIComponent(phoneNumber)}&conferenceName=${encodeURIComponent(
        conferenceName
    )}`;

    try {
        const options = createPOSTOptions('add-participant', postData);
        const response = await sendPOSTrequest(options, postData);
        return {
            success: true,
            action: verb,
            message: `${phoneNumber} "${conferenceName}"`,
            data: response,
        };
    } catch (error) {
        log.error(`Failed ${verb} ${phoneNumber} "${conferenceName}"`, error);
        return {
            success: false,
            action: verb,
            message: `${phoneNumber} "${conferenceName}" ${error.message}`,
        };
    }
}

async function talkToSID(callSid, conferenceName) {
    const verb = 'talkToSID';
    if (!callSid || !conferenceName) {
        const msg = `Call SID and conference name are required`;
        log.error(verb + ': ' + msg);
        return { success: false, action: verb, message: msg };
    }

    log.info(`${verb} ${callSid} "${conferenceName}"`);

    const postData = `callSID=${encodeURIComponent(callSid)}&conferenceName=${encodeURIComponent(conferenceName)}`;

    try {
        const options = createPOSTOptions('guardian/talkToSID', postData);
        const response = await sendPOSTrequest(options, postData);
        return {
            success: true,
            action: verb,
            message: `${callSid} "${conferenceName}"`,
            data: response,
        };
    } catch (error) {
        log.error(`Failed to talkToSID. callSID: ${callSid} conferenceName: ${conferenceName}`, error);
        return {
            success: false,
            action: verb,
            message: `${callSid} "${conferenceName}" ${error.message}`,
        };
    }
}

async function guardianCommand(verb, postName, conferenceName) {
    if (!conferenceName) {
        const msg = `Conference name is required`;
        log.error(verb + ': ' + msg);
        return { success: false, action: verb, message: msg };
    }

    log.info(`${verb} "${conferenceName}"`);

    const postData = `conferenceName=${encodeURIComponent(conferenceName)}`;

    try {
        const options = createPOSTOptions(postName, postData);
        const response = await sendPOSTrequest(options, postData);
        return {
            success: true,
            action: verb,
            message: `"${conferenceName}"`,
            data: response,
        };
    } catch (error) {
        log.error(`Failed to ${verb}: conferenceName: "${conferenceName}"`, error);
        return {
            success: false,
            action: verb,
            message: `"${conferenceName}" ${error.message}`,
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
    const verb = 'handlePhrase';
    if (!phrase) {
        const msg = `Phrase is required`;
        log.error(verb + ': ' + msg);
        return { success: false, action: verb, message: msg };
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
                };
            } else if (cmd === 'addParticipant') {
                // Hardcoded Guardian phone number. TODO: get from DB
                const result = await addParticipant('+12063498679', conferenceName);
                return {
                    ...result,
                };
            } else if (cmd === 'talkToSID') {
                const result = await talkToSID(callSid, conferenceName);
                return {
                    ...result,
                };
            } else if (cmd === 'talkToAll' || cmd === 'hangupAll' || cmd === 'dropOffCall' || cmd === 'monitorCall') {
                const postName = 'guardian/' + cmd;
                const result = await guardianCommand(cmd, postName, conferenceName);
                return {
                    ...result,
                };
            }
        }

        // If we get here, either it wasn't a command or wasn't a recognized command
        log.info(`${verb} not a recognized command: ${JSON.stringify(phrase)}`);

        const result = await sayPhraseAndHangup(callSid, 'Scam detected. Goodbye');
        return {
            ...result,
        };
    } catch (error) {
        log.error(`${verb}`, error);
        return {
            success: false,
            action: verb,
            message: `${error.message}`,
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
