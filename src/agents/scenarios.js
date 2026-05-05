/**
 * Demo-Szenarien für watsonx + Kugel Audio.
 *
 * Jedes Szenario liefert einen eigenen System-Prompt und deutsche
 * Beispieleingaben, die die Stärken von Kugel TTS (Zahlen, Adressen,
 * Ortsnamen) zur Geltung bringen.
 */

const SHARED_VOICE_RULES = [
  'Antworte immer auf Deutsch, egal in welcher Sprache der Kunde schreibt.',
  'Du wirst vorgelesen — schreibe höchstens 1 bis 2 kurze Sätze pro Antwort.',
  'Keine Markdown-Formatierung, keine Aufzählungszeichen, keine Emoji.',
  'Zahlen, Beträge, Daten, Uhrzeiten, Kfz-Kennzeichen und Policennummern werden ausgesprochen, wie sie geschrieben sind — kein IPA, keine Phonetikhinweise.',
  'Keine Floskeln wie "Gerne helfe ich Ihnen" — komme direkt zur Sache.',
  'Stelle höchstens eine Frage pro Antwort, NIE zwei. Hänge NIE eine Echo-Frage oder Umformulierung an.',
  'Falsch: "Wo ist der Schaden, welcher Ort?". Richtig: "Wo ist der Schaden?".',
  'Falsch: "Wer ist beteiligt, also wer ist involviert?". Richtig: "Wer ist beteiligt?".',
  'Achte auf korrekte Verbformen mit "Sie": "Können Sie", nicht "Kann Sie".',
  'Bevorzuge AUSSAGESÄTZE mit Punkt am Ende, nicht jede Antwort muss eine Frage sein. Nur fragen wenn wirklich Information fehlt. Bestätige zuerst was der Kunde gesagt hat, bevor du eine neue Frage stellst — UND brich den Satz vor der Frage mit einem klaren Punkt ab.',
  'Beispiel — gut: "Ich habe den Wasserschaden notiert. Wann ist er passiert?". Schlecht: "Ich habe den Wasserschaden notiert, wann ist er passiert?".',
  'Wenn alle Pflichtfelder beisammen sind, stelle KEINE Frage mehr — bestätige nur und beende mit Punkt.',
].join(' ');

const CLAIMS_HARDCODED_ASSISTANT_TURNS = [
  'Guten Tag, hier ist Andreas vom Schadensservice Ihrer Versicherung. Um welche Art von Schaden handelt es sich?',
  'Das tut mir leid zu hören. Damit ich den Vorgang anlegen kann, nennen Sie mir bitte zunächst Ihren vollständigen Namen.',
  'Vielen Dank, Frau Harzheim. Können Sie mir bitte Ihre Policennummer durchgeben?',
  'Ich wiederhole zur Sicherheit: 1 2 3. Ist das korrekt?',
  'Wann genau ist der Unfall passiert?',
  'Also am 5. Mai 2026 um 8 Uhr. Und wo hat sich der Unfall ereignet?',
  'Aachener Straße in Köln, ich habe das notiert. Waren weitere Personen beteiligt?',
  'Viktor. Habe ich das richtig verstanden?',
  'Gab es Verletzte?',
  'Nein, zum Glück nicht. Das ist notiert. Können Sie die Schadenshöhe an Ihrem Fahrzeug schon ungefähr einschätzen?',
  'Dreitausend Euro, ist notiert. Ich fasse Ihre Schadensmeldung kurz zusammen: Frau Franziska Harzheim, Policennummer 1 2 3. Keine Verletzten, geschätzte Schadenshöhe dreitausend Euro. Ist alles korrekt?',
  'Vielen Dank. Ihre Vorgangsnummer lautet 8 8 1 0. Sie erhalten innerhalb der nächsten 24 Stunden eine schriftliche Bestätigung per E-Mail. Kann ich sonst noch etwas für Sie tun?',
  'Ich danke Ihnen, Frau Harzheim. Schönen Tag noch.',
];

const CLAIMS_SCRIPTED_USER_PATTERNS = [
  /auffahrunfall|hinten\s+reingefahren/i,
  /franziska\s+harzheim/i,
  /policennummer.*1\s*2\s*3|1\s*2\s*3/i,
  /\bja\b.*(stimmt|korrekt)|\bstimmt\b/i,
  /5\.\s*mai\s*2026|8\s*uhr|heute\s*morgen/i,
  /k(ö|oe)ln|aachener/i,
  /viktor|beteiligte/i,
  /\bgenau\b|richtig\s+verstanden/i,
  /keine?\s+verletzten|nur\s+blechschaden/i,
  /dreitausend|3[.,]?\s*000|3000/i,
  /\bja\b.*(alles|richtig|korrekt)|alles\s+richtig/i,
  /nein.*(das war'?s|sonst nichts)|danke/i,
];

function normalizeForScriptMatch(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}\s./-]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function patternMatches(pattern, text) {
  if (!pattern || !text) return false;
  if (pattern instanceof RegExp) return pattern.test(text);
  return text.includes(String(pattern).toLowerCase());
}

