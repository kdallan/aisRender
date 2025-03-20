// Modified CallSession class with performance optimizations
class CallSession {
  constructor(webSocket, services) {
    this.ws = webSocket;
    this.services = services;
    this.callSid = null;
    this.streamSid = null;
    this.active = true;
    this.hangupInitiated = false;
    this.hasSeenMedia = false;
    
    // Counters and audio handling
    this.receivedPackets = 0;
    this.inboundPackets = 0;
    this.silencePackets = 0;
    
    // 1. SEPARATE TRACK PROCESSING - Create separate buffers for each track
    this.audioAccumulator = { inbound: [], outbound: [] };
    this.audioAccumulatorSize = { inbound: 0, outbound: 0 };
    this.lastProcessingTime = { inbound: 0, outbound: 0 };
    this.processingStartTime = { inbound: 0, outbound: 0 };
    
    // 2. ADAPTIVE BUFFER MANAGEMENT - Add parameters
    this.bufferSizeThreshold = { inbound: 2 * 1024, outbound: 2 * 1024 }; // 2 KB initially
    this.flushTimer = { inbound: null, outbound: null };
    this.flushInterval = { 
      inbound: this.services.config.deepgram.throttleInterval,
      outbound: this.services.config.deepgram.throttleInterval
    };
    
    // 4. ERROR RESILIENCE - Add maximum sizes and circuit breaker
    this.MAX_BUFFER_SIZE = 30 * 1024; // 30 KB absolute maximum
    this.consecutiveErrors = { inbound: 0, outbound: 0 };
    this.MAX_CONSECUTIVE_ERRORS = 5;
    
    // 5. PERFORMANCE MONITORING
    this.metrics = {
      processingTimes: { inbound: [], outbound: [] },
      bufferGrowth: { inbound: [], outbound: [] },
      lastMetricTime: Date.now(),
      delays: { inbound: 0, outbound: 0 }
    };
    
    // Initialize STT services - one for each track
    this.sttService = {
      inbound: new DeepgramSTTService(
        this.services.config.deepgram,
        (transcript, isFinal) => this._handleTranscript(transcript, isFinal, 'inbound'),
        (utterance) => this._handleUtteranceEnd(utterance, 'inbound')
      ),
      outbound: new DeepgramSTTService(
        this.services.config.deepgram,
        (transcript, isFinal) => this._handleTranscript(transcript, isFinal, 'outbound'),
        (utterance) => this._handleUtteranceEnd(utterance, 'outbound')
      )
    };
    
    // Setup WebSocket handlers
    this.ws.on("message", this._handleMessage.bind(this));
    this.ws.on("close", this._handleClose.bind(this));
    this.ws.on("error", (error) => log.error("WebSocket error:", error));
    
    // Setup stats logging with enhanced metrics
    this.statsTimer = setInterval(() => {
      if (this.receivedPackets > 0) {
        // Regular stats
        log.info(`Call stats: total=${this.receivedPackets}, inbound=${this.inboundPackets}, silence=${this.silencePackets}`);
        
        // 5. PERFORMANCE MONITORING - Log enhanced metrics
        const now = Date.now();
        const avgProcessingTimeInbound = this._calculateAverage(this.metrics.processingTimes.inbound);
        const avgProcessingTimeOutbound = this._calculateAverage(this.metrics.processingTimes.outbound);
        
        log.info(`Performance metrics: 
          Inbound: buffer=${this.audioAccumulatorSize.inbound} bytes, avgProcessing=${avgProcessingTimeInbound.toFixed(2)}ms, delay=${this.metrics.delays.inbound.toFixed(2)}ms
          Outbound: buffer=${this.audioAccumulatorSize.outbound} bytes, avgProcessing=${avgProcessingTimeOutbound.toFixed(2)}ms, delay=${this.metrics.delays.outbound.toFixed(2)}ms`
        );
        
        // Reset metrics for next interval
        this.metrics.processingTimes = { inbound: [], outbound: [] };
        this.metrics.bufferGrowth = { inbound: [], outbound: [] };
        this.metrics.lastMetricTime = now;
      }
    }, 10000);
    
    log.info("New call session created with optimized processing");
  }
  
  // Helper for calculating averages
  _calculateAverage(array) {
    return array.length > 0 ? array.reduce((a, b) => a + b, 0) / array.length : 0;
  }
  
  // 3. IMPROVED TIMER LOGIC - Track-specific flush timer management
  stopFlushTimer(track) {
    if (this.flushTimer[track]) {
      clearTimeout(this.flushTimer[track]);
      this.flushTimer[track] = null;
    }    
  }
  
