import dotenv from 'dotenv';
import express from 'express';
import WebSocket, { WebSocketServer } from 'ws';
import { createServer as createHttpServer } from 'http';
import { createServer as createHttpsServer } from 'https';
import { spawn, spawnSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import path from 'path';
import { AccessToken } from 'livekit-server-sdk';
import KugelAudioClient from './kugelaudio-client.js';
import OrchestrateClient from './orchestrate-client.js';
import VoicePipeline from './voice-pipeline.js';
import { listScenarios, getScenario, DEFAULT_SCENARIO_ID } from './agents/scenarios.js';
import { cleanLlmText } from './agents/text-cleanup.js';
import {
  buildClaimStateInstruction,
  correctRepeatedDamageTypeQuestion,
  updateClaimStateFromUserText,
} from './agents/claims-state.js';

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

function clipLogValue(value, maxLen = 220) {
  if (value === null || value === undefined) return String(value);
  const s = typeof value === 'string' ? value : JSON.stringify(value);
  if (!s) return '';
  return s.length > maxLen ? `${s.slice(0, maxLen)}…` : s;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseBoolEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  return raw.toLowerCase() === 'true';
}

function parsePositiveIntEnv(name, fallback) {
  const value = Number.parseInt(process.env[name] || '', 10);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function parseProbabilityEnv(name, fallback) {
  const value = Number.parseFloat(process.env[name] || '');
  if (!Number.isFinite(value)) return fallback;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function randomIntBetween(min, max) {
  const low = Math.min(min, max);
  const high = Math.max(min, max);
  return Math.floor(Math.random() * (high - low + 1)) + low;
}

// Load environment variables
dotenv.config();

const FAKE_LLM_LATENCY_ENABLED = parseBoolEnv('FAKE_LLM_LATENCY_ENABLED', true);
const FAKE_LLM_LATENCY_MIN_MS = parsePositiveIntEnv('FAKE_LLM_LATENCY_MIN_MS', 120);
const FAKE_LLM_LATENCY_MAX_MS = parsePositiveIntEnv('FAKE_LLM_LATENCY_MAX_MS', 480);
const FAKE_AGENT_DELAY_ENABLED = parseBoolEnv('FAKE_AGENT_DELAY_ENABLED', true);
const FAKE_AGENT_DELAY_CHANCE = Number.parseFloat(process.env.FAKE_AGENT_DELAY_CHANCE || '0.35');
const FAKE_AGENT_DELAY_MIN_MS = parsePositiveIntEnv('FAKE_AGENT_DELAY_MIN_MS', 70);
const FAKE_AGENT_DELAY_MAX_MS = parsePositiveIntEnv('FAKE_AGENT_DELAY_MAX_MS', 240);
const PRE_SPEECH_DELAY_FIXED_MS = (process.env.PRE_SPEECH_DELAY_MS !== undefined)
  ? parsePositiveIntEnv('PRE_SPEECH_DELAY_MS', 180)
  : null;
const PRE_SPEECH_DELAY_MIN_MS = parsePositiveIntEnv('PRE_SPEECH_DELAY_MIN_MS', 120);
const PRE_SPEECH_DELAY_MAX_MS = parsePositiveIntEnv('PRE_SPEECH_DELAY_MAX_MS', 260);
const PRE_SPEECH_DELAY_LONG_PAUSE_CHANCE = parseProbabilityEnv('PRE_SPEECH_DELAY_LONG_PAUSE_CHANCE', 0.22);
const PRE_SPEECH_DELAY_LONG_PAUSE_MIN_MS = parsePositiveIntEnv('PRE_SPEECH_DELAY_LONG_PAUSE_MIN_MS', 80);
const PRE_SPEECH_DELAY_LONG_PAUSE_MAX_MS = parsePositiveIntEnv('PRE_SPEECH_DELAY_LONG_PAUSE_MAX_MS', 220);
const PSEUDO_DELTA_STREAM_ENABLED = parseBoolEnv('PSEUDO_DELTA_STREAM_ENABLED', true);
const PSEUDO_DELTA_MIN_WORDS = parsePositiveIntEnv('PSEUDO_DELTA_MIN_WORDS', 1);
const PSEUDO_DELTA_MAX_WORDS = parsePositiveIntEnv('PSEUDO_DELTA_MAX_WORDS', 4);
const PSEUDO_DELTA_DELAY_MIN_MS = parsePositiveIntEnv('PSEUDO_DELTA_DELAY_MIN_MS', 18);
const PSEUDO_DELTA_DELAY_MAX_MS = parsePositiveIntEnv('PSEUDO_DELTA_DELAY_MAX_MS', 70);
const PSEUDO_DELTA_LONG_PAUSE_CHANCE = parseProbabilityEnv('PSEUDO_DELTA_LONG_PAUSE_CHANCE', 0.18);
const PSEUDO_DELTA_LONG_PAUSE_MIN_MS = parsePositiveIntEnv('PSEUDO_DELTA_LONG_PAUSE_MIN_MS', 90);
const PSEUDO_DELTA_LONG_PAUSE_MAX_MS = parsePositiveIntEnv('PSEUDO_DELTA_LONG_PAUSE_MAX_MS', 180);
const PSEUDO_DELTA_PUNCT_PAUSE_MIN_MS = parsePositiveIntEnv('PSEUDO_DELTA_PUNCT_PAUSE_MIN_MS', 30);
const PSEUDO_DELTA_PUNCT_PAUSE_MAX_MS = parsePositiveIntEnv('PSEUDO_DELTA_PUNCT_PAUSE_MAX_MS', 110);

async function emitPseudoDeltaStream(text, emitDelta) {
  const normalized = (text || '').trim();
  if (!normalized) return;

  if (!PSEUDO_DELTA_STREAM_ENABLED) {
    emitDelta(normalized);
    return;
  }

  const words = normalized.split(/\s+/).filter(Boolean);
  if (!words.length) return;

  const minWords = Math.max(1, PSEUDO_DELTA_MIN_WORDS);
  const maxWords = Math.max(minWords, PSEUDO_DELTA_MAX_WORDS);
  let cursor = 0;
  while (cursor < words.length) {
    const count = randomIntBetween(minWords, maxWords);
    const end = Math.min(words.length, cursor + count);
    let chunk = words.slice(cursor, end).join(' ');
    if (end < words.length) chunk += ' ';
    emitDelta(chunk);
    cursor = end;
    if (cursor >= words.length) break;

    let pauseMs = randomIntBetween(PSEUDO_DELTA_DELAY_MIN_MS, PSEUDO_DELTA_DELAY_MAX_MS);
    if (/[.,!?;:]$/.test(chunk.trim())) {
      pauseMs += randomIntBetween(PSEUDO_DELTA_PUNCT_PAUSE_MIN_MS, PSEUDO_DELTA_PUNCT_PAUSE_MAX_MS);
    }
    if (Math.random() < PSEUDO_DELTA_LONG_PAUSE_CHANCE) {
      pauseMs += randomIntBetween(PSEUDO_DELTA_LONG_PAUSE_MIN_MS, PSEUDO_DELTA_LONG_PAUSE_MAX_MS);
    }
    await sleep(pauseMs);
  }
}

function samplePreSpeechDelayMs() {
  const baseDelayMs = (PRE_SPEECH_DELAY_FIXED_MS !== null)
    ? PRE_SPEECH_DELAY_FIXED_MS
    : randomIntBetween(PRE_SPEECH_DELAY_MIN_MS, PRE_SPEECH_DELAY_MAX_MS);
  let totalDelayMs = baseDelayMs;
  if (Math.random() < PRE_SPEECH_DELAY_LONG_PAUSE_CHANCE) {
    totalDelayMs += randomIntBetween(PRE_SPEECH_DELAY_LONG_PAUSE_MIN_MS, PRE_SPEECH_DELAY_LONG_PAUSE_MAX_MS);
  }
  return Math.max(0, totalDelayMs);
}

// Initialize Express app
const app = express();
let serverProtocol = 'http';
function createAppServer() {
  const wantsLocalHttps = process.env.LOCAL_HTTPS === 'true';
  if (!wantsLocalHttps) return createHttpServer(app);

  const certPath = process.env.LOCAL_HTTPS_CERT_PATH || path.resolve('.cert/localhost-cert.pem');
  const keyPath = process.env.LOCAL_HTTPS_KEY_PATH || path.resolve('.cert/localhost-key.pem');
  if (!existsSync(certPath) || !existsSync(keyPath)) {
    console.warn(`[https] LOCAL_HTTPS=true but cert/key missing. Expected: cert=${certPath}, key=${keyPath}`);
    console.warn('[https] Falling back to http. Generate certs or use npm run dev:https after creating them.');
    return createHttpServer(app);
  }

  try {
    const cert = readFileSync(certPath);
    const key = readFileSync(keyPath);
    serverProtocol = 'https';
    console.log(`[https] enabled with cert=${certPath}`);
    return createHttpsServer({ key, cert }, app);
  } catch (error) {
    console.warn(`[https] failed to read cert/key: ${error.message}. Falling back to http.`);
    return createHttpServer(app);
  }
}
const httpServer = createAppServer();

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static assets, but let the explicit "/" route choose the primary UI.
app.use(express.static('public', { index: false }));

// Initialize clients
const kugelAudioClient = new KugelAudioClient({
  apiKey: process.env.KUGELAUDIO_API_KEY,
  apiUrl: process.env.KUGELAUDIO_API_URL,
  modelId: process.env.KUGELAUDIO_MODEL_ID || 'kugel-2-turbo',
});

const DEFAULT_TTS_VOICE_ID = process.env.KUGELAUDIO_VOICE_ID
  ? Number(process.env.KUGELAUDIO_VOICE_ID)
  : undefined;

function resolveVoiceId(voiceId) {
  if (voiceId === undefined || voiceId === null || voiceId === '') return DEFAULT_TTS_VOICE_ID;
  const parsed = Number(voiceId);
  return Number.isFinite(parsed) ? parsed : DEFAULT_TTS_VOICE_ID;
}

/**
 * Stream TTS with the selected voice. Fail fast if the configured path fails.
 */
async function streamTtsWithVoice(text, opts) {
  const requestedVoiceId = resolveVoiceId(opts.voiceId);
  await kugelAudioClient.streamFullTextTts(text, {
    language: opts.language,
    cfgScale: opts.cfgScale,
    normalize: opts.normalize,
    onAudio: opts.onAudio,
    voiceId: requestedVoiceId,
  });
  return { usedVoiceId: requestedVoiceId };
}

const REQUIRED_ORCHESTRATE_ENV = [
  'ORCHESTRATE_API_KEY',
  'ORCHESTRATE_INSTANCE_URL',
  'ORCHESTRATE_AGENT_ID',
];
const missingOrchestrateEnv = REQUIRED_ORCHESTRATE_ENV.filter((name) => !process.env[name]);
const orchestrateConfigured = missingOrchestrateEnv.length === 0;
const orchestrateClient = orchestrateConfigured
  ? new OrchestrateClient({
      apiKey: process.env.ORCHESTRATE_API_KEY,
      instanceUrl: process.env.ORCHESTRATE_INSTANCE_URL,
      agentId: process.env.ORCHESTRATE_AGENT_ID,
    })
  : null;
if (orchestrateClient) {
  console.log(`[orchestrate] routing chat through agent ${process.env.ORCHESTRATE_AGENT_ID}`);
} else {
  console.warn(`[orchestrate] required configuration missing: ${missingOrchestrateEnv.join(', ')}`);
}

// Initialize voice pipeline
const voicePipeline = orchestrateClient
  ? new VoicePipeline({
      kugelAudioClient,
      orchestrateClient,
      voiceConfig: {
        voiceId: process.env.KUGELAUDIO_VOICE_ID || 'default',
        language: process.env.KUGELAUDIO_LANGUAGE || 'de',
        // Anything below is left undefined unless the operator explicitly sets
        // an env override — undefined means "don't include in the SDK call",
        // which is what keeps us byte-identical with the reference script.
        speed: process.env.KUGELAUDIO_SPEED ? Number(process.env.KUGELAUDIO_SPEED) : undefined,
        cfgScale: process.env.KUGELAUDIO_CFG_SCALE ? Number(process.env.KUGELAUDIO_CFG_SCALE) : undefined,
        normalize: process.env.KUGELAUDIO_NORMALIZE !== undefined
          ? process.env.KUGELAUDIO_NORMALIZE === 'true'
          : undefined,
      },
    })
  : null;

function requireOrchestrate() {
  if (orchestrateClient && voicePipeline) return null;
  return {
    error: 'orchestrate_not_configured',
    message: `Set ${REQUIRED_ORCHESTRATE_ENV.join(', ')} to run the Watson Orchestrate-first flow`,
    missing: missingOrchestrateEnv,
  };
}

// Initialize WebSocket server
const wss = new WebSocketServer({ server: httpServer });
wss.on('error', (error) => {
  if (error?.code === 'EADDRINUSE') return;
  console.error('WebSocket server error:', error);
});

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
    const orchestrateHealth = orchestrateClient ? await orchestrateClient.healthCheck() : false;

    const status = kugelAudioHealth && orchestrateHealth ? 'healthy' : 'degraded';
    const statusCode = status === 'healthy' ? 200 : 503;

    res.status(statusCode).json({
      status,
      timestamp: new Date().toISOString(),
      services: {
        kugelaudio: kugelAudioHealth ? 'up' : 'down',
        watsonx_orchestrate: orchestrateClient
          ? (orchestrateHealth ? 'up' : 'down')
          : 'missing',
        watsonx_governance: process.env.GOVERNANCE_GUID ? 'provisioned' : 'missing',
      },
      orchestrate: orchestrateClient ? {
        instanceUrl: process.env.ORCHESTRATE_INSTANCE_URL,
        agentId: process.env.ORCHESTRATE_AGENT_ID,
        active: orchestrateHealth,
      } : {
        active: false,
        missing: missingOrchestrateEnv,
      },
    });
  } catch (error) {
    res.status(500).json({
      status: 'error',
      message: error.message,
    });
  }
});

