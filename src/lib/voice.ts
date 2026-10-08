import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AudioClip } from "./protocol";

/**
 * Voice answers, as a capability ladder rather than a single dependency.
 *
 * AuraUI is local-first and asks one question at a time, so voice here is not a feature of
 * the page: it is a way to answer the handful of questions that need words. AuraUI never
 * requires a cloud service and never pretends to have one, so the button adapts to what the
 * webview in front of it can actually do, in this order:
 *
 * 1. **`dictation`** — the webview ships a speech recognizer (`SpeechRecognition`, or the
 *    `webkit-`prefixed one). Words stream into the field as the human speaks, and since we
 *    are already holding the microphone we record the take alongside them: the transcript
 *    goes in the field, the audio goes to the agent.
 * 2. **`recording`** — no recognizer (Tauri's WebKitGTK webview is one of these; it has
 *    never implemented the Web Speech API) but the webview can capture audio. The take is
 *    recorded, and transcribed through `VITE_AURAUI_STT_URL` when the machine has a
 *    transcriber to point at. With none configured the clip is still sent: an agent can do
 *    something useful with "hum the tune" even when nobody can spell it.
 * 3. **`none`** — no microphone and no recognizer, so no button.
 *
 * Recording rather than transcribing is the point of the last rung. The questions voice is
 * for are not all words: *hum the tune*, *say it with the inflection you heard*, *read this
 * script so we have a voice track*. Those need the audio itself, so the audio is what the
 * canvas keeps, and the transcript is a bonus on top of it.
 */

export type VoiceCapability = "dictation" | "recording" | "none";

/** What came out of one finished take. */
export interface VoiceTake {
  /** What was heard. Empty when nothing in this webview could transcribe the clip. */
  text: string;
  /** The recording behind it, when one was made. */
  clip?: AudioClip;
}

/**
 * How much audio one answer may carry.
 *
 * Opus at MediaRecorder's default bitrate spends roughly 16 kB/s, so this is about a minute
 * and a half of speech, and about 2 MB once base64 has done with it — comfortably inside the
 * bridge's 16 MiB frame cap and small enough that a slow local reader is never the bottleneck.
 * A longer take is still transcribed; only the audio is dropped, because a question that took
 * ninety seconds to answer is worth the words even without the sound.
 */
export const MAX_CLIP_BYTES = 1_500_000;

/** A take stops on its own here, so a forgotten microphone cannot record the room all day. */
export const MAX_TAKE_MS = 150_000;

const STT_URL_KEY = "auraui.stt.url";

/** The recognizer as this canvas uses it: only the parts that are not vendor trivia. */
interface SpeechResultAlternative {
  transcript: string;
}
interface SpeechResult {
  readonly isFinal: boolean;
  readonly length: number;
  [index: number]: SpeechResultAlternative | undefined;
}
interface SpeechResultEvent {
  readonly resultIndex: number;
  readonly results: { readonly length: number; [index: number]: SpeechResult | undefined };
}
interface SpeechErrorEvent {
  readonly error?: string;
}
interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  onresult: ((event: SpeechResultEvent) => void) | null;
  onerror: ((event: SpeechErrorEvent) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function speechRecognitionCtor(): SpeechRecognitionCtor | undefined {
  if (typeof window === "undefined") return undefined;
  const scope = window as unknown as Record<string, unknown>;
  const ctor = scope.SpeechRecognition ?? scope.webkitSpeechRecognition;
  return typeof ctor === "function" ? (ctor as SpeechRecognitionCtor) : undefined;
}

function canCaptureAudio(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.MediaRecorder !== "undefined" &&
    typeof navigator !== "undefined" &&
    typeof navigator.mediaDevices?.getUserMedia === "function"
  );
}

/**
 * What the webview in front of us can do.
 *
 * Sampled at call time rather than at module load, so a component that mounts late still
 * sees the truth, and so a test can stub the API it is asking about.
 */
