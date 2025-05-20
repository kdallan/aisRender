'use strict';
const IORedis = require('ioredis');
const pino = require('pino');
const log = pino({ base: null });
const { performance } = require('perf_hooks');

/**
 * SharedWSS - Enables WebSocket communication across different server instances
 * 
 * This module allows streaming to WebSocket connections regardless of which
 * server instance holds the physical connection, using Redis pub/sub for
 * cross-instance messaging and Redis hashes for tracking mappings.
 */
class SharedWSS {
    constructor() {
        // Use environment variable for Redis URL
        const redisUrl = process.env.REDIS_URL;
        if (!redisUrl) {
            throw new Error('REDIS_URL environment variable is not set');
        }
        
        // Instance identifier (hostname or random UUID)
        this.instanceId = process.env.HOSTNAME || require('crypto').randomUUID();
        
        // Redis channels
        this.channelPrefix = 'wss-stream:';
        this.metaChannelName = 'wss-meta';
        this.myChannel = `${this.channelPrefix}${this.instanceId}`;
        
        // Connection state
        this.redisConnected = false;
        this.shuttingDown = false;
        
        // Local WebSockets
        this.localSessions = new Map();
        
        // Remote connection info
        this.remoteConnections = new Map();
        this.knownInstances = new Map();
        
        // Performance metrics
        this.metrics = {
            messagesSent: 0,
            messagesReceived: 0,
            lastMetricsReset: performance.now(),
            errors: 0
        };
        
        // Setup Redis clients with proper error handling and reconnection
        this._setupRedisClients();
        
        // Setup Redis subscriptions
        this._initialize();
        
        // Heartbeat and cleanup timers
        this._setupTimers();
        
        log.info(`SharedWSS initialized with instance ID: ${this.instanceId}`);
    }
    
    /**
     * Set up Redis clients with proper error handling
     * @private
     */
    _setupRedisClients() {
        const redisUrl = process.env.REDIS_URL;
        const redisOptions = {
            retryStrategy: (times) => {
                const delay = Math.min(times * 100, 3000);
                log.warn(`Redis connection attempt ${times}, retrying in ${delay}ms`);
                return delay;
            },
            maxRetriesPerRequest: 3,
            enableReadyCheck: true
        };
        
        // Data client for storing mappings
        this.redisClient = new IORedis(redisUrl, redisOptions);
        this.redisClient.on('connect', () => log.info('Redis client connected'));
        this.redisClient.on('ready', () => {
            log.info('Redis client ready');
            this.redisConnected = true;
        });
        this.redisClient.on('error', (err) => {
            log.error('Redis client error:', err);
            this.metrics.errors++;
        });
        this.redisClient.on('close', () => {
            log.warn('Redis client connection closed');
            this.redisConnected = false;
        });
        
        // Publisher client
        this.redisPublisher = new IORedis(redisUrl, redisOptions);
        this.redisPublisher.on('connect', () => log.info('Redis publisher connected'));
        this.redisPublisher.on('ready', () => log.info('Redis publisher ready'));
        this.redisPublisher.on('error', (err) => {
            log.error('Redis publisher error:', err);
            this.metrics.errors++;
        });
        this.redisPublisher.on('close', () => log.warn('Redis publisher connection closed'));
        
        // Subscriber client (separate connection for pub/sub)
        this.redisSubscriber = new IORedis(redisUrl, redisOptions);
        this.redisSubscriber.on('connect', () => log.info('Redis subscriber connected'));
        this.redisSubscriber.on('ready', () => log.info('Redis subscriber ready'));
        this.redisSubscriber.on('error', (err) => {
            log.error('Redis subscriber error:', err);
            this.metrics.errors++;
        });
        this.redisSubscriber.on('close', () => log.warn('Redis subscriber connection closed'));
    }
    
