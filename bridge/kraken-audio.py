"""Capture system audio (WASAPI loopback) and stream waveform frames to the bridge.

Started and stopped by kraken-bridge.js when the visualizer turns on/off.
Each UDP datagram to 127.0.0.1:<port> is 2048 bytes: 1024 left samples then
1024 right samples, unsigned 8-bit with 128 = silence. That is the format
Butterchurn's render({audioLevels}) reads (getByteTimeDomainData style).

Exits when stdin closes, so it never outlives the bridge that started it.
Needs: pip install soundcard (numpy comes with it).
"""
import argparse
import socket
import sys
import threading
import time
import warnings

import numpy as np
import soundcard as sc

FFT_SIZE = 1024
RATE = 48000

# soundcard warns on every gap ("data discontinuity") when nothing is playing.
warnings.filterwarnings("ignore", category=sc.SoundcardRuntimeWarning)


def watch_stdin(stop):
    try:
        while sys.stdin.read(1):
            pass
    except Exception:
        pass
    stop.set()


def to_bytes(x):
    return np.clip(x * 128.0 + 128.0, 0, 255).astype(np.uint8).tobytes()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=27881)
    ap.add_argument("--fps", type=int, default=60)
    ap.add_argument("--gain", type=float, default=1.0)
    ap.add_argument("--no-stdin", action="store_true", help="don't exit on stdin EOF (manual testing)")
    args = ap.parse_args()

    stop = threading.Event()
    if not args.no_stdin:
        threading.Thread(target=watch_stdin, args=(stop,), daemon=True).start()

    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    dest = ("127.0.0.1", args.port)
    chunk = max(64, RATE // args.fps)
    buf = np.zeros((FFT_SIZE, 2), dtype=np.float32)

    while not stop.is_set():
        try:
            speaker = sc.default_speaker()
            mic = sc.get_microphone(id=str(speaker.id), include_loopback=True)
            print(f"capturing: {speaker.name}", flush=True)
            last_check = time.monotonic()
            with mic.recorder(samplerate=RATE, channels=2, blocksize=chunk) as rec:
                while not stop.is_set():
                    data = rec.record(numframes=chunk)
                    if data.ndim == 1:
                        data = np.stack([data, data], axis=1)
                    data = data[:, :2] * args.gain
                    n = min(len(data), FFT_SIZE)
                    buf = np.concatenate([buf[n:], data[-n:]])
                    sock.sendto(to_bytes(buf[:, 0]) + to_bytes(buf[:, 1]), dest)
                    # Follow the default output device (speakers <-> TV audio).
                    if time.monotonic() - last_check > 2:
                        last_check = time.monotonic()
                        if sc.default_speaker().id != speaker.id:
                            print("default output changed, reopening", flush=True)
                            break
        except Exception as e:  # device unplugged, exclusive mode, etc.
            print(f"capture error: {e}; retrying in 2s", flush=True)
            stop.wait(2)


if __name__ == "__main__":
    main()