export function voiceCapability(): VoiceCapability {
  if (speechRecognitionCtor()) return "dictation";
  if (canCaptureAudio()) return "recording";
  return "none";
}

/**
 * Where to send a recorded take, if anywhere.
 *
 * Any OpenAI-compatible `/v1/audio/transcriptions` endpoint works, from a `whisper.cpp`
 * server on the same machine to a hosted service. Unset is a supported configuration: the
 * canvas records, sends the audio, and says plainly that it could not write it down. The
 * stored value wins over the build-time one so a machine can point at its own transcriber
 * without a rebuild.
 */
export function transcriberUrl(): string | undefined {
  try {
    const stored = window.localStorage.getItem(STT_URL_KEY);
    if (stored !== null && stored.trim() !== "") return stored.trim();
  } catch {
    // Storage can be unavailable in a locked-down webview. That is not a reason to lose the
    // setting that was compiled in.
  }
  // Written as a plain member access on purpose: that is the exact expression Vite replaces
  // at build time, and an optional chain would leave the variable unread in a production build.
  const fromEnv = import.meta.env.VITE_AURAUI_STT_URL;
  return typeof fromEnv === "string" && fromEnv.trim() !== "" ? fromEnv.trim() : undefined;
}

/** The container a blob's mime type implies, for the filename a transcriber expects. */
function extensionFor(mime: string): string {
  if (mime.includes("ogg")) return "ogg";
  if (mime.includes("mp4") || mime.includes("aac")) return "m4a";
  if (mime.includes("wav")) return "wav";
  return "webm";
}

/** The mime types WebKit and Chromium actually produce, best first. */
const PREFERRED_MIMES = [
  "audio/webm;codecs=opus",
  "audio/ogg;codecs=opus",
  "audio/webm",
  "audio/mp4",
];

function pickMime(): string | undefined {
  // A bare `typeof` guard, not an optional chain: `MediaRecorder?.x` still throws on a webview
  // where the constructor was never defined, which is exactly the case this is here for.
  if (typeof MediaRecorder === "undefined" || typeof MediaRecorder.isTypeSupported !== "function") {
    return undefined;
  }
  return PREFERRED_MIMES.find((mime) => MediaRecorder.isTypeSupported(mime));
}

/** Join a settled phrase onto what has already been heard without doubling the separation. */
export function appendSpeech(heard: string, phrase: string): string {
  if (heard === "") return phrase;
  return heard.endsWith(" ") || heard.endsWith("\n") ? `${heard}${phrase}` : `${heard} ${phrase}`;
}

async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  // In slices: spreading a whole minute of audio into `fromCharCode` at once blows the
  // argument limit and throws a RangeError instead of returning a string.
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

/**
 * Ask a transcriber to write down a take.
 *
 * Deliberately tolerant: a machine with no transcriber is normal, and a transcriber that
 * refuses must not cost the human the answer they already gave. The caller turns a throw into
 * a sentence next to the field and keeps the audio.
 */
async function transcribe(blob: Blob, url: string): Promise<string> {
  const body = new FormData();
  body.append("file", blob, `auraui-voice.${extensionFor(blob.type)}`);
  body.append("model", import.meta.env.VITE_AURAUI_STT_MODEL ?? "whisper-1");

  const response = await fetch(url, { method: "POST", body });
  if (!response.ok) {
    throw new Error(`the transcriber answered ${response.status}`);
  }
  const data = (await response.json()) as { text?: unknown };
  return typeof data.text === "string" ? data.text.trim() : "";
}

export interface VoiceInputHandlers {
  /** A settled phrase, ready to be appended to the field being answered. */
  onAppend?: (text: string) => void;
  /** Once per finished take: everything heard, plus the audio when there is any. */
  onTake?: (take: VoiceTake) => void;
}

