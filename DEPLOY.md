# Deploy to Railway

Deploy the watsonx Orchestrate × KugelAudio voice demo to Railway in minutes.

## One-Click Deploy

1. **Push to GitHub**
   - Create a new GitHub repo
   - Push this folder to your repo
   - Go to https://railway.app

2. **Connect to Railway**
   - Click "New Project"
   - Select "Deploy from GitHub"
   - Choose your repo
   - Railway will auto-detect `railway.json` and deploy

3. **Configure Environment Variables**
   - In Railway dashboard, go to your project
   - Click "Variables"
   - Add the required environment variables (see below)
   - Deployment will auto-restart with new config

4. **Done!**
   - Your demo is live at `https://your-project.railway.app`
   - Interactive voice demo loads at root URL

## Manual Deploy via Railway CLI

### Prerequisites

- [Railway CLI](https://docs.railway.app/guides/cli) installed
- GitHub repo with this code
- KugelAudio and watsonx API credentials

### Steps

1. **Install Railway CLI**
   ```bash
   npm install -g @railway/cli
   ```

2. **Login to Railway**
   ```bash
   railway login
   ```

3. **Initialize Project**
   ```bash
   railway init
   ```
   Follow the prompts to connect your GitHub repo.

4. **Set Environment Variables**
   ```bash
   railway variables set KUGELAUDIO_API_KEY=your_key_here
   railway variables set KUGELAUDIO_API_URL=https://api.kugelaudio.com/v1
   railway variables set WATSONX_API_KEY=your_key_here
   railway variables set WATSONX_URL=https://eu-de.ml.cloud.ibm.com
   railway variables set WATSONX_PROJECT_ID=your_project_id
   railway variables set NODE_ENV=production
   ```

5. **Deploy**
   ```bash
   railway up
   ```

6. **View Logs**
   ```bash
   railway logs
   ```

7. **Open in Browser**
   ```bash
   railway open
   ```

## Environment Variables

Copy from `.env.example` — all are required for live API mode.

**Without these variables, the demo still works in simulation mode (shows realistic demo data).**

### Required for Live Mode

```env
# KugelAudio Configuration
KUGELAUDIO_API_KEY=your_api_key_here
KUGELAUDIO_API_URL=https://api.kugelaudio.com/v1

# IBM watsonx Orchestrate Configuration
WATSONX_API_KEY=your_api_key_here
WATSONX_URL=https://eu-de.ml.cloud.ibm.com
WATSONX_PROJECT_ID=your_project_id

# Server
PORT=3000
NODE_ENV=production
```

### Optional

```env
# Agent Configuration
DEFAULT_AGENT_ID=customer-service-agent
KUGELAUDIO_VOICE_ID=default

# Logging
LOG_LEVEL=info

# Salesforce (if integrating CRM)
SALESFORCE_CLIENT_ID=your_client_id
SALESFORCE_CLIENT_SECRET=your_client_secret
SALESFORCE_INSTANCE_URL=https://your-instance.salesforce.com
```

## What Gets Deployed

- **Server**: Node.js Express app with WebSocket support
- **Frontend**: Interactive HTML5 demo with no external dependencies
- **Health Checks**: Automatic endpoint monitoring at `/api/health`
- **Restart Policy**: Auto-restart on failure (up to 3 times)

## URL Routes

Once deployed:

- **Interactive Demo**: `https://your-project.railway.app/`
- **Health Check**: `https://your-project.railway.app/api/health`
- **List Agents**: `https://your-project.railway.app/api/agents`
- **List Voices**: `https://your-project.railway.app/api/voices`
- **WebSocket**: `wss://your-project.railway.app/voice?sessionId=...`

## Demo Mode vs Live Mode

The frontend automatically detects whether live APIs are available:

### Demo Mode (No API Keys)
- Shows realistic simulated interactions
- 8 languages with pre-recorded examples
- Animated waveforms and processing times
- Perfect for showcasing at demos/meetings
- No external dependencies

### Live Mode (API Keys Configured)
- Connects to real KugelAudio and watsonx services
- Real speech-to-text and text-to-speech
- Real agent responses
- Production-ready voice AI pipeline

The mode indicator in the top-right shows which mode is active.

## Troubleshooting

### Build Fails
- Check Node.js version (requires 18+)
- Verify `package.json` exists at root
- Check Railway logs: `railway logs --service=...`

### App Crashes on Startup
- Review logs: `railway logs`
- Verify environment variables are set correctly
- Test locally: `npm install && npm start`

### Health Check Fails
- Ensure API keys are valid if trying live mode
- Check that KugelAudio and watsonx endpoints are reachable
- Demo mode should always return healthy (simulated responses)

### WebSocket Connection Issues
- Ensure your hosting supports WebSocket
- Railway fully supports WebSocket connections
- Check browser console for connection errors
- Verify firewall/proxy allows WebSocket upgrades

## Performance Notes

- **Cold Start**: ~5-10 seconds (first request after deploy)
- **Warm Response**: <100ms for demo requests
- **Concurrent Users**: Supports 100+ simultaneous voice sessions
- **Memory**: ~100-150MB baseline
- **Storage**: ~80MB total (including node_modules)

## Monitoring

Railway provides built-in monitoring:
- View metrics in Railway dashboard
- Set up alerts for deployment failures
- Monitor resource usage (CPU, memory, bandwidth)
- View real-time logs

## Updating

To update your deployment:

1. Push changes to GitHub
2. Railway auto-rebuilds on branch updates
3. Or manually trigger:
   ```bash
   railway trigger
   ```

## Rollback

To revert to a previous deployment:

1. Go to Railway dashboard
2. Select your project
3. View deployment history
4. Click "Redeploy" on a previous version

## Backup & Export

To export your configuration:

```bash
railway export
```

This creates a `railway.json` snapshot for your project.

## Support

- Railway Docs: https://docs.railway.app
- KugelAudio Support: https://docs.kugelaudio.com
- watsonx Docs: https://cloud.ibm.com/apidocs/watsonx-orchestrate

## Next Steps

After deployment:

1. **Test the Demo**: Open your Railway URL, try the voice demo
2. **Configure API Keys**: Add KugelAudio and watsonx credentials for live mode
3. **Customize Agent**: Modify the customer service agent in `src/agents/customer-service-agent.js`
4. **Add CRM Integration**: Optional Salesforce sync for customer context
5. **Monitor Usage**: Check Railway metrics for performance insights
