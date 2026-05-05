import axios from 'axios';

/**
 * watsonx Orchestrate client.
 *
 * Calls the Orchestrate chat completions endpoint on a specific agent.
 * Docs: POST {instanceUrl}/api/v1/orchestrate/{agentId}/chat/completions
 *       body: { messages: [...], stream: false, context: {} }
 *
 * Orchestrate uses an instance-specific API key generated inside the
 * Orchestrate UI (Settings → API details → Generate API key) — NOT the
 * IBM Cloud account IAM API key. That key is exchanged once via IAM for
 * a short-lived access token that's then sent as the Bearer for each
 * chat request, the same pattern as watsonx.ai.
 */
class OrchestrateClient {
  constructor(config) {
    this.apiKey = config.apiKey;
    this.instanceUrl = (config.instanceUrl || '').replace(/\/$/, '');
    this.agentId = config.agentId;
    this.timeout = config.timeout || 30000;

    this.accessToken = null;
    this.tokenExpiresAt = 0;

    this.client = axios.create({
      baseURL: this.instanceUrl,
      timeout: this.timeout,
    });
  }

  async authenticate() {
    const response = await axios.post('https://iam.cloud.ibm.com/identity/token', null, {
      params: {
        grant_type: 'urn:ibm:params:oauth:grant-type:apikey',
        apikey: this.apiKey,
      },
      timeout: this.timeout,
    });
    this.accessToken = response.data.access_token;
    this.tokenExpiresAt = Date.now() + response.data.expires_in * 1000 - 5 * 60 * 1000;
    return this.accessToken;
  }

  async _ensureToken() {
    if (!this.accessToken || Date.now() >= this.tokenExpiresAt) {
      await this.authenticate();
    }
    return this.accessToken;
  }

  /**
   * Run a chat turn through an Orchestrate agent.
   * messages: [{ role, content }]
   * Returns { text, raw }.
   */
  async chat(messages, { agentId, stream = false, context = {} } = {}) {
    const targetAgent = agentId || this.agentId;
    if (!targetAgent) throw new Error('Orchestrate agentId is required');
    if (!this.instanceUrl) throw new Error('Orchestrate instanceUrl is required');

    const token = await this._ensureToken();

    const { data } = await this.client.post(
      `/v1/orchestrate/${targetAgent}/chat/completions`,
      { messages, stream, context },
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      },
    );

    // Orchestrate's response shape is OpenAI-ish: choices[0].message.content
    // but can also return a messages[] array for multi-step agent turns.
    const text =
      data?.choices?.[0]?.message?.content
      ?? data?.messages?.at(-1)?.content
      ?? '';

    return { text: typeof text === 'string' ? text : JSON.stringify(text), raw: data };
  }

  async healthCheck() {
    if (!this.apiKey || !this.instanceUrl) return false;
    try {
      await this._ensureToken();
      return true;
    } catch {
      return false;
    }
  }
}

export default OrchestrateClient;
