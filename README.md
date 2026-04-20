# KugelAudio × watsonx Orchestrate Integration

A production-ready Node.js integration package combining KugelAudio's advanced voice AI with IBM watsonx Orchestrate for intelligent conversational agents.

## Overview

This package provides a complete voice pipeline that:

- **Captures audio streams** via WebSocket
- **Detects language** automatically (39ms latency, 24 EU languages supported)
- **Transcribes speech** to text with high confidence
- **Routes intelligently** through watsonx Orchestrate agents
- **Synthesizes responses** with natural voice cloning
- **Streams audio back** in real-time

Perfect for building customer service agents, support bots, and multilingual voice applications.

## Prerequisites

- **Node.js 18+**
- **KugelAudio API credentials** (API key and endpoint)
- **IBM watsonx Orchestrate credentials** (API key, URL, project ID)
- **Optional:** Salesforce integration for CRM lookup

## Quick Start

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure Environment

```bash
cp .env.example .env
```

Edit `.env` with your credentials:

```env
KUGELAUDIO_API_KEY=your_api_key_here
KUGELAUDIO_API_URL=https://api.kugelaudio.com/v1

WATSONX_API_KEY=your_watsonx_api_key_here
WATSONX_URL=https://eu-de.ml.cloud.ibm.com
WATSONX_PROJECT_ID=your_project_id

PORT=3000
```

### 3. Start the Server

```bash
npm start
```

Server will start on `http://localhost:3000`

For development with auto-reload:

```bash
npm run dev
```

## Architecture Overview

### System Components

```
┌─────────────┐
│   Client    │ (Browser, Mobile, Voice Device)
└──────┬──────┘
       │ WebSocket Audio Stream
       ▼
┌──────────────────────────────────────────┐
│         Express Server (Node.js)         │
├──────────────────────────────────────────┤
│                                          │
│  ┌──────────────────────────────────┐   │
│  │      Voice Pipeline Manager      │   │
│  ├──────────────────────────────────┤   │
│  │ 1. Audio Reception (WebSocket)   │   │
│  │ 2. Language Detection            │   │
│  │ 3. Speech-to-Text (STT)          │   │
│  │ 4. Intent Classification         │   │
│  │ 5. Agent Routing                 │   │
│  │ 6. Text-to-Speech (TTS)          │   │
│  │ 7. Voice Synthesis & Streaming   │   │
│  └──────────────────────────────────┘   │
│           ▲                ▲             │
│           │                │             │
└───────────┼────────────────┼─────────────┘
            │                │
     ┌──────▼─────────┐ ┌────▼──────────┐
     │  KugelAudio    │ │ watsonx       │
     │  Voice AI      │ │ Orchestrate   │
     │  - STT/TTS     │ │ - Agents      │
     │  - 39ms latency│ │ - CRM Sync    │
     │  - 24 Languages│ │ - Escalation  │
     └────────────────┘ └───────────────┘
```

### Data Flow

1. **Audio Ingestion**: Client streams audio chunks via WebSocket
2. **Language Detection**: KugelAudio detects language (39ms average)
3. **Transcription**: Speech converted to text with confidence scoring
4. **Intent Classification**: Message routed based on content
5. **Agent Processing**: watsonx Orchestrate agent handles the query
6. **Response Synthesis**: Agent response converted to natural speech
7. **Audio Streaming**: Response audio streamed back to client in real-time

## File Structure

```
code-templates/
├── package.json                    # Dependencies and metadata
├── .env.example                    # Environment variables template
├── README.md                       # This file
└── src/
    ├── server.js                   # Express server & WebSocket setup
    ├── kugelaudio-client.js        # KugelAudio API client
    ├── watsonx-orchestrate-client.js # watsonx API client
    ├── voice-pipeline.js           # Voice processing pipeline
    └── agents/
        └── customer-service-agent.js # Customer service agent definition
```

## API Reference

### REST Endpoints

#### Health Check

```
GET /api/health
```

Response:
```json
{
  "status": "healthy",
  "timestamp": "2024-04-20T10:30:00Z",
  "services": {
    "kugelaudio": "up",
    "watsonx": "up"
  }
}
```

#### List Agents

```
GET /api/agents
```

Response:
```json
{
  "agents": [
    {
      "agent_id": "customer-service-agent",
      "name": "Customer Service Agent",
      "status": "active"
    }
  ],
  "count": 1
}
```

#### List Voices

```
GET /api/voices
```

Response:
```json
{
  "voices": [
    {
      "voice_id": "voice_001",
      "name": "Emma (EN)",
      "language": "en",
      "gender": "female"
    }
  ],
  "count": 12,
  "supported_languages": 24
}
```

#### Initiate Voice Call

```
POST /api/call
Content-Type: application/json

{
  "agentId": "customer-service-agent",
  "language": "en",
  "customerId": "cust_123"
}
```

Response:
```json
{
  "sessionId": "session_1713607200000_abc123def",
  "agentId": "customer-service-agent",
  "status": "initiated",
  "wsUrl": "ws://localhost:3000/voice?sessionId=session_1713607200000_abc123def"
}
```

#### Get Session Stats

```
GET /api/sessions/:sessionId/stats
```

Response:
```json
{
  "sessionId": "session_1713607200000_abc123def",
  "duration": 45000,
  "messageCount": 3,
  "language": "en",
  "isActive": true,
  "escalated": false
}
```

### WebSocket Endpoint

#### Voice Audio Stream

```
WS ws://localhost:3000/voice?sessionId=SESSION_ID
```

**Connection Flow:**

1. Client connects with session ID
2. Server sends `{ type: "ready" }`
3. Client streams binary audio data
4. Server responds with `{ type: "response", text, language, intent, ... }`
5. Server sends binary audio response
6. Repeat for multi-turn conversations

