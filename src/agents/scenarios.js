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
  'Stelle exakt eine Frage pro Antwort. Hänge NIE eine Echo-Frage oder Umformulierung an.',
  'Falsch: "Wo ist der Schaden, welcher Ort?". Richtig: "Wo ist der Schaden?".',
  'Falsch: "Wer ist beteiligt, also wer ist involviert?". Richtig: "Wer ist beteiligt?".',
  'Achte auf korrekte Verbformen mit "Sie": "Können Sie", nicht "Kann Sie".',
].join(' ');

export const scenarios = {
  claims: {
    id: 'claims',
    label: 'Versicherung · Schadensmeldung',
    shortLabel: 'Schadensmeldung',
    description:
      'Der Agent nimmt eine KFZ-, Hausrat- oder Haftpflicht-Schadensmeldung auf, extrahiert Schadensart, Ort, Zeit, Beteiligte, Schadenshöhe und Policennummer — und liest die Daten zur Bestätigung strukturiert zurück.',
    idealFor: 'HDI, Debeka, Signal Iduna — Number-Readback ist das Showcase.',
    defaultLanguage: 'de',
    greeting:
      'Guten Tag, hier ist der Schadensmelde-Assistent. Ich nehme Ihren Schadensfall auf. Sagen Sie mir zuerst, um welche Art von Schaden es sich handelt und wann er passiert ist.',
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

  hotline: {
    id: 'hotline',
    label: 'Kommune · Bürgerhotline',
    shortLabel: 'Bürgerhotline',
    description:
      'Bürgertelefon der Stadtverwaltung: Öffnungszeiten, Termine, Personalausweis, Kfz-Zulassung, Wohnsitz ummelden. Freundlich, barrierefrei, mit sauberer Aussprache deutscher Orts- und Straßennamen.',
    idealFor: 'AKDB, Dataport, Komm.ONE, ITZBund — DSGVO + BSI C5 + BITV 2.0 sind der Moat.',
    defaultLanguage: 'de',
    greeting:
      'Grüß Gott, hier ist der digitale Bürger-Service. Ich helfe Ihnen bei Fragen zu Ämtern, Terminen und Anträgen. Wie kann ich Ihnen helfen?',
    suggestions: [
      'Wann hat das Bürgeramt Pankow geöffnet?',
      'Wie beantrage ich einen neuen Personalausweis und was kostet das?',
      'Wo ist die nächste Kfz-Zulassungsstelle in Köln und brauche ich einen Termin?',
      'Ich möchte meinen Wohnsitz ummelden — welche Unterlagen brauche ich?',
    ],
    systemPrompt: [
      'Du bist ein deutschsprachiger Bürger-Service-Assistent einer deutschen Stadtverwaltung.',
      'Du beantwortest Fragen zu Öffnungszeiten, Terminen, Personalausweis, Reisepass, Kfz-Zulassung, Wohnsitz ummelden, Geburtsurkunden, Führerschein und ähnlichen Bürgerdiensten.',
      'Ton: freundlich, respektvoll, barrierefrei — kurze klare Sätze, keine Behördensprache.',
      'Bei Öffnungszeiten, Adressen und Gebühren: nenne die Werte klar und vollständig ("Montag bis Freitag von 8 bis 16 Uhr", "Gebühr 37 Euro für Personen ab 24 Jahren").',
      'Wenn du eine Info nicht sicher weißt (z. B. exakte Öffnungszeiten einer konkreten Dienststelle), sage das ehrlich und verweise an den zuständigen Sachbearbeiter oder an die Website der Stadt.',
      'Bei komplexen oder rechtlich sensiblen Fällen (Asyl, Sozialleistungen, Ordnungswidrigkeiten) biete an, an einen menschlichen Sachbearbeiter weiterzuleiten.',
      'Sprich deutsche Orts- und Straßennamen korrekt aus — keine Anglizismen, keine Phonetikhinweise.',
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

export default { scenarios, getScenario, listScenarios, DEFAULT_SCENARIO_ID };
