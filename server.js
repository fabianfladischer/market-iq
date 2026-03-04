import 'dotenv/config';
import express from 'express';
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import cron from 'node-cron';
import RSSParser from 'rss-parser';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;
const CACHE_DIR = join(__dirname, 'cache');
const REFRESH_COOLDOWN_MS = 30 * 60 * 1000;

let lastRefreshTime = 0;

// ─── Major Instruments (Yahoo Finance symbols) ────────────────────────────────

const MAJOR_INSTRUMENTS = [
  { name: 'EUR/USD',         symbol: 'EURUSD=X'  },
  { name: 'USD/JPY',         symbol: 'JPY=X'     },
  { name: 'GBP/USD',         symbol: 'GBPUSD=X'  },
  { name: 'USD/CHF',         symbol: 'CHF=X'     },
  { name: 'DXY (USD Index)', symbol: 'DX-Y.NYB'  },
  { name: 'S&P 500 (SPX)',   symbol: '^GSPC'     },
  { name: 'Nasdaq 100',      symbol: 'QQQ'       },
  { name: 'Dow Jones',       symbol: '^DJI'      },
  { name: 'DAX',             symbol: '^GDAXI'    },
  { name: 'STOXX 600',       symbol: '^STOXX'    },
  { name: 'VIX',             symbol: '^VIX'      },
  { name: 'US 10Y Yield',    symbol: '^TNX'      },
  { name: 'US 2Y Yield',     symbol: '^IRX'      },
  { name: 'Gold (XAU/USD)',  symbol: 'GC=F'      },
  { name: 'Silver',          symbol: 'SI=F'      },
  { name: 'Brent Crude',     symbol: 'BZ=F'      },
  { name: 'WTI Crude',       symbol: 'CL=F'      },
  { name: 'Bitcoin (BTC)',   symbol: 'BTC-USD'   },
  { name: 'EUR/GBP',         symbol: 'EURGBP=X'  },
];

// ─── Price Fetching (Yahoo Finance) ───────────────────────────────────────────

function formatPrice(symbol, price) {
  if (price == null) return '—';
  if (symbol === '^TNX' || symbol === '^IRX') return `${price.toFixed(3)}%`;
  if (symbol === '^VIX') return price.toFixed(2);
  if (symbol.includes('=X') || symbol === 'DX-Y.NYB') return price.toFixed(4);
  if (symbol === 'BTC-USD') return `$${Math.round(price).toLocaleString('en-US')}`;
  if (price >= 1000) return `$${price.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
  return `$${price.toFixed(2)}`;
}

async function fetchPrices(symbols) {
  if (!symbols.length) return {};
  try {
    const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(symbols.join(','))}`;
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json',
      },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return {};
    const data = await res.json();
    const prices = {};
    for (const q of (data.quoteResponse?.result || [])) {
      prices[q.symbol] = {
        price:  q.regularMarketPrice,
        change: q.regularMarketChangePercent,
      };
    }
    return prices;
  } catch {
    return {};
  }
}

// ─── RSS Feeds ────────────────────────────────────────────────────────────────

const RSS_FEEDS = [
  'http://feeds.bbci.co.uk/news/business/rss.xml',
  'http://feeds.bbci.co.uk/news/world/rss.xml',
  'https://www.cnbc.com/id/100727362/device/rss/rss.html',
  'https://www.cnbc.com/id/10001147/device/rss/rss.html',
  'http://feeds.marketwatch.com/marketwatch/topstories/',
  'https://finance.yahoo.com/rss/topfinstories',
  'https://feeds.reuters.com/reuters/businessNews',
  'https://feeds.reuters.com/reuters/topNews',
  'https://feeds.bloomberg.com/markets/news.rss',
  'https://www.theguardian.com/business/rss',
  'https://rss.nytimes.com/services/xml/rss/nyt/Business.xml',
  'https://www.ft.com/?format=rss',
];

// ─── RSS Fetching ─────────────────────────────────────────────────────────────