**Control Messages:**

```json
{ "type": "flush" }
```
Process accumulated audio immediately.

```json
{ "type": "end_session" }
```
End the session and close connection.

## Configuration

### Environment Variables

```env
# KugelAudio Configuration
KUGELAUDIO_API_KEY=your_api_key
KUGELAUDIO_API_URL=https://api.kugelaudio.com/v1

# watsonx Orchestrate Configuration
WATSONX_API_KEY=your_api_key
WATSONX_URL=https://eu-de.ml.cloud.ibm.com
WATSONX_PROJECT_ID=your_project_id

# Server Configuration
PORT=3000
NODE_ENV=development
LOG_LEVEL=info

# Optional: Salesforce Integration
SALESFORCE_CLIENT_ID=your_client_id
SALESFORCE_CLIENT_SECRET=your_client_secret
SALESFORCE_INSTANCE_URL=https://your-instance.salesforce.com
```

### Voice Configuration

In `src/server.js`, customize voice settings:

```javascript
voiceConfig: {
  voiceId: 'default',      // Voice ID from KugelAudio
  language: 'en',          // Default language
  speed: 1.0,              // Speech speed (0.5-2.0)
  pitch: 1.0,              // Voice pitch (0.5-2.0)
}
```

## Features

### Language Support

24 EU languages including:
- English (EN)
- German (DE)
- French (FR)
- Spanish (ES)
- Italian (IT)
- Dutch (NL)
- Polish (PL)
- Portuguese (PT)
- Swedish (SV)
- Danish (DA)
- Norwegian (NO)
- Finnish (FI)
- And more...

### Agent Capabilities

The included Customer Service Agent handles:
- General inquiries
- FAQ lookup
- Account status queries
- Password reset requests
- Order tracking
- Billing information
- Complaint logging
- Intelligent escalation

### Advanced Features

- **Intent Classification**: Automatically routes to appropriate agent
- **Conversation Context**: Maintains multi-turn conversation history
- **Language Detection**: Automatically detects spoken language
- **Voice Cloning**: Personalized voice synthesis from reference audio
- **Escalation Rules**: Automatic routing to human agents when needed
- **CRM Integration**: Optional Salesforce integration for customer context
- **Real-time Streaming**: Low-latency audio processing (39ms)
- **Session Management**: Track and manage concurrent voice sessions

## Usage Examples

### Basic Voice Call (JavaScript/Node.js)

```javascript
// 1. Initiate call
const callResponse = await fetch('http://localhost:3000/api/call', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ language: 'en' })
});
const { sessionId, wsUrl } = await callResponse.json();

// 2. Connect WebSocket
const ws = new WebSocket(wsUrl);

ws.onopen = () => {
  console.log('Connected');
  // Stream audio here
};

ws.onmessage = (event) => {
  if (event.data instanceof ArrayBuffer) {
    // Play response audio
  } else {
    const response = JSON.parse(event.data);
    console.log('Agent:', response.text);
  }
};

// 3. Send audio
ws.send(audioBuffer);

// 4. End session
ws.send(JSON.stringify({ type: 'end_session' }));
```

### Python Client Example

```python
import requests
import websocket
import json

# Initiate call
response = requests.post('http://localhost:3000/api/call',
  json={'language': 'de'})
session_id = response.json()['sessionId']

# Connect to WebSocket
ws = websocket.WebSocketApp(
  f'ws://localhost:3000/voice?sessionId={session_id}'
)

def on_message(ws, msg):
  if isinstance(msg, str):
    data = json.loads(msg)
    print(f"Agent: {data.get('text')}")
  else:
    # Handle audio
    pass

ws.on_message = on_message
ws.run_forever()
```

## Production Considerations

### Performance

- Average latency: 39ms per speech segment
- Supports concurrent sessions with proper scaling
- WebSocket connection pooling recommended
- Consider load balancing for multiple instances

### Security

- Always use HTTPS/WSS in production
- Validate API credentials in environment variables
- Implement rate limiting per session
- Add authentication middleware for REST endpoints
- Log all interactions for compliance

### Scaling

- Use a reverse proxy (nginx) for load balancing
- Deploy multiple server instances
- Consider message queue for high-volume scenarios
- Monitor memory usage during long sessions
- Implement session cleanup after timeout

### Monitoring

- Track session duration and message count
- Monitor API response times
- Alert on service health check failures
- Log all errors and exceptions
- Review escalation triggers

## Troubleshooting

### API Authentication Fails

- Verify credentials in `.env`
- Check token expiration for watsonx
- Confirm API keys are not rotated

### Audio Quality Issues

- Check audio input sample rate (16kHz recommended)
- Verify audio format (WAV recommended)
- Adjust chunk size in voice pipeline
- Test with known-good audio samples

### WebSocket Connection Drops

- Implement reconnection logic on client
- Check firewall/proxy settings
- Verify WebSocket support enabled
- Monitor server memory and connections

### Language Detection Fails

- Ensure minimum audio duration (1+ second)
- Verify audio quality and noise levels
- Check supported language codes
- Test with reference language

## License

MIT

## Support

For issues or questions:
- Check logs with `LOG_LEVEL=debug`
- Review API documentation at respective vendor sites
- Run health check endpoint: `GET /api/health`

## Related Documentation

- [KugelAudio API Docs](https://docs.kugelaudio.com)
- [watsonx Orchestrate API Docs](https://cloud.ibm.com/apidocs/watsonx-orchestrate)
- [Express.js Guide](https://expressjs.com)
- [WebSocket Protocol](https://tools.ietf.org/html/rfc6455)