    /**
     * Initialize Redis subscriptions
     * @private
     */
    async _initialize() {
        try {
            // Set up Redis subscriptions
            await this._setupRedisSubscriptions();
            
            // Announce this instance
            this._announceInstance();
            
        } catch (error) {
            log.error('Initialization error:', error);
            
            // Retry after delay
            if (!this.shuttingDown) {
                setTimeout(() => this._initialize(), 5000);
            }
        }
    }
    
    /**
     * Set up recurring timers for maintenance operations
     * @private
     */
    _setupTimers() {
        // Heartbeat interval - announce this instance and clean up stale instances
        this.heartbeatInterval = setInterval(() => {
            this._announceInstance();
            this._cleanupStaleInstances();
        }, 30000);
        
        // WebSocket ping interval - detect dead connections
        this.wsPingInterval = setInterval(() => {
            this._pingLocalSessions();
        }, 45000);
        
        // Metrics logging
        if (process.env.METRICS_ENABLED === 'true') {
            this.metricsInterval = setInterval(() => {
                this._logMetrics();
            }, 60000);
        }
    }
    
    /**
     * Ping local WebSocket sessions to detect dead connections
     * @private
     */
    _pingLocalSessions() {
        const now = Date.now();
        let pruned = 0;
        
        // Check each local WebSocket
        for (const [sessionId, ws] of this.localSessions.entries()) {
            // Skip if not a proper WebSocket or already being pinged
            if (!ws || ws._isBeingPinged) continue;
            
            try {
                // Mark WebSocket as being pinged
                ws._isBeingPinged = true;
                ws._lastPingTime = now;
                
                // Send ping and setup timeout
                ws.ping();
                
                // Set a timeout to check if pong received
                setTimeout(() => {
                    // If we haven't received a pong within timeout
                    if (ws._lastPingTime === now) {
                        log.warn(`WebSocket ${sessionId} failed to respond to ping, terminating`);
                        
                        try {
                            // Clean up and terminate
                            this.localSessions.delete(sessionId);
                            ws.terminate();
                            pruned++;
                        } catch (error) {
                            log.error(`Error terminating WebSocket ${sessionId}:`, error);
                        }
                    }
                    
                    // Clear ping state regardless
                    ws._isBeingPinged = false;
                }, 5000);
            } catch (error) {
                log.error(`Error pinging WebSocket ${sessionId}:`, error);
                ws._isBeingPinged = false;
            }
        }
        
        if (pruned > 0) {
            log.info(`Pruned ${pruned} unresponsive WebSockets`);
        }
    }
    
    /**
     * Log performance metrics
     * @private
     */
    _logMetrics() {
        const now = performance.now();
        const elapsed = (now - this.metrics.lastMetricsReset) / 1000;
        
        if (elapsed > 0) {
            const messagesSentPerSec = this.metrics.messagesSent / elapsed;
            const messagesReceivedPerSec = this.metrics.messagesReceived / elapsed;
            
            log.info(`SharedWSS metrics: 
            Messages sent: ${this.metrics.messagesSent} (${messagesSentPerSec.toFixed(2)}/sec)
            Messages received: ${this.metrics.messagesReceived} (${messagesReceivedPerSec.toFixed(2)}/sec)
            Errors: ${this.metrics.errors}
            Local sessions: ${this.localSessions.size}
            Remote connections: ${this.remoteConnections.size}
            Known instances: ${this.knownInstances.size}`);
            
            // Reset metrics
            this.metrics.messagesSent = 0;
            this.metrics.messagesReceived = 0;
            this.metrics.lastMetricsReset = now;
        }
    }
    
