import dotenv from 'dotenv';
import express from 'express';
import { WebSocketServer } from 'ws';
import { createServer as createHttpServer } from 'http';
import { createServer as createHttpsServer } from 'https';
import { spawn } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import path from 'path';
import { AccessToken } from 'livekit-server-sdk';
import KugelAudioClient from './kugelaudio-client.js';
import WatsonxClient from './watsonx-client.js';
import OrchestrateClient from './orchestrate-client.js';
import VoicePipeline from './voice-pipeline.js';
import { listScenarios, getScenario, getScriptedAssistantTurn, DEFAULT_SCENARIO_ID } from './agents/scenarios.js';
import { cleanLlmText } from './agents/text-cleanup.js';

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

// Serve static files from public directory
app.use(express.static('public'));

// Initialize clients
const kugelAudioClient = new KugelAudioClient({
  apiKey: process.env.KUGELAUDIO_API_KEY,
  apiUrl: process.env.KUGELAUDIO_API_URL,
  modelId: process.env.KUGELAUDIO_MODEL_ID || 'kugel-2-turbo',
});

const DEFAULT_TTS_VOICE_ID = process.env.KUGELAUDIO_VOICE_ID
  ? Number(process.env.KUGELAUDIO_VOICE_ID)
  : undefined;
const ALLOW_DEFAULT_VOICE_FALLBACK = process.env.KUGELAUDIO_ALLOW_DEFAULT_VOICE_FALLBACK === 'true';

function resolveVoiceId(voiceId) {
  if (voiceId === undefined || voiceId === null || voiceId === '') return DEFAULT_TTS_VOICE_ID;
  const parsed = Number(voiceId);
  return Number.isFinite(parsed) ? parsed : DEFAULT_TTS_VOICE_ID;
}

/**
 * Stream TTS and retry once without voiceId when provider-specific voice
 * selection fails (e.g. timeout/aborted for one voice profile).
 */
async function streamTtsWithVoiceFallback(text, opts) {
  const requestedVoiceId = resolveVoiceId(opts.voiceId);
  const baseOpts = {
    language: opts.language,
    cfgScale: opts.cfgScale,
    normalize: opts.normalize,
    onAudio: opts.onAudio,
  };

  try {
    await kugelAudioClient.streamFullTextTts(text, {
      ...baseOpts,
      voiceId: requestedVoiceId,
    });
    return { usedFallback: false, usedVoiceId: requestedVoiceId };
  } catch (error) {
    if (requestedVoiceId === undefined) throw error;
    if (!ALLOW_DEFAULT_VOICE_FALLBACK) {
      console.warn(
        `[${opts.logTag || 'tts'}] stream failed with pinned voiceId=${requestedVoiceId}: ${error.message} — fallback disabled`,
      );
      throw error;
    }
    console.warn(
      `[${opts.logTag || 'tts'}] stream failed with voiceId=${requestedVoiceId}: ${error.message} — retrying with SDK default voice`,
    );
    await kugelAudioClient.streamFullTextTts(text, baseOpts);
    return { usedFallback: true, usedVoiceId: undefined };
  }
}

const watsonxClient = new WatsonxClient({
  apiKey: process.env.WATSONX_API_KEY,
  url: process.env.WATSONX_URL,
  projectId: process.env.WATSONX_PROJECT_ID,
});

// Optional: route chat through watsonx Orchestrate when fully configured.
// Falls back to direct watsonx.ai chat when any of the three vars are missing.
const orchestrateConfigured = !!(
  process.env.ORCHESTRATE_API_KEY &&
  process.env.ORCHESTRATE_INSTANCE_URL &&
  process.env.ORCHESTRATE_AGENT_ID
);
const orchestrateClient = orchestrateConfigured
  ? new OrchestrateClient({
      apiKey: process.env.ORCHESTRATE_API_KEY,
      instanceUrl: process.env.ORCHESTRATE_INSTANCE_URL,
      agentId: process.env.ORCHESTRATE_AGENT_ID,
    })
  : null;
