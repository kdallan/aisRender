'use strict';
const { createClient, LiveTranscriptionEvents } = require( "@deepgram/sdk" );
const pino = require('pino');
const log = pino({
    extreme: true,     // For maximum speed
    base: null,        // Removes pid/hostname
    formatters: {
      level: () => ({}),    // Remove level
      bindings: () => ({})  // Remove bindings
    }
  });

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
            
            this.deepgram = this.client?.listen?.live(this.config?.sttConfig);
            
            if (this.keepAliveInterval) {
            	clearInterval(this.keepAliveInterval);
             }
                
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
        
        if (this.isShuttingDown) return; // Don't try to reconnect if we're shutting down
        
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
    	let dg = this.deepgram;
     	if( !dg ) return;   
              
        dg.addListener(LiveTranscriptionEvents.Open, () => {
            log.info("DeepgramSTTService:Open - connection opened");
            this.connected = true;
            this.reconnectAttempts = 0;
            
            dg.addListener(LiveTranscriptionEvents.Transcript, (data) => {
                const transcript = data?.channel?.alternatives?.[0]?.transcript;
                if (!transcript) return;
                
                if (!data.is_final) {
                    this.onTranscript?.(transcript, false);
                    return;
                }
                
                let finals = this.isFinals;
                if( !finals ) return;
                
                finals.push(transcript);
                
                if (data.speech_final) {
                    this.onTranscript?.(finals.join(" "), true);
                    this.isFinals = [];
                } else {
                    this.onTranscript?.(transcript, true);
                }
            });
            
            dg.addListener(LiveTranscriptionEvents.UtteranceEnd, () => {
            	let finals = this.isFinals;
                if (finals && finals.length > 0) {
                    this.onUtteranceEnd?.(finals.join(" "));
                    this.isFinals = [];
                }
            });
        });
        
        dg.addListener(LiveTranscriptionEvents.Close, () => {
            log.info("DeepgramSTTService:Close - connection closed");
            this.connected = false;
            this._handleConnectionFailure();
        });
        
        dg.addListener(LiveTranscriptionEvents.Error, (error) => {
            log.error("DeepgramSTTService:Error - ", error);
            if (!this.connected) this._handleConnectionFailure();
        });
        
        dg.addListener(LiveTranscriptionEvents.Warning, (warning) => {
            log.warn("DeepgramSTTService:Warning - ", warning);
        });
    }
    
    send(audioData) {
        if (!this.connected ||this.isShuttingDown) return;
        
        if( !audioData || !Buffer.isBuffer(audioData) || audioData.length === 0) {
        	log.warn( "DeepgramSTTService:send - no audio data" );
         	return;
        }
        
        let dg = this.deepgram;
        if( !dg ) return;
        
        try {
            dg.send(audioData);
        } catch (error) {
            log.error("DeepgramSTTService:send - failed to send: ", error);
            if (error.message?.includes("not open")) {
                this.connected = false;
                this._handleConnectionFailure();
            }
        }
    }
    
    cleanup() {
        this.isShuttingDown = true;
        this.connected = false;        
        
        let keepalive = this.keepAliveInterval;
        if (keepalive) {
            clearInterval(keepalive);
            this.keepAliveInterval = null;
        }
                
        let dg = this.deepgram;
        if( !dg ) return;
            
        try {
            dg.requestClose();
        } catch (error) {
            log.error("DeepgramSTTService:cleanup: ", error);
        }
        
        this.deepgram = null;        
    }
}

module.exports = DeepgramSTTService;
