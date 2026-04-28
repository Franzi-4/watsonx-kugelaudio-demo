/**
 * Strip "Tag-Ons" — redundant echo questions that llama-3.3-70b habitually
 * appends after a real question. They wreck TTS prosody because the model
 * has to read them as a second intonational unit.
 *
 * Examples seen in the wild from this exact deployment:
 *   "Wo ist der Schaden, welcher Ort?"           → "Wo ist der Schaden?"
 *   "Wer ist beteiligt, also wer ist involviert?" → "Wer ist beteiligt?"
 *   "Wann war es, also wann genau?"               → "Wann war es?"
 *
 * Scope is intentionally narrow — only fix what the LLM demonstrably gets
 * wrong every turn, leave grammar (e.g. "Kann Sie") to the system prompt.
 * Aggressive cleanup → broken sentences → worse output. Be conservative.
 */

// Echo question after a comma + "also" (rephrasing) at end of string.
//   ", also wer ist involviert?"
//   ", also wann genau?"
const ALSO_TAG_ON = /,\s*also\s+(?:wer|wo|was|wann|wie|warum|welche[rs]?)\b[^.?!]{0,80}\?/giu;

// "..., welcher Ort?" / "..., welche Stelle?" tail at the end of the string.
// Anchored at $ so it only fires for trailing tag-ons, never mid-sentence —
// "Ich verstehe, welche Optionen es gibt." stays intact because there's no
// `?` ending it. Replaces the tag-on with `?` so the preceding clause keeps
// its question intonation.
const WELCHE_TAG_ON = /,\s*welche[rs]?\s+\w+\?$/iu;

// "ist passiert, was genau?" / "war es, was war es?" — short echo with
// "was" / "wann" / "wo" after a comma at end. Strict: ≤4 words to avoid
// eating substantive clauses like ", was wir auch tun könnten".
const SHORT_ECHO_TAG_ON = /,\s*(?:was|wann|wo|wie)\s+\w+(?:\s+\w+){0,3}\?$/iu;

/**
 * @param {string} text
 * @param {{ language?: string }} opts
 * @returns {string}
 */
export function cleanLlmText(text, { language = 'de' } = {}) {
  if (!text || typeof text !== 'string') return text;
  if (language !== 'de') return text;

  let out = text;

  // Pass 1: ", also wer/wo/was …?" tag-ons → drop, restore terminal `?`
  // on whatever question came before.
  out = out.replace(ALSO_TAG_ON, '?');

  // Pass 2: "…, welcher Ort?" at end → restore terminal `?` on preceding clause.
  out = out.replace(WELCHE_TAG_ON, '?');

  // Pass 3: trailing short echo (", was genau?")
  out = out.replace(SHORT_ECHO_TAG_ON, '?');

  // Tidy doubled question marks the passes can leave behind.
  out = out.replace(/\?\s*\?/g, '?');

  return out.trim();
}

export default cleanLlmText;