    /**
     * Register a WebSocket connection with associated conference and actor
     * @param {string} conferenceUUID - Conference identifier
     * @param {string} actor - Actor role ('SUB', 'OPY', 'GDN')
     * @param {object} ws - WebSocket connection object
     * @param {string} sessionId - WebSocket session ID
     * @returns {Promise<boolean>} - Success status
     */
    async registerConnection(conferenceUUID, actor, ws, sessionId) {
        if (!conferenceUUID || !actor || !ws || !sessionId) {
            log.error('Missing required parameters for registerConnection');
            return false;
        }
        
        try {
            // Store the WebSocket in memory
            this.localSessions.set(sessionId, ws);
            
            // Setup pong handler to update ping state
            ws.on('pong', () => {
                ws._lastPingTime = 0; // Reset ping time on pong received
            });
            
            // Store the mapping in Redis using HSET
            // Key format: conferenceUUID
            // Field: AVA-WSS:{actor}
            // Value: sessionId
            if (this.redisConnected) {
                await this.redisClient.hset(
                    conferenceUUID,
                    `AVA-WSS:${actor}`,
                    sessionId
                );
            } else {
                log.warn(`Redis not connected, only storing WebSocket locally for ${actor} in ${conferenceUUID}`);
            }
            
            // Publish connection information to other instances
            this._publishConnectionInfo(sessionId, conferenceUUID, actor, true);
            
            log.info(`Registered WebSocket with session ${sessionId} for ${actor} in conference ${conferenceUUID}`);
            return true;
        } catch (error) {
            log.error(`Error registering connection for ${actor} in ${conferenceUUID}:`, error);
            return false;
        }
    }
    
    /**
     * Unregister a WebSocket connection
     * @param {string} conferenceUUID - Conference identifier
     * @param {string} actor - Actor role ('SUB', 'OPY', 'GDN')
     * @returns {Promise<boolean>} - Success status
     */
    async unregisterConnection(conferenceUUID, actor) {
        if (!conferenceUUID || !actor) {
            log.error('Missing required parameters for unregisterConnection');
            return false;
        }
        
        try {
            let sessionId = null;
            
            // Get the session ID from Redis
            if (this.redisConnected) {
                sessionId = await this.redisClient.hget(
                    conferenceUUID,
                    `AVA-WSS:${actor}`
                );
            }
            
            if (!sessionId) {
                log.warn(`No session found for ${actor} in conference ${conferenceUUID}`);
                return false;
            }
            
            // If we have this WebSocket locally, remove it
            if (this.localSessions.has(sessionId)) {
                this.localSessions.delete(sessionId);
            }
            
            // Clear the mapping in Redis
            if (this.redisConnected) {
                await this.redisClient.hdel(
                    conferenceUUID,
                    `AVA-WSS:${actor}`
                );
            }
            
            // Publish disconnection information to other instances
            this._publishConnectionInfo(sessionId, conferenceUUID, actor, false);
            
            log.info(`Unregistered WebSocket for ${actor} in conference ${conferenceUUID}`);
            return true;
        } catch (error) {
            log.error(`Error unregistering connection for ${actor} in ${conferenceUUID}:`, error);
            return false;
        }
    }
    
    /**
     * Get session ID for a conference participant
     * @param {string} conferenceUUID - Conference identifier
     * @param {string} actor - Actor role ('SUB', 'OPY', 'GDN')
     * @returns {Promise<string|null>} - Session ID if found
     */
    async getSessionId(conferenceUUID, actor) {
        if (!conferenceUUID || !actor) {
            log.error('Missing required parameters for getSessionId');
            return null;
        }
        
        try {
            // Cannot get session ID if Redis is not connected
            if (!this.redisConnected) {
                log.warn(`Cannot get session ID - Redis not connected`);
                return null;
            }
            
            // Get the session ID from Redis using HGET
            const sessionId = await this.redisClient.hget(
                conferenceUUID,
                `AVA-WSS:${actor}`
            );
            
            return sessionId;
        } catch (error) {
            log.error(`Error getting session ID for ${actor} in ${conferenceUUID}:`, error);
            return null;
        }
    }
    
