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
   * Process a user text turn: agent response + KugelAudio TTS.
   * Returns { userText, responseText, audio, sampleRate, audioFormat, intent, escalated, processingTime }.
   */
  async processText(userText, sessionId, { language } = {}) {
    const startTime = Date.now();
    const session = this.getSession(sessionId);

    if (language) session.context.conversation.language = language;
    const activeLanguage = session.context.conversation.language || this.voiceConfig.language;

    const intentResult = classifyIntent(userText);
    session.context.conversation.intent = intentResult.intent;

    const systemPrompt = this._buildSystemPrompt();
    const history = (session.context.conversation.messages || []).slice(-8).map(m => ({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: m.text,
    }));
    const messages = [
      { role: 'system', content: systemPrompt },
      ...history,
      { role: 'user', content: userText },
    ];

    let responseText;
    let usage;
    try {
      const reply = await this.watsonxClient.chat(messages, { maxTokens: 250, temperature: 0.7 });
      responseText = reply.text?.trim();
      usage = reply.usage;
    } catch (error) {
      console.warn(`[${sessionId}] watsonx chat failed: ${error.message} — falling back to local agent`);
    }
    if (!responseText) {
      responseText = await generateResponse(intentResult.intent, session.context, userText);
    }

    if (intentResult.shouldEscalate) {
      session.context.escalation.triggered = true;
      session.context.escalation.reason = intentResult.intent;
    }

    const tts = await this.kugelAudioClient.textToSpeech(responseText, {
      voiceId: this.voiceConfig.voiceId,
      language: activeLanguage,
    });

    session.messageCount++;
    session.context.conversation.messages.push(
      { role: 'user', text: userText, timestamp: new Date().toISOString() },
      { role: 'assistant', text: responseText, timestamp: new Date().toISOString() },
    );

    return {
      userText,
      responseText,
      language: activeLanguage,
      audio: tts.audio,
      sampleRate: tts.sampleRate,
      audioFormat: tts.audioFormat,
      processingTime: Date.now() - startTime,
      intent: intentResult.intent,
      escalated: intentResult.shouldEscalate,
      usage,
    };
  }

  _buildSystemPrompt() {
    return [
      'You are a friendly, concise customer service voice agent for an automotive dealership.',
      'Always reply in the same language the user writes in.',
      'Keep every response to 1–2 short sentences suitable for being spoken aloud.',
      'Never use markdown, bullet points, lists, or emoji — only plain sentences.',
      'If information is missing, ask a single clarifying question.',
      'If the user sounds upset or mentions a complaint, acknowledge the frustration briefly before helping.',
    ].join(' ');
  }

  /**
   * WebSocket handler — expects JSON control messages.
   *  { type: 'user_text', text, language? } → runs pipeline, responds with JSON + binary audio
   *  { type: 'end_session' } → closes session
   */
  setupAudioStream(ws, sessionId) {
    ws.on('message', async (data) => {
      let message;
      try {
        message = JSON.parse(data.toString());
      } catch {
        ws.send(JSON.stringify({ type: 'error', sessionId, message: 'Expected JSON message' }));
        return;
      }

      try {
        if (message.type === 'user_text') {
          const result = await this.processText(message.text, sessionId, { language: message.language });
          ws.send(JSON.stringify({
            type: 'response',
            sessionId,
            text: result.responseText,
            language: result.language,
            intent: result.intent,
            escalated: result.escalated,
            processingTime: result.processingTime,
            sampleRate: result.sampleRate,
            audioFormat: result.audioFormat,
          }));
          ws.send(result.audio, { binary: true });
        } else if (message.type === 'end_session') {
          this.endSession(sessionId);
          ws.close(1000, 'Session ended');
        }
      } catch (error) {
        console.error(`[${sessionId}] pipeline error:`, error);
        ws.send(JSON.stringify({ type: 'error', sessionId, message: error.message }));
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

    ws.send(JSON.stringify({ type: 'ready', sessionId, message: 'Ready to receive user_text messages' }));
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
