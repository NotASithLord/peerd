#!/usr/bin/env python3
"""Serve a fixed local Decider GGUF checkpoint to Peerd's local Node bridge.

Install the reviewed runtime separately (no installation happens here):
  CMAKE_ARGS="-DGGML_METAL=on" pip install \\
    'decider-ai[gguf] @ git+https://github.com/Mapika/decider.git@91b6fa9b94ab6c4dc2c63d3b14d413243b4fffcc'
Then run:
  python scripts/local-browser/serve_decider.py --help

The CLI prepares the configured checkpoint once, before listening. HTTP requests
cannot download, select, or reload models. Imports and tests need only stdlib.
This endpoint is for a native loopback client, not direct calls from web pages.
"""

from __future__ import annotations

import argparse
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import math
from pathlib import Path
import re
import sys
import threading
import time
from typing import Any, Callable


DEFAULT_MODEL = "Mapika/decider-4b-GGUF"
DEFAULT_FILE = "decider-4b-v3-Q4_K_M.gguf"
DEFAULT_NAME = "decider-4b"
RUNTIME_VERSION = "1.10.0"
MAX_BODY_BYTES = 65_536
MAX_QUESTIONS = 4
MAX_CHOICES = 128
MAX_DEPTH = 12
MAX_NODES = 4_096
READ_TIMEOUT_SECONDS = 5
IDENTIFIER = re.compile(r"[A-Za-z0-9_.:-]{1,128}\Z", re.ASCII)


class RequestError(Exception):
    """A public, deliberately non-sensitive error response."""

    def __init__(self, status: int, code: str, message: str):
        super().__init__(message)
        self.status, self.code, self.message = status, code, message


def invalid(message: str) -> RequestError:
    return RequestError(400, "invalid_request", message)


def _check_json_tree(value: Any, depth: int = 0, budget: list[int] | None = None) -> None:
    budget = [MAX_NODES] if budget is None else budget
    budget[0] -= 1
    if depth > MAX_DEPTH or budget[0] < 0:
        raise invalid("JSON is too deeply nested or contains too many values.")
    if isinstance(value, dict):
        for key, child in value.items():
            if not isinstance(key, str) or len(key) > 256:
                raise invalid("Object keys must be bounded strings.")
            _check_json_tree(child, depth + 1, budget)
    elif isinstance(value, list):
        for child in value:
            _check_json_tree(child, depth + 1, budget)
    elif isinstance(value, str):
        if len(value) > 32_768:
            raise invalid("A text value exceeds the request limit.")
    elif isinstance(value, float) and not math.isfinite(value):
        raise invalid("Numbers must be finite.")
    elif value is not None and not isinstance(value, (bool, int, float)):
        raise invalid("Only JSON values are accepted.")


def _check_id(value: Any) -> None:
    if not isinstance(value, str) or IDENTIFIER.fullmatch(value) is None:
        raise invalid("Question and choice IDs must be short ASCII identifiers.")


def validate_request(payload: Any, model_name: str) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise invalid("The request must be an object.")
    if set(payload) - {"model", "state", "questions"}:
        raise invalid("Unknown request fields are not accepted.")
    if "model" in payload and payload["model"] != model_name:
        raise invalid("Only the configured model is available.")
    if "state" not in payload or not isinstance(payload["state"], (str, dict, list)):
        raise invalid("state must be a string, object, or array.")
    _check_json_tree(payload)
    questions = payload.get("questions")
    if not isinstance(questions, dict) or not 1 <= len(questions) <= MAX_QUESTIONS:
        raise invalid("The request must contain a bounded set of questions.")
    for question_id, question in questions.items():
        _check_id(question_id)
        if not isinstance(question, dict) or set(question) - {"type", "instructions", "criteria"}:
            raise invalid("Invalid question fields.")
        instructions = question.get("instructions")
        if not isinstance(instructions, str) or not instructions.strip() or len(instructions) > 2_048:
            raise invalid("Every question needs bounded, non-empty instructions.")
        kind, criteria = question.get("type"), question.get("criteria")
        if kind == "choice":
            if not isinstance(criteria, dict) or not 2 <= len(criteria) <= MAX_CHOICES:
                raise invalid("choice needs a bounded map of at least two options.")
            for choice_id in criteria:
                _check_id(choice_id)
            descriptions = criteria.values()
        elif kind == "score":
            if not isinstance(criteria, list) or not 2 <= len(criteria) <= 10:
                raise invalid("score needs two to ten ordered descriptions.")
            descriptions = criteria
        elif kind == "noul":
            if criteria is not None and (
                not isinstance(criteria, dict) or set(criteria) - {"true", "false"}
            ):
                raise invalid("noul criteria may describe true and false only.")
            descriptions = (criteria or {}).values()
        else:
            raise invalid("Unsupported question type.")
        if any(value is not None and (not isinstance(value, str) or len(value) > 2_048)
               for value in descriptions):
            raise invalid("Option descriptions must be bounded strings or null.")
    return payload


