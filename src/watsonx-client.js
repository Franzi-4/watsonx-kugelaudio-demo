import axios from 'axios';

const DEFAULT_MODEL_ID = 'meta-llama/llama-3-3-70b-instruct';
const DEFAULT_API_VERSION = '2024-05-01';

class WatsonxClient {
  constructor(config) {
    this.apiKey = config.apiKey;
    this.url = (config.url || 'https://eu-de.ml.cloud.ibm.com').replace(/\/$/, '');
    this.projectId = config.projectId;
    this.modelId = config.modelId || DEFAULT_MODEL_ID;
    this.apiVersion = config.apiVersion || DEFAULT_API_VERSION;
    this.timeout = config.timeout || 30000;

    this.accessToken = null;
    this.tokenExpiresAt = 0;

    this.client = axios.create({
      baseURL: this.url,
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
    // Refresh 5 min before actual expiry.
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
   * Foundation-model chat completion via /ml/v1/text/chat.
   * messages: [{ role: 'system' | 'user' | 'assistant', content: string }]
   * Returns { text, usage, modelId }.
   */
  async chat(messages, { modelId, maxTokens = 300, temperature = 0.7 } = {}) {
    if (!this.projectId) throw new Error('WATSONX_PROJECT_ID is required for chat');
    if (!Array.isArray(messages) || messages.length === 0) {
      throw new Error('messages must be a non-empty array');
    }

    const token = await this._ensureToken();
    const { data } = await this.client.post(
      '/ml/v1/text/chat',
      {
        model_id: modelId || this.modelId,
        project_id: this.projectId,
        messages,
        max_tokens: maxTokens,
        temperature,
      },
      {
        params: { version: this.apiVersion },
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      },
    );

    return {
      text: data?.choices?.[0]?.message?.content ?? '',
      usage: data?.usage,
      modelId: data?.model_id,
    };
  }

  /**
   * Back-compat wrapper so the existing voice pipeline keeps working.
   * Ignores agentId / conversationId — the pipeline already tracks
   * conversation history on its session object and calls chat() directly
   * when it can; this method is kept for callers that pass a single turn.
   */
  async getAgentResponse(_agentId, _conversationId, userMessage, systemPrompt) {
    const messages = [];
    if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
    messages.push({ role: 'user', content: userMessage });
    const reply = await this.chat(messages);
    return { text: reply.text, usage: reply.usage };
  }

  async healthCheck() {
    try {
      await this._ensureToken();
      return true;
    } catch {
      return false;
    }
  }
}

export default WatsonxClient;