    /**
     * Send a message to a specific conference participant
     * @param {string} conferenceUUID - Conference identifier
     * @param {string} actor - Actor role ('SUB', 'OPY', 'GDN')
     * @param {string|Buffer|ArrayBuffer} message - Message to send
     * @param {boolean} isBinary - Whether the message is binary
     * @returns {Promise<boolean>} - Success status
     */
    async sendToParticipant(conferenceUUID, actor, message, isBinary = false) {
        if (!conferenceUUID || !actor || !message) {
            log.error('Missing required parameters for sendToParticipant');
            return false;
        }
        
        try {
            // Get the session ID
            const sessionId = await this.getSessionId(conferenceUUID, actor);
            
            if (!sessionId) {
                log.warn(`No session found for ${actor} in conference ${conferenceUUID}`);
                return false;
            }
            
            // Send using the session ID
            return this.sendToConnection(sessionId, message, isBinary);
        } catch (error) {
            log.error(`Error sending to ${actor} in ${conferenceUUID}:`, error);
            return false;
        }
    }
    
    /**
     * Send a message to a WebSocket by session ID
     * @param {string} sessionId - WebSocket session ID
     * @param {string|Buffer|ArrayBuffer} message - Message to send
     * @param {boolean} isBinary - Whether the message is binary
     * @returns {boolean} - Success status
     */
    sendToConnection(sessionId, message, isBinary = false) {
        if (!sessionId || !message) {
            log.error('Missing required parameters for sendToConnection');
            return false;
        }
        
        // Check if it's a local connection first
        if (this.localSessions.has(sessionId)) {
            try {
                const ws = this.localSessions.get(sessionId);
                
                // Check if WebSocket is in a valid state
                if (ws.readyState !== 1) {  // 1 = OPEN
                    log.warn(`WebSocket ${sessionId} not open (state: ${ws.readyState})`);
                    return false;
                }
                
                // Apply backpressure handling
                const bufferedAmount = ws.getBufferedAmount();
                if (bufferedAmount > 1024 * 1024) {  // 1MB threshold
                    log.warn(`Backpressure on local connection ${sessionId}: ${bufferedAmount} bytes buffered`);
                    return false;
                }
                
                // Send the message
                ws.send(message, isBinary);
                this.metrics.messagesSent++;
                return true;
            } catch (error) {
                log.error(`Error sending to local connection ${sessionId}:`, error);
                this.metrics.errors++;
                return false;
            }
        }
        
        // If not local, check if it's a known remote connection
        if (this.remoteConnections.has(sessionId)) {
            if (!this.redisConnected) {
                log.error(`Cannot send to remote connection ${sessionId} - Redis not connected`);
                return false;
            }
            
            const remoteInfo = this.remoteConnections.get(sessionId);
            
            try {
                // Serialize the message if it's not already a string
                let serializedMessage;
                if (typeof message === 'string') {
                    serializedMessage = message;
                } else if (message instanceof Buffer) {
                    serializedMessage = message.toString('base64');
                } else if (message instanceof ArrayBuffer) {
                    serializedMessage = Buffer.from(message).toString('base64');
                } else {
                    log.error(`Unsupported message type for remote connection ${sessionId}`);
                    return false;
                }
                
                // Create the payload
                const payload = JSON.stringify({
                    sessionId,
                    message: serializedMessage,
                    isBinary,
                    encoding: typeof message === 'string' ? 'utf8' : 'base64',
                    timestamp: Date.now()
                });
                
                // Publish to the appropriate channel
                this.redisPublisher.publish(
                    `${this.channelPrefix}${remoteInfo.instanceId}`,
                    payload
                );
                
                this.metrics.messagesSent++;
                return true;
            } catch (error) {
                log.error(`Error sending to remote connection ${sessionId}:`, error);
                this.metrics.errors++;
                return false;
            }
        }
        
        log.warn(`No connection found for session ${sessionId}`);
        return false;
    }
    
