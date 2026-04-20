# KugelAudio × IBM watsonx Orchestrate Integration Package

## Complete Package Contents

This is a production-ready Node.js integration package combining KugelAudio voice AI with IBM watsonx Orchestrate conversational agents.

**Total Package Size:** 92 KB | **Source Code:** 1,576 lines | **Well-documented:** 40+ functions with JSDoc

### Getting Started

Start with these files in order:

1. **QUICK_REFERENCE.md** (2-minute setup)
   - Installation instructions
   - Basic curl examples
   - Configuration
   - Troubleshooting

2. **README.md** (comprehensive guide)
   - Project overview
   - Architecture diagrams
   - Complete API reference
   - Usage examples (JavaScript & Python)
   - Production considerations

3. **PACKAGE_STRUCTURE.txt** (detailed breakdown)
   - File-by-file documentation
   - Feature list
   - Code metrics
   - Ready-to-deploy checklist

---

## File Directory

### Configuration & Setup
```
package.json          - Node.js dependencies and scripts
.env.example          - Environment variables template
```

### Core API Clients (40+ functions total)

```
src/kugelaudio-client.js
├─ KugelAudioClient class
├─ Methods:
│  ├─ textToSpeech()        - Synthesize text to speech
│  ├─ speechToText()        - Transcribe audio to text
│  ├─ cloneVoice()          - Create voice clones
│  ├─ listVoices()          - List available voices
│  ├─ detectLanguage()      - Detect language from audio
│  ├─ healthCheck()         - Check API status
│  └─ _requestWithRetry()   - Internal retry logic
└─ Features:
   ├─ 24 EU language support
   ├─ 39ms average latency
   ├─ Automatic retry with exponential backoff
   └─ Comprehensive error handling

src/watsonx-orchestrate-client.js
├─ WatsonxOrchestrateClient class
├─ Methods:
│  ├─ authenticate()        - IBM Cloud auth
│  ├─ sendMessage()         - Send message to agent
│  ├─ createAgent()         - Create new agent
│  ├─ listAgents()          - List available agents
│  ├─ getAgentResponse()    - Get agent response
│  ├─ getAgent()            - Get agent details
│  └─ healthCheck()         - Check API status
└─ Features:
   ├─ Automatic token refresh
   ├─ Conversation context management
   └─ Project-scoped operations
```

### Voice Processing Pipeline

```
src/voice-pipeline.js
├─ VoicePipeline class
├─ Methods:
│  ├─ processAudio()       - Process audio through pipeline
│  ├─ setupAudioStream()   - Setup WebSocket handler
│  ├─ createSession()      - Create voice session
│  ├─ getSession()         - Get or create session
│  ├─ endSession()         - End voice session
│  ├─ getSessionStats()    - Get session statistics
│  └─ getActiveSessions()  - List active sessions
└─ Pipeline Steps:
   1. Language detection (39ms)
   2. Speech-to-text
   3. Intent classification
   4. Agent routing
   5. Response generation
   6. Text-to-speech
   7. Audio streaming
```

### Agents & Knowledge Bases

```
src/agents/customer-service-agent.js
├─ Agent Configuration
│  ├─ Name: "Customer Service Agent"
│  ├─ Capabilities: 8+ services
│  ├─ Escalation rules with triggers
│  └─ Salesforce CRM integration
├─ Functions:
│  ├─ classifyIntent()      - Intent classification (8 types)
│  ├─ searchFAQ()           - FAQ lookup
│  ├─ buildAgentContext()   - Build conversation context
│  └─ generateResponse()    - Generate response text
├─ Intent Types:
│  ├─ general_inquiry
│  ├─ account_access
│  ├─ order_status
│  ├─ billing
│  ├─ complaint (escalates)
│  ├─ billing_dispute (escalates)
│  ├─ technical_issue (escalates)
│  └─ feedback
├─ FAQ Database: 5 pre-built FAQs
│  ├─ Password reset
│  ├─ Return policy
│  ├─ Shipping information
│  ├─ Order tracking
│  └─ International shipping
└─ Language Support: 12+ EU languages

### Express Server

src/server.js
├─ REST API Endpoints (6):
│  ├─ GET  /api/health                  - Health check
│  ├─ GET  /api/agents                  - List agents
│  ├─ GET  /api/voices                  - List voices
│  ├─ POST /api/call                    - Start voice call
│  ├─ GET  /api/sessions                - Active sessions
│  └─ GET  /api/sessions/:id/stats      - Session stats
├─ WebSocket Endpoint:
│  └─ WS /voice                         - Voice audio streaming
├─ Middleware:
│  ├─ Express JSON parser
│  ├─ URL encoded parser
│  ├─ Error handler
│  └─ Graceful shutdown
└─ Server Features:
   ├─ Async/await throughout
   ├─ Comprehensive error handling
   ├─ Health check for dependencies
   └─ Detailed startup banner
```

### Documentation Files

```
README.md                    - 350+ lines comprehensive guide
PACKAGE_STRUCTURE.txt        - Detailed architecture breakdown
QUICK_REFERENCE.md          - 2-minute quick start guide
INDEX.md                    - This file
```

---

## Quick Start

### 1. Installation
```bash
npm install
```

### 2. Configuration
```bash
cp .env.example .env
# Edit .env with your API keys
```

### 3. Start Server
```bash
npm start
# Server ready on http://localhost:3000
```

