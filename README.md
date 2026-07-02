# KugelAudio × watsonx Orchestrate Integration

A production-ready Node.js integration package where IBM watsonx Orchestrate owns the dialog flow and KugelAudio provides the voice layer.

## Overview

This package provides a complete voice pipeline that:

- **Captures audio streams** via WebSocket
- **Detects language** automatically (39ms latency, 24 EU languages supported)
- **Transcribes speech** to text with high confidence
- **Routes every dialog turn** through a watsonx Orchestrate agent
- **Synthesizes responses** with natural voice cloning
- **Streams audio back** in real-time


## Prerequisites

- **Node.js 18+**
- **Python 3.11-3.13** for the watsonx Orchestrate ADK
- **KugelAudio API credentials** (API key and endpoint)
- **IBM watsonx Orchestrate credentials** (Orchestrate API key, instance URL, agent ID)

## Quick Start

### 1. Install Dependencies

```bash
npm install
python3.11 -m pip install -r requirements-adk.txt
```

Use `python3.11 -m pip`, not the standalone `pip` shim, so the ADK installs with a supported Python version.

The native watsonx Orchestrate agent definition lives at:

```bash
orchestrate/agents/schaden_meldung_assistant.agent.yaml
```

Import it into the active Orchestrate ADK environment with:

```bash
orchestrate agents import -f orchestrate/agents/schaden_meldung_assistant.agent.yaml --safe
```

### 2. Configure Environment

```bash
cp .env.example .env
```

Edit `.env` with your credentials:

```env
KUGELAUDIO_API_KEY=your_api_key_here
KUGELAUDIO_API_URL=https://api.kugelaudio.com/v1

ORCHESTRATE_API_KEY=your_orchestrate_api_key_here
ORCHESTRATE_INSTANCE_URL=https://eu-de.watson-orchestrate.cloud.ibm.com
ORCHESTRATE_AGENT_ID=your_orchestrate_agent_id

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

### Local HTTPS for microphone access (Chrome)

For reliable microphone permissions in Chrome, run the app over HTTPS:

```bash
npm run dev:https
```

This expects local cert files at:

- `.cert/localhost-cert.pem`
- `.cert/localhost-key.pem`

You can override paths via `LOCAL_HTTPS_CERT_PATH` / `LOCAL_HTTPS_KEY_PATH`.

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

1. **Voice Input**: The browser captures speech or text input.
2. **Dialog Orchestration**: watsonx Orchestrate handles the agent turn and business flow.
3. **Voice Output**: KugelAudio converts the Orchestrate response to speech.
4. **Audio Playback**: The browser plays the synthesized response.

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
ORCHESTRATE_API_KEY=your_orchestrate_api_key
ORCHESTRATE_INSTANCE_URL=https://eu-de.watson-orchestrate.cloud.ibm.com
ORCHESTRATE_AGENT_ID=your_orchestrate_agent_id

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


## Related Documentation

- [KugelAudio API Docs](https://docs.kugelaudio.com)
- [watsonx Orchestrate API Docs](https://cloud.ibm.com/apidocs/watsonx-orchestrate)
- [Express.js Guide](https://expressjs.com)
- [WebSocket Protocol](https://tools.ietf.org/html/rfc6455)
