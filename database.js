'use strict';

const IORedis = require('ioredis');
const pino = require('pino');
const log = pino({ base: null });

let redis = null; // Module-scoped client instance

// Initialization
try {
    const redisUrl = process.env.REDIS_URL;
    if (!redisUrl) {
        throw new Error('REDIS_URL environment variable is not set.');
    }
    // Use lazyConnect so connect() is required
    redis = new IORedis(redisUrl, { lazyConnect: true });

    // Simplified essential listeners
    redis.on('connect', () => log.info('Redis: Connected.'));
    // 'ready' indicates usable connection
    redis.on('ready', () => log.info('Redis: Ready.'));
    redis.on('error', (error) => console.error('Redis Error:', error));
    redis.on('end', () => log.info('Redis: Connection ended.'));
} catch (err) {
    log.error('Failed to initialize Redis client:', err.message);
    redis = null;
}

async function connect() {
    if (!redis) return Promise.reject(new Error('Redis client not initialized.'));
    if (redis.status === 'ready') return Promise.resolve();
    if (redis.status === 'connecting' || redis.status === 'reconnecting' || redis.status === 'connect') {
        log.info('Redis connection/reconnection already in progress. Waiting for ready state...');
        // Fall through to wait for 'ready'
    } else {
        log.info('Redis: Attempting connection...');
        try {
            // Initiate connection if not already attempting
            await redis.connect();
        } catch (error) {
            log.error('Redis: Explicit connect call failed:', error);
            throw error; // Rethrow connection initiation error
        }
    }

    // Wait until the client is fully ready or an error/end occurs
    return new Promise((resolve, reject) => {
        if (redis.status === 'ready') {
            resolve();
            return;
        }
        // Handlers to resolve/reject based on subsequent events
        const readyHandler = () => {
            clearTimeout(timeoutHandler); // Clear timeout if ready fires
            removeListeners();
            resolve();
        };
        const errorHandler = (err) => {
            clearTimeout(timeoutHandler);
            removeListeners();
            reject(err);
        };
        const endHandler = () => {
            clearTimeout(timeoutHandler);
            removeListeners();
            reject(new Error('Redis connection ended while waiting for ready state.'));
        };
        // Safety timeout (e.g., 10 seconds)
        const timeoutHandler = setTimeout(() => {
            removeListeners();
            reject(new Error('Redis connection timed out while waiting for ready state.'));
        }, 10000);

        const removeListeners = () => {
            redis.removeListener('ready', readyHandler);
            redis.removeListener('error', errorHandler);
            redis.removeListener('end', endHandler);
        };

        redis.once('ready', readyHandler);
        redis.once('error', errorHandler);
        redis.once('end', endHandler);
    });
}

async function disconnect() {
    if (redis && redis.status !== 'end') {
        try {
            await redis.quit();
        } catch (error) {
            log.error('Redis: Error during quit:', error);
        }
    }
}

async function set(key, field, value) {
    if (!redis || redis.status !== 'ready') throw new Error('Redis client not ready.');

    if (!key || !field || value === undefined || value === null) {
        const err = `Invalid input for set: key=${key}, field=${field}`;
        log.error(err);
        return Promise.reject(new Error(err));
    }

    try {
        // HSET stores values as strings
        return await redis.hset(key, field, String(value));
    } catch (error) {
        log.error(`Redis HSET Error for key "${key}", field "${field}":`, error);
    }
}

async function get(key, field) {
    if (!redis || redis.status !== 'ready') throw new Error('Redis client not ready.');

    if (!key || !field) {
        const err = `Missing hget: key=${key}, field=${field}`;
        log.error(err);
        return Promise.reject(new Error(err));
    }

    try {
        return await redis.hget(key, field); // Returns string or null
    } catch (error) {
        log.error(`Redis HGET Error for key "${key}", field "${field}":`, error);
        return null;
    }
}

/**
 * Add a phone number to a subscriber's safe numbers set
 * @param {string} subscriberId - The subscriber's ID
 * @param {string} phoneNumber - The phone number to add
 * @returns {Promise<number>} - Number of elements added to the set
 */
async function addSubscriberPhone(subscriberId, phoneNumber) {
    if (!redis || redis.status !== 'ready') throw new Error('Redis client not ready.');
    
    if (!subscriberId || !phoneNumber) {
        const err = 'Subscriber ID and phone number cannot be empty';
        log.error(err);
        return Promise.reject(new Error(err));
    }

    const key = `subscriber:${subscriberId}:phones`;
    
    try {
        return await redis.sadd(key, phoneNumber);
    } catch (error) {
        log.error(`Redis SADD Error for subscriber "${subscriberId}", phone "${phoneNumber}":`, error);
        throw error;
    }
}