export interface VoiceInputState {
  capability: VoiceCapability;
  /** The microphone is live right now. */
  listening: boolean;
  /** Words that are still being recognized, shown while the human is speaking. */
  interim: string;
  /** Why the last take produced no text. Not an error: the audio still went out. */
  notice?: string;
  /** Something went wrong — no microphone, permission refused, transcriber refused. */
  error?: string;
  /** Start a take, or end one that is already running. */
  toggle: () => void;
}

/**
 * One microphone for one card.
 *
 * A card asks one question, so it holds at most one live take, and the button that starts it
 * is the button that ends it. Everything the webview needs is created on demand and released
 * when the take ends or the card goes away: a canvas that leaves a microphone open after the
 * answer is a canvas nobody would keep on their desktop.
 */
export function useVoiceInput({
  onAppend,
  onTake,
}: VoiceInputHandlers = {}): VoiceInputState {
  const capability = useMemo(voiceCapability, []);
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState("");
  const [notice, setNotice] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();

  // Handlers live in a ref so a take in flight keeps calling the latest ones without the
  // recognizer being torn down and restarted on every render.
  const handlers = useRef<VoiceInputHandlers>({ onAppend, onTake });
  handlers.current = { onAppend, onTake };

  const recognition = useRef<SpeechRecognitionLike | null>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const chunks = useRef<Blob[]>([]);
  const heard = useRef("");
  const usedRecorder = useRef(false);
  const settled = useRef(true);
  const startedAt = useRef(0);
  const stopTimer = useRef<number | null>(null);

  const release = useCallback(() => {
    if (stopTimer.current !== null) {
      window.clearTimeout(stopTimer.current);
      stopTimer.current = null;
    }
    for (const track of stream.current?.getTracks() ?? []) track.stop();
    stream.current = null;
    recorder.current = null;
    recognition.current = null;
    chunks.current = [];
  }, []);

  // A card that is answered, dismissed or replaced while the microphone is open has to let
  // go of it. Nothing else will.
  useEffect(() => release, [release]);

  /** Finish a take exactly once, and hand over whatever it produced. */
  const settle = useCallback(
    async (clip: Blob | null) => {
      if (settled.current) return;
      settled.current = true;
      release();

      let audio: AudioClip | undefined;
      let text = heard.current;

      if (clip && clip.size > 0) {
        if (clip.size > MAX_CLIP_BYTES) {
          setNotice(
            "That was long enough that I only kept the words: the recording was too big to send.",
          );
        } else {
          audio = {
            mime: clip.type || "audio/webm",
            durationMs: Math.max(0, Math.round(performance.now() - startedAt.current)),
            data: await blobToBase64(clip),
          };
        }
      }

      const url = transcriberUrl();
      if (text === "" && clip && clip.size > 0) {
        if (!url) {
          setNotice(
            "This window cannot write speech down, so I am sending the recording itself.",
          );
        } else {
          try {
            text = await transcribe(clip, url);
            if (text !== "") {
              heard.current = text;
              handlers.current.onAppend?.(text);
            }
          } catch (cause) {
            setError(
              `Could not reach the transcriber (${cause instanceof Error ? cause.message : String(cause)}), so I am sending the recording itself.`,
            );
          }
        }
      }

      handlers.current.onTake?.({ text, ...(audio ? { clip: audio } : {}) });
    },
    [release],
  );

  /**
   * Start keeping the audio, if this webview will let us.
   *
   * Reports the reason rather than setting an error directly, because whether a failed
   * recording is bad news depends on what else is running. With a recognizer alongside it, the
   * words still arrive and the loss is a note; on its own it is the whole feature failing, and
   * the caller says so.
   */
  const startRecorder = useCallback(
    async (): Promise<{ ok: boolean; message: string }> => {
      if (!navigator.mediaDevices?.getUserMedia) {
        return { ok: false, message: "This window cannot open a microphone." };
      }
      try {
        const captured = await navigator.mediaDevices.getUserMedia({ audio: true });
        stream.current = captured;
        const mime = pickMime();
        const created = mime
          ? new MediaRecorder(captured, { mimeType: mime })
          : new MediaRecorder(captured);
        chunks.current = [];
        created.ondataavailable = (event) => {
          if (event.data.size > 0) chunks.current.push(event.data);
        };
        created.onstop = () => {
          void settle(new Blob(chunks.current, { type: created.mimeType || "audio/webm" }));
        };
        // A timeslice keeps a long take flowing into chunks instead of holding the whole thing
        // in one buffer that a low-memory webview would rather not have.
        created.start(250);
        recorder.current = created;
        usedRecorder.current = true;
        startedAt.current = performance.now();
        return { ok: true, message: "" };
      } catch (cause) {
        // `NotAllowedError` is the one worth naming: on the desktop it means the app did not
        // ask the system for the microphone, which is a fix, not a dead end.
        const detail = cause instanceof Error ? cause.message : String(cause);
        const denied = cause instanceof Error && cause.name === "NotAllowedError";
        return {
          ok: false,
          message: denied
            ? "The microphone is not available to this window. Allow it for AuraUI in the system privacy settings."
            : `Could not open the microphone: ${detail}.`,
        };
      }
    },
    [settle],
  );

  const startDictation = useCallback(() => {
    const Ctor = speechRecognitionCtor();
    if (!Ctor) return false;
    const created = new Ctor();
    created.lang = navigator.language || "en-US";
    created.continuous = true;
    created.interimResults = true;
    created.maxAlternatives = 1;

    created.onresult = (event) => {
      let live = "";
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index];
        if (!result) continue;
        const phrase = (result[0]?.transcript ?? "").trim();
        if (result.isFinal) {
          if (phrase !== "") {
            heard.current = appendSpeech(heard.current, phrase);
            handlers.current.onAppend?.(phrase);
          }
        } else if (result[0]) {
          live += result[0].transcript;
        }
      }
      setInterim(live.trim());
    };

    created.onerror = (event) => {
      const code = event?.error ?? "unknown";
      setError(
        code === "not-allowed" || code === "service-not-allowed"
          ? "The microphone is not available to this window, so nothing was recorded."
          : `Speech recognition stopped: ${code}.`,
      );
    };

    created.onend = () => {
      setListening(false);
      setInterim("");
      // When a recorder is also running, the recording owns the end of the take: it still has
      // the last chunk to flush, and hearing the words twice would be worse than waiting.
      if (!usedRecorder.current) void settle(null);
    };

    created.start();
    recognition.current = created;
    return true;
  }, [settle]);

  const stop = useCallback(() => {
    setListening(false);
    setInterim("");
    recognition.current?.stop();
    if (recorder.current?.state === "recording") recorder.current.stop();
    else if (!usedRecorder.current) void settle(null);
  }, [settle]);

  const toggle = useCallback(() => {
    if (listening) {
      stop();
      return;
    }

    heard.current = "";
    usedRecorder.current = false;
    settled.current = false;
    setNotice(undefined);
    setError(undefined);
    setInterim("");

    void (async () => {
      const dictated = startDictation();
      // Shown as soon as the recognizer is up, so the button never looks idle while the human
      // is already talking into it.
      if (dictated) setListening(true);

      const recorded = await startRecorder();
      if (!recorded.ok) {
        if (!dictated) {
          settled.current = true;
          setError(recorded.message);
          return;
        }
        // Dictation is working, so this is a footnote rather than a failure: the words are
        // arriving, but the recording they would have come with is not.
        setNotice("I can hear you, but this window would not let me keep the recording.");
      }

      setListening(true);
      stopTimer.current = window.setTimeout(stop, MAX_TAKE_MS);
    })();
  }, [listening, startDictation, startRecorder, stop]);

  return useMemo(
    () => ({
      capability,
      listening,
      interim,
      ...(notice !== undefined ? { notice } : {}),
      ...(error !== undefined ? { error } : {}),
      toggle,
    }),
    [capability, listening, interim, notice, error, toggle],
  );
}
