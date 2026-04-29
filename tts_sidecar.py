"""
Kugel TTS Sidecar — FastAPI service that mirrors the colleague's reference
script 1:1 using the official `kugelaudio` Python SDK.

Pattern (from ttfa_bench.py):
    client = await KugelAudio.create(model="kugel-2")
    # warm-up: discard one tiny synthesis to prime the connection
    async for _ in client.tts.stream_async(text="Test", ...): pass
    # real turns reuse the same client (= same persistent WS) — TTFA drops
    async for item in client.tts.stream_async(text=TEXT, ...):
        if isinstance(item, AudioChunk): ...

The Node server keeps watsonx orchestration; this process owns TTS only.
"""

import asyncio
import base64
import json
import os
from contextlib import asynccontextmanager
from typing import Optional

from fastapi import FastAPI, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from kugelaudio import AudioChunk, KugelAudio

API_KEY = os.environ["KUGELAUDIO_API_KEY"]
DEFAULT_MODEL = os.environ.get("KUGELAUDIO_MODEL_ID", "kugel-2")
DEFAULT_LANGUAGE = os.environ.get("KUGELAUDIO_LANGUAGE", "de")
DEFAULT_VOICE_ID = (
    int(os.environ["KUGELAUDIO_VOICE_ID"]) if os.environ.get("KUGELAUDIO_VOICE_ID") else None
)
PORT = int(os.environ.get("TTS_SIDECAR_PORT", "3210"))

state: dict = {"client": None, "lock": asyncio.Lock()}


@asynccontextmanager
async def lifespan(app: FastAPI):
    print(f"[tts-sidecar] booting — model={DEFAULT_MODEL} voice={DEFAULT_VOICE_ID} lang={DEFAULT_LANGUAGE}")
    client = await KugelAudio.create(api_key=API_KEY, model=DEFAULT_MODEL)
    state["client"] = client

    # Warm-up call EXACTLY as in ttfa_bench.py — text, model_id, language,
    # nothing else. SDK fills in its own defaults for voice_id (None →
    # default voice), cfg_scale (2.0), sample_rate (24000), normalize (True).
    print("[tts-sidecar] warming up connection...")
    try:
        async for _ in client.tts.stream_async(
            text="Test",
            model_id=DEFAULT_MODEL,
            language=DEFAULT_LANGUAGE,
        ):
            pass
        print("[tts-sidecar] warm-up complete — connection persistent")
    except Exception as e:
        print(f"[tts-sidecar] warm-up failed: {type(e).__name__}: {e}")

    try:
        yield
    finally:
        try:
            await client.aclose()
        except Exception:
            pass


app = FastAPI(lifespan=lifespan)


class StreamRequest(BaseModel):
    """Every optional field defaults to None so we can pass it through to
    the SDK only when the caller explicitly overrode it. Anything else
    falls through to the SDK's own defaults (voice_id=None, cfg_scale=2.0,
    sample_rate=24000, normalize=True). That keeps `client.tts.stream_async`
    arguments byte-for-byte identical to the reference benchmark script
    when the caller only sends `text`.
    """
    text: str
    voice_id: Optional[int] = None
    language: Optional[str] = None
    model_id: Optional[str] = None
    cfg_scale: Optional[float] = None
    sample_rate: Optional[int] = None
    normalize: Optional[bool] = None


@app.get("/health")
async def health():
    return {"ok": state["client"] is not None, "model": DEFAULT_MODEL}


@app.post("/tts/stream")
async def tts_stream(req: StreamRequest):
    """Stream audio chunks from a single full-text synthesis call.

    Mirrors the bench script: pass the complete text to stream_async and
    forward AudioChunks as SSE. The persistent client handles connection
    reuse + warm state across calls — that's where the TTFA win comes from.
    """
    client = state["client"]
    if client is None:
        raise HTTPException(status_code=503, detail="kugelaudio client not ready")

    # Build kwargs to mirror the bench script: text + model_id + language
    # only. Everything else (voice_id, cfg_scale, sample_rate, normalize)
    # is forwarded ONLY if the caller asked for an override.
    kwargs = dict(
        text=req.text,
        model_id=req.model_id or DEFAULT_MODEL,
        language=req.language or DEFAULT_LANGUAGE,
    )
    # voice_id ONLY if the caller explicitly sent one. No env-var fallback —
    # that lets the UI offer a "SDK default voice" mode (omit voice_id in
    # the request body) which is exactly what the colleague's reference
    # script does. Whatever default voice ships with the SDK is what plays.
    if req.voice_id is not None:
        kwargs["voice_id"] = req.voice_id
    if req.cfg_scale is not None:
        kwargs["cfg_scale"] = req.cfg_scale
    if req.sample_rate is not None:
        kwargs["sample_rate"] = req.sample_rate
    if req.normalize is not None:
        kwargs["normalize"] = req.normalize

    async def generate():
        # The SDK reuses one WS — overlapping calls would interleave audio.
        # Serialise turns; in practice the Node side drives them sequentially.
        async with state["lock"]:
            try:
                async for item in client.tts.stream_async(**kwargs):
                    if isinstance(item, AudioChunk):
                        payload = {
                            "pcm": base64.b64encode(item.audio).decode("ascii"),
                            "sample_rate": item.sample_rate,
                            "samples": item.samples,
                            "index": item.index,
                            "encoding": "pcm_s16le",
                        }
                        yield f"event: audio\ndata: {json.dumps(payload)}\n\n"
                yield "event: done\ndata: {}\n\n"
            except Exception as e:
                err = {"message": f"{type(e).__name__}: {e}"}
                yield f"event: error\ndata: {json.dumps(err)}\n\n"

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=PORT, log_level="info")
