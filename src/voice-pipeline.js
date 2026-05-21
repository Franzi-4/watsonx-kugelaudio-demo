import KugelAudioClient from './kugelaudio-client.js';
import { buildAgentContext } from './agents/customer-service-agent.js';
import { getScenario, DEFAULT_SCENARIO_ID } from './agents/scenarios.js';
import { cleanLlmText } from './agents/text-cleanup.js';
import {
  buildClaimStateInstruction,
  correctRepeatedDamageTypeQuestion,
  updateClaimStateFromUserText,
} from './agents/claims-state.js';

/**
 * Voice Pipeline Manager
 *
 * Orchestrates the complete voice AI workflow:
 * 1. Receives audio stream via WebSocket
 * 2. KugelAudio STT → Transcribes speech to text
 * 3. Language detection
 * 4. Routes every dialog turn to the watsonx Orchestrate agent
 * 5. Gets the orchestrated response
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
   * @param {Object} config.orchestrateClient - watsonx Orchestrate chat client
   * @param {Object} config.voiceConfig - Voice configuration (voiceId, language, etc.)
   */
  constructor(config) {
    this.kugelAudioClient = config.kugelAudioClient;
    if (!config.orchestrateClient) {
      throw new Error('VoicePipeline requires orchestrateClient');
    }
    this.orchestrateClient = config.orchestrateClient;
    // Only carry values that the caller actually set. cfgScale / normalize /
    // sampleRate left undefined → not forwarded → SDK falls through to its
    // own defaults (cfg_scale=2.0, normalize=True, sample_rate=24000), which
    // is exactly what the colleague's reference script does. Setting them
    // here would make our `stream_async` call diverge from the script even
    // if the values match — better to be byte-identical.
    this.voiceConfig = {
      voiceId: 'default',
      language: 'de',
      ...(config.voiceConfig || {}),
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
    const scenarioId = options.scenarioId || DEFAULT_SCENARIO_ID;
    const scenario = getScenario(scenarioId);

    const context = buildAgentContext({
      language: options.language || scenario.defaultLanguage || 'en',
      ...options,
    });

    const session = {
      id: sessionId,
      context,
      scenarioId: scenario.id,
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
   * Process a user text turn: Orchestrate response + KugelAudio TTS.
   * Returns { userText, responseText, audio, sampleRate, audioFormat, processingTime }.
   */
  async processText(userText, sessionId, { language, scenarioId, voiceId } = {}) {
    const startTime = Date.now();
    const session = this.getSession(sessionId);

    if (scenarioId && scenarioId !== session.scenarioId) {
      session.scenarioId = scenarioId;
    }
    if (language) session.context.conversation.language = language;
    const activeLanguage = session.context.conversation.language || this.voiceConfig.language;
    const claimState = updateClaimStateFromUserText(session, userText);

    const history = (session.context.conversation.messages || []).slice(-8).map(m => ({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: m.text,
    }));
    const scenario = getScenario(session.scenarioId);
    const turnGuard = [
      scenario.systemPrompt || this._buildSystemPrompt(session.scenarioId),
      'AKTUELLER TURN: Der Kunde hat bereits gesprochen. Antworte deshalb niemals mit einer Begruessung, Vorstellung oder Telefon-Eroeffnung.',
      'Verbotene Phrasen in diesem Turn: "Guten Tag", "hier ist Anton", "schoen, dass Sie anrufen", "schön, dass Sie anrufen".',
      'Wenn die aktuelle Kundeneingabe eine Schadensart enthaelt, bestaetige sie kurz und frage direkt nach dem naechsten fehlenden Feld. Beispiel: "Ich habe den Autounfall notiert. Wo ist der Schaden passiert?"',
      buildClaimStateInstruction(claimState),
    ].filter(Boolean).join('\n');
    const messages = [
      { role: 'system', content: turnGuard },
      ...history,
      { role: 'user', content: userText },
    ];

    const reply = await this.orchestrateClient.chat(messages, {
      context: { sessionId, scenarioId: session.scenarioId },
      threadId: session.orchestrateThreadId,
    });
    if (reply.threadId) session.orchestrateThreadId = reply.threadId;
    const responseText = reply.text?.trim();
    if (!responseText) {
      throw new Error('Orchestrate returned an empty response');
    }

    const cleanedResponseText = correctRepeatedDamageTypeQuestion(
      cleanLlmText(responseText, { language: activeLanguage }),
      claimState,
    );

    const tts = await this.kugelAudioClient.textToSpeech(cleanedResponseText, {
      ...this.ttsOptions(activeLanguage),
      voiceId,  // per-request override; undefined → SDK default voice
    });

    session.messageCount++;
    session.context.conversation.messages.push(
      { role: 'user', text: userText, timestamp: new Date().toISOString() },
      { role: 'assistant', text: cleanedResponseText, timestamp: new Date().toISOString() },
    );

    return {
      userText,
      responseText: cleanedResponseText,
      language: activeLanguage,
      audio: tts.audio,
      sampleRate: tts.sampleRate,
      audioFormat: tts.audioFormat,
      processingTime: Date.now() - startTime,
      orchestratedBy: 'watsonx_orchestrate',
    };
  }

  ttsOptions(language) {
    return {
      voiceId: this.voiceConfig.voiceId,
      language: language || this.voiceConfig.language,
      speed: this.voiceConfig.speed,
      cfgScale: this.voiceConfig.cfgScale,
      normalize: this.voiceConfig.normalize,
    };
  }

  _buildSystemPrompt(scenarioId) {
    const scenario = getScenario(scenarioId);
    if (scenario?.systemPrompt) return scenario.systemPrompt;
    return [
      'You are a helpful, concise voice assistant.',
      'Always reply in the same language the user writes in.',
      'Keep every response to 1–2 short sentences — spoken aloud, not written.',
      'Be direct: no filler openers like "I\'d be happy to help" or "Certainly".',
      'Never use markdown, bullet points, lists, or emoji — only plain sentences.',
      'If a question is ambiguous, ask a single clarifying question instead of guessing.',
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
            orchestratedBy: result.orchestratedBy,
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
      orchestratedBy: 'watsonx_orchestrate',
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