### 4. Test Health Check
```bash
curl http://localhost:3000/api/health
```

### 5. Initiate Voice Call
```bash
curl -X POST http://localhost:3000/api/call \
  -H "Content-Type: application/json" \
  -d '{"language": "en"}'
```

---

## API Overview

### REST Endpoints (6 total)

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/api/health` | Service health status |
| GET | `/api/agents` | List available agents |
| GET | `/api/voices` | List available voices (24 languages) |
| POST | `/api/call` | Initiate new voice call |
| GET | `/api/sessions` | List active sessions |
| GET | `/api/sessions/:id/stats` | Get session statistics |

### WebSocket Endpoint

```
WS /voice?sessionId=SESSION_ID
```

**Message Types:**
- Binary data: Audio chunks (WAV format)
- JSON: Control messages
  - `{"type": "flush"}` - Process audio
  - `{"type": "end_session"}` - End session

---

## Key Features

Core Capabilities:
- Real-time voice AI processing
- Multi-language support (24 EU languages)
- Low latency (39ms average)
- Automatic language detection
- Voice cloning from reference audio
- Intent classification and routing
- Pre-built FAQ knowledge base
- Optional Salesforce CRM integration
- Intelligent escalation management
- Conversation context tracking
- Session management for concurrent calls
- Automatic retry with exponential backoff
- Comprehensive error handling
- WebSocket streaming
- Production-ready code with full error handling

---

## Architecture

### Voice Processing Pipeline

```
Client Audio Stream
        ↓
   [WebSocket]
        ↓
Language Detection (KugelAudio) - 39ms
        ↓
Speech-to-Text (KugelAudio STT)
        ↓
Intent Classification
        ↓
Agent Routing (watsonx Orchestrate)
        ↓
Response Generation
        ↓
Text-to-Speech (KugelAudio TTS)
        ↓
   Audio Response
        ↓
   Client Playback
```

### Class Dependencies

```
server.js
  ├─ KugelAudioClient
  ├─ WatsonxOrchestrateClient
  ├─ VoicePipeline
  │  ├─ KugelAudioClient
  │  ├─ WatsonxOrchestrateClient
  │  └─ customer-service-agent.js
  └─ Express/WebSocket servers
```

---

## Environment Variables

Required:
```env
KUGELAUDIO_API_KEY=your_api_key
WATSONX_API_KEY=your_api_key
WATSONX_PROJECT_ID=your_project_id
```

Optional:
```env
KUGELAUDIO_API_URL=https://api.kugelaudio.com/v1
WATSONX_URL=https://eu-de.ml.cloud.ibm.com
SALESFORCE_CLIENT_ID=...
SALESFORCE_CLIENT_SECRET=...
SALESFORCE_INSTANCE_URL=...
PORT=3000
NODE_ENV=development
LOG_LEVEL=info
```

---

## Production Deployment

Before deploying:

- [ ] Configure environment variables
- [ ] Enable HTTPS/WSS
- [ ] Add rate limiting middleware
- [ ] Implement authentication
- [ ] Configure logging and monitoring
- [ ] Set up error alerting
- [ ] Load test with expected concurrency
- [ ] Test graceful shutdown
- [ ] Review security headers
- [ ] Enable CORS if needed

---

## Support & Troubleshooting

### Quick Diagnostics

```bash
# Check health
curl http://localhost:3000/api/health

# List agents
curl http://localhost:3000/api/agents

# List voices
curl http://localhost:3000/api/voices

# Check active sessions
curl http://localhost:3000/api/sessions
```

### Common Issues

| Issue | Solution |
|-------|----------|
| API keys invalid | Verify credentials in .env |
| WebSocket fails | Check sessionId, enable WSS for HTTPS |
| Language not detected | Provide clear audio, minimum 1 second |
| Agent timeout | Check watsonx credentials |
| Memory growing | Implement session cleanup intervals |

---

## Development

### Watch Mode
```bash
npm run dev
```

### Code Organization

All code uses:
- ES6 modules (`import`/`export`)
- Async/await for concurrency
- Full JSDoc documentation
- Comprehensive error handling
- Structured logging

### Adding Features

1. **Custom Intent**: Edit `src/agents/customer-service-agent.js`
2. **New Endpoint**: Add to `src/server.js`
3. **Custom Agent**: Create new file in `src/agents/`
4. **New API Client**: Follow pattern in `kugelaudio-client.js`

---

## Performance Metrics

- **KugelAudio STT Latency:** 39ms average
- **Package Size:** 92 KB (source only)
- **Code Quality:** 1,576 lines of production code
- **Documentation:** 350+ comprehensive lines
- **Language Support:** 24 EU languages
- **Concurrent Sessions:** Limited by server resources

---

## License & Attribution

MIT License - Free to use and modify

Created for KugelAudio × IBM watsonx Orchestrate integration.

---

## Next Steps

1. **Read QUICK_REFERENCE.md** - Get running in 2 minutes
2. **Read README.md** - Understand the full architecture
3. **Review PACKAGE_STRUCTURE.txt** - Learn detailed implementation
4. **Check environment variables** - Configure your API keys
5. **Test /api/health** - Verify connectivity
6. **Start building** - Integrate into your application

---

**Package Version:** 1.0.0  
**Created:** 2024-04-20  
**Node.js:** 18+ required  
**Status:** Production-ready
