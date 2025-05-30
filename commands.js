'use strict';
const https = require('https');
const pino = require('pino');
const twilio = require('twilio');
const log = pino({ base: null });
const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN } = require('./config');
const sidDatabase = require('./database');

// Constants
const POST_FIELDS = {
    CONFERENCE_ID: 'conferenceUUID',
    CALL_SID: 'callSID',
    PHONE_NUMBER: 'telephoneNumber',
    GUARDIAN_SID: 'guardianSID',
};

const API_CONFIG = {
    // hostname: 'createconference-2381.twil.io',
    hostname: 'aishield.ngrok.dev', // TESTING
    // hostname: 'callcontrol-v2-4405-dev.twil.io',
    timeout: 10000, // 10 seconds timeout
};

const SUB_COMMANDS = {
    ADD_GUARDIAN: 'addGuardian',
};

const GUARDIAN_COMMANDS = {
    HOLD_OPY: 'holdOPY',
    HOLD_SUB: 'holdSUB',
    TALK_TO_OPY: 'talkToOPY',
    TALK_TO_SUB: 'talkToSUB',
    TALK_TO_ALL: 'talkToAll',
    HANGUP_OPY: 'hangupOPY',
    HANGUP_SUB: 'hangupSUB',
    HANGUP_ALL: 'hangupAll',
    DROP_OFF_CALL: 'dropOffCall',
    MONITOR_CALL: 'monitorCall',
};

/**
 * Creates HTTP POST request options
 * @param {string} restFunction - The endpoint path
 * @param {string} postData - URL encoded post data
 * @returns {Object} HTTP request options
 */
function createPOSTOptions(origin, restFunction, postData) {
    const credentials = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString('base64');

    return {
        hostname: origin,
        path: '/' + restFunction,
        method: 'POST',
        timeout: API_CONFIG.timeout,
        headers: {
            Authorization: 'Basic ' + credentials,
            'Content-Type': 'application/x-www-form-urlencoded',
            'Content-Length': Buffer.byteLength(postData),
        },
    };
}

/**
 * Sends an HTTP POST request
 * @param {Object} options - HTTP request options
 * @param {string} postData - URL encoded post data
 * @returns {Promise<string>} Response data
 */
function sendPOSTrequest(options, postData) {
    return new Promise((resolve, reject) => {
        const req = https.request(options, (res) => {
            let data = '';

            res.on('data', (chunk) => {
                data += chunk;
            });

            res.on('end', () => {
                log.info(`POST Response [${res.statusCode}]:`, data);

                // Reject on non-successful status codes
                if (res.statusCode < 200 || res.statusCode >= 300) {
                    return reject(new Error(`HTTP Error: ${res.statusCode} - ${data}`));
                }

                resolve(data);
            });
        });

        req.on('error', (e) => {
            log.error(`Request error: ${e.message}`);
            reject(e);
        });

        // Add timeout handling
        req.on('timeout', () => {
            req.destroy();
            reject(new Error('Request timeout'));
        });

        req.write(postData);
        req.end();
    });
}

/**
 * Validates a phone number format (basic E.164 validation)
 * @param {string} phoneNumber - Phone number to validate
 * @returns {boolean} True if valid
 */
function isValidPhoneNumber(phoneNumber) {
    return /^\+[1-9]\d{1,14}$/.test(phoneNumber);
}

/**
 * Validates a Twilio Call SID
 * @param {string} callSid - Call SID to validate
 * @returns {boolean} True if valid
 */
function isValidCallSid(callSid) {
    return /^CA[a-f0-9]{32}$/.test(callSid);
}

/**
 * Adds the guardian to a conference
 * @param {string} phoneNumber - Participant's phone number
 * @param {string} conferenceName - Conference name
 * @returns {Promise<Object>} Result of the operation
 */