function stripHtml(str) {
  return (str || '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
}

function jaccardSimilarity(a, b) {
  const wordsA = new Set(a.toLowerCase().split(/\s+/).filter(w => w.length > 3));
  const wordsB = new Set(b.toLowerCase().split(/\s+/).filter(w => w.length > 3));
  if (wordsA.size === 0 && wordsB.size === 0) return 0;
  const intersection = [...wordsA].filter(w => wordsB.has(w)).length;
  const union = new Set([...wordsA, ...wordsB]).size;
  return union === 0 ? 0 : intersection / union;
}

async function fetchFeed(url) {
  const parser = new RSSParser({
    requestOptions: {
      headers: { 'User-Agent': 'MarketIQ/2.0 RSS Reader' },
    },
    timeout: 10000,
  });
  return parser.parseURL(url);
}

async function fetchNews() {
  const results = await Promise.allSettled(
    RSS_FEEDS.map(url =>
      Promise.race([
        fetchFeed(url),
        new Promise((_, reject) => setTimeout(() => reject(new Error('RSS timeout')), 10000)),
      ])
    )
  );

  const articles = [];
  for (const result of results) {
    if (result.status !== 'fulfilled') continue;
    const feed = result.value;
    for (const item of (feed.items || []).slice(0, 8)) {
      if (!item.title) continue;
      const snippet = stripHtml(
        item.contentSnippet || item.content || item.summary || ''
      ).substring(0, 300);

      // Jaccard deduplication
      const isDuplicate = articles.some(a => jaccardSimilarity(a.title, item.title) > 0.6);
      if (isDuplicate) continue;

      articles.push({
        title: item.title.trim(),
        snippet,
        source: feed.title || 'Unknown',
        pubDate: item.pubDate || item.isoDate || new Date().toISOString(),
        link: item.link || '',
      });
    }
  }

  // Sort by pubDate descending, take top 30
  articles.sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));
  const top30 = articles.slice(0, 30);

  if (top30.length < 5) throw new Error('Insufficient news data: only ' + top30.length + ' articles fetched');
  return top30;
}

// ─── System Prompt ────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `Du bist ein erfahrener Sell-Side Research Analyst und Derivatives Trader mit 15 Jahren Erfahrung. Du denkst in konkreten Instrumenten, Ticker-Symbolen, Kontrakten, Spreads und Griechen. Du erklärst wie jemand, der einem Junior Trader am Desk etwas beibringt — präzise, praxisnah, kein Textbuch-Geschwätz.

Du bekommst eine Liste aktueller Nachrichten. Erstelle daraus ein Quiz mit exakt 10 Headlines.

AUSWAHLREGELN:
- Wähle die 10 marktrelevantesten Headlines
- Priorität: Zentralbank-Entscheidungen > Makrodaten (NFP, CPI, PMI, GDP) > Earnings von Top-50-Firmen > Geopolitik mit Rohstoff-/Währungsimpact > Sektor-News
- IGNORIERE Headlines ohne klaren Bezug zu handelbaren Instrumenten
- Jede Headline MUSS mindestens 3 konkret betroffene Instrumente haben

Für JEDE der 10 Headlines erstelle VIER Fragen:

═══════════════════════════════════════
FRAGE 1 — "Instrument Impact" (📊)
═══════════════════════════════════════

Die Frage muss EXAKT so formuliert sein:
"Welches Finanzinstrument wird von dieser Nachricht am stärksten und direktesten beeinflusst?"

Jede Antwortoption MUSS enthalten:
- Exaktes Instrument mit Ticker/Name (z.B. "EUR/USD", "US 10Y Treasury Yield (TNX)", "S&P 500 (SPX)", "Brent Crude (BZ1!)", "Gold (XAU/USD)", "VIX", "USD/JPY", "Bitcoin (BTC/USD)", "Nasdaq 100 (QQQ)", "High Yield Spread (CDX HY)", "2Y/10Y Treasury Spread")
- Richtung mit konkreter Preisprognose, z.B. "EUR/USD steigt von 1.0850 auf ~1.0950" oder "SPX fällt um ~1.5% von aktuellem Niveau"
- KEIN vages Zeug wie "Aktien steigen" oder "Anleihen fallen"

Erklärungen (JEDE Option, 5-6 Sätze):
- RICHTIGE Antwort: Erkläre den kausalen Mechanismus Schritt für Schritt. Nenne konkrete Preisniveaus und Kursziele (nutze die mitgelieferten Marktpreise!). Erkläre den Zeithorizont (intraday, 1-3 Tage, 1 Woche). Erkläre warum andere Instrumente WENIGER stark reagieren.
- FALSCHE Antworten: Erkläre was an dieser Antwort FAST stimmt. Erkläre den konkreten Denkfehler. Erkläre was passieren müsste damit diese Antwort richtig wäre.

═══════════════════════════════════════
FRAGE 2 — "Impact Sizing" (📐)
═══════════════════════════════════════

