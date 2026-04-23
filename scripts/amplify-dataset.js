#!/usr/bin/env node
// Amplifies a handcrafted seed JSONL into a larger training set by asking
// watsonx llama-3-3-70b to generate N-1 plausible variations per seed.
//
// Usage:
//   node scripts/amplify-dataset.js claims    # reads claims.seed.jsonl → claims.jsonl
//   node scripts/amplify-dataset.js hotline   # reads hotline.seed.jsonl → hotline.jsonl
//
// Tunables via env:
//   AMPLIFY_FACTOR   default 10  (seed × factor)
//   AMPLIFY_CONCURRENCY default 3

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import WatsonxClient from '../src/watsonx-client.js';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const scenario = process.argv[2];
if (!scenario || !['claims', 'hotline'].includes(scenario)) {
  console.error('Usage: node scripts/amplify-dataset.js <claims|hotline>');
  process.exit(1);
}

const FACTOR = Number(process.env.AMPLIFY_FACTOR || 10);
// watsonx free/dev plans rate-limit hard; stay sequential by default.
const CONCURRENCY = Number(process.env.AMPLIFY_CONCURRENCY || 1);
const REQUEST_DELAY_MS = Number(process.env.AMPLIFY_DELAY_MS || 1200);
const MAX_RETRIES = 5;

const seedPath = path.join(__dirname, '..', 'src', 'agents', 'training', `${scenario}.seed.jsonl`);
const outPath = path.join(__dirname, '..', 'src', 'agents', 'training', `${scenario}.jsonl`);

const seeds = fs.readFileSync(seedPath, 'utf8')
  .split('\n')
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l));

console.log(`[amplify] ${scenario}: ${seeds.length} seeds × ${FACTOR} → target ${seeds.length * FACTOR}`);

const client = new WatsonxClient({
  apiKey: process.env.WATSONX_API_KEY,
  url: process.env.WATSONX_URL,
  projectId: process.env.WATSONX_PROJECT_ID,
});

const AMPLIFY_SYSTEM = `Du bist ein Datengenerator für deutschsprachige Trainingsdaten.
Du bekommst EIN Beispiel im Format {"messages":[{"role":"system",...},{"role":"user",...},{"role":"assistant",...}]}.
Erzeuge NEUE Varianten: gleicher System-Prompt (wortgleich), aber plausibel andere User-Inputs und passende Assistant-Antworten im exakt gleichen Stil, Format und Tonfall.
Antworte NUR mit JSONL — jede Zeile ein vollständiges JSON-Objekt, keine Markdown-Codefences, keine Einleitung, keine Nummerierung.`;

async function chatWithRetry(messages, opts) {
  let lastErr;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      return await client.chat(messages, opts);
    } catch (e) {
      const status = e?.response?.status;
      lastErr = e;
      if (status === 429 || status === 503) {
        const wait = Math.min(30000, 2000 * Math.pow(2, attempt));
        process.stdout.write(`    rate-limited (${status}), sleeping ${wait}ms…\n`);
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

async function amplifyOne(seed, count) {
  const userPrompt = `Gib genau ${count} neue Varianten des folgenden Beispiels zurück — NUR als JSONL, eine pro Zeile:

${JSON.stringify(seed)}`;

  const { text } = await chatWithRetry(
    [
      { role: 'system', content: AMPLIFY_SYSTEM },
      { role: 'user', content: userPrompt },
    ],
    { maxTokens: 2200, temperature: 0.9 },
  );

  const out = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim().replace(/^```(?:json(?:l)?)?/, '').replace(/```$/, '').trim();
    if (!trimmed || !trimmed.startsWith('{')) continue;
    try {
      const obj = JSON.parse(trimmed);
      if (obj && Array.isArray(obj.messages) && obj.messages.length >= 2) out.push(obj);
    } catch {
      // skip malformed lines
    }
  }
  return out;
}

async function runPool(items, worker, concurrency) {
  const results = new Array(items.length);
  let cursor = 0;
  async function next() {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      try {
        results[i] = await worker(items[i], i);
      } catch (e) {
        console.warn(`  seed ${i} failed: ${e.message}`);
        results[i] = [];
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => next()));
  return results;
}

const perSeed = Math.max(0, FACTOR - 1);
const startedAt = Date.now();

const variantsBySeed = await runPool(seeds, async (seed, i) => {
  const v = await amplifyOne(seed, perSeed);
  process.stdout.write(`  seed ${i + 1}/${seeds.length} → ${v.length} variants\n`);
  if (REQUEST_DELAY_MS > 0) await new Promise((r) => setTimeout(r, REQUEST_DELAY_MS));
  return v;
}, CONCURRENCY);

const all = [];
for (let i = 0; i < seeds.length; i++) {
  all.push(seeds[i]);
  for (const v of variantsBySeed[i]) all.push(v);
}

fs.writeFileSync(outPath, all.map((o) => JSON.stringify(o)).join('\n') + '\n');
console.log(`[amplify] wrote ${all.length} examples → ${outPath}  (${Math.round((Date.now() - startedAt) / 1000)}s)`);
