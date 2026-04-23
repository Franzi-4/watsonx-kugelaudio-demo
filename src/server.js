import dotenv from 'dotenv';
import express from 'express';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import KugelAudioClient from './kugelaudio-client.js';
import WatsonxClient from './watsonx-client.js';
import VoicePipeline from './voice-pipeline.js';
import { listScenarios, getScenario, DEFAULT_SCENARIO_ID } from './agents/scenarios.js';

// Wrap raw PCM16 LE bytes in a minimal WAV container so browsers can <audio src>.
function pcmToWav(pcm, sampleRate, channels = 1, bitsPerSample = 16) {
  const byteRate = sampleRate * channels * (bitsPerSample / 8);
  const blockAlign = channels * (bitsPerSample / 8);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

// Load environment variables
dotenv.config();

// Initialize Express app
const app = express();
const httpServer = createServer(app);

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static files from public directory
app.use(express.static('public'));

// Initialize clients
const kugelAudioClient = new KugelAudioClient({
  apiKey: process.env.KUGELAUDIO_API_KEY,
  apiUrl: process.env.KUGELAUDIO_API_URL,
  modelId: process.env.KUGELAUDIO_MODEL_ID || 'kugel-2-turbo',
});

const watsonxClient = new WatsonxClient({
  apiKey: process.env.WATSONX_API_KEY,
  url: process.env.WATSONX_URL,
  projectId: process.env.WATSONX_PROJECT_ID,
});

// Per-scenario fine-tuned deployment ids (optional). If set, streaming
// requests for that scenario route to /ml/v1/deployments/{id}/text/chat_stream
// instead of the foundation-model endpoint.
const SCENARIO_DEPLOYMENTS = {
  claims: process.env.WATSONX_DEPLOYMENT_ID_CLAIMS || null,
  hotline: process.env.WATSONX_DEPLOYMENT_ID_HOTLINE || null,
};
for (const [id, dep] of Object.entries(SCENARIO_DEPLOYMENTS)) {
  if (dep) console.log(`[watsonx] scenario "${id}" → deployment ${dep}`);
}

// Initialize voice pipeline
const voicePipeline = new VoicePipeline({
  kugelAudioClient,
  watsonxClient,
  defaultAgentId: process.env.DEFAULT_AGENT_ID || 'customer-service-agent',
  voiceConfig: {
    voiceId: process.env.KUGELAUDIO_VOICE_ID || 'default',
    language: process.env.KUGELAUDIO_LANGUAGE || 'de',
    // `speed` not supported by voice 977 / kugel-2-turbo (returns 500 NameError).
    // Only sent if KUGELAUDIO_SPEED is explicitly set; otherwise client-side
    // <audio>.playbackRate handles speedup.
    speed: process.env.KUGELAUDIO_SPEED ? Number(process.env.KUGELAUDIO_SPEED) : undefined,
    cfgScale: Number(process.env.KUGELAUDIO_CFG_SCALE) || 2.0,
    normalize: true,
  },
});

// Initialize WebSocket server
const wss = new WebSocketServer({ server: httpServer });

// ============================================================================
// REST API ENDPOINTS
// ============================================================================

/**
 * Health Check Endpoint
 * GET /api/health
 *
 * Returns the health status of the service and its dependencies
 */
app.get('/api/health', async (req, res) => {
  try {
    const kugelAudioHealth = await kugelAudioClient.healthCheck();
    const watsonxHealth = await watsonxClient.healthCheck();

    const status = kugelAudioHealth && watsonxHealth ? 'healthy' : 'degraded';
    const statusCode = status === 'healthy' ? 200 : 503;

    res.status(statusCode).json({
      status,
      timestamp: new Date().toISOString(),
      services: {
        kugelaudio: kugelAudioHealth ? 'up' : 'down',
        watsonx_ai: watsonxHealth ? 'up' : 'down',
        watsonx_orchestrate: process.env.ORCHESTRATE_URL ? 'provisioned' : 'missing',
        watsonx_governance: process.env.GOVERNANCE_GUID ? 'provisioned' : 'missing',
      },
      orchestrate: process.env.ORCHESTRATE_URL ? {
        launch_url: process.env.ORCHESTRATE_URL + '/chat',
        agent: process.env.ORCHESTRATE_AGENT || 'AskOrchestrate',
      } : null,
      model: 'meta-llama/llama-3-3-70b-instruct',
    });
  } catch (error) {
    res.status(500).json({
      status: 'error',
      message: error.message,
    });
  }
});

/**
 * List Available Agents
 * GET /api/agents
 *
 * Returns all available watsonx Orchestrate agents
 */
app.get('/api/agents', async (req, res) => {
  try {
    const agents = await watsonxClient.listAgents();
    res.json({
      agents,
      count: agents.length,
    });
  } catch (error) {
    res.status(500).json({
      error: 'Failed to list agents',
      message: error.message,
    });
  }
});

/**
 * List Demo Scenarios
 * GET /api/scenarios
 *
 * Returns the demo use cases (Versicherungs-Claims, Bürgerhotline) that the
 * UI can switch between. Each scenario carries its own system prompt and
 * greeting; selection happens via `scenarioId` on POST /api/converse.
 */
app.get('/api/scenarios', (req, res) => {
  res.json({
    scenarios: listScenarios(),
    defaultScenarioId: DEFAULT_SCENARIO_ID,
  });
});

/**
 * List Available Voices
 * GET /api/voices
 *
 * Returns all available KugelAudio voices
 * Supports 24 EU languages
 */
app.get('/api/voices', async (req, res) => {
  try {
    const { language, limit, offset, includePublic } = req.query;
    const result = await kugelAudioClient.listVoices({
      language,
      limit: limit !== undefined ? Number(limit) : undefined,
      offset: offset !== undefined ? Number(offset) : undefined,
      includePublic: includePublic !== undefined ? includePublic === 'true' : undefined,
    });
    res.json({
      voices: result.voices,
      count: result.voices.length,
      total: result.total,
      limit: result.limit,
      offset: result.offset,
    });
  } catch (error) {
    res.status(500).json({
      error: 'Failed to list voices',
      message: error.message,
    });
  }
});

/**
 * Kick off a scenario with the agent's opening line.
 * POST /api/scenario/start { scenarioId, voiceId?, sessionId? }
 *
 * Returns the scenario's canned greeting plus Kugel TTS audio so the UI can
 * open the call with the agent speaking first — no LLM round-trip needed.
 */
app.post('/api/scenario/start', async (req, res) => {
  try {
    const { scenarioId, voiceId, sessionId: providedSessionId } = req.body || {};
    const scenario = getScenario(scenarioId);

    // Fresh session every time a scenario is started, so the system prompt
    // and conversation history belong to this one call.
    const sessionId = providedSessionId || `session_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
    voicePipeline.activeSessions.delete(sessionId);
    const session = voicePipeline.createSession(sessionId, {
      language: scenario.defaultLanguage || 'de',
      scenarioId: scenario.id,
    });
    if (voiceId !== undefined) {
      voicePipeline.voiceConfig.voiceId = Number(voiceId);
    }

    const greeting = scenario.greeting;
    const tts = await kugelAudioClient.textToSpeech(
      greeting,
      voicePipeline.ttsOptions(scenario.defaultLanguage || 'de'),
    );
    const wav = pcmToWav(tts.audio, tts.sampleRate);

    // Seed the conversation history so the LLM sees its own opening turn.
    session.context.conversation.messages.push({
      role: 'assistant',
      text: greeting,
      timestamp: new Date().toISOString(),
    });
    session.messageCount++;

    res.json({
      sessionId,
      scenarioId: scenario.id,
      scenarioLabel: scenario.label,
      greeting,
      language: scenario.defaultLanguage || 'de',
      sampleRate: tts.sampleRate,
      audio: wav.toString('base64'),
      audioMime: 'audio/wav',
    });
  } catch (error) {
    console.error('scenario/start error:', error);
    res.status(500).json({ error: 'scenario start failed', message: error.message });
  }
});

/**
 * One-shot text turn: watsonx agent reply + KugelAudio TTS.
 * POST /api/converse  { text, sessionId?, voiceId?, language? }
 * Returns { responseText, intent, escalated, processingTime, sampleRate, audio (base64 wav) }.
 */
app.post('/api/converse', async (req, res) => {
  try {
    const { text, sessionId: providedSessionId, voiceId, language, scenarioId } = req.body || {};
    if (!text || typeof text !== 'string' || !text.trim()) {
      return res.status(400).json({ error: 'text is required' });
    }

    const scenario = getScenario(scenarioId);
    const effectiveLanguage = language || scenario.defaultLanguage || 'en';

    const sessionId = providedSessionId || `session_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
    if (!voicePipeline.activeSessions.has(sessionId)) {
      voicePipeline.createSession(sessionId, { language: effectiveLanguage, scenarioId: scenario.id });
    }
    if (voiceId !== undefined) {
      voicePipeline.voiceConfig.voiceId = Number(voiceId);
    }

    const result = await voicePipeline.processText(text, sessionId, { language, scenarioId: scenario.id });
    const wav = pcmToWav(result.audio, result.sampleRate);

    res.json({
      sessionId,
      userText: result.userText,
      responseText: result.responseText,
      language: result.language,
      intent: result.intent,
      escalated: result.escalated,
      processingTime: result.processingTime,
      sampleRate: result.sampleRate,
      audio: wav.toString('base64'),
      audioMime: 'audio/wav',
    });
  } catch (error) {
    console.error('converse error:', error);
    res.status(500).json({ error: 'converse failed', message: error.message });
  }
});

/**
 * Streaming variant of /api/converse.
 * Streams tokens from watsonx.ai as they arrive and runs per-sentence TTS,
 * emitting Server-Sent Events so the client can start playing audio while
 * the rest of the response is still generating. Cuts time-to-first-audio
 * from ~5s to ~3s.
 *
 * Events:
 *   event: session   data: {sessionId}
 *   event: delta     data: {text}           // every LLM token chunk
 *   event: sentence  data: {text, audio (b64 WAV), sampleRate, index}
 *   event: done      data: {responseText, intent, processingTime, usage}
 *   event: error     data: {message}
 */
app.post('/api/converse/stream', async (req, res) => {
  const t0 = Date.now();
  const { text, sessionId: providedSessionId, voiceId, language, scenarioId } = req.body || {};
  if (!text || typeof text !== 'string' || !text.trim()) {
    return res.status(400).json({ error: 'text is required' });
  }

  const scenario = getScenario(scenarioId);
  const effectiveLanguage = language || scenario.defaultLanguage || 'en';

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  const send = (event, payload) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
  };

  try {
    const sessionId = providedSessionId || `session_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
    if (!voicePipeline.activeSessions.has(sessionId)) {
      voicePipeline.createSession(sessionId, { language: effectiveLanguage, scenarioId: scenario.id });
    }
    if (voiceId !== undefined) {
      voicePipeline.voiceConfig.voiceId = Number(voiceId);
    }
    const session = voicePipeline.getSession(sessionId);
    // Allow the client to switch scenarios mid-session without creating a new session.
    if (scenario.id !== session.scenarioId) session.scenarioId = scenario.id;
    send('session', { sessionId, scenarioId: session.scenarioId });

    // Build conversation history for the model
    const systemPrompt = voicePipeline._buildSystemPrompt(session.scenarioId);
    const history = (session.context.conversation.messages || []).slice(-8).map((m) => ({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: m.text,
    }));
    const messages = [
      { role: 'system', content: systemPrompt },
      ...history,
      { role: 'user', content: text },
    ];

    // Sentence buffer — TTS in parallel, client plays by index.
    // Only flush on sentence terminators (. ! ?) — Kugel docs explicitly warn
    // that per-clause flushing forces a cold model prefill each segment and
    // wrecks prosody. First chunk is allowed slightly shorter for TTFA, but
    // still must end on a full sentence so the voice stays coherent.
    const ttsOpts = voicePipeline.ttsOptions(effectiveLanguage);
    const FIRST_MIN_CHARS = 40;
    const NEXT_MIN_CHARS = 60;
    const SENTENCE_BOUNDARY = /^([\s\S]*?[.!?])(\s+|$)/;
    let pending = '';
    let sentenceIndex = 0;
    const ttsPromises = [];

    const runTts = (chunk, idx) => {
      const p = kugelAudioClient.textToSpeech(chunk, ttsOpts)
        .then((tts) => {
          send('sentence', {
            index: idx,
            text: chunk,
            audio: pcmToWav(tts.audio, tts.sampleRate).toString('base64'),
            sampleRate: tts.sampleRate,
          });
        })
        .catch((e) => console.warn(`TTS chunk ${idx} failed: ${e.message}`));
      ttsPromises.push(p);
    };

    const tryFlush = (force = false) => {
      while (true) {
        const minChars = sentenceIndex === 0 ? FIRST_MIN_CHARS : NEXT_MIN_CHARS;
        const match = pending.match(SENTENCE_BOUNDARY);
        if (match && match[1].length >= minChars) {
          runTts(match[1].trim(), sentenceIndex++);
          pending = pending.slice(match[0].length);
          continue;
        }
        if (force && pending.trim().length > 0) {
          runTts(pending.trim(), sentenceIndex++);
          pending = '';
        }
        break;
      }
    };

    const deploymentId = SCENARIO_DEPLOYMENTS[session.scenarioId] || undefined;
    const { fullText } = await watsonxClient.chatStream(messages, {
      deploymentId,
      maxTokens: 180,  // tighter responses — live voice is better with short turns
      temperature: 0.7,
      onDelta: (d) => {
        pending += d;
        send('delta', { text: d });
        tryFlush(false);
      },
    });
    tryFlush(true);
    await Promise.all(ttsPromises);

    // Persist to session memory so follow-up turns have context
    session.messageCount++;
    session.context.conversation.messages.push(
      { role: 'user', text, timestamp: new Date().toISOString() },
      { role: 'assistant', text: fullText, timestamp: new Date().toISOString() },
    );

    send('done', {
      responseText: fullText,
      processingTime: Date.now() - t0,
    });
    res.end();
  } catch (error) {
    console.error('stream error:', error);
    send('error', { message: error.message });
    res.end();
  }
});

/**
 * Initiate a New Voice Call
 * POST /api/call
 *
 * Initiates a new voice call session
 *
 * Request body:
 * {
 *   "agentId": "customer-service-agent",  // Optional, uses default if not provided
 *   "language": "en",                      // Optional
 *   "customerId": "cust_123"               // Optional, for CRM lookup
 * }
 */
app.post('/api/call', async (req, res) => {
  try {
    const {
      agentId = process.env.DEFAULT_AGENT_ID || 'customer-service-agent',
      language = 'en',
      customerId = null,
    } = req.body;

    // Generate session ID
    const sessionId = `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    // Create session in voice pipeline
    const session = voicePipeline.createSession(sessionId, {
      language,
      customerId,
    });

    res.json({
      sessionId,
      agentId,
      status: 'initiated',
      message: 'Voice call session created. Connect via WebSocket at /voice',
      wsUrl: `ws://${req.get('host')}/voice?sessionId=${sessionId}`,
    });
  } catch (error) {
    res.status(500).json({
      error: 'Failed to initiate call',
      message: error.message,
    });
  }
});

