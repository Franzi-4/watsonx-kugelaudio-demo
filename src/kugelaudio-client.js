import axios from 'axios';

/**
 * KugelAudio API Client
 *
 * Provides methods for voice AI operations including:
 * - Text-to-speech synthesis with voice cloning
 * - Speech-to-text transcription
 * - Voice cloning from reference audio
 * - Language detection
 *
 * Latency: 39ms average for real-time processing
 * Supports: 24 EU languages
 */
class KugelAudioClient {
  /**
   * Initialize KugelAudio client
   * @param {Object} config - Configuration object
   * @param {string} config.apiKey - KugelAudio API key
   * @param {string} config.apiUrl - Base API URL
   * @param {number} config.maxRetries - Maximum retry attempts (default: 3)
   * @param {number} config.retryDelayMs - Delay between retries in ms (default: 1000)
   */
  constructor(config) {
    this.apiKey = config.apiKey;
    this.apiUrl = config.apiUrl || 'https://api.kugelaudio.com/v1';
    this.maxRetries = config.maxRetries || 3;
    this.retryDelayMs = config.retryDelayMs || 1000;

    // Initialize axios instance with default headers
    this.client = axios.create({
      baseURL: this.apiUrl,
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      timeout: 30000,
    });
  }

  /**
   * Convert text to speech
   * Average latency: 39ms
   *
   * @param {string} text - Text to synthesize
   * @param {string} language - Language code (e.g., 'en', 'de', 'fr')
   * @param {string} voiceId - Voice ID to use
   * @returns {Promise<Buffer>} Audio buffer containing synthesized speech
   * @throws {Error} If text-to-speech conversion fails
   */
  async textToSpeech(text, language = 'en', voiceId) {
    if (!text || text.trim().length === 0) {
      throw new Error('Text cannot be empty');
    }

    const payload = {
      text,
      language,
      voice_id: voiceId,
      format: 'wav',
    };

    return this._requestWithRetry('POST', '/synthesis', payload, 'arraybuffer');
  }

  /**
   * Convert speech to text
   * Detects language automatically if not specified
   *
   * @param {Buffer} audioBuffer - Audio buffer to transcribe
   * @param {string} language - Language code (optional)
   * @returns {Promise<{text: string, confidence: number, language: string}>} Transcription result
   * @throws {Error} If speech-to-text conversion fails
   */
  async speechToText(audioBuffer, language) {
    if (!Buffer.isBuffer(audioBuffer) || audioBuffer.length === 0) {
      throw new Error('Audio buffer must be a valid non-empty buffer');
    }

    const formData = new FormData();
    formData.append('audio', new Blob([audioBuffer], { type: 'audio/wav' }));
    if (language) {
      formData.append('language', language);
    }
    formData.append('format', 'json');

    try {
      const response = await this._requestWithRetry(
        'POST',
        '/transcription',
        formData,
        'json',
        {
          'Content-Type': 'multipart/form-data',
        }
      );
      return response.data;
    } catch (error) {
      throw new Error(`Speech-to-text failed: ${error.message}`);
    }
  }

  /**
   * Create a voice clone from reference audio
   *
   * @param {string} referenceAudioPath - File path to reference audio
   * @param {string} voiceName - Name for the cloned voice
   * @returns {Promise<{voiceId: string, voiceName: string, cloneStatus: string}>} Voice clone details
   * @throws {Error} If voice cloning fails
   */
  async cloneVoice(referenceAudioPath, voiceName) {
    if (!referenceAudioPath || !voiceName) {
      throw new Error('Reference audio path and voice name are required');
    }

    const payload = {
      reference_audio_path: referenceAudioPath,
      voice_name: voiceName,
    };

    try {
      const response = await this._requestWithRetry('POST', '/voice-clone', payload);
      return response.data;
    } catch (error) {
      throw new Error(`Voice cloning failed: ${error.message}`);
    }
  }

  /**
   * List available voices
   * Supports 24 EU languages including English, German, French, Spanish, Italian, etc.
   *
   * @returns {Promise<Array>} Array of available voices with metadata
   * @throws {Error} If voice listing fails
   */
  async listVoices() {
    try {
      const response = await this._requestWithRetry('GET', '/voices');
      return response.data.voices || [];
    } catch (error) {
      throw new Error(`Failed to list voices: ${error.message}`);
    }
  }

  /**
   * Detect language from audio
   * Supports 24 EU languages
   *
   * @param {Buffer} audioBuffer - Audio buffer to analyze
   * @returns {Promise<{language: string, confidence: number, alternatives: Array}>} Language detection result
   * @throws {Error} If language detection fails
   */
  async detectLanguage(audioBuffer) {
    if (!Buffer.isBuffer(audioBuffer) || audioBuffer.length === 0) {
      throw new Error('Audio buffer must be a valid non-empty buffer');
    }

    const formData = new FormData();
    formData.append('audio', new Blob([audioBuffer], { type: 'audio/wav' }));

    try {
      const response = await this._requestWithRetry(
        'POST',
        '/detect-language',
        formData,
        'json',
        {
          'Content-Type': 'multipart/form-data',
        }
      );
      return response.data;
    } catch (error) {
      throw new Error(`Language detection failed: ${error.message}`);
    }
  }

  /**
   * Internal method: Perform HTTP request with retry logic
   *
   * @private
   * @param {string} method - HTTP method
   * @param {string} endpoint - API endpoint
   * @param {*} data - Request payload
   * @param {string} responseType - Expected response type
   * @param {Object} additionalHeaders - Additional headers to merge
   * @returns {Promise<*>} API response
   * @throws {Error} If all retry attempts fail
   */
  async _requestWithRetry(method, endpoint, data, responseType = 'json', additionalHeaders = {}) {
    let lastError;

    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        const config = {
          method,
          url: endpoint,
          responseType,
        };

        // Merge additional headers
        if (Object.keys(additionalHeaders).length > 0) {
          config.headers = { ...this.client.defaults.headers, ...additionalHeaders };
        }

        // Set data for POST/PUT/PATCH requests
        if (method !== 'GET' && method !== 'DELETE') {
          config.data = data;
        }

        const response = await this.client(config);
        return response;
      } catch (error) {
        lastError = error;

        // Check if error is retryable
        const isRetryable = this._isRetryableError(error);
        if (!isRetryable || attempt === this.maxRetries) {
          break;
        }

        // Exponential backoff
        const delay = this.retryDelayMs * Math.pow(2, attempt - 1);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }

    const statusCode = lastError?.response?.status || 'unknown';
    const message = lastError?.message || 'Unknown error';
    throw new Error(`KugelAudio API request failed: ${statusCode} - ${message}`);
  }

  /**
   * Determine if an error is retryable
   *
   * @private
   * @param {Error} error - Error to evaluate
   * @returns {boolean} True if request should be retried
   */
  _isRetryableError(error) {
    // Network errors
    if (!error.response) {
      return true;
    }

    // Server errors (5xx)
    if (error.response.status >= 500) {
      return true;
    }

    // Too Many Requests
    if (error.response.status === 429) {
      return true;
    }

    // Request timeout
    if (error.response.status === 408) {
      return true;
    }

    return false;
  }

  /**
   * Check API health
   *
   * @returns {Promise<boolean>} True if API is accessible
   */
  async healthCheck() {
    try {
      const response = await this.client.get('/health');
      return response.status === 200;
    } catch {
      return false;
    }
  }
}

export default KugelAudioClient;