    /**
     * Set up Redis subscriptions for inter-instance communication
     * @private
     */
    async _setupRedisSubscriptions() {
        try {
            // Subscribe to our instance-specific channel
            await this.redisSubscriber.subscribe(this.myChannel);
            
            // Subscribe to meta channel for connection events
            await this.redisSubscriber.subscribe(this.metaChannelName);
            
            // Handle incoming messages
            this.redisSubscriber.on('message', (channel, message) => {
                if (channel === this.myChannel) {
                    this._handleStreamMessage(message);
                } else if (channel === this.metaChannelName) {
                    this._handleMetaMessage(message);
                }
            });
            
            log.info(`Subscribed to channels: ${this.myChannel}, ${this.metaChannelName}`);
            return true;
        } catch (error) {
            log.error('Error setting up Redis subscriptions:', error);
            this.metrics.errors++;
            return false;
        }
    }
    
    /**
     * Handle incoming stream messages from other instances
     * @param {string} message - JSON encoded message
     * @private
     */
    _handleStreamMessage(message) {
        try {
            const data = JSON.parse(message);
            const { sessionId, message: content, isBinary, encoding, timestamp } = data;
            
            this.metrics.messagesReceived++;
            
            // Check if the message is too old (over 5 seconds)
            const now = Date.now();
            if (timestamp && now - timestamp > 5000) {
                log.warn(`Discarding stale message for ${sessionId} (${now - timestamp}ms old)`);
                return;
            }
            
            // Check if we have this connection locally
            if (!this.localSessions.has(sessionId)) {
                log.warn(`Received message for unknown session: ${sessionId}`);
                return;
            }
            
            const ws = this.localSessions.get(sessionId);
            
            // Check if WebSocket is still open
            if (ws.readyState !== 1) {  // 1 = OPEN
                log.warn(`Cannot deliver to ${sessionId} - WebSocket not open (state: ${ws.readyState})`);
                return;
            }
            
            // Apply backpressure handling
            const bufferedAmount = ws.getBufferedAmount();
            if (bufferedAmount > 1024 * 1024) {  // 1MB threshold
                log.warn(`Backpressure on local connection ${sessionId}: ${bufferedAmount} bytes buffered`);
                return;
            }
            
            // Decode the message if necessary
            let decodedMessage;
            if (encoding === 'base64') {
                decodedMessage = Buffer.from(content, 'base64');
            } else {
                decodedMessage = content;
            }
            
            // Send to the local WebSocket
            ws.send(decodedMessage, isBinary);
            
            if (log.isLevelEnabled('debug')) {
                log.debug(`Delivered remote message to local session ${sessionId}`);
            }
        } catch (error) {
            log.error('Error handling stream message:', error);
            this.metrics.errors++;
        }
    }
    
    /**
     * Handle meta messages for connection management
     * @param {string} message - JSON encoded meta message
     * @private
     */
    _handleMetaMessage(message) {
        try {
            const data = JSON.parse(message);
            
            if (data.type === 'connection') {
                const { instanceId, sessionId, conferenceUUID, actor, connected, timestamp } = data;
                
                // Ignore our own announcements
                if (instanceId === this.instanceId) return;
                
                if (connected) {
                    // Track the remote connection
                    this.remoteConnections.set(sessionId, {
                        instanceId,
                        conferenceUUID,
                        actor,
                        timestamp
                    });
                    
                    if (log.isLevelEnabled('debug')) {
                        log.debug(`Added remote connection ${sessionId} for ${actor} in ${conferenceUUID} on instance ${instanceId}`);
                    } else {
                        log.info(`Added remote connection for ${actor} in ${conferenceUUID}`);
                    }
                } else {
                    // Remove tracking for the remote connection
                    this.remoteConnections.delete(sessionId);
                    
                    if (log.isLevelEnabled('debug')) {
                        log.debug(`Removed remote connection ${sessionId} for ${actor} in ${conferenceUUID} from instance ${instanceId}`);
                    } else {
                        log.info(`Removed remote connection for ${actor} in ${conferenceUUID}`);
                    }
                }
            } else if (data.type === 'instance_heartbeat') {
                // Update our knowledge of active instances
                const { instanceId, timestamp } = data;
                
                // Skip our own heartbeats
                if (instanceId === this.instanceId) return;
                
                // Store or update instance information
                this.knownInstances.set(instanceId, {
                    timestamp
                });
                
                if (log.isLevelEnabled('debug')) {
                    log.debug(`Received heartbeat from instance ${instanceId}`);
                }
            }
        } catch (error) {
            log.error('Error handling meta message:', error);
            this.metrics.errors++;
        }
    }
    