async function addGuardian(origin, phoneNumber, conferenceName) {
    const verb = 'addGuardian';

    // Validate inputs
    if (!phoneNumber || !conferenceName) {
        const msg = `Phone number and conference name are required`;
        log.error(`${verb}: ${msg}`);
        return { success: false, action: verb, message: msg };
    }

    if (!isValidPhoneNumber(phoneNumber)) {
        const msg = `Invalid phone number format: ${phoneNumber}`;
        log.error(`${verb}: ${msg}`);
        return { success: false, action: verb, message: msg };
    }

    log.info(`${verb} ${phoneNumber} "${conferenceName}"`);

    const postData = `${POST_FIELDS.PHONE_NUMBER}=${encodeURIComponent(phoneNumber)}&${
        POST_FIELDS.CONFERENCE_ID
    }=${encodeURIComponent(conferenceName)}`;

    log.info(`POST data: ${postData}`);

    try {
        const options = createPOSTOptions(origin, 'addGuardian', postData);
        const response = await sendPOSTrequest(options, postData);

        log.info('response: ', JSON.stringify(response));

        return {
            success: true,
            remove: true,
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

/**
 * Connects a call SID to a conference
 * @param {string} callSid - Twilio Call SID
 * @param {string} conferenceName - Conference name
 * @returns {Promise<Object>} Result of the operation
 */
async function talkToSID(origin, callSid, conferenceName) {
    const verb = 'talkToSID';

    // Validate inputs
    if (!callSid || !conferenceName) {
        const msg = `Call SID and conference name are required`;
        log.error(`${verb}: ${msg}`);
        return { success: false, action: verb, message: msg };
    }

    if (!isValidCallSid(callSid)) {
        const msg = `Invalid call SID format: ${callSid}`;
        log.error(`${verb}: ${msg}`);
        return { success: false, action: verb, message: msg };
    }

    log.info(`${verb} ${callSid} "${conferenceName}"`);

    const postData = `${POST_FIELDS.CALL_SID}=${encodeURIComponent(callSid)}&${
        POST_FIELDS.CONFERENCE_ID
    }=${encodeURIComponent(conferenceName)}`;

    log.info(`POST data: ${postData}`);

    try {
        const options = createPOSTOptions(origin, 'guardian/talkToSID', postData);
        const response = await sendPOSTrequest(options, postData);
        return {
            success: true,
            action: verb,
            message: `${callSid} "${conferenceName}"`,
            data: response,
        };
    } catch (error) {
        log.error(`Failed to ${verb}. callSID: ${callSid} conferenceName: ${conferenceName}`, error);
        return {
            success: false,
            action: verb,
            message: `${callSid} "${conferenceName}" ${error.message}`,
        };
    }
}

async function hangupSID(origin, callSid, conferenceName) {
    const verb = 'hangupSID';

    // Validate inputs
    if (!callSid || !conferenceName) {
        const msg = `Call SID and conference name are required`;
        log.error(`${verb}: ${msg}`);
        return { success: false, action: verb, message: msg };
    }

    if (!isValidCallSid(callSid)) {
        const msg = `Invalid call SID format: ${callSid}`;
        log.error(`${verb}: ${msg}`);
        return { success: false, action: verb, message: msg };
    }

    log.info(`${verb} ${callSid} "${conferenceName}"`);

    const postData = `${POST_FIELDS.CALL_SID}=${encodeURIComponent(callSid)}&${
        POST_FIELDS.CONFERENCE_ID
    }=${encodeURIComponent(conferenceName)}`;

    log.info(`POST data: ${postData}`);

    try {
        const options = createPOSTOptions(origin, 'guardian/hangupSID', postData);
        const response = await sendPOSTrequest(options, postData);
        return {
            success: true,
            action: verb,
            message: `${callSid} "${conferenceName}"`,
            data: response,
        };
    } catch (error) {
        log.error(`Failed to ${verb}. callSID: ${callSid} conferenceName: ${conferenceName}`, error);
        return {
            success: false,
            action: verb,
            message: `${callSid} "${conferenceName}" ${error.message}`,
        };
    }
}

async function holdSID(origin, callSid, conferenceName) {
    const verb = 'holdSID';

    // Validate inputs
    if (!callSid || !conferenceName) {
        const msg = `Call SID and conference name are required`;
        log.error(`${verb}: ${msg}`);
        return { success: false, action: verb, message: msg };
    }

    if (!isValidCallSid(callSid)) {
        const msg = `Invalid call SID format: ${callSid}`;
        log.error(`${verb}: ${msg}`);
        return { success: false, action: verb, message: msg };
    }

    log.info(`${verb} ${callSid} "${conferenceName}"`);

    const postData = `${POST_FIELDS.CALL_SID}=${encodeURIComponent(callSid)}&${
        POST_FIELDS.CONFERENCE_ID
    }=${encodeURIComponent(conferenceName)}`;

    log.info(`POST data: ${postData}`);

    try {
        const options = createPOSTOptions(origin, 'guardian/holdSID', postData);
        const response = await sendPOSTrequest(options, postData);
        return {
            success: true,
            action: verb,
            message: `${callSid} "${conferenceName}"`,
            data: response,
        };
    } catch (error) {
        log.error(`Failed to ${verb}. callSID: ${callSid} conferenceName: ${conferenceName}`, error);
        return {
            success: false,
            action: verb,
            message: `${callSid} "${conferenceName}" ${error.message}`,
        };
    }
}

async function stopAudio(origin, callSID) {
    const verb = 'audioStop';

    if (!callSID) {
        const msg = `callSID is required`;
        log.error(`${verb}: ${msg}`);
        return { success: false, action: verb, message: msg };
    }

    log.info(`${verb} "${callSID}"`);

    let postData = `&callSID=${encodeURIComponent(callSID)}`;

    log.info(`POST data: ${postData}`);

    try {
        const options = createPOSTOptions(origin, verb, postData);
        const response = await sendPOSTrequest(options, postData);
        return {
            success: true,
            action: verb,
            message: `"${callSID}"`,
            data: response,
        };
    } catch (error) {
        log.error(`Failed to ${verb} callSID: "${callSID}"`, error);
        return {
            success: false,
            action: verb,
            message: `"${callSID}" ${error.message}`,
            error: error.message,
        };
    }
}

async function playAudio(origin, callSID, conferenceName, fileName, sessionId) {
    const verb = 'audioPlay';

    // Validate inputs
    if ((!callSID && !conferenceName) || !fileName || !sessionId) {
        const msg = `ConferenceName | callSID and fileName and sessionId are required`;
        log.error(`${verb}: ${msg}`);
        return { success: false, action: verb, message: msg };
    }

    log.info(`${verb} "${callSID}" "${conferenceName}" "${fileName}" "${sessionId}"`);

    let postData = `audioFileName=${encodeURIComponent(fileName)}&sessionId=${encodeURIComponent(sessionId)}`;
    if (callSID) {
        postData = postData + `&callSID=${encodeURIComponent(callSID)}`;
    }
    if (conferenceName) {
        postData = postData + `&${POST_FIELDS.CONFERENCE_ID}=${encodeURIComponent(conferenceName)}`;
    }

    log.info(`POST data: ${postData}`);

    try {
        const options = createPOSTOptions(origin, verb, postData);
        const response = await sendPOSTrequest(options, postData);
        return {
            success: true,
            action: verb,
            message: `"${callSID}" "${conferenceName}" "${fileName}" "${sessionId}`,
            data: response,
        };
    } catch (error) {
        log.error(
            `Failed to ${verb} callSID: "${callSID}" conferenceName: ${conferenceName} fileName: ${fileName} sessionId: ${sessionId}`,
            error
        );
        return {
            success: false,
            action: verb,
            message: `"${callSID}" "${conferenceName}" "${fileName}" "${sessionId}" ${error.message}`,
            error: error.message,
        };
    }
}

async function callConnect(origin, callSID, conferenceName, telephoneNumber, actor) {
    const verb = 'callConnect';

    // Validate inputs
    if (!conferenceName || !telephoneNumber || !callSID | !actor) {
        const msg = `Missing parameters`;
        log.error(`${verb}: ${msg}`);
        return { success: false, action: verb, message: msg };
    }

    log.info(`${verb} "${callSID}" "${actor}" "${conferenceName}" "${telephoneNumber}"`);

    const postData = `${POST_FIELDS.CALL_SID}=${encodeURIComponent(callSID)}&${
        POST_FIELDS.CONFERENCE_ID
    }=${encodeURIComponent(conferenceName)}&telephoneNumber=${encodeURIComponent(
        telephoneNumber
    )}&actor=${encodeURIComponent(actor)}`;

    log.info(`POST data: ${postData}`);

    try {
        const options = createPOSTOptions(origin, verb, postData);
        const response = await sendPOSTrequest(options, postData);
        return {
            success: true,
            action: verb,
            message: `"${callSID}" "${conferenceName}" "${telephoneNumber}" "${actor}"`,
            data: response,
        };
    } catch (error) {
        log.error(
            `Failed to ${verb} callSID: ${callSID} conferenceName: ${conferenceName} fileName: ${telephoneNumber} actor: ${actor}`,
            error
        );
        return {
            success: false,
            action: verb,
            message: `"${callSID}" "${conferenceName}" "${telephoneNumber}" "${actor}" ${error.message}`,
        };
    }
}

async function talkToActor(origin, actor, conferenceName) {
    const actorSid = await sidDatabase.get(conferenceName, actor);
    if (actorSid) {
        return talkToSID(origin, actorSid, conferenceName);
    }

    log.error(`Failed to talk to actor. No ${actor} SID found for conference: ${conferenceName}`);
}

async function hangupActor(origin, actor, conferenceName) {
    const actorSid = await sidDatabase.get(conferenceName, actor);
    if (actorSid) {
        return hangupSID(origin, actorSid, conferenceName);
    }

    log.error(`Failed to hangup actor. No ${actor} SID found for conference: ${conferenceName}`);
}

async function holdActor(origin, actor, conferenceName) {
    const actorSid = await sidDatabase.get(conferenceName, actor);
    if (actorSid) {
        return holdSID(origin, actorSid, conferenceName);
    }

    log.error(`Failed to hold actor. No ${actor} SID found for conference: ${conferenceName}`);
}

/**
 * Executes a guardian command on a conference
 * @param {string} verb - The command verb (for logging)
 * @param {string} postName - The endpoint path
 * @param {string} conferenceName - Conference name
 * @returns {Promise<Object>} Result of the operation
 */
async function guardianCommand(origin, verb, postName, conferenceName) {
    if (!conferenceName) {
        const msg = `Conference name is required`;
        log.error(`${verb}: ${msg}`);
        return { success: false, action: verb, message: msg };
    }

    log.info(`${verb} "${conferenceName}"`);

    const postData = `${POST_FIELDS.CONFERENCE_ID}=${encodeURIComponent(conferenceName)}`;

    log.info(`POST data: ${postData}`);

    try {
        const options = createPOSTOptions(origin, postName, postData);
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

/**
 * Gets a Twilio client instance
 * @returns {Object} Twilio client
 */
function getTwilioClient() {
    return twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
}

// Cache Twilio client to avoid recreating it
let twilioClientInstance = null;

/**
 * Gets a singleton Twilio client instance
 * @returns {Object} Twilio client
 */
function getOrCreateTwilioClient() {
    if (!twilioClientInstance) {
        twilioClientInstance = getTwilioClient();
    }
    return twilioClientInstance;
}

/**
 * Says a phrase and hangs up a call
 * @param {string} callSid - Twilio Call SID
 * @param {string} phrase - Phrase to say before hangup
 * @returns {Promise<Object>} Result of the operation
 */
async function sayPhrase(callSid, phrase, hangup) {
    const verb = 'sayPhrase';
    if (!callSid) {
        const msg = 'Call SID is required';
        log.error(`${verb}: ${msg}`);
        return { success: false, action: verb, message: msg };
    }

    if (!isValidCallSid(callSid)) {
        const msg = `Invalid call SID format: ${callSid}`;
        log.error(`${verb}: ${msg}`);
        return { success: false, action: verb, message: msg };
    }

    const client = getOrCreateTwilioClient();
    const VoiceResponse = twilio.twiml.VoiceResponse;

    try {
        log.info(`${verb}: saying phrase ${callSid}: "${phrase}" hangup: ${hangup}`);
        const twiml = new VoiceResponse();
        twiml.say({ voice: 'Polly.Amy-Neural', language: 'en-US' }, phrase);
        if (hangup) {
            twiml.leave();
        }

        const result = await client.calls(callSid).update({ twiml: twiml.toString() });
        log.info(`${verb}: call ${callSid} successfully updated with TwiML`);
        return {
            success: true,
            action: verb,
            message: `${callSid}`,
            data: result,
        };
    } catch (error) {
        log.error(`Failed to update call ${callSid} with TwiML`, error);
        return {
            success: false,
            action: verb,
            message: `${callSid} ${error.message}`,
        };
    }
}

/**
 * Retrieves the Guardian phone number
 * This should be implemented to fetch from a database
 * @returns {string} Guardian phone number
 */
function getGuardianPhoneNumber() {
    // TODO: Implement database retrieval
    return '+12063498679'; // Temporary hardcoded value
}

/**
 * Handles a phrase command
 * @param {Object} phrase - Phrase object
 * @param {Object} track - Track object
 * @param {string} callSid - Twilio Call SID
 * @param {string} conferenceName - Conference name
 * @returns {Promise<Object>} Result of the operation
 */
async function handlePhrase(origin, phrase, track, callSid, conferenceName) {
    log.info(`handlePhrase: ${JSON.stringify(phrase)}`);

    const verb = 'handlePhrase';
    if (!phrase) {
        const msg = `Phrase is required`;
        log.error(`${verb}: ${msg}`);
        return { success: false, action: verb, message: msg };
    }

    try {
        // Check if phrase has a type property that's a command
        const cmdstr = phrase.type;

        if (cmdstr && cmdstr.startsWith('cmd:')) {
            const cmd = cmdstr.slice(4);

            switch (cmd) {
                case SUB_COMMANDS.ADD_GUARDIAN: {
                    const guardianPhone = getGuardianPhoneNumber();
                    return await addGuardian(origin, guardianPhone, conferenceName);
                }

                case GUARDIAN_COMMANDS.HOLD_SUB: {
                    return await holdActor(origin, 'SUB', conferenceName);
                }

                case GUARDIAN_COMMANDS.HOLD_OPY: {
                    return await holdActor(origin, 'OPY', conferenceName);
                }

                case GUARDIAN_COMMANDS.TALK_TO_SUB: {
                    return await talkToActor(origin, 'SUB', conferenceName);
                }

                case GUARDIAN_COMMANDS.TALK_TO_OPY: {
                    return await talkToActor(origin, 'OPY', conferenceName);
                }

                case GUARDIAN_COMMANDS.HANGUP_SUB: {
                    return await hangupActor(origin, 'SUB', conferenceName);
                }

                case GUARDIAN_COMMANDS.HANGUP_OPY: {
                    return await hangupActor(origin, 'OPY', conferenceName);
                }

                case GUARDIAN_COMMANDS.TALK_TO_ALL:
                case GUARDIAN_COMMANDS.HANGUP_ALL:
                case GUARDIAN_COMMANDS.DROP_OFF_CALL:
                case GUARDIAN_COMMANDS.MONITOR_CALL: {
                    const postName = 'guardian/' + cmd;
                    return await guardianCommand(origin, cmd, postName, conferenceName);
                }

                default: {
                    const msg = `${verb}: Unknown command: ${cmd}`;
                    log.error(msg);
                    return {
                        success: false,
                        action: verb,
                        message: msg,
                    };
                }
            }
        }

        // If we get here, it wasn't a command, must have been a scam phrase
        log.info(`${verb}: Not a command: ${JSON.stringify(phrase)}`);
        return await sayPhrase(callSid, 'Scam detected. Hanging up', true);
    } catch (error) {
        log.error(`${verb} error:`, error);
        return {
            success: false,
            action: verb,
            message: `${error.message}`,
        };
    }
}

module.exports = {
    handlePhrase,
    sayPhrase,
    playAudio,
    stopAudio,
    callConnect,
};
