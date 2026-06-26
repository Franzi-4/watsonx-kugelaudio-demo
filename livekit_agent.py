"""
LiveKit voice agent — full conversational pipeline.

Architecture: User audio → Deepgram STT → Orchestrate LLM → KugelAudio TTS → WebRTC

Run:
    python livekit_agent.py dev

Required env:
    KUGELAUDIO_API_KEY
    LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET
    ORCHESTRATE_API_KEY, ORCHESTRATE_INSTANCE_URL, ORCHESTRATE_AGENT_ID
    DEEPGRAM_API_KEY
"""

import os
import logging

from dotenv import load_dotenv
from livekit.agents import Agent, AgentSession, JobContext, WorkerOptions, cli
from livekit.plugins import deepgram, silero
from kugelaudio.livekit import TTS as KugelAudioTTS

from plugins.orchestrate_llm import OrchestrateLLM

load_dotenv()

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(name)s] %(message)s")
logger = logging.getLogger("livekit-agent")

DEFAULT_VOICE_ID = (
    int(os.environ["KUGELAUDIO_VOICE_ID"])
    if os.environ.get("KUGELAUDIO_VOICE_ID")
    else None
)
DEFAULT_MODEL = os.environ.get("LIVEKIT_AGENT_MODEL", "kugel-1")
DEFAULT_LANGUAGE = os.environ.get("KUGELAUDIO_LANGUAGE", "de")

GREETING = (
    "Guten Tag, hier ist Anton vom Schadensservice, "
    "schön dass Sie anrufen. Um welche Art von Schaden geht es?"
)

SYSTEM_PROMPT = (
    "Du bist Anton, ein freundlicher und sachlicher Mitarbeiter im Schadensservice "
    "einer deutschen Versicherung. Anrufer sind oft aufgeregt oder verunsichert, "
    "bleib ruhig, empathisch und fuehre sie sicher durch das Gespraech.\n\n"
    "DEINE EINZIGE AUFGABE\n"
    "Nimm eine Schadensmeldung am Telefon auf. Frage die folgenden sechs Felder "
    "in genau dieser Reihenfolge ab, eines pro Turn:\n"
    "1. Schadensart\n2. Ort des Schadens\n3. Zeitpunkt\n"
    "4. Beteiligte Personen oder Fahrzeuge\n5. Geschaetzte Schadenshoehe in Euro\n"
    "6. Policennummer\n\n"
    "STIL-REGELN\n"
    "- Sprich Deutsch, per Sie, ruhig und empathisch.\n"
    "- Maximal zwei Saetze pro Antwort.\n"
    "- Stelle pro Turn genau eine konkrete Frage.\n"
    "- Keine Aufzaehlungszeichen, keine Listen, keine Markdown-Formatierung.\n"
    "- Beende deine Antwort niemals mit Echo-Rueckfragen.\n\n"
    "ABSCHLUSS\n"
    "Sobald alle sechs Felder erfasst sind, fasse sie in einer strukturierten "
    "Bestaetigung zusammen und frage: 'Sind diese Angaben so korrekt?'"
)


async def entrypoint(ctx: JobContext):
    logger.info("agent connecting to room")
    await ctx.connect()

    tts_kwargs = {"model": DEFAULT_MODEL, "sample_rate": 24000}
    if DEFAULT_VOICE_ID is not None:
        tts_kwargs["voice_id"] = DEFAULT_VOICE_ID
    if DEFAULT_LANGUAGE:
        tts_kwargs["language"] = DEFAULT_LANGUAGE
    cfg_scale = os.environ.get("KUGELAUDIO_CFG_SCALE")
    if cfg_scale:
        tts_kwargs["cfg_scale"] = float(cfg_scale)

    logger.info(
        "config: model=%s voice_id=%s language=%s",
        tts_kwargs.get("model"),
        tts_kwargs.get("voice_id"),
        tts_kwargs.get("language"),
    )

    tts = KugelAudioTTS(**tts_kwargs)
    if hasattr(tts._opts, "word_timestamps"):
        tts._opts.word_timestamps = False

    stt = deepgram.STT(language=DEFAULT_LANGUAGE, model="nova-3")
    vad = silero.VAD.load()

    orchestrate = OrchestrateLLM(
        api_key=os.environ["ORCHESTRATE_API_KEY"],
        instance_url=os.environ["ORCHESTRATE_INSTANCE_URL"],
        agent_id=os.environ["ORCHESTRATE_AGENT_ID"],
    )

    agent = Agent(instructions=SYSTEM_PROMPT)
    session = AgentSession(stt=stt, llm=orchestrate, tts=tts, vad=vad)
    await session.start(room=ctx.room, agent=agent)

    logger.info("speaking greeting")
    await session.say(GREETING)
    logger.info("greeting done — agent listening")


if __name__ == "__main__":
    cli.run_app(WorkerOptions(entrypoint_fnc=entrypoint))