    /**
     * Publish connection information to other instances
     * @param {string} sessionId - Session identifier
     * @param {string} conferenceUUID - Conference identifier
     * @param {string} actor - Actor role
     * @param {boolean} connected - Whether connected (true) or disconnected (false)
     * @private
     */
    _publishConnectionInfo(sessionId, conferenceUUID, actor, connected) {
        if (!this.redisConnected) {
            log.warn('Cannot publish connection info - Redis not connected');
            return;
        }
        
        const message = JSON.stringify({
            type: 'connection',
            instanceId: this.instanceId,
            sessionId,
            conferenceUUID,
            actor,
            connected,
            timestamp: Date.now()
        });
        
        this.redisPublisher.publish(this.metaChannelName, message)
            .catch(error => {
                log.error('Error publishing connection info:', error);
                this.metrics.errors++;
            });
    }
    
    /**
     * Announce this instance's presence to other instances
     * @private
     */
    _announceInstance() {
        if (!this.redisConnected) {
            log.warn('Cannot announce instance - Redis not connected');
            return;
        }
        
        const message = JSON.stringify({
            type: 'instance_heartbeat',
            instanceId: this.instanceId,
            timestamp: Date.now()
        });
        
        this.redisPublisher.publish(this.metaChannelName, message)
            .catch(error => {
                log.error('Error announcing instance:', error);
                this.metrics.errors++;
            });
    }
    
    /**
     * Clean up stale instances and their connections
     * @private
     */
    _cleanupStaleInstances() {
        const now = Date.now();
        const staleThreshold = 90000; // 90 seconds
        let removedInstances = 0;
        let removedConnections = 0;
        
        // Find stale instances
        for (const [instanceId, info] of this.knownInstances.entries()) {
            if (now - info.timestamp > staleThreshold) {
                // Remove the instance
                this.knownInstances.delete(instanceId);
                removedInstances++;
                
                // Find connections from this instance
                for (const [sessionId, connInfo] of this.remoteConnections.entries()) {
                    if (connInfo.instanceId === instanceId) {
                        this.remoteConnections.delete(sessionId);
                        removedConnections++;
                    }
                }
            }
        }
        
        if (removedInstances > 0 || removedConnections > 0) {
            log.info(`Cleaned up ${removedInstances} stale instances and ${removedConnections} connections`);
        }
    }
    
    /**
     * Clean up resources
     */
    async cleanup() {
        this.shuttingDown = true;
        
        // Clear all intervals
        if (this.heartbeatInterval) {
            clearInterval(this.heartbeatInterval);
            this.heartbeatInterval = null;
        }
        
        if (this.wsPingInterval) {
            clearInterval(this.wsPingInterval);
            this.wsPingInterval = null;
        }
        
        if (this.metricsInterval) {
            clearInterval(this.metricsInterval);
            this.metricsInterval = null;
        }
        
        // Close all Redis connections
        try {
            if (this.redisClient) {
                await this.redisClient.quit();
            }
        } catch (error) {
            log.error('Error closing Redis client:', error);
        }
        
        try {
            if (this.redisPublisher) {
                await this.redisPublisher.quit();
            }
        } catch (error) {
            log.error('Error closing Redis publisher:', error);
        }
        
        try {
            if (this.redisSubscriber) {
                await this.redisSubscriber.quit();
            }
        } catch (error) {
            log.error('Error closing Redis subscriber:', error);
        }
        
        log.info('SharedWSS cleanup complete');
    }
}

module.exports = new SharedWSS();