def _unique_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise invalid("Duplicate JSON keys are not accepted.")
        result[key] = value
    return result


def decode_request(body: bytes, model_name: str) -> dict[str, Any]:
    if not body or len(body) > MAX_BODY_BYTES:
        raise RequestError(413, "request_too_large", "Request body is empty or too large.")
    try:
        payload = json.loads(body.decode("utf-8"), object_pairs_hook=_unique_object,
                             parse_constant=lambda _: (_ for _ in ()).throw(invalid("Numbers must be finite.")))
    except (ValueError, UnicodeError, RecursionError) as error:
        raise invalid("The body must be valid, bounded UTF-8 JSON.") from error
    return validate_request(payload, model_name)


class DeciderBackend:
    """Keep upstream prompt construction and prevent its silent truncation."""

    def __init__(self, model: Any, render_state: Callable[[Any], str], context_tokens: int):
        self.model, self.render_state, self.context_tokens = model, render_state, context_tokens

    def system_one(self, state: Any, questions: dict[str, Any]) -> dict[str, Any]:
        # why: upstream slices the state before adding questions. Losing the goal
        # or an observed candidate silently would turn a valid action into a guess.
        state_text = "Context:\n" + self.render_state(state)
        token_count = len(self.model.m.tok.encode(state_text, add_special_tokens=False))
        if token_count > self.context_tokens:
            raise RequestError(413, "context_too_large", "State exceeds the configured context; compact the observation.")
        _, _, items = self.model._system_one_items(
            state, questions, independent=True, max_state_tokens=self.context_tokens, layout="state_first"
        )
        if not items or any(len(item["ids"]) > self.context_tokens for item in items):
            raise RequestError(413, "context_too_large", "State and questions exceed the configured context.")
        return self.model.system_one(
            state, questions, independent=True, max_state_tokens=self.context_tokens,
            max_fwd_tokens=self.context_tokens, layout="state_first"
        )


class DecisionService:
    def __init__(self, model_name: str = DEFAULT_NAME, backend: Any = None):
        _check_id(model_name)
        self.model_name, self.backend = model_name, backend
        self._inference_lock = threading.Lock()

    @property
    def loaded(self) -> bool:
        return self.backend is not None

    def predict(self, payload: Any) -> dict[str, Any]:
        payload = validate_request(payload, self.model_name)
        if not self.loaded:
            raise RequestError(503, "model_not_loaded", "No model is loaded; prepare it at server startup.")
        # why: one GPU context must not execute concurrent model calls or build
        # an unbounded queue. Native callers can retry a busy response explicitly.
        if not self._inference_lock.acquire(blocking=False):
            raise RequestError(503, "model_busy", "The local model is processing another request.")
        try:
            started = time.monotonic()
            result = self.backend.system_one(payload["state"], payload["questions"])
            if not isinstance(result, dict) or not isinstance(result.get("answers"), dict):
                raise RuntimeError("Invalid backend result")
            response = {
                "model": self.model_name,
                "answers": result["answers"],
                "usage": {**result.get("usage", {}), "latency_ms": round((time.monotonic() - started) * 1_000, 3)},
            }
            encoded = json.dumps(response, allow_nan=False).encode("utf-8")
            if len(encoded) > MAX_BODY_BYTES:
                raise RuntimeError("Oversized backend result")
            return response
        except RequestError:
            raise
        except Exception as error:
            # why: model/runtime exceptions may embed state, paths, or private
            # page text. Return a stable error without forwarding their contents.
            raise RequestError(500, "inference_failed", "Local inference failed; no decision was returned.") from error
        finally:
            self._inference_lock.release()


class DecisionHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.0"
    server_version = "peerd-local-decider"
    sys_version = ""

    def setup(self) -> None:
        self.request.settimeout(READ_TIMEOUT_SECONDS)
        super().setup()

    def log_message(self, _format: str, *args: Any) -> None:
        # why: access logs must not retain URLs, prompts, or browser state.
        return

    def _send(self, status: int, value: dict[str, Any]) -> None:
        body = json.dumps(value, ensure_ascii=True, allow_nan=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Connection", "close")
        self.end_headers()
        self.close_connection = True
        self.wfile.write(body)

    def _error(self, error: RequestError) -> None:
        self._send(error.status, {"error": {"code": error.code, "message": error.message}})

    def send_error(self, code: int, message: str | None = None, explain: str | None = None) -> None:
        self._error(RequestError(code, "http_error", "Unsupported or malformed HTTP request."))

    def _check_client(self) -> None:
        hosts = self.headers.get_all("Host", [])
        allowed = {f"127.0.0.1:{self.server.server_port}", f"localhost:{self.server.server_port}"}
        if len(hosts) != 1 or hosts[0] not in allowed:
            raise RequestError(403, "invalid_host", "A loopback Host with the server port is required.")
        if "Origin" in self.headers or self.headers.get("Sec-Fetch-Site", "none") != "none":
            raise RequestError(403, "browser_origin_denied", "Use the native local bridge; browser-origin requests are refused.")
        if "Transfer-Encoding" in self.headers or "Content-Encoding" in self.headers:
            raise invalid("Encoded or chunked request bodies are not accepted.")
        if "Expect" in self.headers:
            raise RequestError(417, "expectation_failed", "Expect headers are not accepted.")

    def do_GET(self) -> None:
        try:
            self._check_client()
            service = self.server.service
            if self.path == "/health":
                self._send(200, {"status": "ready" if service.loaded else "unloaded",
                                 "loaded": service.loaded, "model": service.model_name})
            elif self.path == "/v1/models":
                self._send(200, {"object": "list", "data": [
                    {"id": service.model_name, "object": "model", "owned_by": "local", "loaded": service.loaded}
                ]})
            else:
                raise RequestError(404, "not_found", "Unknown endpoint.")
        except RequestError as error:
            self._error(error)

    def do_POST(self) -> None:
        try:
            self._check_client()
            if self.path != "/v1/systemone":
                raise RequestError(404, "not_found", "Unknown endpoint.")
            lengths = self.headers.get_all("Content-Length", [])
            if len(lengths) != 1 or re.fullmatch(r"[0-9]{1,10}", lengths[0], re.ASCII) is None:
                raise RequestError(411, "length_required", "One decimal Content-Length is required.")
            length = int(lengths[0])
            if not 1 <= length <= MAX_BODY_BYTES:
                raise RequestError(413, "request_too_large", "Request body is empty or too large.")
            content_types = self.headers.get_all("Content-Type", [])
            if len(content_types) != 1 or content_types[0].lower().replace(" ", "") not in {
                "application/json", "application/json;charset=utf-8"
            }:
                raise RequestError(415, "unsupported_media_type", "Use application/json with UTF-8 encoding.")
            body = self.rfile.read(length)
            if len(body) != length:
                raise invalid("Request body is incomplete.")
            payload = decode_request(body, self.server.service.model_name)
            self._send(200, self.server.service.predict(payload))
        except RequestError as error:
            self._error(error)
        except (TimeoutError, OSError):
            self._error(RequestError(408, "request_timeout", "Request body was not received in time."))


class DecisionServer(ThreadingHTTPServer):
    daemon_threads = True
    request_queue_size = 8

    def __init__(self, service: DecisionService, port: int = 8000):
        self.service = service
        self._clients = threading.BoundedSemaphore(8)
        # why: there is deliberately no --host switch or non-loopback bind path.
        super().__init__(("127.0.0.1", port), DecisionHandler)

    def process_request(self, request: Any, client_address: Any) -> None:
        if not self._clients.acquire(blocking=False):
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, client_address)
        except Exception:
            self._clients.release()
            raise

    def process_request_thread(self, request: Any, client_address: Any) -> None:
        try:
            super().process_request_thread(request, client_address)
        finally:
            self._clients.release()