/**
 * Get Session Statistics
 * GET /api/sessions/:sessionId/stats
 *
 * Returns statistics for an active or recent session
 */
app.get('/api/sessions/:sessionId/stats', (req, res) => {
  try {
    const { sessionId } = req.params;
    const stats = voicePipeline.getSessionStats(sessionId);

    if (!stats) {
      return res.status(404).json({
        error: 'Session not found',
        sessionId,
      });
    }

    res.json(stats);
  } catch (error) {
    res.status(500).json({
      error: 'Failed to get session stats',
      message: error.message,
    });
  }
});

/**
 * Get All Active Sessions
 * GET /api/sessions
 *
 * Returns summary of all active sessions
 */
app.get('/api/sessions', (req, res) => {
  try {
    const sessions = voicePipeline.getActiveSessions();
    res.json({
      sessions,
      count: sessions.length,
    });
  } catch (error) {
    res.status(500).json({
      error: 'Failed to get sessions',
      message: error.message,
    });
  }
});

// ============================================================================
// WEBSOCKET ENDPOINTS
// ============================================================================

/**
 * Voice Audio Stream WebSocket
 * WS /voice
 *
 * Handles real-time bidirectional audio streaming for voice calls
 * Query parameters:
 * - sessionId: Session identifier from POST /api/call
 * - language: Optional language override
 *
 * Message formats:
 * - Binary: Audio data (WAV format)
 * - JSON: Control messages
 *   - { type: 'flush' } - Process accumulated audio
 *   - { type: 'end_session' } - End the session
 */