  startFlushTimer(track) {
    // Cancel the previous timer, if any        
    this.stopFlushTimer(track);
    
    if (this.isShuttingDown) {
      return;
    }
    
    // 3. IMPROVED TIMER LOGIC - Adaptive interval based on processing time
    const baseInterval = this.flushInterval[track];
    const processingTime = this.lastProcessingTime[track];
    let interval = baseInterval;
    
    // If processing is taking longer, increase the interval
    if (processingTime > baseInterval) {
      interval = Math.min(processingTime * 1.5, 200); // Cap at 200ms
      this.metrics.delays[track] = processingTime - baseInterval;
    } else {
      interval = Math.max(baseInterval - 5, 10); // Try to catch up, but not too fast
      this.metrics.delays[track] = 0;
    }
    
    // Schedule the timer
    this.flushTimer[track] = setTimeout(() => {
      this.flushAudioBuffer(track);
    }, interval);
  }
  
  flushAudioBuffer(track) {
    this.stopFlushTimer(track);
    
    if (this.audioAccumulatorSize[track] > 0) {
      // 5. PERFORMANCE MONITORING - Record start time
      this.processingStartTime[track] = Date.now();
      
      const combinedBuffer = Buffer.concat(this.audioAccumulator[track]);
      
      try {
        if (this.sttService[track]?.connected) {
          log.debug(`Flushing ${track} track: ${this.audioAccumulator[track].length} buffers, size: ${combinedBuffer.length} bytes`);
          this.sttService[track].send(combinedBuffer);
          
          // 4. ERROR RESILIENCE - Reset error counter on success
          this.consecutiveErrors[track] = 0;
        } else {
          log.warn(`STT service not connected for ${track} track, dropping audio`);
          this.consecutiveErrors[track]++;
        }
      } catch (error) {
        log.error(`Error sending ${track} audio to Deepgram`, error);
        this.consecutiveErrors[track]++;
      } finally {
        // 4. ERROR RESILIENCE - Always clear the buffer
        this.audioAccumulator[track] = [];
        this.audioAccumulatorSize[track] = 0;
        
        // 5. PERFORMANCE MONITORING - Record processing time
        const processingTime = Date.now() - this.processingStartTime[track];
        this.lastProcessingTime[track] = processingTime;
        this.metrics.processingTimes[track].push(processingTime);
      }
      
      // 4. ERROR RESILIENCE - Implement circuit breaker
      if (this.consecutiveErrors[track] >= this.MAX_CONSECUTIVE_ERRORS) {
        log.error(`Circuit breaker triggered for ${track} track after ${this.consecutiveErrors[track]} errors`);
        // Attempt to reconnect the STT service
        if (this.sttService[track]) {
          this.sttService[track].cleanup();
          this.sttService[track] = new DeepgramSTTService(
            this.services.config.deepgram,
            (transcript, isFinal) => this._handleTranscript(transcript, isFinal, track),
            (utterance) => this._handleUtteranceEnd(utterance, track)
          );
        }
        this.consecutiveErrors[track] = 0;
      }
    }
    
    // 3. IMPROVED TIMER LOGIC - Only restart if we're still active
    if (this.active && !this.isShuttingDown) {
      this.startFlushTimer(track);
    }
  }
  
  accumulateAudio(buffer, track) {
    this.audioAccumulator[track].push(buffer);
    this.audioAccumulatorSize[track] += buffer.length;
    
    // 5. PERFORMANCE MONITORING - Track buffer growth
    this.metrics.bufferGrowth[track].push(buffer.length);
    
    // 2. ADAPTIVE BUFFER MANAGEMENT - Adjust threshold based on processing time
    const processingTime = this.lastProcessingTime[track];
    if (processingTime > 0) {
      // If processing is fast, we can use smaller buffers
      if (processingTime < 10) {
        this.bufferSizeThreshold[track] = Math.max(1024, this.bufferSizeThreshold[track] - 128);
      } 
      // If processing is slow, use larger buffers to reduce overhead
      else if (processingTime > 50) {
        this.bufferSizeThreshold[track] = Math.min(8 * 1024, this.bufferSizeThreshold[track] + 256);
      }
    }
    
    // 4. ERROR RESILIENCE - Enforce maximum buffer size
    if (this.audioAccumulatorSize[track] >= this.MAX_BUFFER_SIZE) {
      log.warn(`${track} buffer exceeded maximum size (${this.MAX_BUFFER_SIZE} bytes), flushing immediately`);
      this.flushAudioBuffer(track);
      return;
    }
    
    if (this.audioAccumulatorSize[track] >= this.bufferSizeThreshold[track]) {
      this.flushAudioBuffer(track);
    } else if (!this.flushTimer[track]) {
      this.startFlushTimer(track);
    }
  }
  
  _hasAudioEnergy(base64Payload, threshold = 0.2, mulawThreshold = 0x68) {
    try {
      const binary = Buffer.from(base64Payload, "base64");
      if (binary.length < 10) return true;
      
      let nonSilenceCount = 0;
      const samples = Math.ceil(binary.length / 8);
      
      for (let i = 0; i < binary.length; i += 8) {
        if (binary[i] < mulawThreshold) nonSilenceCount++;
      }
      
      return nonSilenceCount / samples > threshold;
    } catch {
      return true;
    }
  }
  
