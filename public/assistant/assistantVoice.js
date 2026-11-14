// shared/assistantVoice.js — ⭐ D190 P4 · VOICE for Tiny and Ask draft: the browser's own speech-to-text, then the same engine
// (a spoken "delete page 2" is the typed one). ⛔ MIRRORED byte-identical into resume-master at public/assistant/assistantVoice.js.
// Neither site's server hears the audio. Where the browser can recognise ON THIS DEVICE (Chrome's processLocally) it does;
// otherwise the browser's own speech service hears it, and the panel says so in plain words — never "no server" when there is one.

/** The browser's recogniser, or null (Firefox, older Safari). */
export function voiceSupported(w = globalThis) {
  return !!(w && (w.SpeechRecognition || w.webkitSpeechRecognition));
}

/**
 * Listen once. Resolves when listening starts: { stop, local } — `local` true when recognition runs on this device.
 *   onText(transcript) — the final words · onEnd(errorCode | null) — listening stopped
 */
export async function listenOnce({ onText, onEnd = () => {}, lang = null, w = globalThis } = {}) {
  const SR = w.SpeechRecognition || w.webkitSpeechRecognition;
  if (!SR) throw new Error("This browser has no speech input — type instead.");
  const r = new SR();
  r.lang = lang || w.navigator?.language || "en-US";
  r.interimResults = false;
  r.maxAlternatives = 1;
  let local = false;
  try {
    if (typeof SR.available === "function") {
      const st = await SR.available({ langs: [r.lang], processLocally: true });
      if (st === "available") { r.processLocally = true; local = true; }
    }
  } catch { local = false; }
  let ended = false;
  const end = (code) => { if (!ended) { ended = true; onEnd(code || null); } };
  r.onresult = (e) => { const t = e.results?.[0]?.[0]?.transcript || ""; if (t.trim()) onText(t.trim()); };
  r.onerror = (e) => end(e?.error || "error");
  r.onend = () => end(null);
  r.start();
  return { stop: () => { try { r.stop(); } catch { /* already stopped */ } }, local };
}

/** The one line the panels show beside the microphone. */
export function voiceNote(local) {
  return local ? "Listening on this device." : "Listening — your browser's speech service turns it into words; neither site hears the audio.";
}

export const VOICE_ERRORS = Object.freeze({
  "not-allowed": "The microphone is blocked — allow it in the browser's site settings, or type instead.",
  "no-speech": "I didn't hear anything — try again.",
  "audio-capture": "No microphone was found.",
  network: "The browser's speech service couldn't be reached — type instead.",
});