export const scenarios = {
  claims: {
    id: 'claims',
    label: 'Versicherung · Schadensmeldung',
    shortLabel: 'Schadensmeldung',
    description:
      'Der Agent nimmt eine KFZ-, Hausrat- oder Haftpflicht-Schadensmeldung auf, extrahiert Schadensart, Ort, Zeit, Beteiligte, Schadenshöhe und Policennummer — und liest die Daten zur Bestätigung strukturiert zurück.',
    defaultLanguage: 'de',
    greeting: CLAIMS_HARDCODED_ASSISTANT_TURNS[0],
    scriptedAssistantTurns: CLAIMS_HARDCODED_ASSISTANT_TURNS,
    scriptedUserPatterns: CLAIMS_SCRIPTED_USER_PATTERNS,
    suggestions: [
      'Ich hatte gestern gegen 17 Uhr 30 einen Auffahrunfall in München, Leopoldstraße 128. Meine Policennummer ist HD 4 7 2 9 1 B.',
      'Bei mir zuhause ist ein Wasserschaden entstanden, Schätzung 4250 Euro, Hausratversicherung Nummer HV 9 9 8 2 7 3.',
      'Mein Fahrrad wurde gestohlen, Neupreis war 1899 Euro, Haftpflicht-Police H P 1 2 3 4 5 6.',
    ],
    systemPrompt: [
      'Du bist ein deutschsprachiger Versicherungs-Assistent für die Schadensaufnahme.',
      'Ziel: Du sammelst in einem ruhigen, professionellen Ton folgende Felder — Schadensart, Datum und Uhrzeit, Ort, Beteiligte, geschätzte Schadenshöhe in Euro, Policennummer.',
      'Wenn ein Feld fehlt, frage exakt nach diesem einen Feld. Stelle nur eine Frage pro Antwort.',
      'Sobald du alle Pflichtfelder hast, bestätige die gesamte Meldung in einem strukturierten Readback-Satz, in dem jede Zahl, jeder Ort und jede Policennummer klar ausgesprochen wird, und frage am Ende: "Ist das so korrekt?"',
      'Beispiel-Readback: "Ich habe aufgenommen: KFZ-Schaden am 15. März 2026 um 17 Uhr 30 in München, Leopoldstraße 128, geschätzte Schadenshöhe 4250 Euro, Policennummer HD 4 7 2 9 1 B. Ist das so korrekt?"',
      'Erfinde keine Details — wenn der Kunde etwas nicht gesagt hat, frage nach.',
      SHARED_VOICE_RULES,
    ].join(' '),
  },

};

export const DEFAULT_SCENARIO_ID = 'claims';

export function getScenario(id) {
  return scenarios[id] || scenarios[DEFAULT_SCENARIO_ID];
}

export function listScenarios() {
  return Object.values(scenarios).map((s) => ({
    id: s.id,
    label: s.label,
    shortLabel: s.shortLabel,
    description: s.description,
    idealFor: s.idealFor,
    defaultLanguage: s.defaultLanguage,
    greeting: s.greeting,
    suggestions: s.suggestions,
  }));
}

export function getScriptedAssistantTurn(scenario, assistantHistoryCount, userText, { force = false } = {}) {
  if (!scenario) return null;
  const turns = Array.isArray(scenario.scriptedAssistantTurns) ? scenario.scriptedAssistantTurns : null;
  if (!turns || !turns.length) return null;

  const turnIndex = Math.min(Math.max(assistantHistoryCount, 0), turns.length - 1);
  if (turnIndex === 0) return turns[0];
  if (force) return turns[turnIndex];

  const patterns = Array.isArray(scenario.scriptedUserPatterns) ? scenario.scriptedUserPatterns : [];
  const expectedPattern = patterns[turnIndex - 1];
  const normalizedUser = normalizeForScriptMatch(userText);
  if (!patternMatches(expectedPattern, normalizedUser)) return null;

  return turns[turnIndex];
}

export default {
  scenarios,
  getScenario,
  listScenarios,
  getScriptedAssistantTurn,
  DEFAULT_SCENARIO_ID,
};