wss.on('connection', (ws, req) => {
  // Extract session ID from query parameters
  const url = new URL(req.url, `http://${req.headers.host}`);
  const sessionId = url.searchParams.get('sessionId');
  const language = url.searchParams.get('language');

  if (!sessionId) {
    ws.close(1008, 'Session ID required');
    return;
  }

  console.log(`[${sessionId}] WebSocket connected`);

  try {
    // Setup audio stream handler in voice pipeline
    voicePipeline.setupAudioStream(ws, sessionId);
  } catch (error) {
    console.error(`[${sessionId}] WebSocket setup error:`, error);
    ws.close(1011, 'Internal server error');
  }
});

// ============================================================================
// STATIC ROUTES
// ============================================================================

/**
 * Root Route - Serve Interactive Demo
 * GET /
 */
app.get('/', (req, res) => {
  res.sendFile('public/index.html', { root: '.' });
});

// ============================================================================
// ERROR HANDLING
// ============================================================================

/**
 * 404 Handler
 */
app.use((req, res) => {
  res.status(404).json({
    error: 'Not found',
    path: req.path,
    method: req.method,
  });
});

/**
 * Global Error Handler
 */
app.use((error, req, res, next) => {
  console.error('Unhandled error:', error);
  res.status(500).json({
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? error.message : 'An error occurred',
  });
});

