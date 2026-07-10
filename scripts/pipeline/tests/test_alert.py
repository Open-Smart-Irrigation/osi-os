from unittest.mock import patch
from pipeline.alert import send_alert, PipelineHeartbeat
import time

@patch("pipeline.alert.urllib.request.urlopen")
def test_send_alert(mock_urlopen):
    assert send_alert("test-topic", "Test", "body") is True
    mock_urlopen.assert_called_once()

@patch("pipeline.alert.urllib.request.urlopen")
def test_send_alert_failure_returns_false(mock_urlopen):
    mock_urlopen.side_effect = OSError("network unreachable")
    assert send_alert("test-topic", "Test", "body") is False

@patch("pipeline.alert.send_alert")
def test_heartbeat_fires(mock_alert):
    hb = PipelineHeartbeat("test", interval_s=1)
    hb.start("B0")
    time.sleep(2.5)
    hb.stop()
    assert mock_alert.call_count >= 1

@patch("pipeline.alert.send_alert")
def test_heartbeat_stop_prevents_further_alerts(mock_alert):
    hb = PipelineHeartbeat("test", interval_s=1)
    hb.start("B0")
    time.sleep(1.5)
    hb.stop()
    count_after_stop = mock_alert.call_count
    time.sleep(1.5)
    assert mock_alert.call_count == count_after_stop
    assert not hb._thread.is_alive()
