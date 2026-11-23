#!/usr/bin/env python3
# Hermes Music's ears for the Discord bot ("Hey Sour Box, play ..."), 3.17.
#
# Speech to text with Vosk, on this machine: nothing is sent anywhere and nothing is kept. The bot hands over
# what one person said (16 kHz, mono, 16-bit) one sentence at a time on stdin, and gets a line of JSON back on
# stdout:
#   in:  {"id": 7, "bytes": 51200}\n  followed by that many bytes of audio
#        {"grammar": ["play", "retry", "now", ...]}\n   the words that can follow "Sour Box" (commands, and the
#                                                       words of the library's song titles and artists)
#   out: {"ready": true}                       once the model is loaded
#        {"id": 7, "wake": false}              nobody said "Sour Box"
#        {"id": 7, "wake": true, "text": "hey sour box play retry now"}
#
# Two passes keep it light. The first only knows "hey", "sour" and "box" (everything else is "[unk]"), so it is
# quick and runs on every sentence. Only when it hears "sour box" does the second pass run, which knows the
# commands and the library's words and nothing else - that is what makes song titles come out right.
import json
import sys

from vosk import KaldiRecognizer, Model, SetLogLevel

RATE = 16000
SetLogLevel(-1)


def say(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def text_of(rec, data):
    rec.AcceptWaveform(data)
    try:
        return json.loads(rec.FinalResult()).get("text", "")
    except Exception:
        return ""


def main():
    model = Model(sys.argv[1])
    gate = KaldiRecognizer(model, RATE, json.dumps(["hey sour box", "sour box", "[unk]"]))
    words = None  # the second pass, made again whenever the word list changes
    say({"ready": True})
    stdin = sys.stdin.buffer
    while True:
        line = stdin.readline()
        if not line:
            break
        try:
            head = json.loads(line)
        except Exception:
            continue
        if "grammar" in head:
            try:
                wanted = [str(w) for w in head["grammar"] if w]
                words = KaldiRecognizer(model, RATE, json.dumps(wanted + ["[unk]"])) if wanted else None
            except Exception as e:  # a word list Vosk can't take: free recognition instead
                words = None
                sys.stderr.write("ears: word list not taken: %s\n" % e)
            continue
        size = int(head.get("bytes", 0))
        data = stdin.read(size) if size > 0 else b""
        ident = head.get("id")
        try:
            # "force": the person just said "Hey Sour Box" on its own, so this sentence is the command
            first = "" if head.get("force") else text_of(gate, data)
            gate.Reset()
            if not head.get("force") and "sour box" not in first:
                say({"id": ident, "wake": False})
                continue
            rec = words if words is not None else KaldiRecognizer(model, RATE)
            text = text_of(rec, data)
            rec.Reset()
            say({"id": ident, "wake": True, "text": text or first})
        except Exception as e:
            say({"id": ident, "wake": False, "error": str(e)})


if __name__ == "__main__":
    main()
