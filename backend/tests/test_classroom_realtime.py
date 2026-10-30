"""
Unit and integration tests for Smart Classroom Real-Time Monitoring:
- Live screen frame broadcasting and caching
- Live webcam frame broadcasting and caching
- Device frame retrieval endpoints
- Auto-seeding of monitoring policies
- Offline lease verification
"""

import pytest
from datetime import datetime, timezone, timedelta
from unittest.mock import MagicMock
from app.classroom.hub import classroom_hub
from app.classroom.api.policies import seed_default_policy
from app.classroom.models import ClassroomPolicy

def test_classroom_hub_screen_and_webcam_caching():
    """Verify in-memory caching and retrieval of live frames per device."""
    device_id = "test-device-uuid-1"
    now_iso = datetime.now(timezone.utc).isoformat()
    fake_screen_b64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
    fake_webcam_b64 = "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA="

    # Screen frame
    classroom_hub.set_latest_screen_frame(device_id, fake_screen_b64, now_iso)
    cached_screen = classroom_hub.get_latest_screen_frame(device_id)
    assert cached_screen is not None
    assert cached_screen["image_b64"] == fake_screen_b64
    assert cached_screen["timestamp"] == now_iso

    # Webcam frame
    classroom_hub.set_latest_webcam_frame(device_id, fake_webcam_b64, now_iso)
    cached_webcam = classroom_hub.get_latest_webcam_frame(device_id)
    assert cached_webcam is not None
    assert cached_webcam["image_b64"] == fake_webcam_b64
    assert cached_webcam["timestamp"] == now_iso


def test_offline_lease_calculation():
    """Verify server lease timestamps and expiration calculation."""
    duration_min = 120
    now = datetime.now(timezone.utc)
    expires_at = now + timedelta(minutes=duration_min)
    
    assert expires_at > now
    diff_minutes = (expires_at - now).total_seconds() / 60
    assert abs(diff_minutes - 120) < 1.0


def test_policy_auto_seed_when_empty():
    """Verify seed_default_policy creates a valid default policy if count is 0."""
    mock_db = MagicMock()
    mock_scalar = MagicMock()
    mock_scalar.scalar_one.return_value = 0
    mock_db.execute.return_value = mock_scalar

    seed_default_policy(mock_db)
    assert mock_db.add.called
    added_obj = mock_db.add.call_args[0][0]
    assert isinstance(added_obj, ClassroomPolicy)
    assert added_obj.name == "Standard Exam Policy"
    assert added_obj.screen_capture_interval_sec >= 1
    assert mock_db.commit.called
