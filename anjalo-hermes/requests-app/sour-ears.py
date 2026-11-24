#!/usr/bin/env python3
# Hermes Music's ears for the Discord bot ("Hey Sour Box, play ..."), 3.17.
#
# Speech to text with Vosk, on this machine: nothing is sent anywhere and nothing is kept. The bot hands over
# what one person said (16 kHz, mono, 16-bit) one sentence at a time on stdin, and gets a line of JSON back on
# stdout:
#   in:  {"id": 7, "bytes": 51200}\n  followed by that many bytes of audio
#        {"grammar": ["hey sour box play retry now", "play retry now by nakiso", "pause", ...]}\n
#            what can be said after "Sour Box", as whole sentences (3.17.1): the commands, and every song
#            with "play" in front. The recognizer learns from them which word follows which. Loose words
#            work too, but then any order of them is as likely as any other.
#   out: {"ready": true}                       once the model is loaded
#        {"id": 7, "wake": false}              nobody said "Sour Box"
#        {"id": 7, "wake": true, "text": "hey sour box play retry now", "alts": ["hey sour box play we try now"]}
#            alts (3.17.1): what else it could have been, the likeliest first - the second pass's other
#            readings, then what the same words in any order make of it (Hermes Music weighs them all)
#
# Two passes keep it light. The first only knows "hey", "sour" and "box" (everything else is "[unk]"), so it is
# quick and runs on every sentence. Only when it hears "sour box" does the second pass run, which knows the
# commands and the library's songs and nothing else - that is what makes song titles come out right.
import json
import sys

from vosk import KaldiRecognizer, Model, SetLogLevel

RATE = 16000
ALTS = 5
SetLogLevel(-1)


def say(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def tidy(text):
    return " ".join(str(text).replace("[unk]", " ").split())


def texts_of(rec, data):
    """Everything the recognizer thinks was said, the likeliest first."""
    rec.AcceptWaveform(data)
    try:
        res = json.loads(rec.FinalResult())
    except Exception:
        return []
    out = []
    for alt in res.get("alternatives", [res]):
        t = tidy(alt.get("text", ""))
        if t and t not in out:
            out.append(t)
    return out


def second_pass(model, phrases):
    rec = KaldiRecognizer(model, RATE, json.dumps(phrases + ["[unk]"])) if phrases else KaldiRecognizer(model, RATE)
    try:
        rec.SetMaxAlternatives(ALTS)
    except Exception:
        pass
    return rec


def main():
    model = Model(sys.argv[1])
    gate = KaldiRecognizer(model, RATE, json.dumps(["hey sour box", "sour box", "[unk]"]))
    songs = None  # the second pass, made again whenever the sentences change
    loose = None  # (3.17.1) and once more with the same words in any order: more readings for Hermes Music to weigh
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
                songs = second_pass(model, wanted) if wanted else None
                sentences = any(" " in w for w in wanted)
                loose = second_pass(model, sorted(set(" ".join(wanted).split()))) if sentences else None
            except Exception as e:  # sentences Vosk can't take: free recognition instead
                songs = None
                loose = None
                sys.stderr.write("ears: sentences not taken: %s\n" % e)
            continue
        size = int(head.get("bytes", 0))
        data = stdin.read(size) if size > 0 else b""
        ident = head.get("id")
        try:
            # "force": the person just said "Hey Sour Box" on its own, so this sentence is the command
            first = "" if head.get("force") else (texts_of(gate, data) or [""])[0]
            gate.Reset()
            if not head.get("force") and "sour box" not in first:
                say({"id": ident, "wake": False})
                continue
            rec = songs if songs is not None else second_pass(model, [])
            texts = texts_of(rec, data)
            rec.Reset()
            if loose is not None:
                for t in texts_of(loose, data):
                    if t not in texts:
                        texts.append(t)
                loose.Reset()
            say({"id": ident, "wake": True, "text": texts[0] if texts else first, "alts": texts[1:11]})
        except Exception as e:
            say({"id": ident, "wake": False, "error": str(e)})


if __name__ == "__main__":
    main()
