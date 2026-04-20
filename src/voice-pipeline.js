import KugelAudioClient from './kugelaudio-client.js';
import WatsonxOrchestrateClient from './watsonx-orchestrate-client.js';
import { classifyIntent, generateResponse, buildAgentContext } from './agents/customer-service-agent.js';

/**
 * Voice Pipeline Manager
 *
 * Orchestrates the complete voice AI workflow:
 * 1. Receives audio stream via WebSocket
 * 2. KugelAudio STT → Transcribes speech to text
 * 3. Language detection
 * 4. Routes to watsonx Orchestrate agent
 * 5. Gets response from agent
 * 6. KugelAudio TTS → Synthesizes response with voice cloning
 * 7. Streams audio back to client
 *
 * Latency: 39ms for speech processing with KugelAudio
 */
class VoicePipeline {
  /**
   * Initialize voice pipeline
   * @param {Object} config - Configuration object
   * @param {KugelAudioClient} config.kugelAudioClient - KugelAudio API client
   * @param {WatsonxOrchestrateClient} config.watsonxClient - watsonx Orchestrate client
   * @param {string} config.defaultAgentId - Default agent to route queries to
   * @param {Object} config.voiceConfig - Voice configuration (voiceId, language, etc.)
   */
  constructor(config) {
    this.kugelAudioClient = config.kugelAudioClient;
    this.watsonxClient = config.watsonxClient;
    this.defaultAgentId = config.defaultAgentId;
    this.voiceConfig = config.voiceConfig || {
      voiceId: 'default',
      language: 'en',
      speed: 1.0,
      pitch: 1.0,
    };

    // Session management
    this.activeSessions = new Map();
  }

