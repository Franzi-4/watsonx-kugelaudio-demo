"""
LiveKit voice agent — minimal Phase-2a scaffold.

Goal: verify that audio delivered as a native WebRTC track sounds smoother
than our current PCM-chunk-over-SSE pipeline. The agent joins any room
named in the dispatch, plays one greeting via Kugel TTS, then waits.

Run:
    python livekit_agent.py dev    # connect to LIVEKIT_URL, dispatch on room

Required env (in .env):
    KUGELAUDIO_API_KEY
    LIVEKIT_URL                    e.g. wss://your-project.livekit.cloud
    LIVEKIT_API_KEY
    LIVEKIT_API_SECRET

Once Phase 2a confirms audio quality, swap the trivial entrypoint for a
full AgentSession with STT, watsonx LLM (custom plugin), Kugel TTS, VAD.
"""

import os
import logging

from dotenv import load_dotenv
from livekit.agents import Agent, AgentSession, JobContext, WorkerOptions, cli
from livekit.plugins import silero
from kugelaudio.livekit import TTS as KugelAudioTTS

load_dotenv()

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(name)s] %(message)s")
logger = logging.getLogger("livekit-agent")

DEFAULT_VOICE_ID = (
    int(os.environ["LIVEKIT_AGENT_VOICE_ID"])
    if os.environ.get("LIVEKIT_AGENT_VOICE_ID")
    else (
        int(os.environ["KUGELAUDIO_VOICE_ID"])
        if os.environ.get("KUGELAUDIO_VOICE_ID")
        else None
    )
)
# IMPORTANT: the LiveKit plugin's TTSModels Literal only declares
# "kugel-1" and "kugel-1-turbo". The /ws/tts/multi endpoint that LiveKit
# uses is not yet wired up for kugel-2 (which is what our SSE sidecar
# uses). Forcing "kugel-2" here makes the agent sound off — the server
# either falls back silently or runs an untested config path. Pin to
# the model the plugin actually supports for natural-sounding output.
# Override via env if Kugel ships kugel-2 multi-stream support later.
DEFAULT_MODEL = os.environ.get("LIVEKIT_AGENT_MODEL", "kugel-1")
DEFAULT_LANGUAGE = os.environ.get("LIVEKIT_AGENT_LANGUAGE") or os.environ.get("KUGELAUDIO_LANGUAGE")
GREETING = os.environ.get(
    "LIVEKIT_GREETING",
    "Guten Tag, hier ist der digitale Versicherungs-Assistent. "
    "Wenn Sie mich gut hören, klingt diese Stimme so natürlich wie sie sollte.",
)


async def entrypoint(ctx: JobContext):
    """Phase 2a: connect, speak greeting via Kugel, idle.

    Phase 2b will replace this with a full AgentSession (STT → watsonx LLM
    → Kugel TTS) so the agent actually converses. Right now we just need
    to validate that the WebRTC audio path delivers clean playback.
    """
    logger.info("agent connecting to room")
    await ctx.connect()

    tts_kwargs = {
        "model": DEFAULT_MODEL,
        "sample_rate": 24000,
    }
    if DEFAULT_VOICE_ID is not None:
        tts_kwargs["voice_id"] = DEFAULT_VOICE_ID
    if DEFAULT_LANGUAGE:
        tts_kwargs["language"] = DEFAULT_LANGUAGE
    cfg_scale = os.environ.get("KUGELAUDIO_CFG_SCALE")
    if cfg_scale:
        tts_kwargs["cfg_scale"] = float(cfg_scale)

    logger.info(
        "livekit tts config: model=%s voice_id=%s language=%s",
        tts_kwargs.get("model"),
        tts_kwargs.get("voice_id"),
        tts_kwargs.get("language"),
    )

    tts = KugelAudioTTS(**tts_kwargs)
    # word_timestamps=True (plugin default) forces forced-alignment per
    # chunk on the server. We don't render captions so it's pure overhead.
    # Keep barge-in working without alignment by not relying on it.
    if hasattr(tts._opts, "word_timestamps"):
        tts._opts.word_timestamps = False

    # Minimal AgentSession with TTS + VAD only — no STT/LLM yet.
    session = AgentSession(tts=tts, vad=silero.VAD.load())
    agent = Agent(instructions="Phase 2a audio quality probe.")
    await session.start(room=ctx.room, agent=agent)

    logger.info("speaking greeting via Kugel TTS over WebRTC")
    await session.say(GREETING)
    logger.info("greeting done — agent will idle in room")


if __name__ == "__main__":
    cli.run_app(WorkerOptions(entrypoint_fnc=entrypoint))