Die Frage muss so formuliert sein:
"Wie groß schätzt du den kurzfristigen Marktimpact (innerhalb 24-48h) auf [HAUPTINSTRUMENT AUS FRAGE 1]?"

Antworoptionen sind konkrete Größenordnungen mit Preisniveaus basierend auf den aktuellen Kursen. Z.B. nicht "50-80 Pips" sondern "EUR/USD von 1.0847 auf 1.0900-1.0930 (+50-80 Pips)".
Berücksichtige: War das Event erwartet oder eine Überraschung? Liquidität? Historische Analogien? Bereits eingepreist?

Erklärungen (5-6 Sätze pro Option):
- Beziehe dich auf konkrete historische Vergleiche mit Daten: "Als die Fed im Sep 2024 überraschend 50bp senkte, stieg EUR/USD um 120 Pips intraday."
- Erkläre Volatilitätskontext: "Der 1-Monats-IV von EUR/USD liegt derzeit bei ~6%, was einem täglichen Expected Move von ~70 Pips entspricht."
- Erkläre eingepreist vs. Überraschung präzise.

═══════════════════════════════════════
FRAGE 3 — "Trading Strategy" (💰)
═══════════════════════════════════════

Die Frage muss so formuliert sein:
"Du willst von dieser Nachricht profitieren. Welche Strategie hat das beste Risiko/Rendite-Profil?"

Jede Antwortoption MUSS beschreiben:
- Exaktes Instrument (Ticker) mit aktuellem Preisniveau als Referenz
- Exakte Positionierung: Entry-Preis, Target, Stop-Loss
- R/R-Ratio (z.B. "Risk/Reward: 1:2.8")
- Bei Optionen: Strike-Logik, Laufzeit (30-60 DTE), Greeks (Delta, Theta, Vega), max. Verlust in $ oder %
- Bei Spreads: beide Legs mit Strikes, Nettodebit/-kredit

Erklärungen (7-8 Sätze pro Option):
- RICHTIGE Antwort: Entry begründen, Target-Logik erklären, Stop-Loss begründen, R/R berechnen, Greek-Analyse ("du hast Long Delta ~0.55, Theta kostet dich $X/Tag, Vega profitiert wenn IV steigt"), maximalen Verlust nennen, Edge gegenüber Alternativen erklären.
- FALSCHE Antworten: Erkläre warum die Strategie PLAUSIBEL klingt. Nenne den konkreten Fehler (z.B. "nackter Short Put: Margin-Anforderung $X, bei Gap-Down um 5% verlierst du $Y — das ist 8x die Prämie"). Erkläre das Worst-Case-Szenario in konkreten Zahlen.

═══════════════════════════════════════
FRAGE 4 — "Second-Order / Spillover" (🔗)
═══════════════════════════════════════

Die Frage muss so formuliert sein:
"Welcher indirekte Effekt dieser Nachricht wird von den meisten Marktteilnehmern UNTERSCHÄTZT?"

Fokus auf Cross-Asset Spillover, Zweitrundeneffekte, Supply-Chain-Kaskaden, Policy-Reaktionsketten, Positionierungseffekte.

Erklärungen (5-6 Sätze): Beschreibe die Kausalkette mit 4-5 Gliedern. Nenne konkrete betroffene Instrumente mit Preiswirkung. Erkläre warum der Markt das übersieht (Zeithorizont, Aufmerksamkeitsbias, Cross-Asset-Blindheit). Nenne historische Analogien.

═══════════════════════════════════════
SCHWIERIGKEITSGRAD
═══════════════════════════════════════

- Frage 1 (Instrument Impact): "beginner" oder "intermediate"
- Frage 2 (Impact Sizing): "intermediate" oder "advanced"
- Frage 3 (Trading Strategy): "advanced"
- Frage 4 (Second-Order): "intermediate" oder "advanced"

═══════════════════════════════════════
TAKEAWAY (pro Headline)
═══════════════════════════════════════

Nach jeder Headline: ein "takeaway" — eine allgemeingültige Lernregel in 1-2 Sätzen die über diese spezifische Nachricht hinaus gilt.

═══════════════════════════════════════
JSON SCHEMA
═══════════════════════════════════════

Antworte AUSSCHLIESSLICH mit validem JSON. Kein Markdown, keine Backticks, kein Text davor oder danach.

