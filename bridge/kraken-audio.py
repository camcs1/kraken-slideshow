"""Capture system audio (WASAPI loopback) and stream waveform frames to the bridge.

Started and stopped by kraken-bridge.js when the visualizer turns on/off.
Each UDP datagram to 127.0.0.1:<port> is 2048 bytes: 1024 left samples then
1024 right samples, unsigned 8-bit with 128 = silence. That is the format
Butterchurn's render({audioLevels}) reads (getByteTimeDomainData style).

Exits when stdin closes, so it never outlives the bridge that started it.
Needs: pip install soundcard (numpy comes with it). Install it from a normal
terminal: run from the Claude desktop app, a --user install lands in that app's
private AppData copy and the bridge (started at login) can't import it.
Levels are normalised with automatic gain (see AGC_*); --gain N fixes it instead.
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

# Automatic gain. Loopback is recorded after the Windows volume slider, so at
# normal listening volume the waveform only uses a small part of the 8-bit range
# and presets barely react. Track a peak envelope (instant attack, slow release)
# and scale it towards TARGET, so the visualizer sees the same level whatever
# the volume. The slow release keeps beats louder than the quiet bits around them.
AGC_TARGET = 0.8      # envelope peak maps to 80% of full scale
AGC_MAX_GAIN = 16.0   # don't blow up near-silence into noise
AGC_FLOOR = 0.004     # below this the output is treated as silence: no boost
AGC_RELEASE_S = 4.0   # envelope falls back over ~4 s after a loud passage
AGC_SMOOTH = 0.15     # per-chunk step of the applied gain towards its target

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
    ap.add_argument("--gain", type=float, default=0.0,
                    help="fixed gain instead of automatic gain (0 = automatic)")
    ap.add_argument("--no-stdin", action="store_true", help="don't exit on stdin EOF (manual testing)")
    args = ap.parse_args()

    stop = threading.Event()
    if not args.no_stdin:
        threading.Thread(target=watch_stdin, args=(stop,), daemon=True).start()

    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    dest = ("127.0.0.1", args.port)
    chunk = max(64, RATE // args.fps)
    buf = np.zeros((FFT_SIZE, 2), dtype=np.float32)
    release = float(np.exp(-(chunk / RATE) / AGC_RELEASE_S))
    env, gain = 0.0, 1.0
    last_report = time.monotonic()

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
                    data = data[:, :2]
                    if args.gain > 0:
                        gain = args.gain
                    else:
                        peak = float(np.abs(data).max()) if len(data) else 0.0
                        env = peak if peak > env else env * release + peak * (1 - release)
                        want = 1.0 if env < AGC_FLOOR else min(AGC_MAX_GAIN, max(1.0, AGC_TARGET / env))
                        gain += (want - gain) * AGC_SMOOTH
                        if time.monotonic() - last_report > 30:
                            last_report = time.monotonic()
                            print(f"level: envelope {env:.3f}, gain x{gain:.1f}", flush=True)
                    data = data * gain
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