// ============================================================================
// SERVER STARTUP
// ============================================================================

const PORT = process.env.PORT || 3000;

httpServer.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════════════════════════╗
║  KugelAudio × watsonx Orchestrate Voice AI Integration     ║
║  Server running on port ${PORT}
║                                                            ║
║  REST API:                                                 ║
║    GET  /api/health          - Service health check        ║
║    GET  /api/agents          - List available agents       ║
║    GET  /api/voices          - List available voices       ║
║    POST /api/call            - Initiate voice call         ║
║    GET  /api/sessions        - List active sessions        ║
║    GET  /api/sessions/:id... - Get session stats           ║
║                                                            ║
║  WebSocket:                                                ║
║    WS   /voice               - Voice audio streaming       ║
║                                                            ║
║  Environment:                                              ║
║    NODE_ENV: ${process.env.NODE_ENV || 'development'}
║    API Keys: ${process.env.KUGELAUDIO_API_KEY ? '✓' : '✗'} KugelAudio, ${process.env.WATSONX_API_KEY ? '✓' : '✗'} watsonx      ║
╚════════════════════════════════════════════════════════════╝
  `);
});

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log('\nShutting down gracefully...');
  httpServer.close(() => {
    console.log('Server closed');
    process.exit(0);
  });

  // Force close after 10 seconds
  setTimeout(() => {
    console.error('Forced shutdown');
    process.exit(1);
  }, 10000);
});

export default app;
