# Setup-Anleitung

Diese Anleitung beschreibt alle Schritte, um die Demo-Umgebung einzurichten.

## 1. Benoetigte API-Keys

| Dienst | Env-Variable | Beschreibung | Wo erstellen |
|---|---|---|---|
| **KugelAudio** | `KUGELAUDIO_API_KEY` | TTS (Text-to-Speech) | [kugelaudio.com](https://kugelaudio.com) |
| **Deepgram** | `DEEPGRAM_API_KEY` | STT (Speech-to-Text) | [console.deepgram.com](https://console.deepgram.com) |
| **LiveKit** | `LIVEKIT_URL` | WebRTC-Server URL (wss://...) | [cloud.livekit.io](https://cloud.livekit.io) |
| | `LIVEKIT_API_KEY` | LiveKit API Key | |
| | `LIVEKIT_API_SECRET` | LiveKit API Secret | |
| **watsonx Orchestrate** | `ORCHESTRATE_API_KEY` | IAM API Key | [cloud.ibm.com](https://cloud.ibm.com/iam/apikeys) |
| | `ORCHESTRATE_INSTANCE_URL` | Instanz-URL (z.B. `https://eu-de.watson-orchestrate.cloud.ibm.com`) | Orchestrate UI |
| | `ORCHESTRATE_AGENT_ID` | Agent-ID aus Orchestrate | Orchestrate UI > Settings > Agents |

Kopiere `.env.example` nach `.env` und trage die Werte ein:

```bash
cp .env.example .env
```

## 2. Agent in watsonx Orchestrate anlegen

Der Agent muss in der watsonx Orchestrate UI manuell angelegt werden. Die vollstaendige Konfiguration liegt unter `orchestrate/agents/schaden_meldung_assistant.agent.yaml`.

### 2.1 Neuen Agent erstellen

1. Orchestrate UI oeffnen > **AI Agents** > **Create Agent**
2. Folgende Werte eintragen:

| Feld | Wert |
|---|---|
| Name | `Schadensmeldungs-Assistent` |
| LLM | `groq/openai/gpt-oss-120b` |
| Style | `default` |
| Memory | deaktiviert |

### 2.2 Instructions (System-Prompt)

Den kompletten Instructions-Block aus dem YAML uebernehmen. Kernpunkte:

- Agent heisst **Anton**, spricht Deutsch, per Sie
- Nimmt genau **6 Felder** auf, eines pro Turn:
  1. Schadensart (Auto, Wohnung, Hausrat, Haftpflicht)
  2. Ort des Schadens
  3. Zeitpunkt (Datum + Uhrzeit)
  4. Beteiligte Personen / Fahrzeuge
  5. Geschaetzte Schadenshoehe in Euro
  6. Policennummer
- Am Ende: strukturierter **Readback** aller Angaben
- Nach Bestaetigung: Gespraech beenden
- Maximal 2 Saetze pro Antwort, kein Markdown

### 2.3 Guidelines

4 Guidelines im Orchestrate-UI anlegen:

| Guideline | Bedingung | Aktion |
|---|---|---|
| Empathie bei schweren Schaeden | Personenschaden, Brand, Einbruch | Beruhigenden Satz voranstellen |
| Fehlende Angabe ueberspringen | Kunde kann Feld nicht angeben | `nicht bekannt` notieren, weiterfahren |
| Themenfremde Abschweifung | Kunde schweift ab | Einmal zurueckfuehren, dann Eskalation |
| Abschluss und Readback | Alle 6 Felder erfasst | Zusammenfassung + Bestaetigungsfrage |

### 2.4 Knowledge Base

Eine Knowledge-Base-Datei hochladen:

- Datei: `knowledge/schadenverfahren.md`
- Beschreibt den vollstaendigen Schadenverfahren-Leitfaden inkl. Eskalationsregeln

### 2.5 Starter Prompts

3 Starter-Prompts konfigurieren:

1. "Ich moechte einen Autoschaden melden."
2. "Ich moechte einen Schaden in meiner Wohnung melden."
3. "Ich moechte einen Schaden melden, habe meine Policennummer aber gerade nicht zur Hand."

### 2.6 Welcome Message

> Guten Tag, ich bin Anton vom Schadensservice.

### 2.7 Agent-ID kopieren

Nach dem Speichern die **Agent-ID** aus der Orchestrate UI kopieren (Settings > Agents > ID) und in die `.env` eintragen als `ORCHESTRATE_AGENT_ID`.

## 3. App starten

```bash
npm install
npm start
```

Die App laeuft auf `http://localhost:3000`.