/**
 * Add multiple phone numbers to a subscriber's safe numbers set
 * @param {string} subscriberId - The subscriber's ID
 * @param {string[]} phoneNumbers - Array of phone numbers to add
 * @returns {Promise<number>} - Number of elements added to the set
 */
async function addSubscriberPhones(subscriberId, phoneNumbers) {
    if (!redis || redis.status !== 'ready') throw new Error('Redis client not ready.');
    
    if (!subscriberId || !phoneNumbers || !Array.isArray(phoneNumbers) || phoneNumbers.length === 0) {
        const err = 'Subscriber ID must be provided and phone numbers must be a non-empty array';
        log.error(err);
        return Promise.reject(new Error(err));
    }

    const key = `subscriber:${subscriberId}:phones`;
    
    try {
        return await redis.sadd(key, ...phoneNumbers);
    } catch (error) {
        log.error(`Redis SADD Error for subscriber "${subscriberId}", multiple phones:`, error);
        throw error;
    }
}

/**
 * Check if a phone number is in a subscriber's safe numbers set
 * @param {string} subscriberId - The subscriber's ID
 * @param {string} phoneNumber - The phone number to check
 * @returns {Promise<boolean>} - True if the number is in the set, false otherwise
 */
async function isSubscriberPhone(subscriberId, phoneNumber) {
    if (!redis || redis.status !== 'ready') throw new Error('Redis client not ready.');
    
    if (!subscriberId || !phoneNumber) {
        const err = 'Subscriber ID and phone number cannot be empty';
        log.error(err);
        return Promise.reject(new Error(err));
    }

    const key = `subscriber:${subscriberId}:phones`;
    
    try {
        const result = await redis.sismember(key, phoneNumber);
        return result === 1;
    } catch (error) {
        log.error(`Redis SISMEMBER Error for subscriber "${subscriberId}", phone "${phoneNumber}":`, error);
        return false;
    }
}

/**
 * Get all phone numbers for a subscriber
 * @param {string} subscriberId - The subscriber's ID
 * @returns {Promise<string[]>} - Array of all subscriber's phone numbers
 */
async function getSubscriberPhones(subscriberId) {
    if (!redis || redis.status !== 'ready') throw new Error('Redis client not ready.');
    
    if (!subscriberId) {
        const err = 'Subscriber ID cannot be empty';
        log.error(err);
        return Promise.reject(new Error(err));
    }

    const key = `subscriber:${subscriberId}:phones`;
    
    try {
        return await redis.smembers(key);
    } catch (error) {
        log.error(`Redis SMEMBERS Error for subscriber "${subscriberId}":`, error);
        return [];
    }
}

/**
 * Remove a phone number from a subscriber's set
 * @param {string} subscriberId - The subscriber's ID
 * @param {string} phoneNumber - The phone number to remove
 * @returns {Promise<number>} - Number of elements removed from the set
 */
async function removeSubscriberPhone(subscriberId, phoneNumber) {
    if (!redis || redis.status !== 'ready') throw new Error('Redis client not ready.');
    
    if (!subscriberId || !phoneNumber) {
        const err = 'Subscriber ID and phone number cannot be empty';
        log.error(err);
        return Promise.reject(new Error(err));
    }

    const key = `subscriber:${subscriberId}:phones`;
    
    try {
        return await redis.srem(key, phoneNumber);
    } catch (error) {
        log.error(`Redis SREM Error for subscriber "${subscriberId}", phone "${phoneNumber}":`, error);
        throw error;
    }
}

/**
 * Remove all phone numbers for a subscriber
 * @param {string} subscriberId - The subscriber's ID
 * @returns {Promise<number>} - Number of elements removed (0 if key didn't exist)
 */
async function removeAllSubscriberPhones(subscriberId) {
    if (!redis || redis.status !== 'ready') throw new Error('Redis client not ready.');
    
    if (!subscriberId) {
        const err = 'Subscriber ID cannot be empty';
        log.error(err);
        return Promise.reject(new Error(err));
    }

    const key = `subscriber:${subscriberId}:phones`;
    
    try {
        return await redis.del(key);
    } catch (error) {
        log.error(`Redis DEL Error for subscriber "${subscriberId}":`, error);
        throw error;
    }
}


module.exports = {
    connect,
    disconnect,
    set,
    get,
    addSubscriberPhone,
    addSubscriberPhones,
    isSubscriberPhone,
    getSubscriberPhones,
    removeSubscriberPhone,
    removeAllSubscriberPhones    
};
