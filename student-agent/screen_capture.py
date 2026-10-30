"""
ExamProctor.ai — Student Agent: Screen Capture Module.

Captures the primary desktop screen as a compressed JPEG thumbnail
and returns it as base64 for upload to the classroom server.

- Windows: uses mss (cross-platform) or PIL
- Linux X11: uses mss
"""

from __future__ import annotations

import base64
import io
import logging
from typing import Optional, Tuple

logger = logging.getLogger("agent.screen")


def capture_screen_jpeg(
    max_dimension: int = 960,
    quality: int = 60,
) -> Optional[str]:
    """
    Capture the primary screen and return base64-encoded JPEG.

    Args:
        max_dimension: Maximum width or height (preserves aspect ratio).
        quality: JPEG quality (1-95).

    Returns:
        base64-encoded JPEG string, or None on failure.
    """
    try:
        import mss
        import mss.tools
        from PIL import Image

        with mss.mss() as sct:
            monitor = sct.monitors[1]          # Primary monitor
            screenshot = sct.grab(monitor)
            img = Image.frombytes("RGB", screenshot.size, screenshot.bgra, "raw", "BGRX")

        # Downscale if necessary (preserving aspect ratio)
        w, h = img.size
        if max(w, h) > max_dimension:
            ratio = max_dimension / max(w, h)
            img = img.resize((int(w * ratio), int(h * ratio)), Image.LANCZOS)

        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=quality, optimize=True)
        return base64.b64encode(buf.getvalue()).decode("ascii")

    except ImportError:
        logger.warning("mss or Pillow not installed — screen capture unavailable")
        return None
    except Exception as e:
        logger.warning("Screen capture failed: %s", e)
        return None


def capture_screen_size_bytes() -> Optional[int]:
    """Returns the approximate size of the last capture in bytes (for logging)."""
    result = capture_screen_jpeg()
    if result:
        return len(base64.b64decode(result))
    return None