{
  "generated_at": "ISO-8601",
  "headlines": [
    {
      "id": 1,
      "headline": "...",
      "source": "Reuters / Bloomberg / CNBC / etc.",
      "context": "3-4 Sätze Kontext. Was ist passiert, was war die Erwartung, was ist die Überraschung.",
      "category": "central_bank|macro|earnings|geopolitical|commodities|sector|credit",
      "affected_instruments": [
        {"name": "EUR/USD", "symbol": "EURUSD=X"},
        {"name": "German 2Y Bund", "symbol": "^IRDE2YT=RR"},
        {"name": "STOXX 600 Banks ETF", "symbol": "SX7P.DE"}
      ],
      "takeaway": "Allgemeingültige Lernregel, 1-2 Sätze.",
      "instrument_impact": {
        "question": "Welches Finanzinstrument wird von dieser Nachricht am stärksten und direktesten beeinflusst?",
        "difficulty": "beginner|intermediate",
        "options": [
          {"id": "A", "text": "...", "correct": false, "explanation": "3-4 Sätze warum fast richtig aber nicht ganz..."},
          {"id": "B", "text": "...", "correct": false, "explanation": "..."},
          {"id": "C", "text": "EUR/USD steigt um 50-80 Pips", "correct": true, "explanation": "3-4 Sätze kausaler Mechanismus..."},
          {"id": "D", "text": "...", "correct": false, "explanation": "..."}
        ]
      },
      "impact_sizing": {
        "question": "Wie groß schätzt du den Impact auf [INSTRUMENT] innerhalb 24-48h?",
        "difficulty": "intermediate|advanced",
        "reference_instrument": "EUR/USD",
        "options": [
          {"id": "A", "text": "+80 bis +120 Pips (sehr großer Move)", "correct": false, "explanation": "..."},
          {"id": "B", "text": "+10 bis +30 Pips (moderater Move)", "correct": false, "explanation": "..."},
          {"id": "C", "text": "Kaum Bewegung, bereits eingepreist", "correct": false, "explanation": "..."},
          {"id": "D", "text": "+40 bis +70 Pips (großer Move)", "correct": true, "explanation": "Historischer Vergleich..."}
        ]
      },
      "trading_strategy": {
        "question": "Welche Strategie hat das beste Risiko/Rendite-Profil für diese Nachricht?",
        "difficulty": "advanced",
        "options": [
          {"id": "A", "text": "Naked Long Call auf FXE...", "correct": false, "explanation": "4-5 Sätze warum plausibel aber suboptimal..."},
          {"id": "B", "text": "Bull Call Spread auf FXE (Long 108C / Short 110C, 30 DTE)...", "correct": true, "explanation": "4-5 Sätze mit R/R Analyse, Greeks, Edge..."},
          {"id": "C", "text": "...", "correct": false, "explanation": "..."},
          {"id": "D", "text": "...", "correct": false, "explanation": "..."}
        ]
      },
      "second_order": {
        "question": "Welcher indirekte Effekt wird vom Markt am meisten unterschätzt?",
        "difficulty": "intermediate|advanced",
        "options": [
          {"id": "A", "text": "...", "correct": false, "explanation": "..."},
          {"id": "B", "text": "...", "correct": false, "explanation": "..."},
          {"id": "C", "text": "...", "correct": false, "explanation": "..."},
          {"id": "D", "text": "...", "correct": true, "explanation": "Kausalkette mit 3-4 Gliedern..."}
        ]
      }
    }
  ]
}

RICHTIGE ANTWORT — POSITION RANDOMISIEREN:
Die korrekte Antwort ("correct": true) MUSS über alle Fragen hinweg zufällig auf A, B, C oder D verteilt sein.
VERBOTEN: Die richtige Antwort immer auf Position A oder immer auf dieselbe Position zu setzen.
PFLICHT: Verteile die richtigen Antworten ungefähr gleichmäßig — z.B. Frage 1 → C, Frage 2 → A, Frage 3 → D, Frage 4 → B, usw.
Überprüfe vor dem Ausgeben: Sind "correct": true nicht alle auf A? Falls ja, verschiebe sie auf verschiedene Positionen.

