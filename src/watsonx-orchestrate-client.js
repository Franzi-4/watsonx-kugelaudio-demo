import axios from 'axios';

/**
 * IBM watsonx Orchestrate API Client
 *
 * Provides methods for:
 * - Creating and managing conversational agents
 * - Sending messages to agents
 * - Managing conversation context
 * - IBM Cloud authentication
 */
class WatsonxOrchestrateClient {
  /**
   * Initialize watsonx Orchestrate client
   * @param {Object} config - Configuration object
   * @param {string} config.apiKey - IBM Cloud API key
   * @param {string} config.url - watsonx Orchestrate base URL
   * @param {string} config.projectId - IBM Cloud project ID
   * @param {number} config.timeout - Request timeout in ms (default: 30000)
   */
  constructor(config) {
    this.apiKey = config.apiKey;
    this.url = config.url || 'https://eu-de.ml.cloud.ibm.com';
    this.projectId = config.projectId;
    this.timeout = config.timeout || 30000;
    this.accessToken = null;
    this.tokenExpiresAt = null;

    // Initialize axios instance
    this.client = axios.create({
      baseURL: this.url,
      timeout: this.timeout,
    });
  }

  /**
   * Authenticate with IBM Cloud and obtain access token
   * Called automatically when token expires
   *
   * @returns {Promise<string>} Access token
   * @throws {Error} If authentication fails
   */
  async authenticate() {
    try {
      const response = await axios.post('https://iam.cloud.ibm.com/identity/token', null, {
        auth: {
          username: 'bx',
          password: 'bx',
        },
        params: {
          grant_type: 'urn:ibm:params:oauth:grant-type:apikey',
          apikey: this.apiKey,
          response_type: 'cloud_iam',
        },
        timeout: this.timeout,
      });

      this.accessToken = response.data.access_token;
      // Set expiry 5 minutes before actual expiry for safety
      this.tokenExpiresAt = Date.now() + (response.data.expires_in * 1000) - (5 * 60 * 1000);

      return this.accessToken;
    } catch (error) {
      throw new Error(`IBM Cloud authentication failed: ${error.message}`);
    }
  }

  /**
   * Ensure valid access token
   * Authenticates if token is missing or expired
   *
   * @private
   * @returns {Promise<string>} Valid access token
   */
  async _ensureToken() {
    if (!this.accessToken || Date.now() >= this.tokenExpiresAt) {
      return this.authenticate();
    }
    return this.accessToken;
  }

  /**
   * Send a message to a watsonx Orchestrate agent
   *
   * @param {string} agentId - Agent identifier
   * @param {string} message - User message to send
   * @param {Object} context - Conversation context (optional)
   * @returns {Promise<{response: string, context: Object, status: string}>} Agent response
   * @throws {Error} If message sending fails
   */
  async sendMessage(agentId, message, context = {}) {
    if (!agentId || !message) {
      throw new Error('Agent ID and message are required');
    }

    const token = await this._ensureToken();

    const payload = {
      input: {
        message_type: 'text',
        text: message,
      },
      context: context,
    };

    try {
      const response = await this.client.post(
        `/api/v2/agents/${agentId}/message`,
        payload,
        {
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          params: {
            project_id: this.projectId,
          },
        }
      );

      return {
        response: response.data.output?.text || '',
        context: response.data.context || {},
        status: response.data.status || 'success',
      };
    } catch (error) {
      throw new Error(`Failed to send message to agent: ${error.message}`);
    }
  }

  /**
   * Create a new watsonx Orchestrate agent
   *
   * @param {Object} config - Agent configuration
   * @param {string} config.name - Agent name
   * @param {string} config.description - Agent description
   * @param {string} config.type - Agent type (e.g., 'conversational')
   * @param {Object} config.parameters - Agent-specific parameters
   * @returns {Promise<{agentId: string, name: string, status: string}>} Created agent details
   * @throws {Error} If agent creation fails
   */
  async createAgent(config) {
    if (!config.name) {
      throw new Error('Agent name is required');
    }

    const token = await this._ensureToken();

    const payload = {
      name: config.name,
      description: config.description || '',
      agent_type: config.type || 'conversational',
      parameters: config.parameters || {},
    };

    try {
      const response = await this.client.post(
        '/api/v2/agents',
        payload,
        {
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          params: {
            project_id: this.projectId,
          },
        }
      );

      return {
        agentId: response.data.agent_id,
        name: response.data.name,
        status: response.data.status,
      };
    } catch (error) {
      throw new Error(`Failed to create agent: ${error.message}`);
    }
  }

  /**
   * List all available agents
   *
   * @returns {Promise<Array>} Array of agent objects with metadata
   * @throws {Error} If listing fails
   */
  async listAgents() {
    const token = await this._ensureToken();

    try {
      const response = await this.client.get(
        '/api/v2/agents',
        {
          headers: {
            'Authorization': `Bearer ${token}`,
          },
          params: {
            project_id: this.projectId,
          },
        }
      );

      return response.data.agents || [];
    } catch (error) {
      throw new Error(`Failed to list agents: ${error.message}`);
    }
  }

  /**
   * Get agent response in conversation context
   * Maintains conversation history and context
   *
   * @param {string} agentId - Agent identifier
   * @param {string} conversationId - Conversation identifier
   * @param {string} userMessage - User's message
   * @returns {Promise<{text: string, conversationId: string, context: Object}>} Agent response
   * @throws {Error} If request fails
   */
  async getAgentResponse(agentId, conversationId, userMessage) {
    if (!agentId || !conversationId || !userMessage) {
      throw new Error('Agent ID, conversation ID, and user message are required');
    }

    const token = await this._ensureToken();

    const payload = {
      message: userMessage,
      conversation_id: conversationId,
    };

    try {
      const response = await this.client.post(
        `/api/v2/agents/${agentId}/conversations/${conversationId}/message`,
        payload,
        {
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          params: {
            project_id: this.projectId,
          },
        }
      );

      return {
        text: response.data.response?.text || '',
        conversationId: response.data.conversation_id,
        context: response.data.context || {},
      };
    } catch (error) {
      throw new Error(`Failed to get agent response: ${error.message}`);
    }
  }

  /**
   * Get agent details
   *
   * @param {string} agentId - Agent identifier
   * @returns {Promise<Object>} Agent details
   * @throws {Error} If request fails
   */
  async getAgent(agentId) {
    if (!agentId) {
      throw new Error('Agent ID is required');
    }

    const token = await this._ensureToken();

    try {
      const response = await this.client.get(
        `/api/v2/agents/${agentId}`,
        {
          headers: {
            'Authorization': `Bearer ${token}`,
          },
          params: {
            project_id: this.projectId,
          },
        }
      );

      return response.data;
    } catch (error) {
      throw new Error(`Failed to get agent: ${error.message}`);
    }
  }

  /**
   * Check API health
   *
   * @returns {Promise<boolean>} True if API is accessible
   */
  async healthCheck() {
    try {
      const token = await this._ensureToken();
      const response = await this.client.get(
        '/api/v2/status',
        {
          headers: {
            'Authorization': `Bearer ${token}`,
          },
        }
      );
      return response.status === 200;
    } catch {
      return false;
    }
  }
}

export default WatsonxOrchestrateClient;
