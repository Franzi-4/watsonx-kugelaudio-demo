"""
Custom livekit-agents LLM plugin for IBM watsonx Orchestrate.

Orchestrate is not an OpenAI-compatible API — it has its own auth (IAM),
endpoint format, and thread management. This plugin wraps it as a standard
livekit LLM so AgentSession can use it in the STT → LLM → TTS pipeline.
"""

import logging
import time
from typing import Any

import aiohttp
from livekit.agents import llm

from .text_cleanup import clean_llm_text

logger = logging.getLogger("orchestrate-llm")


class OrchestrateStream(llm.LLMStream):
    """Single-shot stream — Orchestrate doesn't do token streaming."""

    def __init__(
        self,
        orc_llm: "OrchestrateLLM",
        *,
        chat_ctx: llm.ChatContext,
        conn_options: llm.APIConnectOptions,
    ):
        super().__init__(orc_llm, chat_ctx=chat_ctx, tools=[], conn_options=conn_options)
        self._orc = orc_llm

    async def _run(self) -> None:
        messages = []
        for msg in self._chat_ctx.items:
            role = msg.role
            text = msg.text_content or ""
            if role in ("system", "developer"):
                messages.append({"role": "system", "content": text})
            elif role == "user":
                messages.append({"role": "user", "content": text})
            elif role == "assistant":
                messages.append({"role": "assistant", "content": text})

        token = await self._orc._ensure_token()
        headers = {
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        }
        if self._orc._thread_id:
            headers["X-IBM-THREAD-ID"] = self._orc._thread_id

        url = f"{self._orc._instance_url}/v1/orchestrate/{self._orc._agent_id}/chat/completions"
        body = {"messages": messages, "stream": False, "context": {}}

        async with self._orc._http.post(url, json=body, headers=headers) as resp:
            data = await resp.json()
            if resp.status != 200:
                detail = data.get("message", data.get("detail", str(resp.status)))
                raise llm.APIStatusError(
                    detail,
                    status_code=resp.status,
                    body=data,
                    retryable=resp.status >= 500,
                )

        thread_id = data.get("thread_id")
        if thread_id:
            self._orc._thread_id = thread_id

        text = (
            data.get("choices", [{}])[0].get("message", {}).get("content", "")
            or ""
        )
        if isinstance(text, list):
            text = " ".join(str(t) for t in text)

        text = clean_llm_text(text)

        self._event_ch.send_nowait(
            llm.ChatChunk(
                id="orc-0",
                delta=llm.ChoiceDelta(role="assistant", content=text),
            )
        )


class OrchestrateLLM(llm.LLM):
    """livekit-agents LLM adapter for watsonx Orchestrate."""

    def __init__(
        self,
        *,
        api_key: str,
        instance_url: str,
        agent_id: str,
        timeout: float = 30.0,
    ):
        super().__init__()
        self._api_key = api_key
        self._instance_url = instance_url.rstrip("/")
        self._agent_id = agent_id
        self._timeout = timeout

        self._access_token: str | None = None
        self._token_expires_at: float = 0
        self._thread_id: str | None = None
        self._http: aiohttp.ClientSession | None = None

    @property
    def provider(self) -> str:
        return "ibm-orchestrate"

    @property
    def model(self) -> str:
        return "orchestrate-agent"

    async def _ensure_http(self) -> None:
        if self._http is None or self._http.closed:
            self._http = aiohttp.ClientSession(
                timeout=aiohttp.ClientTimeout(total=self._timeout)
            )

    async def _ensure_token(self) -> str:
        if self._access_token and time.time() < self._token_expires_at:
            return self._access_token

        await self._ensure_http()
        async with self._http.post(
            "https://iam.cloud.ibm.com/identity/token",
            data={
                "grant_type": "urn:ibm:params:oauth:grant-type:apikey",
                "apikey": self._api_key,
            },
        ) as resp:
            data = await resp.json()
            self._access_token = data["access_token"]
            self._token_expires_at = time.time() + data["expires_in"] - 300
            return self._access_token

    def chat(
        self,
        *,
        chat_ctx: llm.ChatContext,
        tools: list[Any] | None = None,
        conn_options: llm.APIConnectOptions = llm.APIConnectOptions(),
        **kwargs,
    ) -> OrchestrateStream:
        return OrchestrateStream(
            self, chat_ctx=chat_ctx, conn_options=conn_options
        )

    def reset_thread(self) -> None:
        self._thread_id = None

    async def aclose(self) -> None:
        if self._http and not self._http.closed:
            await self._http.close()