/**
 * Browser debug-log ingest endpoint.
 * POST /api/client-log { source?, sessionId?, page?, logs: [{ts,args:[]}] }
 */
app.post('/api/client-log', (req, res) => {
  try {
    const { source = 'web', sessionId = 'unknown', page = '', logs = [] } = req.body || {};
    const entries = Array.isArray(logs) ? logs : [];
    for (const entry of entries) {
      const ts = entry?.ts ? new Date(entry.ts).toISOString() : new Date().toISOString();
      const args = Array.isArray(entry?.args) ? entry.args : [];
      const line = args.map((a) => clipLogValue(a)).join(' | ');
      console.log(`[client-log] [${source}] [${sessionId}] ${ts} ${page} ${line}`);
    }
    res.json({ ok: true, ingested: entries.length });
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message });
  }
});

/**
 * Mint a LiveKit access token so the browser can join a room as a
 * participant. The Python agent (livekit_agent.py) joins the same room
 * using its own server-side credentials. Phase 2a uses this just for the
 * audio-quality probe; phase 2b will use it for the full voice agent.
 *
 * GET /api/livekit/token?room=audio-test&identity=user-1234
 */
app.get('/api/livekit/token', async (req, res) => {
  try {
    const apiKey = process.env.LIVEKIT_API_KEY;
    const apiSecret = process.env.LIVEKIT_API_SECRET;
    const url = process.env.LIVEKIT_URL;
    if (!apiKey || !apiSecret || !url) {
      return res.status(503).json({
        error: 'livekit_not_configured',
        message: 'Set LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET in .env',
      });
    }

    const room = String(req.query.room || 'audio-test');
    const identity = String(req.query.identity || `user-${Math.random().toString(36).slice(2, 10)}`);

    const at = new AccessToken(apiKey, apiSecret, { identity, ttl: '10m' });
    at.addGrant({
      roomJoin: true,
      room,
      canPublish: true,
      canSubscribe: true,
    });

    res.json({
      url,
      token: await at.toJwt(),
      identity,
      room,
    });
  } catch (error) {
    console.error('livekit token error:', error);
    res.status(500).json({ error: 'token_failed', message: error.message });
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
    const configError = requireOrchestrate();
    if (configError) return res.status(503).json(configError);
    const agents = [{
      agent_id: process.env.ORCHESTRATE_AGENT_ID,
      name: process.env.ORCHESTRATE_AGENT_NAME || process.env.ORCHESTRATE_AGENT_ID,
      runtime: 'watsonx_orchestrate',
      status: 'configured',
    }];
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
  const payload = {
    scenarios: listScenarios(),
    defaultScenarioId: DEFAULT_SCENARIO_ID,
  };
  res.json(payload);

  const defaultScenarioId = payload.defaultScenarioId || payload.scenarios?.[0]?.id;
  if (defaultScenarioId && voicePipeline) {
    prefetchScenarioOpening(defaultScenarioId, DEFAULT_TTS_VOICE_ID)
      .then((d) => {
        console.log(
          `[scenario/prefetch] warmup ready scenario=${d.scenarioId} chunks=${d.audioChunks?.length || 0} cacheHit=${d.cacheHit ? 'yes' : 'no'}`,
        );
      })
      .catch((error) => {
        console.warn(`[scenario/prefetch] warmup failed: ${error.message}`);
      });
  }
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

// Prefetched Orchestrate openings for instant playback on "Gespräch starten".
const openingPrefetchCache = new Map();
const OPENING_PREFETCH_TTL_MS = 2 * 60 * 1000;

function normalizeConversationMode(mode) {
  return 'orchestrate';
}

function openingPrefetchKey(scenarioId, voiceId, conversationMode = 'free') {
  const v = (voiceId === undefined || voiceId === null) ? 'default' : String(Number(voiceId));
  return `${scenarioId}::${v}::${normalizeConversationMode(conversationMode)}`;
}

function getFreshOpeningPrefetch(scenarioId, voiceId, conversationMode = 'free') {
  const key = openingPrefetchKey(scenarioId, voiceId, conversationMode);
  const hit = openingPrefetchCache.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expiresAt) {
    openingPrefetchCache.delete(key);
    return null;
  }
  return hit;
}

function consumeOpeningPrefetch(scenarioId, voiceId, conversationMode = 'free') {
  const key = openingPrefetchKey(scenarioId, voiceId, conversationMode);
  const hit = getFreshOpeningPrefetch(scenarioId, voiceId, conversationMode);
  if (!hit) return null;
  openingPrefetchCache.delete(key);
  return hit;
}

async function buildScenarioOpening(scenario, { sessionId, conversationMode = 'free' } = {}) {
  const configError = requireOrchestrate();
  if (configError) throw new Error(configError.message);

  const openerMessages = [
    {
      role: 'system',
      content: [
        scenario.systemPrompt,
        'AKTUELLER TURN: Dies ist der einzige erlaubte Eroeffnungs-Turn. Begruesse nur jetzt kurz und frage direkt nach der Schadensart.',
      ].filter(Boolean).join('\n'),
    },
    {
      role: 'user',
      content: 'Starte das Gespräch jetzt als erster Agent-Turn. Schreibe genau eine kurze, natürliche Begrüßung für den Kunden und eine konkrete erste Frage. Deutsch, maximal 2 Sätze.',
    },
  ];

  const reply = await orchestrateClient.chat(openerMessages, {
    context: { sessionId, scenarioId: scenario.id, prefetch: true, turn: 'opening' },
  });
  const openingText = (reply.text || '').trim();
  if (!openingText) throw new Error('Orchestrate returned an empty opening');
  return {
    text: cleanLlmText(openingText, { language: scenario.defaultLanguage || 'de' }),
    threadId: reply.threadId,
  };
}

async function prefetchScenarioOpening(scenarioId, voiceId, conversationMode = 'free') {
  const scenario = getScenario(scenarioId);
  const mode = normalizeConversationMode(conversationMode);
  const existing = getFreshOpeningPrefetch(scenario.id, voiceId, mode);
  if (existing) return { ...existing, cacheHit: true };

  const language = scenario.defaultLanguage || 'de';
  let openingText;
  let threadId = null;
  if (scenario.greeting) {
    openingText = scenario.greeting;
  } else {
    const configError = requireOrchestrate();
    if (configError) throw new Error(configError.message);
    const opening = await buildScenarioOpening(scenario, {
      sessionId: `prefetch_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
      conversationMode: mode,
    });
    openingText = opening.text;
    threadId = opening.threadId;
  }

  const ttsOpts = voicePipeline.ttsOptions(language);
  const chunks = [];

  const ttsResult = await streamTtsWithVoice(openingText, {
    voiceId,
    language: ttsOpts.language,
    cfgScale: ttsOpts.cfgScale,
    normalize: ttsOpts.normalize,
    logTag: 'scenario/prefetch',
    onAudio: ({ pcm, sampleRate, samples }) => {
      chunks.push({
        pcm: pcm.toString('base64'),
        sampleRate,
        samples,
        encoding: 'pcm_s16le',
      });
    },
  });

  const record = {
    scenarioId: scenario.id,
    language,
    greeting: openingText,
    threadId,
    audioChunks: chunks,
    usedVoiceId: ttsResult.usedVoiceId,
    createdAt: Date.now(),
    expiresAt: Date.now() + OPENING_PREFETCH_TTL_MS,
    cacheHit: false,
  };
  openingPrefetchCache.set(openingPrefetchKey(scenario.id, voiceId, mode), record);
  return record;
}

async function ensureTtsSidecarReady(timeoutMs = 12000) {
  if (await kugelAudioClient.sidecarHealthy()) return true;
  await startTtsSidecar();
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await kugelAudioClient.sidecarHealthy()) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

/**
 * Streaming variant of /api/scenario/start.
 * Same outcome (session + greeting + Kugel TTS) but the audio streams in
 * chunks via SSE so the user hears the first syllable in ~500ms instead of
 * waiting for the entire greeting to be synthesised first (~1–3s).
 *
 * Events:
 *   event: session   data: {sessionId, scenarioId, scenarioLabel, greeting, language}
 *   event: audio     data: {pcm (b64 PCM s16le), sampleRate, samples, index, encoding}
 *   event: done      data: {processingTime}
 *   event: error     data: {message}
 */
app.post('/api/scenario/start/stream', async (req, res) => {
  const t0 = Date.now();
  const { scenarioId, voiceId, sessionId: providedSessionId, mode } = req.body || {};
  const conversationMode = normalizeConversationMode(mode);
  const effectiveVoiceId = resolveVoiceId(voiceId);
  const scenario = getScenario(scenarioId);
  const language = scenario.defaultLanguage || 'de';

  const configError = requireOrchestrate();
  if (configError) return res.status(503).json(configError);

  if (!(await ensureTtsSidecarReady())) {
    return res.status(503).json({
      error: 'tts_unavailable',
      message: 'TTS sidecar is not reachable',
    });
  }

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
    voicePipeline.activeSessions.delete(sessionId);
    const session = voicePipeline.createSession(sessionId, {
      language,
      scenarioId: scenario.id,
      conversationMode,
    });
    const prefetched = consumeOpeningPrefetch(scenario.id, effectiveVoiceId, conversationMode);
    let greeting;
    if (prefetched) {
      greeting = prefetched.greeting;
      if (prefetched.threadId) {
        session.orchestrateThreadId = prefetched.threadId;
      } else {
        // Boot-prefetch has no Orchestrate thread — start one in the background
        // so subsequent user turns have a conversation context.
        buildScenarioOpening(scenario, { sessionId, conversationMode })
          .then((bg) => { if (bg.threadId) session.orchestrateThreadId = bg.threadId; })
          .catch((e) => console.warn(`[scenario/start] background thread init failed: ${e.message}`));
      }
    } else {
      const opening = await buildScenarioOpening(scenario, { sessionId, conversationMode });
      greeting = opening.text;
      if (opening.threadId) session.orchestrateThreadId = opening.threadId;
    }

    send('session', {
      sessionId,
      scenarioId: scenario.id,
      scenarioLabel: scenario.label,
      greeting,
      language,
    });

    let chunkCount = 0;
    const ttsOpts = voicePipeline.ttsOptions(language);
    const prefetchedAudio = prefetched?.audioChunks;
    const preSpeechDelayMs = samplePreSpeechDelayMs();
    if (preSpeechDelayMs > 0) await sleep(preSpeechDelayMs);
    if (prefetchedAudio && prefetchedAudio.length) {
      for (const c of prefetchedAudio) {
        send('audio', { index: chunkCount++, ...c });
      }
      console.log(`[scenario/start/stream] ${sessionId} prefetch hit (${prefetchedAudio.length} chunks)`);
    } else {
      try {
        await streamTtsWithVoice(greeting, {
          voiceId: effectiveVoiceId,
          language: ttsOpts.language,
          cfgScale: ttsOpts.cfgScale,
          normalize: ttsOpts.normalize,
          logTag: 'scenario/start',
          onAudio: ({ pcm, sampleRate, samples }) => {
            chunkCount++;
            send('audio', {
              index: chunkCount - 1,
              pcm: pcm.toString('base64'),
              sampleRate,
              samples,
              encoding: 'pcm_s16le',
            });
          },
        });
      } catch (e) {
        console.warn(`[scenario/start] TTS stream failed: ${e.message}`);
        send('error', { message: `tts: ${e.message}` });
      }
    }

    session.context.conversation.messages.push({
      role: 'assistant',
      text: greeting,
      timestamp: new Date().toISOString(),
    });
    session.messageCount++;

    console.log(`[scenario/start/stream] ${sessionId} chunks=${chunkCount} took=${Date.now() - t0}ms`);
    send('done', { processingTime: Date.now() - t0, chunks: chunkCount });
    res.end();
  } catch (error) {
    console.error('scenario/start/stream error:', error);
    send('error', { message: error.message });
    res.end();
  }
});

/**
 * Kick off a scenario with the agent's opening line.
 * POST /api/scenario/start { scenarioId, voiceId?, sessionId? }
 *
 * Returns the Orchestrate-generated opening plus Kugel TTS audio so the UI can
 * open the call with the agent speaking first.
 */
app.post('/api/scenario/start', async (req, res) => {
  try {
    const configError = requireOrchestrate();
    if (configError) return res.status(503).json(configError);

    if (!(await ensureTtsSidecarReady())) {
      return res.status(503).json({
        error: 'tts_unavailable',
        message: 'TTS sidecar is not reachable',
      });
    }

    const { scenarioId, voiceId, sessionId: providedSessionId, mode } = req.body || {};
    const conversationMode = normalizeConversationMode(mode);
    const effectiveVoiceId = resolveVoiceId(voiceId);
    const scenario = getScenario(scenarioId);

    // Fresh session every time a scenario is started, so the system prompt
    // and conversation history belong to this one call.
    const sessionId = providedSessionId || `session_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
    voicePipeline.activeSessions.delete(sessionId);
    const session = voicePipeline.createSession(sessionId, {
      language: scenario.defaultLanguage || 'de',
      scenarioId: scenario.id,
      conversationMode,
    });
    // Per-request voiceId only — if undefined (UI sent SDK-Default) the
    // SDK falls back to its built-in default voice, which is what the
    // colleague's reference script tests with.
    const opening = await buildScenarioOpening(scenario, {
      sessionId,
      conversationMode,
    });
    const greeting = opening.text;
    if (opening.threadId) session.orchestrateThreadId = opening.threadId;
    const tts = await kugelAudioClient.textToSpeech(greeting, {
      ...voicePipeline.ttsOptions(scenario.defaultLanguage || 'de'),
      voiceId: effectiveVoiceId,
    });
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
 * Prefetch first-turn opening (Orchestrate + TTS) before the user presses
 * "Gespräch starten", so start playback can happen immediately on click.
 *
 * POST /api/scenario/prefetch { scenarioId, voiceId? }
 */
app.post('/api/scenario/prefetch', async (req, res) => {
  try {
    const configError = requireOrchestrate();
    if (configError) return res.status(503).json(configError);

    if (!(await ensureTtsSidecarReady())) {
      return res.status(503).json({
        error: 'tts_unavailable',
        message: 'TTS sidecar is not reachable',
      });
    }
    const { scenarioId, voiceId, mode } = req.body || {};
    const conversationMode = normalizeConversationMode(mode);
    const effectiveVoiceId = resolveVoiceId(voiceId);
    const scenario = getScenario(scenarioId);
    const prefetched = await prefetchScenarioOpening(scenario.id, effectiveVoiceId, conversationMode);
    res.json({
      ok: true,
      cacheHit: !!prefetched.cacheHit,
      scenarioId: prefetched.scenarioId,
      greeting: prefetched.greeting,
      chunks: prefetched.audioChunks?.length || 0,
      expiresAt: prefetched.expiresAt,
    });
  } catch (error) {
    console.warn(`[scenario/prefetch] failed: ${error.message}`);
    res.status(500).json({ ok: false, error: 'prefetch_failed', message: error.message });
  }
});

/**
 * One-shot text turn: watsonx agent reply + KugelAudio TTS.
 * POST /api/converse  { text, sessionId?, voiceId?, language? }
 * Returns { responseText, intent, escalated, processingTime, sampleRate, audio (base64 wav) }.
 */
/**
 * Pure TTS endpoint — turns arbitrary text into a WAV.
 *
 * POST /api/tts  { text, voiceId?, language? }  →  audio/wav
 */
app.post('/api/tts', async (req, res) => {
  try {
    if (!(await ensureTtsSidecarReady())) {
      return res.status(503).json({
        error: 'tts_unavailable',
        message: 'TTS sidecar is not reachable',
      });
    }

    const { text, voiceId, language } = req.body || {};
    if (!text || typeof text !== 'string' || !text.trim()) {
      return res.status(400).json({ error: 'text is required' });
    }
    const tts = await kugelAudioClient.textToSpeech(text, {
      voiceId: resolveVoiceId(voiceId),
      language: language || process.env.KUGELAUDIO_LANGUAGE || 'de',
    });
    const wav = pcmToWav(tts.audio, tts.sampleRate);
    res.setHeader('Content-Type', 'audio/wav');
    res.setHeader('Cache-Control', 'no-store');
    res.send(wav);
  } catch (error) {
    console.error('tts error:', error);
    res.status(500).json({ error: 'tts_failed', message: error.message });
  }
});

app.post('/api/converse', async (req, res) => {
  try {
    const configError = requireOrchestrate();
    if (configError) return res.status(503).json(configError);

    if (!(await ensureTtsSidecarReady())) {
      return res.status(503).json({
        error: 'tts_unavailable',
        message: 'TTS sidecar is not reachable',
      });
    }

    const { text, sessionId: providedSessionId, voiceId, language, scenarioId } = req.body || {};
    const effectiveVoiceId = resolveVoiceId(voiceId);
    if (!text || typeof text !== 'string' || !text.trim()) {
      return res.status(400).json({ error: 'text is required' });
    }

    const scenario = getScenario(scenarioId);
    const effectiveLanguage = language || scenario.defaultLanguage || 'en';

    const sessionId = providedSessionId || `session_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
    if (!voicePipeline.activeSessions.has(sessionId)) {
      voicePipeline.createSession(sessionId, {
        language: effectiveLanguage,
        scenarioId: scenario.id,
      });
    }

    const fakeLlmLatencyMs = FAKE_LLM_LATENCY_ENABLED
      ? randomIntBetween(FAKE_LLM_LATENCY_MIN_MS, FAKE_LLM_LATENCY_MAX_MS)
      : 0;
    const withExtraAgentDelay = FAKE_AGENT_DELAY_ENABLED
      && Number.isFinite(FAKE_AGENT_DELAY_CHANCE)
      && FAKE_AGENT_DELAY_CHANCE > 0
      && Math.random() < Math.min(1, FAKE_AGENT_DELAY_CHANCE);
    const fakeAgentDelayMs = withExtraAgentDelay
      ? randomIntBetween(FAKE_AGENT_DELAY_MIN_MS, FAKE_AGENT_DELAY_MAX_MS)
      : 0;
    const syntheticDelayMs = fakeLlmLatencyMs + fakeAgentDelayMs;
    if (syntheticDelayMs > 0) await sleep(syntheticDelayMs);

    const result = await voicePipeline.processText(text, sessionId, {
      language,
      scenarioId: scenario.id,
      voiceId: effectiveVoiceId,
    });
    const wav = pcmToWav(result.audio, result.sampleRate);

    res.json({
      sessionId,
      userText: result.userText,
      responseText: result.responseText,
      language: result.language,
      orchestratedBy: result.orchestratedBy,
      processingTime: result.processingTime,
      sampleRate: result.sampleRate,
      audio: wav.toString('base64'),
      audioMime: 'audio/wav',
    });
  } catch (error) {
    console.error(`converse error: ${error.message}`);
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
 *   event: audio     data: {pcm (b64 PCM s16le), sampleRate, samples, index, encoding}
 *   event: done      data: {responseText, processingTime, ttfa}
 *   event: error     data: {message}
 */
app.post('/api/converse/stream', async (req, res) => {
  const t0 = Date.now();
  const { text, sessionId: providedSessionId, voiceId, language, scenarioId } = req.body || {};
  const effectiveVoiceId = resolveVoiceId(voiceId);
  if (!text || typeof text !== 'string' || !text.trim()) {
    return res.status(400).json({ error: 'text is required' });
  }

  const configError = requireOrchestrate();
  if (configError) return res.status(503).json(configError);

  if (!(await ensureTtsSidecarReady())) {
    return res.status(503).json({
      error: 'tts_unavailable',
      message: 'TTS sidecar is not reachable',
    });
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
      voicePipeline.createSession(sessionId, {
        language: effectiveLanguage,
        scenarioId: scenario.id,
      });
    }
    const session = voicePipeline.getSession(sessionId);
    // Allow the client to switch scenarios mid-session without creating a new session.
    if (scenario.id !== session.scenarioId) session.scenarioId = scenario.id;
    const claimState = updateClaimStateFromUserText(session, text);
    send('session', { sessionId, scenarioId: session.scenarioId });

    const ttsOpts = voicePipeline.ttsOptions(effectiveLanguage);
    const llmStartedAt = Date.now();
    const fakeLlmLatencyMs = FAKE_LLM_LATENCY_ENABLED
      ? randomIntBetween(FAKE_LLM_LATENCY_MIN_MS, FAKE_LLM_LATENCY_MAX_MS)
      : 0;
    const withExtraAgentDelay = FAKE_AGENT_DELAY_ENABLED
      && Number.isFinite(FAKE_AGENT_DELAY_CHANCE)
      && FAKE_AGENT_DELAY_CHANCE > 0
      && Math.random() < Math.min(1, FAKE_AGENT_DELAY_CHANCE);
    const fakeAgentDelayMs = withExtraAgentDelay
      ? randomIntBetween(FAKE_AGENT_DELAY_MIN_MS, FAKE_AGENT_DELAY_MAX_MS)
      : 0;
    const syntheticDelayMs = fakeLlmLatencyMs + fakeAgentDelayMs;
    if (syntheticDelayMs > 0) await sleep(syntheticDelayMs);

    const history = (session.context.conversation.messages || []).slice(-8).map((m) => ({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: m.text,
    }));
    const turnGuard = [
      scenario.systemPrompt,
      'AKTUELLER TURN: Der Kunde hat bereits gesprochen. Antworte deshalb niemals mit einer Begruessung, Vorstellung oder Telefon-Eroeffnung.',
      'Verbotene Phrasen in diesem Turn: "Guten Tag", "hier ist Anton", "schoen, dass Sie anrufen", "schön, dass Sie anrufen".',
      'Wenn die aktuelle Kundeneingabe eine Schadensart enthaelt, bestaetige sie kurz und frage direkt nach dem naechsten fehlenden Feld. Beispiel: "Ich habe den Autounfall notiert. Wo ist der Schaden passiert?"',
      buildClaimStateInstruction(claimState),
    ].filter(Boolean).join('\n');
    const messages = [
      { role: 'system', content: turnGuard },
      ...history,
      { role: 'user', content: text },
    ];

    console.log(
      `[converse/stream] ${sessionId} -> orchestrate agent=${process.env.ORCHESTRATE_AGENT_ID} scenario=${session.scenarioId} history=${history.length} userChars=${text.length}`,
    );
    const reply = await orchestrateClient.chat(messages, {
      context: { sessionId, scenarioId: session.scenarioId },
      threadId: session.orchestrateThreadId,
    });
    if (reply.threadId) session.orchestrateThreadId = reply.threadId;
    const fullText = correctRepeatedDamageTypeQuestion(
      cleanLlmText((reply.text || '').trim(), { language: effectiveLanguage }),
      claimState,
    );
    if (!fullText) throw new Error('Orchestrate returned an empty response');
    console.log(
      `[converse/stream] ${sessionId} <- orchestrate responseChars=${fullText.length} llmMs=${Date.now() - llmStartedAt}`,
    );
    await emitPseudoDeltaStream(fullText, (chunk) => send('delta', { text: chunk }));
    const llmMs = Date.now() - llmStartedAt;

    // Strip llama's habitual echo-question tag-ons before they hit TTS —
    // the live `delta` stream stays raw (user sees what the model said),
    // but everything from here forward (TTS, session history, done event)
    // uses the cleaned version so what's heard matches what's persisted.
    const spokenText = fullText;

    let audioIdx = 0;
    let firstAudioAt = null;
    const ttsStartedAt = Date.now();
    if (!spokenText || !spokenText.trim()) {
      console.warn(`[converse/stream] ${sessionId} empty spokenText after cleanup — emitting error`);
      send('error', { message: 'tts: empty response from LLM' });
      res.end();
      return;
    }
    try {
      const preSpeechDelayMs = samplePreSpeechDelayMs();
      if (preSpeechDelayMs > 0) await sleep(preSpeechDelayMs);
      await streamTtsWithVoice(spokenText, {
        voiceId: effectiveVoiceId,
        language: ttsOpts.language,
        cfgScale: ttsOpts.cfgScale,
        normalize: ttsOpts.normalize,
        logTag: 'converse/stream',
        onAudio: ({ pcm, sampleRate, samples }) => {
          if (firstAudioAt === null) firstAudioAt = Date.now() - ttsStartedAt;
          send('audio', {
            index: audioIdx++,
            pcm: pcm.toString('base64'),
            sampleRate,
            samples,
            encoding: 'pcm_s16le',
          });
        },
      });
    } catch (e) {
      console.warn(`TTS sidecar stream failed: ${e.message}`);
      send('error', { message: `tts: ${e.message}` });
    }
    console.log(`[converse/stream] ${sessionId} chunks=${audioIdx} ttfa=${firstAudioAt}ms`);
    if (audioIdx === 0) {
      console.warn(`[converse/stream] ${sessionId} emitted ZERO audio chunks — sidecar stuck?`);
    }

    // Persist the cleaned text to session memory — follow-up turns then see
    // a tidy history without the model's echo-question tag-ons influencing
    // its next reply (otherwise it would learn the bad pattern from itself).
    session.messageCount++;
    session.context.conversation.messages.push(
      { role: 'user', text, timestamp: new Date().toISOString() },
      { role: 'assistant', text: spokenText, timestamp: new Date().toISOString() },
    );

    send('done', {
      responseText: spokenText,
      processingTime: Date.now() - t0,
      llmMs,
      ttsTtfa: firstAudioAt,
    });
    res.end();
  } catch (error) {
    console.error(`stream error: ${error.message}`);
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
    const configError = requireOrchestrate();
    if (configError) return res.status(503).json(configError);

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
    const configError = requireOrchestrate();
    if (configError) return res.status(503).json(configError);

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
    const configError = requireOrchestrate();
    if (configError) return res.status(503).json(configError);

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
    const configError = requireOrchestrate();
    if (configError) {
      ws.close(1011, configError.error);
      return;
    }
    // Setup audio stream handler in voice pipeline
    voicePipeline.setupAudioStream(ws, sessionId);
  } catch (error) {
    console.error(`[${sessionId}] WebSocket setup error:`, error);
    ws.close(1011, 'Internal server error');
  }
});

// ============================================================================
// DEEPGRAM STT PROXY
// ============================================================================

const sttWss = new WebSocketServer({ noServer: true });

httpServer.on('upgrade', (request, socket, head) => {
  const { pathname } = new URL(request.url, `http://${request.headers.host}`);
  if (pathname === '/stt') {
    sttWss.handleUpgrade(request, socket, head, (ws) => {
      sttWss.emit('connection', ws, request);
    });
  }
});

sttWss.on('connection', (ws) => {
  const dgKey = process.env.DEEPGRAM_API_KEY;
  if (!dgKey) {
    ws.close(1011, 'DEEPGRAM_API_KEY not set');
    return;
  }

  const dgUrl =
    'wss://api.deepgram.com/v1/listen?' +
    'model=nova-3&language=de&punctuate=true&interim_results=true' +
    '&utterance_end_ms=1200&vad_events=true&encoding=linear16&sample_rate=16000';

  const dgWs = new WebSocket(dgUrl, { headers: { Authorization: `Token ${dgKey}` } });

  dgWs.on('open', () => {
    console.log('[stt] deepgram connected');
    ws.send(JSON.stringify({ type: 'ready' }));
  });

  dgWs.on('message', (data) => {
    try {
      const msg = JSON.parse(data);
      if (msg.type === 'Results' && msg.channel?.alternatives?.[0]) {
        const alt = msg.channel.alternatives[0];
        ws.send(JSON.stringify({
          type: 'transcript',
          text: alt.transcript || '',
          isFinal: msg.is_final === true,
          speechFinal: msg.speech_final === true,
        }));
      } else if (msg.type === 'UtteranceEnd') {
        ws.send(JSON.stringify({ type: 'utterance_end' }));
      }
    } catch {}
  });

  dgWs.on('close', () => {
    if (ws.readyState <= 1) ws.close();
  });

  dgWs.on('error', (e) => {
    console.error('[stt] deepgram error:', e.message);
    if (ws.readyState <= 1) ws.close(1011, 'Deepgram error');
  });

  ws.on('message', (data) => {
    if (dgWs.readyState === 1) dgWs.send(data);
  });

  ws.on('close', () => {
    if (dgWs.readyState <= 1) dgWs.close();
  });
});

// ============================================================================
// STATIC ROUTES
// ============================================================================

/**
 * Root Route - Serve the custom voice UI.
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
const HOST = '0.0.0.0';
let shuttingDown = false;
let ttsSidecarChild = null;
let livekitAgentChild = null;
process.once('SIGINT', () => { shuttingDown = true; });
process.once('SIGTERM', () => { shuttingDown = true; });

function resolvePythonCommand() {
  const venvPython = path.resolve('.venv-tts/bin/python');
  if (existsSync(venvPython)) return venvPython;

  const candidates = ['python3.11', 'python3', 'python'];
  for (const candidate of candidates) {
    const check = spawnSync(candidate, ['--version'], { stdio: 'ignore' });
    if (check.status === 0) return candidate;
  }
  return null;
}

// Spawn the Python TTS sidecar as a child process so the dev experience is
// `node src/server.js` and you get a working voice demo. The sidecar owns
// the persistent KugelAudio SDK client (warm-up, connection reuse) — i.e.
// the colleague's reference pattern, run by Python, not reimplemented here.
async function startTtsSidecar() {
  if (ttsSidecarChild && ttsSidecarChild.exitCode === null) {
    return ttsSidecarChild;
  }

  // node --watch restarts spawn a new server but the previous sidecar may
  // still be alive (it's our child but signal delivery races the new boot).
  // Skip the spawn if the port is already serving — the existing sidecar
  // is fine to reuse, and double-spawning would just EADDRINUSE.
  if (await kugelAudioClient.sidecarHealthy()) {
    console.log('[tts sidecar] already running on', kugelAudioClient.sidecarUrl);
    return null;
  }

  const pythonCommand = resolvePythonCommand();
  if (!pythonCommand) {
    console.warn('[tts sidecar] no Python runtime found — skipping auto-start. Install Python 3.11+ and requirements-tts.txt');
    return null;
  }
  if (!existsSync('tts_sidecar.py')) {
    console.warn('[tts sidecar] tts_sidecar.py missing — skipping auto-start');
    return null;
  }

  console.log(`[tts sidecar] launching Python child process with ${pythonCommand}`);
  const child = spawn(pythonCommand, ['tts_sidecar.py'], {
    env: {
      ...process.env,
      KUGELAUDIO_MODEL_ID: process.env.KUGELAUDIO_MODEL_ID || 'kugel-2',
      TTS_SIDECAR_PORT: process.env.TTS_SIDECAR_PORT || '3210',
      PYTHONUNBUFFERED: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    // Detach so node --watch SIGTERM on the parent doesn't cascade to the
    // sidecar before its warm-up completes. We still kill on clean exit.
    detached: false,
  });
  ttsSidecarChild = child;

  const tag = (line) => `[tts sidecar] ${line}`;
  child.stdout.on('data', (b) => b.toString().split(/\r?\n/).filter(Boolean).forEach((l) => console.log(tag(l))));
  child.stderr.on('data', (b) => b.toString().split(/\r?\n/).filter(Boolean).forEach((l) => console.warn(tag(l))));
  child.on('exit', (code, signal) => {
    console.warn(`[tts sidecar] exited (code ${code}, signal ${signal})`);
    if (ttsSidecarChild === child) ttsSidecarChild = null;
    // Keep sidecar available during long demos even if the process drops.
    if (!shuttingDown) {
      setTimeout(() => {
        startTtsSidecar().catch((e) => {
          console.warn(`[tts sidecar] auto-restart failed: ${e.message}`);
        });
      }, 1500);
    }
  });

  const stop = () => { try { child.kill('SIGTERM'); } catch {} };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  process.once('exit', stop);
  return child;
}

// Spawn the LiveKit voice agent (Phase 2). Different from the TTS sidecar:
// the agent is a long-running worker that connects out to LiveKit Cloud,
// not a local HTTP server. Idempotency is just "did we already spawn one
// in this process".
function startLivekitAgent() {
  if (livekitAgentChild && livekitAgentChild.exitCode === null) {
    console.log('[livekit agent] already running');
    return livekitAgentChild;
  }
  if (!process.env.LIVEKIT_URL || !process.env.LIVEKIT_API_KEY || !process.env.LIVEKIT_API_SECRET) {
    console.warn('[livekit agent] LIVEKIT_* env vars not set — skipping auto-start');
    return null;
  }
  const pythonCommand = resolvePythonCommand();
  if (!pythonCommand || !existsSync('livekit_agent.py')) {
    console.warn('[livekit agent] Python runtime or livekit_agent.py missing — skipping');
    return null;
  }

  console.log(`[livekit agent] launching worker with ${pythonCommand}`);
  const child = spawn(pythonCommand, ['livekit_agent.py', 'dev'], {
    env: { ...process.env, PYTHONUNBUFFERED: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  livekitAgentChild = child;
  const tag = (line) => `[livekit agent] ${line}`;
  child.stdout.on('data', (b) => b.toString().split(/\r?\n/).filter(Boolean).forEach((l) => console.log(tag(l))));
  child.stderr.on('data', (b) => b.toString().split(/\r?\n/).filter(Boolean).forEach((l) => console.warn(tag(l))));
  child.on('exit', (code, signal) => {
    console.warn(`[livekit agent] exited (code ${code}, signal ${signal})`);
    if (livekitAgentChild === child) livekitAgentChild = null;
    // Auto-respawn unless we're shutting down — agent dying mid-session
    // shouldn't require a full Node restart to recover.
    if (!shuttingDown) {
      setTimeout(() => startLivekitAgent(), 1500);
    }
  });
  const stop = () => { try { child.kill('SIGTERM'); } catch {} };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  process.once('exit', stop);
  return child;
}

httpServer.on('error', (error) => {
  if (error?.code === 'EADDRINUSE') {
    console.warn(`[boot] port ${PORT} already in use. Another server instance is likely running.`);
    console.warn(`[boot] re-use existing instance on ${serverProtocol}://localhost:${PORT} or stop stale node --watch processes first.`);
    return;
  }
  throw error;
});

httpServer.listen(PORT, HOST, () => {
  console.log('[boot] Orchestrate-first flow active');
  startTtsSidecar();
  startLivekitAgent();

  // Poll until TTS sidecar is ready, then pre-synthesize the greeting.
  (async () => {
    for (let i = 0; i < 30; i++) {
      if (await kugelAudioClient.sidecarHealthy()) {
        console.log('[tts sidecar] reachable on', kugelAudioClient.sidecarUrl);
        // Pre-synthesize the hardcoded greeting at boot so it's instant
        // when the user clicks "Gespräch starten".
        try {
          const scenario = getScenario(DEFAULT_SCENARIO_ID);
          if (scenario.greeting && voicePipeline) {
            const language = scenario.defaultLanguage || 'de';
            const ttsOpts = voicePipeline.ttsOptions(language);
            const chunks = [];
            await streamTtsWithVoice(scenario.greeting, {
              voiceId: DEFAULT_TTS_VOICE_ID,
              language: ttsOpts.language,
              cfgScale: ttsOpts.cfgScale,
              normalize: ttsOpts.normalize,
              logTag: 'boot/greeting',
              onAudio: ({ pcm, sampleRate, samples }) => {
                chunks.push({ pcm: pcm.toString('base64'), sampleRate, samples, encoding: 'pcm_s16le' });
              },
            });
            const key = openingPrefetchKey(scenario.id, DEFAULT_TTS_VOICE_ID, 'orchestrate');
            openingPrefetchCache.set(key, {
              scenarioId: scenario.id,
              language,
              greeting: scenario.greeting,
              threadId: null,
              audioChunks: chunks,
              usedVoiceId: DEFAULT_TTS_VOICE_ID,
              createdAt: Date.now(),
              expiresAt: Date.now() + OPENING_PREFETCH_TTL_MS,
              cacheHit: false,
              bootPrefetch: true,
            });
            console.log(`[boot] greeting pre-synthesized (${chunks.length} chunks)`);
          }
        } catch (e) {
          console.warn(`[boot] greeting pre-synthesis failed: ${e.message}`);
        }
        return;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    console.warn(`[tts sidecar] NOT reachable on ${kugelAudioClient.sidecarUrl} after 15s`);
  })();

  // Pre-fetch the IBM Cloud IAM token so the very first user turn doesn't
  // pay the ~500ms-1s OAuth round-trip. Token TTL is ~55min so this stays
  // valid across the demo session.
  if (orchestrateClient) {
    (async () => {
      try {
        await orchestrateClient.authenticate();
        console.log('[orchestrate] IAM token pre-warmed');
      } catch (e) {
        console.warn(`[orchestrate] pre-auth failed: ${e.message}`);
      }
    })();
  }

  console.log(`
╔════════════════════════════════════════════════════════════╗
║  KugelAudio × watsonx Orchestrate Voice AI Integration     ║
║  Server running on ${serverProtocol}://localhost:${PORT}
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
║    API Keys: ${process.env.KUGELAUDIO_API_KEY ? '✓' : '✗'} KugelAudio, ${process.env.ORCHESTRATE_API_KEY ? '✓' : '✗'} Orchestrate ║
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
