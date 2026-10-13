"""Run the shared kernel vectors. Exits non-zero when the Python verifier disagrees."""

import gzip
import json
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).parent))
from rwaix_verifier import bit_at, canonical, digest, disclosure_digest, evaluate, verify_jws_es256

ROOT = pathlib.Path(__file__).resolve().parents[2]
VECTORS = ROOT / "verifiers" / "vectors" / "kernel.json"


def main() -> None:
    body = json.loads(VECTORS.read_text())
    for item in body["canonical"]:
        got = canonical(item["value"])
        if got != item["canonical"]:
            raise SystemExit(f"canonical {item['canonical']!r} != {got!r}")
        if digest(item["value"]) != item["digest"]:
            raise SystemExit("digest mismatch")
    for item in body["policies"]:
        got = evaluate(item["input"])
        if got["decision"] != item["expect"]["decision"] or got["reasonCodes"] != item["expect"]["reasonCodes"]:
            raise SystemExit(f"policy {item['id']}: {got} != {item['expect']}")
        pairs = [(row["ruleId"], row["outcome"], row["reasonCode"]) for row in got["predicateResults"]]
        expected = [(row["ruleId"], row["outcome"], row["reasonCode"]) for row in item["expect"]["predicateResults"]]
        if pairs != expected:
            raise SystemExit(f"predicates {item['id']}: {pairs} != {expected}")
    disclosed = body["sdJwt"]
    if disclosure_digest(disclosed["disclosure"]) != disclosed["digest"]:
        raise SystemExit("sd-jwt digest")
    payload = verify_jws_es256(disclosed["issuerJws"], bytes.fromhex(disclosed["publicKeyHex"]))
    if disclosed["digest"] not in payload["_sd"]:
        raise SystemExit("sd-jwt commitment")
    raw = gzip.decompress(bytes.fromhex(body["status"]["gzipHex"]))
    if bit_at(raw, body["status"]["index"]) != body["status"]["bit"]:
        raise SystemExit("status bit")
    print(f"python verifier passed {len(body['policies'])} policy vectors")


if __name__ == "__main__":
    main()