if (orchestrateClient) {
  console.log(`[orchestrate] routing chat through agent ${process.env.ORCHESTRATE_AGENT_ID}`);
}

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
  orchestrateClient,
  defaultAgentId: process.env.DEFAULT_AGENT_ID || 'customer-service-agent',
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
});

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
    const watsonxHealth = await watsonxClient.healthCheck();
    const orchestrateHealth = orchestrateClient ? await orchestrateClient.healthCheck() : false;

    const status = kugelAudioHealth && watsonxHealth ? 'healthy' : 'degraded';
    const statusCode = status === 'healthy' ? 200 : 503;

    res.status(statusCode).json({
      status,
      timestamp: new Date().toISOString(),
      services: {
        kugelaudio: kugelAudioHealth ? 'up' : 'down',
        watsonx_ai: watsonxHealth ? 'up' : 'down',
        watsonx_orchestrate: orchestrateClient
          ? (orchestrateHealth ? 'up' : 'down')
          : (process.env.ORCHESTRATE_URL ? 'provisioned' : 'missing'),
        watsonx_governance: process.env.GOVERNANCE_GUID ? 'provisioned' : 'missing',
      },
      orchestrate: process.env.ORCHESTRATE_URL ? {
        launch_url: process.env.ORCHESTRATE_URL + '/chat',
        agent: process.env.ORCHESTRATE_AGENT || process.env.ORCHESTRATE_AGENT_ID || 'AskOrchestrate',
        active: !!orchestrateClient,
      } : (orchestrateClient ? { agent: process.env.ORCHESTRATE_AGENT_ID, active: true } : null),
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
  const payload = {
    scenarios: listScenarios(),
    defaultScenarioId: DEFAULT_SCENARIO_ID,
  };
  res.json(payload);

  const defaultScenarioId = payload.defaultScenarioId || payload.scenarios?.[0]?.id;
  if (defaultScenarioId) {
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

// Pre-rendered greeting audio cache for instant playback on "Gespräch starten".
const greetingCache = new Map();
const openingPrefetchCache = new Map();
const OPENING_PREFETCH_TTL_MS = 2 * 60 * 1000;

function normalizeConversationMode(mode) {
  return mode === 'script' ? 'script' : 'free';
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
  if (
    normalizeConversationMode(conversationMode) === 'script' &&
    Array.isArray(scenario.scriptedAssistantTurns) &&
    scenario.scriptedAssistantTurns.length
  ) {
    return scenario.scriptedAssistantTurns[0];
  }

  const openerMessages = [
    { role: 'system', content: scenario.systemPrompt },
    {
      role: 'user',
      content: 'Starte das Gespräch jetzt als erster Agent-Turn. Schreibe genau eine kurze, natürliche Begrüßung für den Kunden und eine konkrete erste Frage. Deutsch, maximal 2 Sätze.',
    },
  ];

  let openingText = '';
  if (orchestrateClient) {
    try {
      const reply = await orchestrateClient.chat(openerMessages, {
        context: { sessionId, scenarioId: scenario.id, prefetch: true, turn: 'opening' },
      });
      openingText = (reply.text || '').trim();
    } catch (error) {
      console.warn(`[prefetch] orchestrate opening failed: ${error.message}`);
    }
  }

  if (!openingText) {
    try {
      const reply = await watsonxClient.chat(openerMessages, {
        maxTokens: 120,
        temperature: 0.6,
      });
      openingText = (reply.text || '').trim();
    } catch (error) {
      console.warn(`[prefetch] watsonx opening failed: ${error.message}`);
    }
  }

  if (!openingText) return scenario.greeting;
  return cleanLlmText(openingText, { language: scenario.defaultLanguage || 'de' }) || scenario.greeting;
}

async function prefetchScenarioOpening(scenarioId, voiceId, conversationMode = 'free') {
  const scenario = getScenario(scenarioId);
  const mode = normalizeConversationMode(conversationMode);
  const existing = getFreshOpeningPrefetch(scenario.id, voiceId, mode);
  if (existing) return { ...existing, cacheHit: true };

  const language = scenario.defaultLanguage || 'de';
  const openingText = await buildScenarioOpening(scenario, {
    sessionId: `prefetch_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
    conversationMode: mode,
  });
  const ttsOpts = voicePipeline.ttsOptions(language);
  const chunks = [];

  const ttsResult = await streamTtsWithVoiceFallback(openingText, {
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
    audioChunks: chunks,
    usedFallbackVoice: ttsResult.usedFallback,
    createdAt: Date.now(),
    expiresAt: Date.now() + OPENING_PREFETCH_TTL_MS,
    cacheHit: false,
  };
  openingPrefetchCache.set(openingPrefetchKey(scenario.id, voiceId, mode), record);
  return record;
}

async function prerenderGreeting(scenarioId) {
  const scenario = getScenario(scenarioId);
  if (!scenario?.greeting) return;
  const ttsOpts = voicePipeline.ttsOptions(scenario.defaultLanguage || 'de');
  const chunks = [];
  const t0 = Date.now();
  try {
    await kugelAudioClient.streamFullTextTts(scenario.greeting, {
      language: ttsOpts.language,
      cfgScale: ttsOpts.cfgScale,
      normalize: ttsOpts.normalize,
      onAudio: ({ pcm, sampleRate, samples }) => {
        chunks.push({
          pcm: pcm.toString('base64'),
          sampleRate,
          samples,
          encoding: 'pcm_s16le',
        });
      },
    });
    greetingCache.set(scenario.id, chunks);
    console.log(`[greeting cache] ${scenario.id}: ${chunks.length} chunks (${Date.now() - t0}ms)`);
  } catch (e) {
    console.warn(`[greeting cache] ${scenario.id} failed: ${e.message}`);
  }
}

async function prerenderAllGreetings() {
  const ids = listScenarios().map((s) => s.id);
  console.log(`[greeting cache] prerendering ${ids.length} scenarios: ${ids.join(', ')}`);
  for (const id of ids) {
    await prerenderGreeting(id);
  }
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
    const greeting = prefetched?.greeting || await buildScenarioOpening(scenario, {
      sessionId,
      conversationMode,
    });

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
      const cached = (effectiveVoiceId === undefined || effectiveVoiceId === null)
        ? greetingCache.get(scenario.id)
        : null;
      if (cached && greeting === scenario.greeting) {
        for (const c of cached) {
          send('audio', { index: chunkCount++, ...c });
        }
        console.log(`[scenario/start/stream] ${sessionId} static cache hit (${cached.length} chunks)`);
      } else {
        try {
          const ttsResult = await streamTtsWithVoiceFallback(greeting, {
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
          if (ttsResult.usedFallback) {
            console.log(`[scenario/start/stream] ${sessionId} retried with SDK default voice`);
          }
        } catch (e) {
          console.warn(`[scenario/start] TTS stream failed: ${e.message}`);
          send('error', { message: `tts: ${e.message}` });
        }
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
 * Returns the scenario's canned greeting plus Kugel TTS audio so the UI can
 * open the call with the agent speaking first — no LLM round-trip needed.
 */
app.post('/api/scenario/start', async (req, res) => {
  try {
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
    const greeting = await buildScenarioOpening(scenario, {
      sessionId,
      conversationMode,
    });
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
 * Pure TTS endpoint — turns arbitrary text into a WAV. Used by the
 * IBM-Orchestrate-widget overlay page (public/orchestrate.html) which
 * scrapes assistant messages from the widget DOM and pipes each one
 * through Kugel for the voice layer.
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
    if (!(await ensureTtsSidecarReady())) {
      return res.status(503).json({
        error: 'tts_unavailable',
        message: 'TTS sidecar is not reachable',
      });
    }

    const { text, sessionId: providedSessionId, voiceId, language, scenarioId, mode } = req.body || {};
    const conversationMode = normalizeConversationMode(mode);
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
        conversationMode,
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
      conversationMode,
    });
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
 *   event: audio     data: {pcm (b64 PCM s16le), sampleRate, samples, index, encoding}
 *   event: done      data: {responseText, processingTime, ttfa}
 *   event: error     data: {message}
 */
app.post('/api/converse/stream', async (req, res) => {
  const t0 = Date.now();
  const { text, sessionId: providedSessionId, voiceId, language, scenarioId, mode } = req.body || {};
  const conversationMode = normalizeConversationMode(mode);
  const effectiveVoiceId = resolveVoiceId(voiceId);
  if (!text || typeof text !== 'string' || !text.trim()) {
    return res.status(400).json({ error: 'text is required' });
  }

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
        conversationMode,
      });
    }
    const session = voicePipeline.getSession(sessionId);
    // Allow the client to switch scenarios mid-session without creating a new session.
    if (scenario.id !== session.scenarioId) session.scenarioId = scenario.id;
    session.conversationMode = conversationMode;
    send('session', { sessionId, scenarioId: session.scenarioId });

    const ttsOpts = voicePipeline.ttsOptions(effectiveLanguage);
    const scenarioConfig = getScenario(session.scenarioId);
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

    let fullText;
    let llmMs;
    const assistantHistoryCount = (session.context.conversation.messages || [])
      .filter((m) => m.role === 'assistant')
      .length;
    const scriptedResponse = (conversationMode === 'script')
      ? getScriptedAssistantTurn(scenarioConfig, assistantHistoryCount, text, { force: true })
      : null;
    if (scriptedResponse) {
      fullText = scriptedResponse;
      await emitPseudoDeltaStream(fullText, (chunk) => send('delta', { text: chunk }));
      llmMs = Date.now() - llmStartedAt;
    } else if (req.body?.skipLlm) {
      // Dev escape hatch — useful when watsonx is rate-limited and you only
      // want to exercise the TTS sidecar path. The user's text becomes the
      // assistant's response verbatim. Drop this if it ever ships beyond dev.
      fullText = text;
      await emitPseudoDeltaStream(fullText, (chunk) => send('delta', { text: chunk }));
      llmMs = Date.now() - llmStartedAt;
    } else {
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

      // Two-stage flow that matches the colleague's reference pattern:
      //   1) Stream LLM tokens to the browser as they arrive (so the user sees
      //      text appear live).
      //   2) Once LLM is done, hand the COMPLETE text to the Kugel SDK in
      //      Python — `client.tts.stream_async(text=TEXT, ...)` — and forward
      //      each AudioChunk to the browser. Full-text-in lets the model plan
      //      prosody at paragraph level, which is what restores voice quality
      //      vs. token-incremental streaming.
      if (orchestrateClient) {
        // Orchestrate path: non-streaming agent call. Emit the full response as
        // a single delta so the existing client SSE handler still works.
        try {
          const reply = await orchestrateClient.chat(messages, {
            context: { sessionId, scenarioId: session.scenarioId },
          });
          fullText = (reply.text || '').trim();
          if (fullText) {
            await emitPseudoDeltaStream(fullText, (chunk) => send('delta', { text: chunk }));
          }
        } catch (e) {
          console.warn(`Orchestrate chat failed: ${e.message} — falling back to watsonx.ai`);
        }
        if (!fullText) {
          const deploymentId = SCENARIO_DEPLOYMENTS[session.scenarioId] || undefined;
          const result = await watsonxClient.chatStream(messages, {
            deploymentId,
            maxTokens: 180,
            temperature: 0.7,
            onDelta: (d) => send('delta', { text: d }),
          });
          fullText = result.fullText;
        }
        llmMs = Date.now() - llmStartedAt;
      } else {
        const deploymentId = SCENARIO_DEPLOYMENTS[session.scenarioId] || undefined;
        const result = await watsonxClient.chatStream(messages, {
          deploymentId,
          maxTokens: 180,
          temperature: 0.7,
          onDelta: (d) => send('delta', { text: d }),
        });
        fullText = result.fullText;
        llmMs = Date.now() - llmStartedAt;
      }
    }

    // Strip llama's habitual echo-question tag-ons before they hit TTS —
    // the live `delta` stream stays raw (user sees what the model said),
    // but everything from here forward (TTS, session history, done event)
    // uses the cleaned version so what's heard matches what's persisted.
    const spokenText = cleanLlmText(fullText, { language: effectiveLanguage });

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
      const ttsResult = await streamTtsWithVoiceFallback(spokenText, {
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
      if (ttsResult.usedFallback) {
        console.log(`[converse/stream] ${sessionId} retried with SDK default voice`);
      }
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
const HOST = '0.0.0.0';
let shuttingDown = false;
let ttsSidecarChild = null;
let livekitAgentChild = null;
process.once('SIGINT', () => { shuttingDown = true; });
process.once('SIGTERM', () => { shuttingDown = true; });

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

  const venvPython = path.resolve('.venv-tts/bin/python');
  if (!existsSync(venvPython)) {
    console.warn(`[tts sidecar] ${venvPython} not found — skipping auto-start. Run: python3.11 -m venv .venv-tts && .venv-tts/bin/pip install -r requirements-tts.txt`);
    return null;
  }
  if (!existsSync('tts_sidecar.py')) {
    console.warn('[tts sidecar] tts_sidecar.py missing — skipping auto-start');
    return null;
  }

  console.log('[tts sidecar] launching Python child process');
  const child = spawn(venvPython, ['tts_sidecar.py'], {
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
  const venvPython = path.resolve('.venv-tts/bin/python');
  if (!existsSync(venvPython) || !existsSync('livekit_agent.py')) {
    console.warn('[livekit agent] venv or livekit_agent.py missing — skipping');
    return null;
  }

  console.log('[livekit agent] launching worker');
  const child = spawn(venvPython, ['livekit_agent.py', 'dev'], {
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
  console.log('[boot] greeting-cache build active');
  startTtsSidecar();
  startLivekitAgent();

  // Poll briefly so the boot log makes it obvious whether TTS is ready.
  (async () => {
    for (let i = 0; i < 30; i++) {
      if (await kugelAudioClient.sidecarHealthy()) {
        console.log('[tts sidecar] reachable on', kugelAudioClient.sidecarUrl);
        prerenderAllGreetings();
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
