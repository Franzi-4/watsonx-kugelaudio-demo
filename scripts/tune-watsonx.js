#!/usr/bin/env node
// Submits a watsonx.ai fine-tuning job for one of the demo scenarios.
//
// Usage:
//   node scripts/tune-watsonx.js claims
//   node scripts/tune-watsonx.js hotline
//
// What this script does:
//   1. Validates the amplified JSONL file locally.
//   2. Uploads the JSONL as a training-data asset to the watsonx project
//      (via COS connection defined in env).
//   3. POSTs a fine-tuning job to /ml/v1/fine_tunings.
//   4. Polls status until completed, then prints the deployment_id
//      to paste into .env as WATSONX_DEPLOYMENT_ID_<SCENARIO>.
//
// Required env:
//   WATSONX_API_KEY, WATSONX_URL, WATSONX_PROJECT_ID   (already set)
//   COS_CONNECTION_ID     asset-id of the COS connection inside the project
//   COS_BUCKET            bucket name where training data lives
//   TUNE_BASE_MODEL       default: ibm/granite-3-8b-instruct
//
// If COS_CONNECTION_ID / COS_BUCKET are missing the script stops before
// submitting and tells you exactly what to set up in watsonx Studio.

import fs from 'node:fs';
import path from 'node:path';
import axios from 'axios';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import WatsonxClient from '../src/watsonx-client.js';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const scenario = process.argv[2];
if (!scenario || !['claims', 'hotline'].includes(scenario)) {
  console.error('Usage: node scripts/tune-watsonx.js <claims|hotline>');
  process.exit(1);
}

const BASE_MODEL = process.env.TUNE_BASE_MODEL || 'ibm/granite-3-8b-instruct';
const API_VERSION = '2024-05-01';
const jsonlPath = path.join(__dirname, '..', 'src', 'agents', 'training', `${scenario}.jsonl`);

if (!fs.existsSync(jsonlPath)) {
  console.error(`missing ${jsonlPath} — run 'npm run amplify:${scenario}' first.`);
  process.exit(1);
}

const lines = fs.readFileSync(jsonlPath, 'utf8').split('\n').filter((l) => l.trim());
let badLines = 0;
for (const l of lines) {
  try {
    const o = JSON.parse(l);
    if (!Array.isArray(o.messages)) badLines++;
  } catch { badLines++; }
}
if (badLines > 0) {
  console.error(`${badLines}/${lines.length} malformed lines in ${jsonlPath}. Aborting.`);
  process.exit(1);
}
console.log(`[tune] ${scenario}: ${lines.length} valid examples`);

const { WATSONX_API_KEY, WATSONX_URL, WATSONX_PROJECT_ID, COS_CONNECTION_ID, COS_BUCKET } = process.env;
if (!WATSONX_API_KEY || !WATSONX_PROJECT_ID) {
  console.error('WATSONX_API_KEY and WATSONX_PROJECT_ID are required in .env');
  process.exit(1);
}

if (!COS_CONNECTION_ID || !COS_BUCKET) {
  console.log(`
[tune] COS_CONNECTION_ID / COS_BUCKET not set — can't submit a job yet.

To enable automated tuning you need a one-time watsonx Studio setup:
  1. Open the project (id ${WATSONX_PROJECT_ID}) in watsonx.ai Studio.
  2. Add a Cloud Object Storage connection (Assets → New asset → Connection → IBM Cloud Object Storage).
     Copy its asset id into COS_CONNECTION_ID.
  3. Pick or create a bucket in that COS instance; put its name in COS_BUCKET.
  4. Re-run: node scripts/tune-watsonx.js ${scenario}

Seed file is ready at ${jsonlPath} with ${lines.length} examples.
`);
  process.exit(0);
}

const client = new WatsonxClient({
  apiKey: WATSONX_API_KEY,
  url: WATSONX_URL,
  projectId: WATSONX_PROJECT_ID,
});

async function iamToken() {
  await client._ensureToken();
  return client.accessToken;
}

