"""
ExamProctor.ai — Student Agent: signed authorization lease verification.

The server issues an Ed25519-signed lease (device, session, student, capabilities, expiry).
The agent verifies the signature locally against a PINNED public key, so an editable config file
cannot grant or extend monitoring. Verified leases are cached on disk so a restart while offline
resumes only while the cached lease is still valid and its signature still checks out.

Residual limitation (documented): the check uses the device wall clock; a user with administrator
rights who changes the system clock can delay expiry. Online renewal re-checks against the server.
"""
from __future__ import annotations

import base64
import json
import logging
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional, Tuple

logger = logging.getLogger("agent.lease")

_DIR = Path(os.environ.get("EXAMPROCTOR_AGENT_DATA", Path(__file__).parent))
LEASE_FILE = _DIR / "lease.json"
PUBKEY_FILE = _DIR / "lease_pubkey.txt"


def canonical(payload: dict) -> bytes:
    return json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()


def _parse(ts: str) -> datetime:
    dt = datetime.fromisoformat(str(ts).replace("Z", "+00:00"))
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def verify_lease(lease: dict, pubkey_b64: str, device_id: str, session_id: str,
                 now: Optional[datetime] = None) -> Tuple[bool, str]:
    """Return (ok, reason). Checks signature, device, session and expiry."""
    try:
        from cryptography.exceptions import InvalidSignature
        from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

        payload = lease["payload"]
        sig = base64.b64decode(lease["signature"])
        Ed25519PublicKey.from_public_bytes(base64.b64decode(pubkey_b64)).verify(sig, canonical(payload))
    except InvalidSignature:
        return False, "bad_signature"
    except Exception as e:  # malformed lease / key
        return False, f"malformed:{type(e).__name__}"

    if payload.get("device_id") != device_id:
        return False, "device_mismatch"
    if payload.get("session_id") != session_id:
        return False, "session_mismatch"
    try:
        expires = _parse(payload["expires_at"])
    except Exception:
        return False, "malformed:expires_at"
    if (now or datetime.now(timezone.utc)) >= expires:
        return False, "expired"
    return True, "ok"


def pinned_public_key() -> Optional[str]:
    env = os.environ.get("EXAMPROCTOR_LEASE_PUBKEY", "").strip()
    if env:
        return env
    try:
        return PUBKEY_FILE.read_text().strip() or None
    except OSError:
        return None


def pin_public_key(key_b64: str) -> None:
    """Trust-on-first-use pinning (set EXAMPROCTOR_LEASE_PUBKEY to avoid TOFU)."""
    if not pinned_public_key():
        PUBKEY_FILE.write_text(key_b64)
        logger.info("Pinned server lease public key (trust on first use)")


def save_lease(lease: dict) -> None:
    LEASE_FILE.write_text(json.dumps(lease))


def clear_lease() -> None:
    try:
        LEASE_FILE.unlink()
    except OSError:
        pass


def load_cached_lease(device_id: str, session_id: str) -> Optional[dict]:
    """Return the cached lease only if it still verifies and has not expired."""
    key = pinned_public_key()
    if not key:
        return None
    try:
        lease = json.loads(LEASE_FILE.read_text())
    except (OSError, ValueError):
        return None
    ok, reason = verify_lease(lease, key, device_id, session_id)
    if not ok:
        logger.warning("Cached lease rejected: %s", reason)
        return None
    return lease


def lease_expiry(lease: dict) -> datetime:
    return _parse(lease["payload"]["expires_at"])
