const { createClient, LiveTranscriptionEvents } = require( "@deepgram/sdk" );

// Simplified logger
const log = {
    info: (msg, data) => console.log(`${msg}`, data || ""),
    error: (msg, err) => console.error(`[ERROR] ${msg}`, err || ""),
    warn: (msg, data) => console.warn(`[WARN] ${msg}`, data || ""),
    debug: (msg, data) => process.env.DEBUG && console.log(`[DEBUG] ${msg}`, data || "")
};

// DeepgramSTTService
class DeepgramSTTService {
    constructor(config, onTranscript, onUtteranceEnd) {
        this.config = config;
        this.onTranscript = onTranscript;
        this.onUtteranceEnd = onUtteranceEnd;
        this.client = createClient(config.apiKey);
        this.deepgram = null;
        this.isFinals = [];
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
            log.info(this.reconnectAttempts > 0 
                     ? `Reconnecting to Deepgram (attempt ${this.reconnectAttempts + 1}/${this.maxReconnectAttempts})...`
                     : "Connecting to Deepgram...");
            
            this.deepgram = this.client.listen.live(this.config.sttConfig);
            
            if (this.keepAliveInterval) clearInterval(this.keepAliveInterval);
            this.keepAliveInterval = setInterval(() => {
                if (this.deepgram && this.connected) this.deepgram.keepAlive();
            }, 10000);
            
            this._setupEventListeners();
            return this.deepgram;
        } catch (error) {
            log.error("Failed to connect to Deepgram STT", error);
            this._handleConnectionFailure();
            return null;
        }
    }
    
    _handleConnectionFailure() {
        this.connected = false;
        
        if (this.isShuttingDown) return; // Don't try to reconnect if we shut down
        
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
    
    _setupEventListeners() {
        // Open event
        this.deepgram.addListener(LiveTranscriptionEvents.Open, () => {
            log.info("Deepgram STT connection opened");
            this.connected = true;
            this.reconnectAttempts = 0;
            
            // Transcript event
            this.deepgram.addListener(LiveTranscriptionEvents.Transcript, (data) => {
                const transcript = data.channel?.alternatives?.[0]?.transcript;
                if (!transcript) return;
                
                if (!data.is_final) {
                    this.onTranscript?.(transcript, false);
                    return;
                }
                
                this.isFinals.push(transcript);
                if (data.speech_final) {
                    this.onTranscript?.(this.isFinals.join(" "), true);
                    this.isFinals = [];
                } else {
                    this.onTranscript?.(transcript, true);
                }
            });
            
            // Utterance end event
            this.deepgram.addListener(LiveTranscriptionEvents.UtteranceEnd, () => {
                if (this.isFinals.length > 0) {
                    this.onUtteranceEnd?.(this.isFinals.join(" "));
                    this.isFinals = [];
                }
            });
        });
        
        // Error and close events
        this.deepgram.addListener(LiveTranscriptionEvents.Close, () => {
            log.info("Deepgram STT connection closed");
            this.connected = false;
            this._handleConnectionFailure();
        });
        
        this.deepgram.addListener(LiveTranscriptionEvents.Error, (error) => {
            log.error("Deepgram STT error: ", error);
            if (!this.connected) this._handleConnectionFailure();
        });
        
        this.deepgram.addListener(LiveTranscriptionEvents.Warning, (warning) => {
            log.warn("Deepgram STT warning: ", warning);
        });
    }
    
    send(audioData) {
        if (!this.connected || !this.deepgram || !audioData || !Buffer.isBuffer(audioData) || audioData.length === 0) return;
        
        try {
            this.deepgram.send(audioData);
        } catch (error) {
            log.error("Failed to send audio to Deepgram: ", error);
            if (error.message?.includes("not open")) {
                this.connected = false;
                this._handleConnectionFailure();
            }
        }
    }
    
    cleanup() {
        this.isShuttingDown = true;
        
        if (this.keepAliveInterval) {
            clearInterval(this.keepAliveInterval);
            this.keepAliveInterval = null;
        }
        
        if (this.deepgram) {
            try {
                this.deepgram.requestClose();
            } catch (error) {
                log.error("Error while closing Deepgram connection: ", error);
            }
            this.deepgram = null;
        }
        
        this.connected = false;
    }
}

module.exports = DeepgramSTTService;
