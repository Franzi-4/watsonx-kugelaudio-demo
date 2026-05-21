const DAMAGE_PATTERNS = [
  {
    label: 'Personenschaden und Autoschaden',
    tests: [
      /\bpersonenschaden\b/i,
      /\bjemanden\s+umgefahren\b/i,
      /\bperson(?:en)?\s+(?:verletzt|angefahren)\b/i,
    ],
  },
  {
    label: 'Autoschaden',
    tests: [
      /\bauto(?:unfall|schaden)?\b/i,
      /\bautounfall\b/i,
      /\bblechschaden\b/i,
      /\bkfz\b/i,
      /\bwagen\b/i,
      /\bfahrzeug\b/i,
    ],
  },
];

const REPEATED_DAMAGE_TYPE_QUESTION =
  /(?:um\s+)?welche\s+art\s+von\s+schaden|schadensart|ist\s+es\s+tats(?:ä|ae)chlich\s+ein\s+schaden|schaden\s+an\s+ihrem\s+auto/i;

export function updateClaimStateFromUserText(session, userText) {
  if (!session.claimState) session.claimState = {};
  if (!userText || typeof userText !== 'string') return session.claimState;

  const detected = DAMAGE_PATTERNS
    .filter((entry) => entry.tests.some((pattern) => pattern.test(userText)))
    .map((entry) => entry.label);

  if (detected.includes('Personenschaden und Autoschaden')) {
    session.claimState.damageType = 'Personenschaden und Autoschaden';
  } else if (detected.includes('Autoschaden') && !session.claimState.damageType) {
    session.claimState.damageType = 'Autoschaden';
  }

  return session.claimState;
}

export function buildClaimStateInstruction(claimState = {}) {
  if (!claimState.damageType) return '';
  return [
    `BEREITS ERFASST: Schadensart = ${claimState.damageType}.`,
    'Frage NICHT mehr nach der Schadensart und bitte den Kunden NICHT, diese zu bestaetigen.',
    'Das naechste fehlende Feld ist der Ort des Schadens. Frage genau danach.',
  ].join('\n');
}

export function correctRepeatedDamageTypeQuestion(text, claimState = {}) {
  if (!claimState.damageType || !text || typeof text !== 'string') return text;
  if (!REPEATED_DAMAGE_TYPE_QUESTION.test(text)) return text;
  return `Ich habe ${claimState.damageType} notiert. Wo ist der Schaden passiert?`;
}

export default {
  updateClaimStateFromUserText,
  buildClaimStateInstruction,
  correctRepeatedDamageTypeQuestion,
};
