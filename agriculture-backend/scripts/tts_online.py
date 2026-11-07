# -*- coding: utf-8 -*-
"""
使用 edge-tts 的神经网络语音合成（比 Windows 自带的 Huihui 自然得多）
输出：原始 PCM，16 位单声道 24kHz

用法: python tts_online.py <text_file> <out_pcm>
"""
import asyncio
import os
import sys

VOICE = os.environ.get("HEZHEN_TTS_VOICE", "zh-CN-XiaoxiaoNeural")
RATE = os.environ.get("HEZHEN_TTS_RATE", "+0%")


async def synth(text: str, out_pcm: str) -> None:
    import edge_tts

    mp3 = out_pcm + ".mp3"
    comm = edge_tts.Communicate(text, VOICE, rate=RATE)
    await comm.save(mp3)

    # MP3 -> PCM 24k 单声道，用 miniaudio（自带解码器，不需要 ffmpeg）
    import miniaudio

    dec = miniaudio.decode_file(
        mp3,
        output_format=miniaudio.SampleFormat.SIGNED16,
        nchannels=1,
        sample_rate=24000,
    )
    with open(out_pcm, "wb") as f:
        f.write(bytes(dec.samples))
    try:
        os.remove(mp3)
    except OSError:
        pass


def main() -> int:
    if len(sys.argv) < 3:
        print("usage: tts_online.py <text_file> <out_pcm>", file=sys.stderr)
        return 1
    with open(sys.argv[1], "r", encoding="utf-8") as f:
        text = f.read().strip()
    if not text:
        return 2
    asyncio.run(synth(text, sys.argv[2]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
