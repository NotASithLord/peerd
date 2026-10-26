"""Dependency-free tests of the real HTTP parser, boundary, and model adapter.

Run: python -m unittest discover -s scripts/local-browser -p 'test_serve_decider.py'
No listening socket, external service, model download, or GPU is needed.
"""

import io
import json
import threading
from types import SimpleNamespace
import unittest

from serve_decider import (
    DEFAULT_NAME, MAX_BODY_BYTES, DecisionHandler, DecisionService,
    DeciderBackend, RequestError, decode_request, validate_request,
)


def example():
    return {"model": DEFAULT_NAME, "state": {"goal": "Find an article", "url": "https://example.test"},
            "questions": {"action": {"type": "choice", "instructions": "Choose the next observed action.",
                                     "criteria": {"type:e1": "Type in Search", "blocked": "Cannot proceed"}}}}


class FakeBackend:
    def __init__(self):
        self.calls = []

    def system_one(self, state, questions):
        self.calls.append((state, questions))
        return {"answers": {"action": {"choice": "type:e1", "probabilities": {"type:e1": 0.9, "blocked": 0.1}}},
                "usage": {"input_tokens": 42, "output_tokens": 0}}


class MemorySocket:
    def __init__(self, request):
        self.input = io.BytesIO(request)
        self.output = bytearray()

    def settimeout(self, timeout):
        self.timeout = timeout

    def makefile(self, _mode, _buffering):
        return self.input

    def sendall(self, data):
        self.output.extend(data)


def http(service, method="POST", path="/v1/systemone", body=None, headers=None, raw=None):
    body = json.dumps(example()).encode() if body is None else body
    if raw is None:
        headers = [("Host", "127.0.0.1:8765"), ("Content-Type", "application/json"),
                   ("Content-Length", str(len(body)))] if headers is None else headers
        head = f"{method} {path} HTTP/1.1\r\n" + "".join(f"{key}: {value}\r\n" for key, value in headers)
        raw = head.encode() + b"\r\n" + body
    sock = MemorySocket(raw)
    DecisionHandler(sock, ("127.0.0.1", 1), SimpleNamespace(service=service, server_port=8765))
    head, response_body = bytes(sock.output).split(b"\r\n\r\n", 1)
    return int(head.split()[1]), json.loads(response_body), head.lower()


class HttpBoundaryTests(unittest.TestCase):
    def setUp(self):
        self.backend = FakeBackend()
        self.service = DecisionService(backend=self.backend)

    def test_real_http_parser_round_trip(self):
        status, response, headers = http(self.service)
        self.assertEqual(status, 200)
        self.assertEqual(response["answers"]["action"]["choice"], "type:e1")
        self.assertEqual(response["model"], DEFAULT_NAME)
        self.assertEqual(self.backend.calls[0], (example()["state"], example()["questions"]))
        self.assertIn(b"cache-control: no-store", headers)
        self.assertNotIn(b"access-control-allow-origin", headers)

    def test_health_does_not_load_and_inference_refuses_unloaded_model(self):
        service = DecisionService()
        status, response, _ = http(service, "GET", "/health", body=b"")
        self.assertEqual(status, 200)
        self.assertFalse(response["loaded"])
        self.assertEqual(response["status"], "unloaded")
        status, response, _ = http(service)
        self.assertEqual((status, response["error"]["code"]), (503, "model_not_loaded"))

    def test_models_reports_fixed_loaded_identity(self):
        status, response, _ = http(self.service, "GET", "/v1/models", body=b"")
        self.assertEqual(status, 200)
        self.assertEqual(response["data"][0]["id"], DEFAULT_NAME)
        self.assertTrue(response["data"][0]["loaded"])

    def test_origin_and_rebinding_hosts_are_rejected_before_inference(self):
        for host, origin in [("evil.test:8765", None), ("localhost", None),
                             ("127.0.0.1:8765", "null"), ("127.0.0.1:8765", "https://evil.test"),
                             ("127.0.0.1:8765", "")]:
            with self.subTest(host=host, origin=origin):
                headers = [("Host", host)]
                if origin is not None:
                    headers.append(("Origin", origin))
                self.assertEqual(http(self.service, headers=headers)[0], 403)
        self.assertFalse(self.backend.calls)

    def test_duplicate_host_is_rejected(self):
        self.assertEqual(http(self.service, headers=[("Host", "localhost:8765"),
                                                    ("Host", "127.0.0.1:8765")])[0], 403)

    def test_ambiguous_framing_and_request_sizes_are_rejected(self):
        base = [("Host", "127.0.0.1:8765"), ("Content-Type", "application/json")]
        cases = [([], 411), ([("Content-Length", "-1")], 411),
                 ([("Content-Length", "1"), ("Content-Length", "1")], 411),
                 ([("Content-Length", str(MAX_BODY_BYTES + 1))], 413),
                 ([("Transfer-Encoding", "chunked")], 400),
                 ([("Content-Encoding", "gzip")], 400), ([("Expect", "100-continue")], 417)]
        for extra, expected in cases:
            with self.subTest(extra=extra):
                self.assertEqual(http(self.service, headers=base + extra)[0], expected)
        self.assertFalse(self.backend.calls)

    def test_non_json_and_truncated_bodies_are_rejected(self):
        headers = [("Host", "127.0.0.1:8765"), ("Content-Length", "2"), ("Content-Type", "text/plain")]
        self.assertEqual(http(self.service, body=b"{}", headers=headers)[0], 415)
        headers[-1] = ("Content-Type", "application/json")
        self.assertEqual(http(self.service, body=b"{", headers=headers)[0], 400)
        self.assertFalse(self.backend.calls)

    def test_endpoint_and_fetch_metadata_are_checked(self):
        self.assertEqual(http(self.service, path="/v1/systemone?model=other")[0], 404)
        self.assertEqual(http(self.service, headers=[("Host", "localhost:8765"),
                                                    ("Sec-Fetch-Site", "cross-site")])[0], 403)


