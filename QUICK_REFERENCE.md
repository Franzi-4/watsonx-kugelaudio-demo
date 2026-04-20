# Quick Reference Guide

## Setup (2 minutes)

```bash
# 1. Install dependencies
npm install

# 2. Copy environment template
cp .env.example .env

# 3. Edit .env with your API keys
# KUGELAUDIO_API_KEY=...
# WATSONX_API_KEY=...
# etc.

# 4. Start the server
npm start
```

## API Quick Start

### Initiate a Call
```bash
curl -X POST http://localhost:3000/api/call \
  -H "Content-Type: application/json" \
  -d '{
    "language": "en",
    "agentId": "customer-service-agent"
  }'
```

Response includes `sessionId` and `wsUrl` for WebSocket connection.

### Stream Audio (JavaScript)
```javascript
const sessionId = 'session_...'; // from /api/call response
const ws = new WebSocket(`ws://localhost:3000/voice?sessionId=${sessionId}`);

ws.onopen = () => {
  // Send audio buffer
  ws.send(audioBuffer);
};

ws.onmessage = (event) => {
  if (event.data instanceof ArrayBuffer) {
    // Play response audio
  } else {
    const response = JSON.parse(event.data);
    console.log('Response:', response.text);
  }
};
```

## File Reference

| File | Purpose | Key Classes/Exports |
|------|---------|-------------------|
| `src/server.js` | Express + WebSocket server | Express app, HTTP server setup |
| `src/kugelaudio-client.js` | KugelAudio API wrapper | `KugelAudioClient` class |
| `src/watsonx-orchestrate-client.js` | watsonx API wrapper | `WatsonxOrchestrateClient` class |
| `src/voice-pipeline.js` | Voice processing pipeline | `VoicePipeline` class |
| `src/agents/customer-service-agent.js` | Agent definition | Agent config, intent classifier, FAQ DB |

## REST Endpoints

```
GET  /api/health                    -> Service health
GET  /api/agents                    -> List agents
GET  /api/voices                    -> List voices
POST /api/call                      -> Start call session
GET  /api/sessions                  -> Active sessions
GET  /api/sessions/:id/stats        -> Session stats
```

## WebSocket Endpoint

```
WS /voice?sessionId=SESSION_ID

Messages:
  - Binary: Audio data
  - {"type": "flush"}       -> Process audio
  - {"type": "end_session"} -> End session
```

## Configuration

Key environment variables:
```env
KUGELAUDIO_API_KEY=...
WATSONX_API_KEY=...
WATSONX_PROJECT_ID=...
PORT=3000
```

## Common Tasks

### Add Custom Intent
Edit `src/agents/customer-service-agent.js`:
```javascript
intentClassificationRules.push({
  intent: 'my_intent',
  keywords: ['keyword1', 'keyword2'],
  escalate: false,
});
```

### Add Custom FAQ
```javascript
faqDatabase.push({
  id: 'faq_custom',
  question: 'Your question?',
  answer: 'Your answer.',
  category: 'category',
  languages: ['en', 'de', 'fr'],
});
```

### Change Voice
In `src/server.js`, modify `voiceConfig`:
```javascript
voiceConfig: {
  voiceId: 'voice_id_from_list_voices',
  language: 'en',
}
```

### Custom Voice Cloning
```javascript
// In voice-pipeline.js or server.js
const voiceClone = await kugelAudioClient.cloneVoice(
  'path/to/reference/audio.wav',
  'Custom Voice Name'
);
// Use returned voiceId in TTS calls
```

## Troubleshooting

| Issue | Solution |
|-------|----------|
| API keys invalid | Check `.env` file, verify credentials |
| WebSocket connection fails | Check CORS, verify `sessionId` in URL |
| Slow audio processing | Check audio file size, verify network latency |
| Language not detected | Provide minimum 1 second of clear audio |
| Agent not responding | Verify watsonx credentials and project ID |

## Performance Notes

- **Latency**: 39ms average (KugelAudio STT)
- **Concurrent sessions**: Depends on server resources
- **Audio format**: WAV 16kHz recommended
- **Chunk size**: 2 seconds = ~32KB at 16kHz

## Production Checklist

- [ ] Environment variables configured
- [ ] HTTPS/WSS enabled
- [ ] Rate limiting added
- [ ] Authentication middleware added
- [ ] Error logging configured
- [ ] Monitoring/alerting set up
- [ ] Load testing completed
- [ ] Graceful shutdown tested

## Support Resources

- **README.md** - Full documentation
- **PACKAGE_STRUCTURE.txt** - Detailed architecture
- **JSDoc comments** - In-code documentation
- `/api/health` - Service status check

## Next Steps

1. Review architecture in README.md
2. Configure environment variables
3. Test `/api/health` endpoint
4. Start a sample voice call
5. Integrate into your application
6. Deploy to production