@dataclass(frozen=True)
class ModelConfig:
    model: str = DEFAULT_MODEL
    filename: str = DEFAULT_FILE
    revision: str | None = None
    context_tokens: int = 4_096


def load_backend(config: ModelConfig) -> DeciderBackend:
    """Explicit CLI startup only; checkpoint Python files are never downloaded."""
    from importlib.metadata import version

    if version("decider-ai") != RUNTIME_VERSION:
        raise RuntimeError(f"This adapter requires reviewed decider-ai=={RUNTIME_VERSION}.")
    if Path(config.filename).name != config.filename or not config.filename.endswith(".gguf"):
        raise ValueError("--file must be a GGUF basename.")
    model_path = Path(config.model).expanduser()
    if model_path.is_dir():
        if config.revision is not None:
            raise ValueError("--revision applies to a Hub repository, not a local directory.")
    else:
        if re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", config.model, re.ASCII) is None:
            raise ValueError("--model must be an existing directory or a Hugging Face owner/repository.")
        from huggingface_hub import snapshot_download

        model_path = Path(snapshot_download(
            config.model, revision=config.revision,
            allow_patterns=[config.filename, "decider_config.json", "tokenizer.json", "tokenizer_config.json",
                            "special_tokens_map.json", "chat_template.jinja"],
        ))
    for filename in (config.filename, "decider_config.json", "tokenizer.json", "tokenizer_config.json"):
        if not (model_path / filename).is_file():
            raise ValueError("The checkpoint directory is incomplete.")
    # why: Decider does not expose revision=. Resolving the snapshot first keeps
    # its GGUF, tokenizer, and decision configuration on the same revision.
    from decider.infer import Decider
    from decider.systemone import render_state

    model = Decider(str(model_path), gguf_file=config.filename,
                    gguf_options={"n_ctx": config.context_tokens, "n_gpu_layers": -1, "n_seq_max": 1})
    return DeciderBackend(model, render_state, config.context_tokens)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--model", default=DEFAULT_MODEL, help="Fixed Hub repository or local checkpoint directory.")
    parser.add_argument("--file", default=DEFAULT_FILE, help="GGUF basename within that checkpoint.")
    parser.add_argument("--revision", help="Hub revision; use a full commit SHA for reproducibility.")
    parser.add_argument("--name", default=DEFAULT_NAME, help="Only accepted HTTP model ID.")
    parser.add_argument("--context", type=int, default=4_096, help="Total prompt tokens, including question/choices.")
    parser.add_argument("--port", type=int, default=8000, help="Listen on 127.0.0.1 at this port.")
    args = parser.parse_args(argv)
    if not 1 <= args.port <= 65_535 or not 256 <= args.context <= 8_192:
        parser.error("port or context is outside the supported range")
    try:
        service = DecisionService(args.name)
        print("Preparing fixed local decision model; HTTP is not listening yet.", file=sys.stderr)
        service.backend = load_backend(ModelConfig(args.model, args.file, args.revision, args.context))
        with DecisionServer(service, args.port) as server:
            print(f"Local decision model ready at http://127.0.0.1:{args.port}", file=sys.stderr)
            server.serve_forever(poll_interval=0.25)
    except KeyboardInterrupt:
        return 0
    except Exception as error:
        print(f"Startup failed ({type(error).__name__}); check the fixed checkpoint and runtime installation.", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
