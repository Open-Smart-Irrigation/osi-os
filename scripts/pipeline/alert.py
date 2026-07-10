"""Alert via ntfy.sh push notifications + pipeline heartbeat."""
from __future__ import annotations
import json
import threading
import time
import urllib.request


def send_alert(topic: str, title: str, body: str,
               priority: str = "high", ntfy_url: str = "https://ntfy.sh") -> bool:
    url = f"{ntfy_url}/{topic}"
    data = json.dumps({"topic": topic, "title": title, "message": body,
                        "priority": priority}).encode()
    req = urllib.request.Request(url, data=data,
                                 headers={"Content-Type": "application/json"})
    try:
        urllib.request.urlopen(req, timeout=10)
        return True
    except Exception as e:
        print(f"ALERT DELIVERY FAILED: {e}")
        return False


class PipelineHeartbeat:
    def __init__(self, topic: str, interval_s: int = 1800,
                 ntfy_url: str = "https://ntfy.sh"):
        self._topic = topic
        self._interval = interval_s
        self._ntfy_url = ntfy_url
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def start(self, bundle_name: str = "") -> None:
        self._stop.clear()
        self._thread = threading.Thread(target=self._loop, args=(bundle_name,),
                                         daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=5)

    def _loop(self, bundle_name: str) -> None:
        while not self._stop.wait(self._interval):
            send_alert(self._topic,
                       f"Pipeline alive — soaking {bundle_name}",
                       f"Heartbeat at {time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}",
                       priority="low", ntfy_url=self._ntfy_url)