QUALITÄTSCHECKS bevor du antwortest:
1. Jede Option nennt mindestens EIN konkretes Instrument mit Ticker
2. Jede Erklärung hat mindestens 3 Sätze
3. Falsche Antworten erklären warum sie FAST stimmen (nicht offensichtlich falsch)
4. Strategy-Frage: mindestens 2 der 4 Optionen sind Optionsstrategien mit Strike/Laufzeit-Logik
5. Impact Sizing: Zahlen sind realistisch mit historischem Vergleich
6. Takeaway gilt über den spezifischen Fall hinaus als allgemeine Marktregel
7. Richtige Antworten sind auf A, B, C, D verteilt — NICHT alle auf derselben Position`;

// ─── Groq API Call ────────────────────────────────────────────────────────────

async function generateQuizFromGroq(articles, majorPrices = {}) {
  const today = new Date().toISOString().split('T')[0];
  const articlesList = articles
    .map((a, i) => `${i + 1}. [${a.source}] ${a.title}\n   ${a.snippet}`)
    .join('\n\n');

  const pricesSection = MAJOR_INSTRUMENTS
    .filter(i => majorPrices[i.symbol]?.price != null)
    .map(i => {
      const p = majorPrices[i.symbol];
      const sign = p.change >= 0 ? '+' : '';
      return `  ${i.name}: ${formatPrice(i.symbol, p.price)} (${sign}${p.change.toFixed(2)}% heute)`;
    })
    .join('\n');

  const userPrompt = `Datum: ${today}

AKTUELLE MARKTPREISE — nutze diese in deinen Erklärungen für konkrete Preisniveaus und Kursziele:
${pricesSection || '  (Preise nicht verfügbar)'}

Aktuelle Nachrichten:
${articlesList}

Wähle 10 davon aus und generiere das Quiz-JSON. Referenziere wo passend die aktuellen Marktpreise in Erklärungen.`;

  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      response_format: { type: 'json_object' },
      max_tokens: 8000,
      temperature: 0.7,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Groq API error ${response.status}: ${errText}`);
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error('Empty Groq response');
  return JSON.parse(content);
}

// ─── Cache Helpers ────────────────────────────────────────────────────────────

function ensureCacheDir() {
  if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });
}

function getQuizFiles() {
  ensureCacheDir();
  return readdirSync(CACHE_DIR)
    .filter(f => f.startsWith('quiz_') && f.endsWith('.json'))
    .sort()
    .reverse(); // ISO timestamps sort correctly — newest first after reverse
}

function getLatestCachedQuiz() {
  const files = getQuizFiles();
  if (files.length === 0) return null;
  try {
    const content = JSON.parse(readFileSync(join(CACHE_DIR, files[0]), 'utf-8'));
    return { timestamp: content.cached_at, quiz: content.quiz };
  } catch {
    return null;
  }
}

function saveQuizToCache(quiz) {
  ensureCacheDir();
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `quiz_${ts}.json`;
  writeFileSync(
    join(CACHE_DIR, filename),
    JSON.stringify({ cached_at: new Date().toISOString(), quiz }, null, 2)
  );
  cleanupOldCaches();
}

function cleanupOldCaches(keep = 20) {
  const files = getQuizFiles();
  for (const file of files.slice(keep)) {
    try { unlinkSync(join(CACHE_DIR, file)); } catch {}
  }
}

// ─── Quiz Generation ──────────────────────────────────────────────────────────

async function generateQuiz() {
  console.log(`[${new Date().toISOString()}] Fetching RSS + market prices in parallel...`);
  const majorSymbols = MAJOR_INSTRUMENTS.map(i => i.symbol);
  const [articles, majorPrices] = await Promise.all([
    fetchNews(),
    fetchPrices(majorSymbols),
  ]);
  console.log(`[${new Date().toISOString()}] ${articles.length} articles, ${Object.keys(majorPrices).length} prices. Calling Groq...`);

  const quiz = await generateQuizFromGroq(articles, majorPrices);

  // Fetch prices for affected instruments mentioned in the quiz
  const quizSymbols = new Set();
  for (const hl of (quiz.headlines || [])) {
    for (const inst of (hl.affected_instruments || [])) {
      if (inst?.symbol) quizSymbols.add(inst.symbol);
    }
  }
  const allPrices = { ...majorPrices };
  if (quizSymbols.size > 0) {
    const extra = await fetchPrices([...quizSymbols]);
    Object.assign(allPrices, extra);
  }

  // Embed prices into affected_instruments
  for (const hl of (quiz.headlines || [])) {
    for (const inst of (hl.affected_instruments || [])) {
      if (inst?.symbol && allPrices[inst.symbol]) {
        inst.price  = allPrices[inst.symbol].price;
        inst.change = allPrices[inst.symbol].change;
      }
    }
  }

  // Add market snapshot
  quiz.market_snapshot = MAJOR_INSTRUMENTS
    .map(i => ({ ...i, ...(majorPrices[i.symbol] || {}) }))
    .filter(i => i.price != null);
  quiz.prices_at = new Date().toISOString();

  saveQuizToCache(quiz);
  lastRefreshTime = Date.now();
  console.log(`[${new Date().toISOString()}] Quiz generated and cached.`);
  return quiz;
}

