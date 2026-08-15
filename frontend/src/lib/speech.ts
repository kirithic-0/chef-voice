// Text-to-speech voice helper.
//
// window.speechSynthesis.getVoices() returns [] on the first call in many
// browsers (Chrome especially): the list is populated asynchronously and the
// browser fires a 'voiceschanged' event when it's ready. If we read voices
// synchronously on the very first spoken line, we either pick no preferred voice
// (falling back to the browser default) or the utterance is dropped entirely.
//
// So we warm a cache up front and refresh it on 'voiceschanged', and both spoken
// paths (speakLocal in App, speakWebSpeech in useVoiceChat) pick from the cache.

let cachedVoices: SpeechSynthesisVoice[] = [];

function refreshVoices() {
  try {
    if (typeof window === 'undefined' || !window.speechSynthesis) return;
    const v = window.speechSynthesis.getVoices();
    if (v && v.length) cachedVoices = v;
  } catch {
    /* ignore */
  }
}

if (typeof window !== 'undefined' && window.speechSynthesis) {
  refreshVoices();
  // Fires once the voice list finishes loading (and when it changes).
  window.speechSynthesis.addEventListener?.('voiceschanged', refreshVoices);
}

/**
 * Best available English voice, preferring a Google voice. Returns null if the
 * voice list hasn't loaded yet (the browser then uses its default voice).
 */
export function getPreferredVoice(): SpeechSynthesisVoice | null {
  // Fall back to a live read in case the cache is still cold.
  const voices =
    cachedVoices.length > 0
      ? cachedVoices
      : (typeof window !== 'undefined' && window.speechSynthesis?.getVoices()) || [];
  return (
    voices.find((v) => v.lang.startsWith('en') && v.name.includes('Google')) ||
    voices.find((v) => v.lang.startsWith('en')) ||
    null
  );
}
