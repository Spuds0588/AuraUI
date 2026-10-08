/// <reference types="vite/client" />

/**
 * The build-time knobs this canvas reads.
 *
 * Deliberately a short list. AuraUI is local-first, so nothing here is required and nothing
 * here is a secret: an unset variable means a feature is off, never that the app is broken.
 * Merging into Vite's own `ImportMetaEnv`, which the reference above brings into scope.
 */
interface ImportMetaEnv {
  /**
   * An OpenAI-compatible `/v1/audio/transcriptions` endpoint, for machines whose webview has
   * no speech recognizer of its own. Unset is supported: the voice button still records, and
   * the recording is sent instead of a transcript. A value in `localStorage` under
   * `auraui.stt.url` overrides this without a rebuild.
   */
  readonly VITE_AURAUI_STT_URL?: string;
  /** The model name to ask that endpoint for. Defaults to `whisper-1`. */
  readonly VITE_AURAUI_STT_MODEL?: string;
}