// ─── Express Middleware ───────────────────────────────────────────────────────

app.use(express.static(join(__dirname, 'public')));

// ─── API Routes ───────────────────────────────────────────────────────────────

app.get('/api/quiz', async (req, res) => {
  const wantsRefresh = req.query.refresh === 'true';

  if (wantsRefresh) {
    const now = Date.now();
    const elapsed = now - lastRefreshTime;
    if (lastRefreshTime > 0 && elapsed < REFRESH_COOLDOWN_MS) {
      const cooldownRemaining = Math.ceil((REFRESH_COOLDOWN_MS - elapsed) / 60000);
      const cached = getLatestCachedQuiz();
      return res.json({
        ...(cached?.quiz ?? {}),
        cached: true,
        cooldown_remaining: cooldownRemaining,
      });
    }

    try {
      const quiz = await generateQuiz();
      return res.json({ ...quiz, cached: false });
    } catch (err) {
      console.error(`[${new Date().toISOString()}] Refresh failed:`, err.message);
      const cached = getLatestCachedQuiz();
      if (cached) return res.json({ ...cached.quiz, cached: true });
      return res.status(500).json({ error: 'generation_failed', message: err.message });
    }
  }

  // No refresh — serve cache or generate fresh
  const cached = getLatestCachedQuiz();
  if (cached) return res.json({ ...cached.quiz, cached: true });

  try {
    const quiz = await generateQuiz();
    return res.json({ ...quiz, cached: false });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Generation failed:`, err.message);
    return res.status(500).json({ error: 'generation_failed', message: err.message });
  }
});

app.get('/api/quiz/history', (_req, res) => {
  const files = getQuizFiles();
  const history = files.map(filename => {
    try {
      const content = JSON.parse(readFileSync(join(CACHE_DIR, filename), 'utf-8'));
      return { timestamp: content.cached_at, filename };
    } catch {
      return { timestamp: null, filename };
    }
  });
  res.json(history);
});

app.get('/api/health', (_req, res) => {
  const cached = getLatestCachedQuiz();
  const files = getQuizFiles();
  res.json({
    status: 'ok',
    cached: !!cached,
    latest_cache: cached?.timestamp ?? null,
    cache_count: files.length,
    vienna_time: new Date().toLocaleString('de-AT', { timeZone: 'Europe/Vienna' }),
  });
});

if (process.env.NODE_ENV !== 'production') {
  app.delete('/api/cache', (_req, res) => {
    try {
      const files = getQuizFiles();
      files.forEach(f => unlinkSync(join(CACHE_DIR, f)));
      lastRefreshTime = 0;
      res.json({ message: `Deleted ${files.length} cache files` });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}

// GET /api/prices — live price refresh for frontend
app.get('/api/prices', async (req, res) => {
  const requested = (req.query.symbols || '').split(',').filter(Boolean);
  const symbols = requested.length > 0 ? requested : MAJOR_INSTRUMENTS.map(i => i.symbol);
  const prices = await fetchPrices(symbols);
  res.json({ prices, fetched_at: new Date().toISOString() });
});

// ─── Cron: 06:00 Vienna ───────────────────────────────────────────────────────

cron.schedule('0 6 * * *', async () => {
  console.log(`[CRON ${new Date().toISOString()}] Generating daily quiz...`);
  try {
    await generateQuiz();
    console.log('[CRON] Daily quiz cached successfully.');
  } catch (err) {
    console.error('[CRON] Failed:', err.message);
  }
}, { timezone: 'Europe/Vienna' });

// ─── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`
  ╔═══════════════════════════════════╗
  ║       MarketIQ Server v2          ║
  ╠═══════════════════════════════════╣
  ║  URL:   http://localhost:${PORT}     ║
  ║  LLM:   Groq llama-3.3-70b        ║
  ║  Data:  RSS feeds (12 sources)    ║
  ║  Cron:  06:00 Europe/Vienna       ║
  ║  Cache: cache/quiz_*.json         ║
  ╚═══════════════════════════════════╝
`);
});
