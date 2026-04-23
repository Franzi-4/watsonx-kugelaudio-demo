import axios from 'axios';

class KugelAudioClient {
  constructor(config) {
    this.apiKey = config.apiKey;
    this.apiUrl = (config.apiUrl || 'https://api.kugelaudio.com/v1').replace(/\/$/, '');
    this.defaultModelId = config.modelId || 'kugel-2-turbo';
    this.maxRetries = config.maxRetries ?? 3;
    this.retryDelayMs = config.retryDelayMs ?? 500;

    this.client = axios.create({
      baseURL: this.apiUrl,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
      },
      timeout: config.timeout || 30000,
    });
  }

  async listModels() {
    const { data } = await this._request({ method: 'GET', url: '/models' });
    return data.models || [];
  }

  async listVoices({ language, limit, offset, includePublic } = {}) {
    const params = {};
    if (language) params.language = language;
    if (limit !== undefined) params.limit = limit;
    if (offset !== undefined) params.offset = offset;
    if (includePublic !== undefined) params.include_public = includePublic;
    const { data } = await this._request({ method: 'GET', url: '/voices', params });
    return {
      voices: data.voices || [],
      total: data.total,
      limit: data.limit,
      offset: data.offset,
    };
  }

  async getVoice(voiceId) {
    const { data } = await this._request({ method: 'GET', url: `/voices/${voiceId}` });
    return data;
  }

  /**
   * Synthesize speech.
   * Returns { audio: Buffer, sampleRate, audioFormat, requestId }.
   * `audio` is raw PCM bytes (default pcm_s16le at 24000 Hz). Wrap in a WAV
   * header client-side if you need a playable file.
   */
  async textToSpeech(text, options = {}) {
    if (!text || !text.trim()) {
      throw new Error('text cannot be empty');
    }

    const body = {
      text,
      model_id: options.modelId || this.defaultModelId,
    };
    if (options.voiceId !== undefined) body.voice_id = Number(options.voiceId);
    if (options.cfgScale !== undefined) body.cfg_scale = options.cfgScale;
    if (options.maxNewTokens !== undefined) body.max_new_tokens = options.maxNewTokens;
    if (options.sampleRate !== undefined) body.sample_rate = options.sampleRate;
    if (options.normalize !== undefined) body.normalize = options.normalize;
    if (options.language !== undefined) body.language = options.language;
    if (options.speed !== undefined) body.speed = options.speed;

    const response = await this._request({
      method: 'POST',
      url: '/tts/generate',
      data: body,
      responseType: 'arraybuffer',
      headers: { 'Content-Type': 'application/json' },
    });

    return {
      audio: Buffer.from(response.data),
      sampleRate: Number(response.headers['x-sample-rate']) || 24000,
      audioFormat: response.headers['x-audio-format'] || 'pcm_s16le',
      requestId: response.headers['x-request-id'],
    };
  }

  async healthCheck() {
    try {
      await this._request({ method: 'GET', url: '/models', retries: 0 });
      return true;
    } catch {
      return false;
    }
  }

  async _request(config) {
    const maxAttempts = (config.retries ?? this.maxRetries) + 1;
    let lastError;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await this.client.request(config);
      } catch (error) {
        lastError = error;
        const status = error.response?.status;
        const retryable = !error.response || status >= 500 || status === 429 || status === 408;
        if (!retryable || attempt === maxAttempts) break;
        await new Promise((r) => setTimeout(r, this.retryDelayMs * 2 ** (attempt - 1)));
      }
    }

    const status = lastError.response?.status ?? 'network';
    let body = lastError.response?.data;
    if (body && Buffer.isBuffer(body)) body = body.toString('utf8').slice(0, 500);
    else if (body && typeof body === 'object') body = JSON.stringify(body).slice(0, 500);
    throw new Error(`KugelAudio ${status}: ${body || lastError.message}`);
  }
}

export default KugelAudioClient;