  // Message handling
  _handleMessage(message) {
    if (!this.active) return;
    
    let data;
    try {
      // Parse message into JSON
      if (Buffer.isBuffer(message)) {
        data = JSON.parse(message.toString("utf8"));
      } else if (typeof message === "string") {
        data = JSON.parse(message);
      } else {
        return;
      }
      
      // Process by event type
      switch (data.event) {
        case "connected":
          log.info("Twilio: Connected event received");
          break;
          
        case "start":
          this.callSid = data.start?.callSid || data.callSid;
          if (this.callSid) {
            log.info(`Twilio: Call started, SID: ${this.callSid}`);
          }
          break;
          
        case "media":
          this.receivedPackets++;
          
          // Handle first media packet
          if (!this.hasSeenMedia) {
            this.hasSeenMedia = true;
            log.info("Twilio: First media event received");
          }
          
          // Track stream SID
          if (!this.streamSid && data.streamSid) {
            this.streamSid = data.streamSid;
            log.info(`Twilio: Stream SID: ${this.streamSid}`);
          }
          
          // Process audio payload
          if (data.media?.payload) {
            // 1. SEPARATE TRACK PROCESSING - Handle tracks separately
            if (data.media.track === "inbound" || data.media.track === "outbound") {
              this.inboundPackets++;
              const payload = data.media.payload;
              const track = data.media.track;
              
              // Skip processing if it's silence
              const STRIP_SILENCE = false;
              if (!STRIP_SILENCE || this._hasAudioEnergy(payload)) {
                const rawAudio = Buffer.from(payload, "base64");
                this.accumulateAudio(rawAudio, track); // Pass track information
              } else {
                this.silencePackets++;
              }
            }
          }
          break;
          
        case "close":
          log.info("Twilio: Close event received");
          this._cleanup();
          break;
      }
    } catch (error) {
      log.error("Error processing message", error);
    }
  }
  
  // Transcript handling - now includes track information
  _handleTranscript(transcript, isFinal, track) {
    if (!this.active || this.hangupInitiated) return;
    
    log.info(`[${track}][${isFinal ? 'Final' : 'Interim'}] ${transcript}`);
    
    // Only process commands from the inbound track
    if (track === 'inbound' && isFinal) {
      // Check for commands in transcript
      if (config.commands.hangup.test(transcript)) {
        log.info("Hangup command detected in transcript");
        this._handleHangup("Thank you for calling. Goodbye.");
      } else if (config.commands.goodbye.test(transcript)) {
        log.info("Goodbye command detected in transcript");
        this._handleHangup("We appreciate your call. Have a great day!");
      }
    }
  }
  
  _handleUtteranceEnd(utterance, track) {
    if (this.active) log.info(`[${track}] Complete utterance: ${utterance}`);
  }
  
  // Call control
  async _handleHangup(customPhrase) {
    if (!this.active || !this.callSid || this.hangupInitiated) return;
    
    try {
      this.hangupInitiated = true;
      log.info(`Initiating hangup for call ${this.callSid}${customPhrase ? ` with message: "${customPhrase}"` : ""}`);
      
      if (customPhrase) {
        await this.services.twilioService.sayPhraseAndHangup(this.callSid, customPhrase);
      } else {
        await this.services.twilioService.hangupCall(this.callSid);
      }
    } catch (error) {
      log.error("Failed to hang up call", error);
      this.hangupInitiated = false;
    }
  }
  
  _handleClose() {
    log.info("Twilio: Connection closed");
    this._cleanup();
  }
  
  _cleanup() {
    if (!this.active) return;
    
    this.active = false;
    this.hangupInitiated = false;
    this.isShuttingDown = true;
    
    // Clear timers
    if (this.statsTimer) {
      clearInterval(this.statsTimer);
      this.statsTimer = null;
    }
    
    // Stop flush timers for both tracks
    this.stopFlushTimer('inbound');
    this.stopFlushTimer('outbound');
    
    // Clean up services for both tracks
    if (this.sttService.inbound) {
      this.sttService.inbound.cleanup();
      this.sttService.inbound = null;
    }
    
    if (this.sttService.outbound) {
      this.sttService.outbound.cleanup();
      this.sttService.outbound = null;
    }
    
    // Close WebSocket
    if (this.ws) {
      try {
        if (this.ws.readyState === WebSocket.OPEN) {
          this.ws.terminate();
        }
        this.ws.removeAllListeners();
      } catch (err) {
        log.error("Error terminating WebSocket", err);
      }
      this.ws = null;
    }
    
    log.info(`Call session cleaned up, Call SID: ${this.callSid || "unknown"}, processed ${this.receivedPackets} packets`);
  }
}
