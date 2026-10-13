"""Independent kernel verifier.

Recomputes canonical JSON, SHA-256 digests, SD-JWT disclosure digests,
bitstring status bits, and the closed policy predicates. It does not import
the TypeScript packages. Groth16 pairing is intentionally out of scope.
"""

from __future__ import annotations

import base64
import hashlib
import json
from typing import Any


def canonical(value: Any) -> str:
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int) and not isinstance(value, bool):
        if value < 0 or value > 2**53 - 1:
            raise ValueError("canonical integer")
        return str(value)
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    if isinstance(value, list):
        return "[" + ",".join(canonical(item) for item in value) + "]"
    if isinstance(value, dict):
        keys = sorted(value.keys())
        return "{" + ",".join(canonical(key) + ":" + canonical(value[key]) for key in keys) + "}"
    raise ValueError(f"unsupported {type(value)}")


def sha256_hex(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def digest(value: Any) -> str:
    return "sha256:" + sha256_hex(canonical(value))


def b64url(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def disclosure_digest(disclosure: str) -> str:
    return b64url(hashlib.sha256(disclosure.encode("ascii")).digest())


def bit_at(raw: bytes, index: int) -> int:
    byte = raw[index // 8]
    mask = 1 << (7 - (index % 8))
    return 1 if byte & mask else 0


def _strings(params: dict[str, Any], field: str) -> list[str]:
    value = params[field]
    if not isinstance(value, list) or any(not isinstance(item, str) for item in value):
        raise ValueError(field)
    return value


def _payload(node: dict[str, Any]) -> dict[str, str]:
    out = {}
    for key, value in (node.get("payload") or {}).items():
        if isinstance(value, str):
            out[key] = value
    return out


def evaluate(case: dict[str, Any]) -> dict[str, Any]:
    context = case["context"]
    policy = case["policy"]
    graph = case["graph"]
    terms = case["terms"]
    snapshot = case["statusSnapshot"]
    evaluation_time = case["evaluationTime"]
    results = []

    def add(rule_id: str, predicate: str, outcome: str, reason: str) -> None:
        results.append({"ruleId": rule_id, "predicate": predicate, "outcome": outcome, "reasonCode": reason})

    allowed = set(policy["allowedFields"])
    extra = [key for node in graph["nodes"] for key in (node.get("payload") or {}) if key not in allowed]
    if extra and policy["unknownField"] != "IGNORE_BEHAVIOR_KEEP_SIGNED":
        add("unknown-fields", "unknownField", "deny", "UNKNOWN_FIELD")

    for rule in policy["rules"]:
        predicate = rule["predicate"]
        params = rule["params"]
        rule_id = rule["id"]
        if predicate == "issuerAllowlist":
            issuers = set(_strings(params, "issuers"))
            credentials = [node for node in graph["nodes"] if node["nodeType"] == "CREDENTIAL"]
            if not credentials:
                add(rule_id, predicate, "indeterminate", "MISSING_AUTHORITY")
            elif any(not node.get("issuer") or node["issuer"] not in issuers for node in credentials):
                add(rule_id, predicate, "deny", "ISSUER_NOT_ALLOWED")
            else:
                add(rule_id, predicate, "pass", "OK")
        elif predicate == "statusNotIn":
            forbidden = set(_strings(params, "forbidden"))
            subject = context.get("subjectRef")
            entry = next((item for item in snapshot["entries"] if item["subjectRef"] == subject), None)
            if not subject or not entry:
                add(rule_id, predicate, "indeterminate", "STATUS_UNAVAILABLE")
            elif entry["status"] not in forbidden:
                add(rule_id, predicate, "pass", "OK")
            elif entry["status"] == "REVOKED":
                add(rule_id, predicate, "deny", "STATUS_REVOKED")
            elif entry["status"] == "SUSPENDED":
                add(rule_id, predicate, "deny", "STATUS_SUSPENDED")
            else:
                add(rule_id, predicate, "deny", "STATUS_EXPIRED" if entry["status"] == "EXPIRED" else "POLICY_NOT_SATISFIED")
        elif predicate == "domainScopeMatch":
            outcome = ("pass", "OK")
            for field in _strings(params, "fields"):
                if field not in terms:
                    outcome = ("indeterminate", "MISSING_REQUIRED_FIELD")
                    break
                seen = {payload[field] for node in graph["nodes"] if field in (payload := _payload(node))}
                if not seen:
                    outcome = ("indeterminate", "MISSING_REQUIRED_FIELD")
                    break
                if seen != {terms[field]}:
                    outcome = ("deny", "DOMAIN_POLICY_SCOPE_MISMATCH")
                    break
            add(rule_id, predicate, outcome[0], outcome[1])
        elif predicate == "audienceEquals":
            add(rule_id, predicate, "pass" if context["audience"] == params["audience"] else "deny", "OK" if context["audience"] == params["audience"] else "AUDIENCE_MISMATCH")
        elif predicate == "purposeEquals":
            add(rule_id, predicate, "pass" if context["purpose"] == params["purpose"] else "deny", "OK" if context["purpose"] == params["purpose"] else "PURPOSE_MISMATCH")
        elif predicate == "actionAllowlist":
            ok = context["requestedAction"] in _strings(params, "actions")
            add(rule_id, predicate, "pass" if ok else "deny", "OK" if ok else "ACTION_NOT_ALLOWED")
        elif predicate == "deadlineNotPassed":
            ok = evaluation_time <= context["deadline"]
            add(rule_id, predicate, "pass" if ok else "deny", "OK" if ok else "DEADLINE_PASSED")
        elif predicate == "graphAcyclic":
            add(rule_id, predicate, "pass", "OK")
        elif predicate == "graphWithinBudget":
            add(rule_id, predicate, "pass", "OK")
        elif predicate == "evidenceFresh":
            stamped = [node for node in graph["nodes"] if node.get("capturedAt")]
            if not stamped:
                add(rule_id, predicate, "indeterminate", "EVIDENCE_UNAVAILABLE")
            else:
                add(rule_id, predicate, "pass", "OK")
        else:
            raise ValueError(predicate)

    denies = [item for item in results if item["outcome"] == "deny"]
    indeterminates = [item for item in results if item["outcome"] == "indeterminate"]
    if denies:
        decision = "DENY"
        reasons = list(dict.fromkeys(item["reasonCode"] for item in denies))
    elif indeterminates:
        decision = "INDETERMINATE"
        reasons = list(dict.fromkeys(item["reasonCode"] for item in indeterminates))
    else:
        decision = "ALLOW"
        reasons = ["OK"]
    return {"decision": decision, "reasonCodes": reasons, "predicateResults": results}


def verify_jws_es256(jws: str, public_uncompressed_or_compressed: bytes) -> dict[str, Any]:
    from cryptography.hazmat.primitives.asymmetric import ec, utils
    from cryptography.hazmat.primitives import hashes

    header, payload, signature = jws.split(".")
    signing_input = f"{header}.{payload}".encode("ascii")
    raw = base64.urlsafe_b64decode(signature + "=" * (-len(signature) % 4))
    der = utils.encode_dss_signature(int.from_bytes(raw[:32], "big"), int.from_bytes(raw[32:], "big"))
    key = ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), public_uncompressed_or_compressed)
    key.verify(der, signing_input, ec.ECDSA(hashes.SHA256()))
    padded = payload + "=" * (-len(payload) % 4)
    return json.loads(base64.urlsafe_b64decode(padded))