class SchemaTests(unittest.TestCase):
    def test_no_dynamic_model_assets_or_runtime_overrides(self):
        for field, value in [("model", "untrusted/remote-model"), ("revision", "main"),
                             ("assets", {"page": "http://example.test"}), ("file", "../file.gguf"),
                             ("truncate", True), ("context", 100_000)]:
            with self.subTest(field=field):
                payload = example()
                payload[field] = value
                with self.assertRaises(RequestError):
                    validate_request(payload, DEFAULT_NAME)

    def test_unknown_questions_and_bad_choices_rejected(self):
        for mutation in [lambda q: q.update(unknown=True), lambda q: q.update(type="generate"),
                         lambda q: q.update(criteria={"only": "one"}),
                         lambda q: q.update(criteria={str(i): "many" for i in range(129)}),
                         lambda q: q.update(criteria={"a": {}, "b": "nested descriptions"}),
                         lambda q: q.update(instructions="")]:
            payload = example()
            mutation(payload["questions"]["action"])
            with self.assertRaises(RequestError):
                validate_request(payload, DEFAULT_NAME)

    def test_duplicate_keys_nonfinite_and_deep_inputs_rejected(self):
        bodies = [b'{"state":"first","state":"second","questions":{}}',
                  b'{"state":{"number":NaN},"questions":{}}',
                  b'{"state":{"number":1e1000},"questions":{}}', b"\xff",
                  b'{"state":' + b"[" * 20 + b"0" + b"]" * 20 + b',"questions":{}}']
        for body in bodies:
            with self.subTest(body=body[:50]), self.assertRaises(RequestError):
                decode_request(body, DEFAULT_NAME)

    def test_noul_and_score_schema_are_supported(self):
        payload = {"state": "A fact", "questions": {
            "truth": {"type": "noul", "instructions": "Is the fact true?"},
            "scale": {"type": "score", "instructions": "How strong?", "criteria": ["low", "high"]}}}
        self.assertIs(validate_request(payload, DEFAULT_NAME), payload)


class InferenceBoundaryTests(unittest.TestCase):
    def test_errors_do_not_expose_page_or_runtime_details_and_release_lock(self):
        class BrokenBackend:
            def system_one(self, *_args):
                raise RuntimeError("secret page content /private/model/file")

        service = DecisionService(backend=BrokenBackend())
        for _ in range(2):
            status, response, _ = http(service)
            self.assertEqual(status, 500)
            self.assertEqual(response["error"]["code"], "inference_failed")
            self.assertNotIn("secret", json.dumps(response))

    def test_inference_is_serialized_without_queueing(self):
        entered, release = threading.Event(), threading.Event()

        class WaitingBackend(FakeBackend):
            def system_one(self, *args):
                entered.set()
                release.wait(timeout=2)
                return super().system_one(*args)

        service = DecisionService(backend=WaitingBackend())
        errors = []

        def run():
            try:
                service.predict(example())
            except Exception as error:
                errors.append(error)

        worker = threading.Thread(target=run)
        worker.start()
        try:
            self.assertTrue(entered.wait(timeout=1))
            with self.assertRaises(RequestError) as caught:
                service.predict(example())
            self.assertEqual(caught.exception.code, "model_busy")
        finally:
            release.set()
            worker.join(timeout=2)
        self.assertFalse(errors)
        self.assertEqual(len(service.backend.calls), 1)

    def test_exact_prompt_preflight_prevents_truncation(self):
        class FakeDecider:
            def __init__(self, row_length):
                self.m = SimpleNamespace(tok=SimpleNamespace(encode=lambda text, **_: list(text)))
                self.row_length, self.calls = row_length, []

            def _system_one_items(self, *args, **kwargs):
                return None, None, [{"ids": [0] * self.row_length}]

            def system_one(self, *args, **kwargs):
                self.calls.append(kwargs)
                return {"answers": {}}

        for state, row_length in [("x" * 100, 10), ("short", 65)]:
            model = FakeDecider(row_length)
            backend = DeciderBackend(model, str, 64)
            with self.assertRaises(RequestError) as caught:
                backend.system_one(state, {})
            self.assertEqual(caught.exception.status, 413)
            self.assertFalse(model.calls)
        model = FakeDecider(64)
        backend = DeciderBackend(model, str, 64)
        backend.system_one("short", {})
        self.assertEqual(model.calls[0]["max_state_tokens"], 64)
        self.assertEqual(model.calls[0]["layout"], "state_first")


if __name__ == "__main__":
    unittest.main()