async function uploadToCos(token) {
  // Upload the JSONL directly into the bucket via the watsonx data-asset
  // create-and-upload endpoint. We store the asset name as
  // `${scenario}-YYYYMMDDHHMMSS.jsonl` so repeated runs don't collide.
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const assetName = `${scenario}-${stamp}.jsonl`;

  // Use the CPD data-assets API to register the file, then upload bytes.
  const baseUrl = (WATSONX_URL || 'https://eu-de.ml.cloud.ibm.com').replace(/\/$/, '');

  // Step 1 — create asset handle
  const createResp = await axios.post(
    `${baseUrl}/v2/assets`,
    {
      metadata: {
        name: assetName,
        asset_type: 'data_asset',
        origin_country: 'de',
        rov: { mode: 0 },
      },
      entity: {
        data_asset: { mime_type: 'application/jsonl' },
      },
    },
    {
      params: { project_id: WATSONX_PROJECT_ID },
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    },
  );
  const assetId = createResp.data.metadata.asset_id;

  // Step 2 — upload bytes
  const body = fs.readFileSync(jsonlPath);
  await axios.put(
    `${baseUrl}/v2/asset_files/${assetId}`,
    body,
    {
      params: { project_id: WATSONX_PROJECT_ID },
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/jsonl' },
    },
  );
  console.log(`[tune] uploaded ${body.length} bytes → asset ${assetId} (${assetName})`);
  return { assetId, assetName };
}

async function submitFineTune(token, assetName) {
  const baseUrl = (WATSONX_URL || 'https://eu-de.ml.cloud.ibm.com').replace(/\/$/, '');
  const payload = {
    name: `kugel-${scenario}-${Date.now()}`,
    description: `Fine-tune for ${scenario} scenario`,
    project_id: WATSONX_PROJECT_ID,
    task_id: 'generation',
    training_data_references: [
      {
        type: 'connection_asset',
        connection: { id: COS_CONNECTION_ID },
        location: { bucket: COS_BUCKET, file_name: assetName },
      },
    ],
    results_reference: {
      type: 'connection_asset',
      connection: { id: COS_CONNECTION_ID },
      location: { bucket: COS_BUCKET, path: `tuning-results/${scenario}` },
    },
    base_model: { model_id: BASE_MODEL },
    parameters: {
      num_epochs: 4,
      learning_rate: 0.0002,
      batch_size: 8,
      max_seq_length: 1024,
      accumulate_steps: 16,
    },
    auto_update_model: true,
  };

  const resp = await axios.post(
    `${baseUrl}/ml/v1/fine_tunings`,
    payload,
    {
      params: { version: API_VERSION },
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    },
  );
  return resp.data;
}

async function pollJob(token, jobId) {
  const baseUrl = (WATSONX_URL || 'https://eu-de.ml.cloud.ibm.com').replace(/\/$/, '');
  const terminal = new Set(['completed', 'failed', 'canceled']);
  while (true) {
    const resp = await axios.get(
      `${baseUrl}/ml/v1/fine_tunings/${jobId}`,
      {
        params: { version: API_VERSION, project_id: WATSONX_PROJECT_ID },
        headers: { Authorization: `Bearer ${token}` },
      },
    );
    const state = resp.data?.entity?.status?.state || 'pending';
    const msg = resp.data?.entity?.status?.message?.text || '';
    process.stdout.write(`  [tune] ${state}${msg ? ' — ' + msg : ''}\n`);
    if (terminal.has(state)) return resp.data;
    await new Promise((r) => setTimeout(r, 30000));
  }
}

(async () => {
  try {
    const token = await iamToken();
    const { assetName } = await uploadToCos(token);
    const job = await submitFineTune(token, assetName);
    const jobId = job?.metadata?.id;
    console.log(`[tune] submitted job ${jobId} — polling every 30s…`);
    const final = await pollJob(token, jobId);
    const state = final?.entity?.status?.state;
    if (state !== 'completed') {
      console.error(`[tune] job ended in state: ${state}`);
      process.exit(1);
    }
    const modelId = final?.entity?.model_id || final?.entity?.result?.model_id;
    console.log(`
[tune] ✓ complete. Tuned model id: ${modelId}

Next step — create a deployment in watsonx Studio (or via /ml/v1/deployments),
then add its id to .env as:
  WATSONX_DEPLOYMENT_ID_${scenario.toUpperCase()}=<deployment-id>
`);
  } catch (e) {
    const body = e?.response?.data ? JSON.stringify(e.response.data) : '';
    console.error(`[tune] failed: ${e.message} ${body}`);
    process.exit(1);
  }
})();