  /**
   * Create a new voice session
   *
   * @param {string} sessionId - Unique session identifier
   * @param {Object} options - Session options
   * @returns {Object} Session context
   */
  createSession(sessionId, options = {}) {
    const context = buildAgentContext({
      language: options.language || 'en',
      ...options,
    });

    const session = {
      id: sessionId,
      context,
      conversationId: `conv_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      startTime: Date.now(),
      messageCount: 0,
      isActive: true,
    };

    this.activeSessions.set(sessionId, session);
    return session;
  }

  /**
   * Get or create session
   *
   * @param {string} sessionId - Session identifier
   * @param {Object} options - Options if creating new session
   * @returns {Object} Session object
   */
  getSession(sessionId, options = {}) {
    if (this.activeSessions.has(sessionId)) {
      return this.activeSessions.get(sessionId);
    }
    return this.createSession(sessionId, options);
  }

  /**
   * Process audio through the complete voice pipeline
   *
   * @param {Buffer} audioBuffer - Audio buffer to process
   * @param {string} sessionId - Session identifier
   * @returns {Promise<{
   *   text: string,
   *   language: string,
   *   audioBuffer: Buffer,
   *   confidence: number,
   *   processingTime: number
   * }>} Pipeline output
   */
  async processAudio(audioBuffer, sessionId) {
    const startTime = Date.now();

    try {
      const session = this.getSession(sessionId);

      // Step 1: Detect language (39ms latency)
      console.log(`[${sessionId}] Detecting language...`);
      const languageDetection = await this.kugelAudioClient.detectLanguage(audioBuffer);
      const detectedLanguage = languageDetection.language;
      session.context.conversation.language = detectedLanguage;

      // Step 2: Speech-to-text transcription
      console.log(`[${sessionId}] Transcribing speech to text...`);
      const transcription = await this.kugelAudioClient.speechToText(audioBuffer, detectedLanguage);
      const userText = transcription.text;
      const transcriptionConfidence = transcription.confidence || 0.95;

      console.log(`[${sessionId}] Transcribed: "${userText}"`);

      // Step 3: Classify intent
      console.log(`[${sessionId}] Classifying intent...`);
      const intentResult = classifyIntent(userText);
      session.context.conversation.intent = intentResult.intent;

      // Step 4: Route to watsonx Orchestrate agent
      console.log(`[${sessionId}] Sending to watsonx agent...`);
      const agentResponse = await this.watsonxClient.getAgentResponse(
        this.defaultAgentId,
        session.conversationId,
        userText
      );

      const responseText = agentResponse.text || await generateResponse(
        intentResult.intent,
        session.context,
        userText
      );

      // Step 5: Check for escalation
      if (intentResult.shouldEscalate) {
        console.log(`[${sessionId}] Escalation triggered for intent: ${intentResult.intent}`);
        session.context.escalation.triggered = true;
        session.context.escalation.reason = intentResult.intent;
      }

      // Step 6: Text-to-speech synthesis with voice cloning
      console.log(`[${sessionId}] Synthesizing response to speech...`);
      const responseAudio = await this.kugelAudioClient.textToSpeech(
        responseText,
        detectedLanguage,
        this.voiceConfig.voiceId
      );

      // Update session
      session.messageCount++;
      session.context.conversation.messages.push({
        role: 'user',
        text: userText,
        timestamp: new Date().toISOString(),
      });
      session.context.conversation.messages.push({
        role: 'assistant',
        text: responseText,
        timestamp: new Date().toISOString(),
      });

      const processingTime = Date.now() - startTime;

      console.log(`[${sessionId}] Pipeline complete (${processingTime}ms)`);

      return {
        userText,
        responseText,
        language: detectedLanguage,
        audioBuffer: responseAudio,
        confidence: transcriptionConfidence,
        processingTime,
        intent: intentResult.intent,
        escalated: intentResult.shouldEscalate,
      };
    } catch (error) {
      console.error(`[${sessionId}] Pipeline error:`, error);
      throw error;
    }
  }

  /**
   * Stream audio processing with WebSocket
   * Handles chunked audio data from client
   *
   * @param {WebSocket} ws - WebSocket connection
   * @param {string} sessionId - Session identifier
   */
  async setupAudioStream(ws, sessionId) {
    const session = this.getSession(sessionId);
    let audioChunks = [];
    const CHUNK_THRESHOLD = 32000; // Process when 2 seconds of audio accumulated (16kHz sample rate)

    ws.on('message', async (data) => {
      try {
        // Handle binary audio data
        if (Buffer.isBuffer(data)) {
          audioChunks.push(data);

          // Process when threshold reached or on explicit flush signal
          if (Buffer.concat(audioChunks).length >= CHUNK_THRESHOLD) {
            const audioBuffer = Buffer.concat(audioChunks);
            audioChunks = [];

            const result = await this.processAudio(audioBuffer, sessionId);

            // Send response back to client
            ws.send(JSON.stringify({
              type: 'response',
              sessionId,
              text: result.responseText,
              language: result.language,
              intent: result.intent,
              escalated: result.escalated,
              processingTime: result.processingTime,
            }));

            // Send audio data
            ws.send(result.audioBuffer, { binary: true }, (error) => {
              if (error) {
                console.error(`[${sessionId}] Error sending audio:`, error);
              }
            });
          }
        }
        // Handle control messages
        else if (typeof data === 'string') {
          const message = JSON.parse(data);

          if (message.type === 'flush') {
            // Process any remaining audio
            if (audioChunks.length > 0) {
              const audioBuffer = Buffer.concat(audioChunks);
              audioChunks = [];

              const result = await this.processAudio(audioBuffer, sessionId);

              ws.send(JSON.stringify({
                type: 'response',
                sessionId,
                text: result.responseText,
                language: result.language,
                intent: result.intent,
                escalated: result.escalated,
                processingTime: result.processingTime,
              }));

              ws.send(result.audioBuffer, { binary: true });
            }
          } else if (message.type === 'end_session') {
            this.endSession(sessionId);
            ws.close(1000, 'Session ended');
          }
        }
      } catch (error) {
        console.error(`[${sessionId}] Audio stream error:`, error);
        ws.send(JSON.stringify({
          type: 'error',
          sessionId,
          message: error.message,
        }));
      }
    });

    ws.on('close', () => {
      console.log(`[${sessionId}] WebSocket closed`);
      this.endSession(sessionId);
    });

    ws.on('error', (error) => {
      console.error(`[${sessionId}] WebSocket error:`, error);
      this.endSession(sessionId);
    });

    // Send ready signal
    ws.send(JSON.stringify({
      type: 'ready',
      sessionId,
      message: 'Ready to receive audio',
    }));
  }

  /**
   * End voice session
   *
   * @param {string} sessionId - Session identifier
   */
  endSession(sessionId) {
    const session = this.activeSessions.get(sessionId);
    if (session) {
      session.isActive = false;
      const duration = Date.now() - session.startTime;

      console.log(`[${sessionId}] Session ended. Duration: ${duration}ms, Messages: ${session.messageCount}`);

      // Remove from active sessions after a delay
      setTimeout(() => {
        this.activeSessions.delete(sessionId);
      }, 60000); // Keep for 1 minute for reference
    }
  }

  /**
   * Get session statistics
   *
   * @param {string} sessionId - Session identifier
   * @returns {Object} Session stats
   */
  getSessionStats(sessionId) {
    const session = this.activeSessions.get(sessionId);
    if (!session) return null;

    return {
      sessionId,
      duration: Date.now() - session.startTime,
      messageCount: session.messageCount,
      language: session.context.conversation.language,
      isActive: session.isActive,
      escalated: session.context.escalation.triggered,
    };
  }

  /**
   * Get all active sessions
   *
   * @returns {Array} Active session information
   */
  getActiveSessions() {
    const sessions = [];
    for (const [sessionId, session] of this.activeSessions) {
      if (session.isActive) {
        sessions.push({
          sessionId,
          duration: Date.now() - session.startTime,
          messageCount: session.messageCount,
        });
      }
    }
    return sessions;
  }
}

export default VoicePipeline;
