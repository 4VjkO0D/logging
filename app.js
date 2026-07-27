// ---------------------------------------------------------------------------
// Road to 80 — storage helpers
// ---------------------------------------------------------------------------
const APP_VERSION = 'v1.0';
const LS = {
  settings: 'cl_settings',
  foods: 'cl_foods',
  batches: 'cl_batches',
  logs: 'cl_logs',
  chat: 'cl_chat',
};

function loadJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw);
  } catch (e) {
    return fallback;
  }
}
function saveJSON(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}
function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function nowTimeStr() {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
function fmtDateLabel(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  return date.toLocaleDateString('sv-SE', { weekday: 'long', day: 'numeric', month: 'long' });
}

let settings = Object.assign(
  { dailyLimit: 2000, proxyUrl: '', proxyToken: '', model: 'deepseek-v4-flash', voiceLang: 'sv-SE' },
  loadJSON(LS.settings, {})
);
let foods = loadJSON(LS.foods, []);       // {id, name, calsPerGram}
let batches = loadJSON(LS.batches, []);   // {id, name, ingredients:[{name,grams,calsPerGram}], totalGrams, totalCals, portionType}
let logs = loadJSON(LS.logs, []);         // {id, date, time, description, grams, calories, type, refId}
let chatHistory = loadJSON(LS.chat, []);  // {role: 'user'|'assistant', content}

function persistAll() {
  saveJSON(LS.settings, settings);
  saveJSON(LS.foods, foods);
  saveJSON(LS.batches, batches);
  saveJSON(LS.logs, logs);
}
function persistChat() {
  saveJSON(LS.chat, chatHistory);
}

// ---------------------------------------------------------------------------
// Tab navigation
// ---------------------------------------------------------------------------
const tabs = document.querySelectorAll('.tab');
const views = document.querySelectorAll('.view');
tabs.forEach(tab => {
  tab.addEventListener('click', () => {
    tabs.forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    const target = tab.dataset.view;
    views.forEach(v => v.hidden = (v.id !== `view-${target}`));
    if (target === 'today') renderToday();
    if (target === 'add') renderChatMessages();
    if (target === 'batches') renderBatches();
    if (target === 'foods') renderFoods();
    if (target === 'history') renderHistory();
    if (target === 'settings') renderSettings();
  });
});

// ---------------------------------------------------------------------------
// DeepSeek proxy call
// ---------------------------------------------------------------------------
// Tool definition for AI-driven web search (resolved server-side by proxy.php via Serper.dev).
const WEB_SEARCH_TOOL = {
  type: 'function',
  function: {
    name: 'web_search',
    description: 'Sök på webben efter kalori-/näringsvärden. Använd när du INTE tillförlitligt känner till kalorivärdet själv — t.ex. för specifika varumärken, färdigrätter, restaurangmenyer eller ovanliga produkter. Använd INTE för vanliga råvaror eller mat du redan känner till väl.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Sökfråga på svenska eller engelska, t.ex. "IKEA köttbullar kalorier per 100 gram"' },
      },
      required: ['query'],
    },
  },
};

async function callDeepSeekJSON(systemPrompt, userPrompt) {
  if (!settings.proxyUrl || !settings.proxyToken) {
    throw new Error('Ställ in proxy-URL och token under Inställningar först.');
  }
  const res = await fetch(settings.proxyUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Proxy-Token': settings.proxyToken,
    },
    body: JSON.stringify({
      model: settings.model || 'deepseek-v4-flash',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      tools: [WEB_SEARCH_TOOL],
      temperature: 0.2,
    }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`Proxy/DeepSeek-fel (${res.status}): ${t.slice(0, 200)}`);
  }
  const data = await res.json();
  let content = data?.choices?.[0]?.message?.content || '';
  return extractJson(content);
}

// Some AI responses (especially after a tool round-trip) may wrap the JSON in a stray
// sentence despite instructions. Try a direct parse first, then fall back to pulling out
// the first {...} or [...] block before giving up.
function extractJson(content) {
  let text = (content || '').trim().replace(/^```json/i, '').replace(/^```/, '').replace(/```$/, '').trim();
  try {
    return JSON.parse(text);
  } catch (e) {
    // fall through to extraction
  }
  const objMatch = text.match(/\{[\s\S]*\}/);
  const arrMatch = text.match(/\[[\s\S]*\]/);
  let candidate = null;
  if (objMatch && arrMatch) {
    candidate = objMatch.index <= arrMatch.index ? objMatch[0] : arrMatch[0];
  } else {
    candidate = (objMatch && objMatch[0]) || (arrMatch && arrMatch[0]) || null;
  }
  if (candidate) {
    try {
      return JSON.parse(candidate);
    } catch (e) {
      // fall through
    }
  }
  throw new Error('Kunde inte tolka AI-svaret som JSON: ' + text.slice(0, 200));
}

// Finds "KLART:" anywhere in a message (the model doesn't always put it as the very
// first characters, e.g. "Toppen! KLART: [...]") and returns the parsed payload after it.
// Throws if there's a KLART: marker but the payload after it can't be parsed as JSON.
function extractKlarPayload(raw) {
  const match = raw.match(/KLART:/i);
  if (!match) return null;
  const after = raw.slice(match.index + match[0].length);
  return extractJson(after);
}

async function callDeepSeekRaw(systemPrompt, historyMessages) {
  if (!settings.proxyUrl || !settings.proxyToken) {
    throw new Error('Ställ in proxy-URL och token under Inställningar först.');
  }
  const res = await fetch(settings.proxyUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Proxy-Token': settings.proxyToken,
    },
    body: JSON.stringify({
      model: settings.model || 'deepseek-v4-flash',
      messages: [
        { role: 'system', content: systemPrompt },
        ...historyMessages.map(m => ({ role: m.role, content: m.content })),
      ],
      tools: [WEB_SEARCH_TOOL],
      temperature: 0.2,
    }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`Proxy/DeepSeek-fel (${res.status}): ${t.slice(0, 200)}`);
  }
  const data = await res.json();
  return (data?.choices?.[0]?.message?.content || '').trim();
}

// Simple local helpers so obvious matches never need to touch the AI at all
function extractGrams(text) {
  const m = text.match(/(\d+(?:[.,]\d+)?)\s*(gram|g)\b/i);
  if (m) return parseFloat(m[1].replace(',', '.'));
  const m2 = text.match(/(\d+(?:[.,]\d+)?)/);
  return m2 ? parseFloat(m2[1].replace(',', '.')) : null;
}
function findFoodMatch(text) {
  const lower = text.toLowerCase();
  return foods.find(f =>
    lower.includes(f.name.toLowerCase()) ||
    (f.altName && lower.includes(f.altName.toLowerCase()))
  );
}
// Exact (not substring) match by either name, used for prefill in forms/datalists.
function matchFoodByExactName(text) {
  const t = (text || '').trim().toLowerCase();
  if (!t) return null;
  return foods.find(f =>
    f.name.toLowerCase() === t ||
    (f.altName && f.altName.toLowerCase() === t)
  ) || null;
}

function savedFoodsForPrompt() {
  return foods.map(f => ({
    name: f.name,
    altName: f.altName || undefined,
    calsPerGram: Math.round(f.calsPerGram * 100) / 100,
  }));
}

function buildIngredientDensitySystem() {
  return `Du är en assistent som uppskattar kaloritäthet i livsmedel. Svara ENDAST med ett JSON-objekt, ingen övrig text:
{"valid": boolean, "calsPerGram": number}

Sätt "valid" till false om texten inte rimligen beskriver ett ätbart livsmedel/ingrediens. Gissa då inget, sätt calsPerGram till 0.

Användarens sparade livsmedel (använd EXAKT dessa värden om ett omnämnt livsmedel matchar "name" ELLER "altName" — de är två namn på samma sparade livsmedel):
${JSON.stringify(savedFoodsForPrompt())}

Om inget matchar, avgör enligt denna REGEL (inte efter hur säker du "känner dig"): om namnet innehåller ett varumärke, en butiks-/kedjeprodukt eller en specifik förpackad produkt (t.ex. "IKEA köttbullar", "Snickers", "ICA Basic kycklingfilé") — använd ALLTID verktyget web_search för att slå upp exakt värde innan du svarar. Annars, om det är en vanlig råvara utan varumärke (t.ex. "kyckling", "ris", "broccoli"), ge en rimlig uppskattning direkt ur din egen kunskap utan att söka.`;
}

// Fixed contract between the AI and the app's parser — not user-editable, always appended.
const CHAT_PROTOCOL = `Svarsformat (följ alltid, oavsett hur du resonerar):
- Om du behöver mer information eller bara konverserar: svara ENDAST med kort, naturlig svensk text. Ingen JSON, inget prefix.
- När du har en rimlig uppskattning för ALLA livsmedel som nämnts i samtalet (namn, gram, källa) — även om vissa detaljer är antagna snarare än exakta: svara ENDAST med den bokstavliga texten "KLART:" direkt följt av en JSON-array, utan något annat före eller efter, utan markdown-taggar. Exakt format:
[{"name": string, "grams": number, "caloriesTotal": number, "calsPerGram": number, "source": "sparat livsmedel" | "AI-uppskattning" | "webbsökning"}]
- När du behöver fråga användaren om ett val mellan flera alternativ (t.ex. tillagningsgrad på kyckling/kött/ris/pasta) — fråga KORT på svenska, och lägg därefter EXAKT på en egen rad: VAL:{"fråga":"din fråga här","alternativ":["Alternativ 1","Alternativ 2","..."]} Exempel: VAL:{"fråga":"Hur var kycklingen tillagad?","alternativ":["Rå/otillagad","Stekt i panna","Ugnsbakad","Kokt","Grillad"]}. Använd bara VAL: för val som MÄRKBART påverkar kalorierna. Blanda aldrig VAL: med KLART: i samma svar.
- Blanda aldrig fritext och JSON i samma svar.`;

// User-editable reasoning style — how cautious/chatty the AI is, when it asks follow-ups, etc.
const DEFAULT_CHAT_INSTRUCTIONS = `Så här ska du resonera:
1. Om det användaren skriver inte rimligen är en beskrivning av mat eller dryck (t.ex. "ja", "hej", eller annat obegripligt), anta ALDRIG att det är mat — fråga istället kort vad de menar eller vad de åt.
2. Om mängd (gram/antal) saknas för något som nämnts, fråga efter det EN gång. Om användaren svarar att de inte vet, inte mätte, eller liknande — fråga INTE igen. Gör då direkt en rimlig standarduppskattning (t.ex. typisk vikt för den varan) och gå vidare, och nämn kort vilket antagande du gjorde.
3. Använd VAL:-formatet (se Svarsformat ovan) för att ge användaren knappar när tillagningsgrad MÄRKBART påverkar kalorierna. Fråga ALDRIG i vanlig text om sådana val. Följ denna kategoriserade logik:

   Kräver VAL: med råt/kokt + metod (två steg, andra steget om relevant):
   - Fettrikt kött (fläsk, bacon, lamm, anka, korv) – 20–50%+ skillnad
   - Fet fisk (lax, makrill) – 10–15% skillnad

   Kräver VAL: med råt/kokt, metod mindre kritisk:
   - Magert kött/fisk (kyckling, kalkon, torsk) – 15–30% skillnad

   Kräver VAL: endast råt/kokt (enkel fråga, relevanta alternativ):
   - Stärkelserika rotfrukter (potatis, sötpotatis, majs) – 10–20% skillnad
   - Baljväxter (bönor, linser) – 60–70% skillnad (vattenupptag)
   - Spannmål (ris, pasta, havre) – 60–70% skillnad (vattenupptag)
   - Svamp – 25–60% ökning (vattenförlust, metod påverkar något)

   Kräver INGET VAL: (gör en rimlig uppskattning direkt)
   - Vanliga grönsaker (paprika, gurka, broccoli, zucchini, tomat) – <10% skillnad
   - Bladgrönsaker (spinat, mangold, sallad) – ~0% per 100g (samma kaloritäthet)
   - Frukt – ~0%
   - Ägg – <5%
   - Nötter/frön – <10%
   - Mejeri – ej tillämpligt

   Exempel VAL: för svamp: VAL:{"fråga":"Hur var svampen tillagad?","alternativ":["Rå","Kokt/stekt i panna","Grillad/ugnsbakad"]}
   Exempel VAL: för kyckling: VAL:{"fråga":"Hur var kycklingen tillagad?","alternativ":["Rå/otillagad","Stekt i panna","Ugnsbakad","Kokt","Grillad"]}
   Exempel VAL: för ris: VAL:{"fråga":"Var riset kokt eller otillagat?","alternativ":["Kokt","Rå/otillagat"]}

4. Fråga ALDRIG om detaljer som knappt påverkar kalorierna (t.ex. exakt smak på en glass eller godis, märke på liknande produkter) — gör bara en rimlig uppskattning för sånt direkt.
5. Ställ som mest EN uppföljningsfråga per svar, och bara om den faktiskt behövs för att kunna ge en rimlig kaloriuppskattning. Fråga aldrig igen om något du redan frågat om i det här samtalet — använd det användaren redan sagt, eller gör en uppskattning.`;

function buildChatSystem() {
  const instructions = settings.chatInstructions || DEFAULT_CHAT_INSTRUCTIONS;
  return `Du är en vänlig assistent i en kaloriloggnings-app. Du hjälper användaren logga vad de ätit genom ett samtal på svenska.

Användarens sparade livsmedel (använd EXAKT dessa kcal/gram-värden om ett omnämnt livsmedel matchar "name" ELLER "altName" här — de är två namn på samma sparade livsmedel — gissa då inte annat):
${JSON.stringify(savedFoodsForPrompt())}

Du har tillgång till verktyget web_search. Använd denna konkreta REGEL för när du ska söka (lita inte på hur säker du "känner dig" — den känslan är opålitlig):
- Om något som nämnts innehåller ett varumärke, en butiks-/kedjeprodukt, en restaurang-/snabbmatsrätt, eller en specifik förpackad produkt (t.ex. "IKEA köttbullar", "Snickers", "Marabou", "McDonald's", "ICA Basic kycklingfilé") — använd ALLTID web_search innan du ger ett kalorivärde för det, oavsett om du tror dig veta svaret.
- Annars, för vanliga råvaror eller hemlagad mat utan varumärke (t.ex. "kyckling", "ris", "äpple") — uppskatta direkt själv utan att söka.

${instructions}

${CHAT_PROTOCOL}`;
}

// ---------------------------------------------------------------------------
// Voice input (Web Speech API) — manual toggle: tap to start, tap to stop
// ---------------------------------------------------------------------------
// Recording NEVER stops until the user taps the button.
// Uses continuous=false in a loop — each utterance gets a fresh instance,
// which gives clean single results (no duplication). When an utterance ends,
// if the user hasn't tapped stop, a new instance starts immediately.
const SpeechRecognitionImpl = window.SpeechRecognition || window.webkitSpeechRecognition;

function setupVoiceInput(inputEl, btnEl, statusEl) {
  if (!SpeechRecognitionImpl) {
    btnEl.disabled = true;
    statusEl.textContent = 'Röstinmatning stöds inte i den här webbläsaren.';
    return;
  }
  let currentRecognition = null;
  let currentToken = 0; // increments per instance; lets us ignore stale events from a superseded instance
  let restartTimer = null;
  let listening = false;
  let finalTranscript = '';

  // Errors that mean "give up, don't restart" — genuinely fatal.
  const FATAL_ERRORS = new Set(['not-allowed', 'service-not-allowed', 'network']);
  // Errors that are just normal chatter from the restart-loop workaround
  // (Android fires 'no-speech' very eagerly on brief pauses, and 'aborted'
  // fires whenever we or the browser cut an instance short) — these should
  // just lead to a restart, not a full stop.

  function stopForGood(message) {
    listening = false;
    if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
    btnEl.classList.remove('listening');
    btnEl.classList.remove('recording');
    statusEl.textContent = message || '';
  }

  function startInstance() {
    if (!listening) return;
    currentToken += 1;
    const token = currentToken;
    const rec = new SpeechRecognitionImpl();
    rec.continuous = false;
    rec.interimResults = true;
    rec.lang = settings.voiceLang || 'sv-SE';

    let instanceFatalError = null;

    rec.onresult = (e) => {
      if (token !== currentToken) return; // stale instance, ignore
      // continuous=false ⇒ exactly one result per event.
      const result = e.results[0];
      const text = result[0].transcript;
      if (result.isFinal) {
        finalTranscript += text;
        inputEl.value = finalTranscript;
      } else {
        inputEl.value = finalTranscript + text;
      }
    };
    rec.onerror = (err) => {
      if (token !== currentToken) return; // stale instance, ignore
      if (FATAL_ERRORS.has(err.error)) {
        instanceFatalError = err.error;
        const msgs = {
          'not-allowed': 'Mikrofonen tilläts inte. Kontrollera webbläsarens behörigheter.',
          'service-not-allowed': 'Röstigenkänning är blockerad. Kontrollera webbläsarens behörigheter.',
          'network': 'Nätverksfel — röstigenkänning kräver internet.',
        };
        stopForGood(msgs[err.error] || 'Ett fel uppstod: ' + err.error);
      }
      // Transient errors (no-speech, aborted): do nothing here — onend
      // fires right after and the normal restart logic below takes care of it.
    };
    rec.onend = () => {
      if (token !== currentToken) return; // stale instance, ignore
      currentRecognition = null;
      if (!listening || instanceFatalError) {
        // User stopped or a fatal error occurred — final cleanup already done.
        return;
      }
      // Still recording — restart with a fresh instance after a short delay.
      // The delay lets Android fully release the mic first; restarting
      // instantly is what causes the same words to get captured twice.
      restartTimer = setTimeout(() => {
        restartTimer = null;
        startInstance();
      }, 300);
    };

    currentRecognition = rec;
    try {
      rec.start();
    } catch (e) {
      // start() can throw if called too soon after a previous instance;
      // retry shortly rather than silently dying.
      if (listening && token === currentToken) {
        restartTimer = setTimeout(() => { restartTimer = null; startInstance(); }, 300);
      }
    }
  }

  btnEl.addEventListener('click', () => {
    if (listening) {
      // User tapped to stop — abort and don't restart.
      currentToken += 1; // invalidate any in-flight instance
      listening = false;
      if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
      if (currentRecognition) {
        try { currentRecognition.abort(); } catch (e) { /* ignore */ }
        currentRecognition = null;
      }
      btnEl.classList.remove('listening');
      btnEl.classList.remove('recording');
      if (finalTranscript) {
        inputEl.value = finalTranscript;
      }
      statusEl.textContent = '';
      return;
    }

    // User tapped to start.
    finalTranscript = '';
    inputEl.value = '';
    listening = true;
    btnEl.classList.add('listening');
    btnEl.classList.add('recording');
    statusEl.textContent = 'Spelar in — tryck igen för att stoppa';
    startInstance();
  });
}

setupVoiceInput(document.getElementById('chat-input'), document.getElementById('chat-mic-btn'), document.getElementById('chat-mic-status'));

// ---------------------------------------------------------------------------
// TODAY view
// ---------------------------------------------------------------------------
function todaysLogs() {
  const t = todayStr();
  return logs.filter(l => l.date === t).sort((a, b) => (a.time < b.time ? 1 : -1));
}

function renderToday() {
  document.getElementById('today-date-label').textContent = fmtDateLabel(todayStr());
  const todays = todaysLogs();
  const consumed = todays.reduce((s, l) => s + l.calories, 0);
  const limit = settings.dailyLimit || 0;
  const remaining = limit - consumed;

  const dialNumber = document.getElementById('dial-remaining');
  dialNumber.textContent = Math.round(remaining);
  dialNumber.classList.toggle('over', remaining < 0);

  const circumference = 540.4;
  const progress = document.getElementById('dial-progress');
  const fraction = limit > 0 ? Math.min(consumed / limit, 1) : 0;
  progress.style.strokeDashoffset = circumference * (1 - fraction);
  progress.style.stroke = consumed > limit ? getComputedStyle(document.documentElement).getPropertyValue('--brick') : getComputedStyle(document.documentElement).getPropertyValue('--pine');

  document.getElementById('dial-consumed').textContent = `${Math.round(consumed)} kcal loggat`;
  document.getElementById('dial-limit').textContent = `mål ${limit} kcal`;

  // quick log chips = saved batches
  const row = document.getElementById('quicklog-row');
  row.innerHTML = '';
  batches.forEach(b => {
    const chip = document.createElement('button');
    chip.className = 'chip';
    chip.textContent = b.name;
    chip.addEventListener('click', () => openBatchLogModal(b.id));
    row.appendChild(chip);
  });

  const list = document.getElementById('today-log-list');
  list.innerHTML = '';
  document.getElementById('today-empty').hidden = todays.length > 0;
  todays.forEach(l => {
    const li = document.createElement('li');
    li.className = 'log-item';
    li.innerHTML = `
      <div class="log-item-main">
        <span class="log-item-name">${escapeHtml(l.description)}</span>
        <span class="log-item-meta">${l.time} · ${l.grams ? Math.round(l.grams) + ' g' : ''}</span>
      </div>
      <span class="log-item-cals mono">${Math.round(l.calories)} kcal</span>
      <button class="icon-btn" data-del="${l.id}" title="Ta bort">✕</button>
    `;
    list.appendChild(li);
  });
  list.querySelectorAll('[data-del]').forEach(btn => {
    btn.addEventListener('click', () => {
      if (!confirm('Ta bort den här loggen?')) return;
      logs = logs.filter(l => l.id !== btn.dataset.del);
      persistAll();
      renderToday();
    });
  });
}

// Auto-add a food item to foods if it doesn't already exist.
function refreshFoodDatalist() {
  let dl = document.getElementById('food-options');
  if (!dl) {
    dl = document.createElement('datalist');
    dl.id = 'food-options';
    document.body.appendChild(dl);
  }
  dl.innerHTML = foods.map(f => `<option value="${escapeHtml(f.name)}">`
    + (f.altName ? `<option value="${escapeHtml(f.altName)}">` : '')).join('');
}

function autoSaveFood(name, grams, calories) {
  if (!name || grams <= 0 || calories <= 0) return;
  const calsPerGram = calories / grams;
  const existing = foods.find(f =>
    f.name.toLowerCase() === name.toLowerCase() ||
    (f.altName && f.altName.toLowerCase() === name.toLowerCase())
  );
  if (!existing) {
    foods.push({ id: uid(), name, calsPerGram });
    persistAll();
    refreshFoodDatalist();
  }
}

function addLog(entry) {
  const fullEntry = Object.assign({
    id: uid(),
    date: todayStr(),
    time: nowTimeStr(),
  }, entry);
  logs.push(fullEntry);
  persistAll();
  // Auto-save to foods
  autoSaveFood(fullEntry.description, fullEntry.grams, fullEntry.calories);
  renderToday();
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&', '<': '<', '>': '>', '"': '"', "'": '&#39;' }[c]));
}

// ---------------------------------------------------------------------------
// AI CHAT mode — the only logging method
// ---------------------------------------------------------------------------
const chatMessagesEl = document.getElementById('chat-messages');
const chatInputEl = document.getElementById('chat-input');
const chatPendingEl = document.getElementById('chat-pending');
const chatPendingItemsEl = document.getElementById('chat-pending-items');
let chatPendingDraft = [];

function renderChatMessages() {
  chatMessagesEl.innerHTML = '';
  chatHistory.forEach(m => {
    if (m.role === 'assistant') {
      const raw = m.content;
      const isKlar = /KLART:/i.test(raw);

      // Detect VAL: marker — strip it from displayed text
      let displayText = raw;
      let valData = null;
      const valMatch = raw.match(/VAL:\s*(\{[\s\S]*?\})/);
      if (valMatch) {
        try {
          valData = JSON.parse(valMatch[1]);
          displayText = raw.replace(valMatch[0], '').trim();
        } catch (e) {
          // Invalid VAL JSON — show as normal text
        }
      }

      const div = document.createElement('div');
      div.className = `chat-msg ${m.role}`;
      div.textContent = isKlar
        ? 'Här är vad jag uppfattade — kolla sammanställningen nedan.'
        : displayText || raw;
      chatMessagesEl.appendChild(div);

      // Render choice buttons if VAL: data was found
      if (valData && valData.alternativ && Array.isArray(valData.alternativ)) {
        const choiceArea = document.createElement('div');
        choiceArea.className = 'chat-choice-area';
        valData.alternativ.forEach(alt => {
          const btn = document.createElement('button');
          btn.className = 'choice-btn';
          btn.textContent = alt;
          btn.addEventListener('click', () => {
            handleChoiceClick(alt);
          });
          choiceArea.appendChild(btn);
        });
        chatMessagesEl.appendChild(choiceArea);
      }
    } else {
      const div = document.createElement('div');
      div.className = `chat-msg ${m.role}`;
      div.textContent = m.content;
      chatMessagesEl.appendChild(div);
    }
  });
  chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
}

function renderChatPending() {
  if (chatPendingDraft.length === 0) {
    chatPendingEl.hidden = true;
    return;
  }
  chatPendingEl.hidden = false;
  chatPendingItemsEl.innerHTML = '';
  chatPendingDraft.forEach((item, idx) => {
    const row = document.createElement('div');
    row.className = 'pending-row';
    row.innerHTML = `
      <label class="field-label">${escapeHtml(item.name)}
        <span class="source-badge ${item.source === 'sparat livsmedel' ? 'saved' : item.source === 'webbsökning' ? 'web' : ''}">${escapeHtml(item.source || 'AI-uppskattning')}</span>
      </label>
      <label class="field-label grams-field">Gram <input type="number" class="mono pend-grams" data-idx="${idx}" value="${Math.round(item.grams)}"></label>
      <label class="field-label grams-field">kcal <input type="number" class="mono pend-cals" data-idx="${idx}" value="${Math.round(item.caloriesTotal)}"></label>
    `;
    chatPendingItemsEl.appendChild(row);
  });
  chatPendingItemsEl.querySelectorAll('.pend-grams').forEach(inp => {
    inp.addEventListener('input', (e) => {
      chatPendingDraft[e.target.dataset.idx].grams = parseFloat(e.target.value) || 0;
    });
  });
  chatPendingItemsEl.querySelectorAll('.pend-cals').forEach(inp => {
    inp.addEventListener('input', (e) => {
      chatPendingDraft[e.target.dataset.idx].caloriesTotal = parseFloat(e.target.value) || 0;
    });
  });
}

document.getElementById('chat-log-btn').addEventListener('click', () => {
  // Log each item individually
  chatPendingDraft.forEach(item => {
    addLog({ description: item.name, grams: item.grams, calories: item.caloriesTotal, type: 'chat' });
  });

  // Auto-create a "rätt" (batch) from the group
  if (chatPendingDraft.length >= 1) {
    const now = new Date();
    const hh = String(now.getHours()).padStart(2, '0');
    const mm = String(now.getMinutes()).padStart(2, '0');
    const batchName = `Måltid ${hh}:${mm}`;
    const ingredients = chatPendingDraft.map(item => ({
      name: item.name,
      grams: item.grams,
      calsPerGram: item.grams > 0 ? item.caloriesTotal / item.grams : 0,
    }));
    const totalGrams = ingredients.reduce((s, i) => s + i.grams, 0);
    const totalCals = ingredients.reduce((s, i) => s + i.grams * i.calsPerGram, 0);
    batches.push({
      id: uid(),
      name: batchName,
      ingredients,
      totalGrams,
      totalCals,
      portionType: 'variable',
      createdAt: Date.now(),
    });
    persistAll();
  }

  chatPendingDraft = [];
  renderChatPending();
  chatHistory.push({ role: 'assistant', content: 'Loggat! Säg till om du åt något mer.' });
  persistChat();
  renderChatMessages();
});

document.getElementById('chat-reset-btn').addEventListener('click', () => {
  if (chatHistory.length && !confirm('Rensa hela chatten?')) return;
  chatHistory = [];
  chatPendingDraft = [];
  persistChat();
  renderChatMessages();
  renderChatPending();
});

async function sendChatMessage() {
  const text = chatInputEl.value.trim();
  if (!text) return;
  chatHistory.push({ role: 'user', content: text });
  persistChat();
  renderChatMessages();
  chatInputEl.value = '';

  const sendBtn = document.getElementById('chat-send-btn');
  sendBtn.disabled = true;
  sendBtn.textContent = '...';
  try {
    const raw = await callDeepSeekRaw(buildChatSystem(), chatHistory);
    chatHistory.push({ role: 'assistant', content: raw });
    persistChat();
    renderChatMessages();
    try {
      const items = extractKlarPayload(raw);
      if (items) {
        chatPendingDraft = items.filter(i => i && i.name && i.grams > 0);
        renderChatPending();
      }
    } catch (e) {
      chatHistory.push({ role: 'assistant', content: 'Kunde inte tolka sammanställningen från AI:n. Kan du säga det igen, gärna lite enklare?' });
      persistChat();
      renderChatMessages();
    }
  } catch (err) {
    chatHistory.push({ role: 'assistant', content: 'Fel: ' + err.message });
    persistChat();
    renderChatMessages();
  } finally {
    sendBtn.disabled = false;
    sendBtn.textContent = 'Skicka';
  }
}
document.getElementById('chat-send-btn').addEventListener('click', sendChatMessage);
chatInputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); sendChatMessage(); }
});

// Handle when user taps a VAL: choice button
async function handleChoiceClick(choice) {
  // Add the choice as a user message
  chatHistory.push({ role: 'user', content: choice });
  persistChat();
  renderChatMessages();

  const sendBtn = document.getElementById('chat-send-btn');
  sendBtn.disabled = true;
  const origText = sendBtn.textContent;
  sendBtn.textContent = '...';
  try {
    const raw = await callDeepSeekRaw(buildChatSystem(), chatHistory);
    chatHistory.push({ role: 'assistant', content: raw });
    persistChat();
    renderChatMessages();
    try {
      const items = extractKlarPayload(raw);
      if (items) {
        chatPendingDraft = items.filter(i => i && i.name && i.grams > 0);
        renderChatPending();
      }
    } catch (e) {
      chatHistory.push({ role: 'assistant', content: 'Kunde inte tolka sammanställningen från AI:n. Kan du säga det igen, gärna lite enklare?' });
      persistChat();
      renderChatMessages();
    }
  } catch (err) {
    chatHistory.push({ role: 'assistant', content: 'Fel: ' + err.message });
    persistChat();
    renderChatMessages();
  } finally {
    sendBtn.disabled = false;
    sendBtn.textContent = origText;
  }
}

// ---------------------------------------------------------------------------
// BATCHES view
// ---------------------------------------------------------------------------
function renderBatches() {
  const list = document.getElementById('batch-list');
  list.innerHTML = '';
  document.getElementById('batch-empty').hidden = batches.length > 0;
  batches.forEach(b => {
    const density = b.totalGrams > 0 ? b.totalCals / b.totalGrams : 0;
    const metaText = b.portionType === 'fixed'
      ? `Fast portion · ${Math.round(b.totalCals)} kcal totalt`
      : `${Math.round(b.totalGrams)} g totalt · ${density.toFixed(2)} kcal/g`;
    const li = document.createElement('li');
    li.className = 'card-item';
    li.innerHTML = `
      <div class="log-item-main">
        <span class="log-item-name">${escapeHtml(b.name)}</span>
        <span class="log-item-meta">${metaText}</span>
      </div>
      <button class="btn-small" data-view="${b.id}">Visa</button>
      <button class="btn-small" data-log="${b.id}">Logga</button>
      <button class="icon-btn" data-del="${b.id}" title="Ta bort">✕</button>
    `;
    list.appendChild(li);
  });
  list.querySelectorAll('[data-view]').forEach(btn => btn.addEventListener('click', () => openBatchDetail(btn.dataset.view)));
  list.querySelectorAll('[data-log]').forEach(btn => btn.addEventListener('click', () => openBatchLogModal(btn.dataset.log)));
  list.querySelectorAll('[data-del]').forEach(btn => btn.addEventListener('click', () => {
    if (!confirm('Ta bort den här rätten?')) return;
    batches = batches.filter(b => b.id !== btn.dataset.del);
    persistAll();
    renderBatches();
  }));
}

// --- New batch modal ---
const batchModal = document.getElementById('batch-modal');
let batchDraftIngredients = [];
let batchDraftPortionType = 'variable';

document.getElementById('new-batch-btn').addEventListener('click', () => {
  batchDraftIngredients = [];
  batchDraftPortionType = 'variable';
  document.getElementById('batch-name').value = '';
  document.getElementById('batch-ingredients').innerHTML = '';
  document.querySelectorAll('#batch-portion-toggle .seg').forEach(b => b.classList.toggle('active', b.dataset.portion === 'variable'));
  addIngredientRow();
  updateBatchTotal();
  batchModal.hidden = false;
});
document.getElementById('batch-cancel-btn').addEventListener('click', () => batchModal.hidden = true);
document.getElementById('batch-portion-toggle').addEventListener('click', (e) => {
  const btn = e.target.closest('.seg');
  if (!btn) return;
  document.querySelectorAll('#batch-portion-toggle .seg').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  batchDraftPortionType = btn.dataset.portion;
});

function addIngredientRow() {
  const idx = batchDraftIngredients.length;
  batchDraftIngredients.push({ name: '', grams: 0, calsPerGram: 0 });
  const wrap = document.getElementById('batch-ingredients');
  const row = document.createElement('div');
  row.className = 'ingredient-row';
  row.dataset.idx = idx;
  row.innerHTML = `
    <label class="field-label">Ingrediens
      <input type="text" class="ing-name" list="food-options" placeholder="t.ex. broccoli">
    </label>
    <label class="field-label grams-field">Gram
      <input type="number" class="ing-grams mono">
    </label>
    <label class="field-label grams-field">kcal/100g
      <input type="number" step="1" class="ing-density mono">
    </label>
    <button class="btn-small ing-ai" type="button">AI</button>
    <button class="remove-ing" type="button">✕</button>
  `;
  document.getElementById('batch-ingredients').appendChild(row);

  const nameEl = row.querySelector('.ing-name');
  const gramsEl = row.querySelector('.ing-grams');
  const densityEl = row.querySelector('.ing-density');

  nameEl.addEventListener('input', () => {
    batchDraftIngredients[idx].name = nameEl.value;
    const match = matchFoodByExactName(nameEl.value);
    if (match) {
      densityEl.value = Math.round(match.calsPerGram * 100);
      batchDraftIngredients[idx].calsPerGram = match.calsPerGram;
    }
    updateBatchTotal();
  });
  gramsEl.addEventListener('input', () => {
    batchDraftIngredients[idx].grams = parseFloat(gramsEl.value) || 0;
    updateBatchTotal();
  });
  densityEl.addEventListener('input', () => {
    batchDraftIngredients[idx].calsPerGram = (parseFloat(densityEl.value) || 0) / 100;
    updateBatchTotal();
  });
  row.querySelector('.ing-ai').addEventListener('click', async () => {
    const name = nameEl.value.trim();
    if (!name) { alert('Skriv ett namn på ingrediensen först.'); return; }

    const savedMatch = matchFoodByExactName(name);
    if (savedMatch) {
      densityEl.value = Math.round(savedMatch.calsPerGram * 100);
      batchDraftIngredients[idx].calsPerGram = savedMatch.calsPerGram;
      updateBatchTotal();
      return;
    }

    const aiBtn = row.querySelector('.ing-ai');
    aiBtn.disabled = true;
    aiBtn.textContent = '...';
    try {
      const result = await callDeepSeekJSON(buildIngredientDensitySystem(), name);
      if (result.valid === false) {
        alert('Kunde inte tolka "' + name + '" som ett livsmedel. Skriv gärna tydligare.');
        return;
      }
      densityEl.value = Math.round(result.calsPerGram * 100);
      batchDraftIngredients[idx].calsPerGram = result.calsPerGram;
      updateBatchTotal();
    } catch (err) {
      alert(err.message);
    } finally {
      aiBtn.disabled = false;
      aiBtn.textContent = 'AI';
    }
  });
  row.querySelector('.remove-ing').addEventListener('click', () => {
    row.remove();
    batchDraftIngredients[idx] = null;
    updateBatchTotal();
  });
}
document.getElementById('batch-add-ingredient').addEventListener('click', addIngredientRow);

function updateBatchTotal() {
  const valid = batchDraftIngredients.filter(Boolean);
  const totalGrams = valid.reduce((s, i) => s + (i.grams || 0), 0);
  const totalCals = valid.reduce((s, i) => s + (i.grams || 0) * (i.calsPerGram || 0), 0);
  document.getElementById('batch-total').textContent = `Totalt: ${Math.round(totalGrams)} g · ${Math.round(totalCals)} kcal`;
}

document.getElementById('batch-save-btn').addEventListener('click', () => {
  const name = document.getElementById('batch-name').value.trim();
  const valid = batchDraftIngredients.filter(Boolean).filter(i => i.name && i.grams > 0);
  if (!name || valid.length === 0) { alert('Ge rätten ett namn och minst en ingrediens med gram.'); return; }
  const totalGrams = valid.reduce((s, i) => s + i.grams, 0);
  const totalCals = valid.reduce((s, i) => s + i.grams * i.calsPerGram, 0);
  batches.push({ id: uid(), name, ingredients: valid, totalGrams, totalCals, portionType: batchDraftPortionType, createdAt: Date.now() });
  persistAll();
  batchModal.hidden = true;
  renderBatches();
});

// --- Log a batch ---
const batchLogModal = document.getElementById('batch-log-modal');
let batchBeingLogged = null;

function openBatchLogModal(batchId) {
  const b = batches.find(x => x.id === batchId);
  if (!b) return;

  if (b.portionType === 'fixed') {
    addLog({ description: b.name, grams: b.totalGrams, calories: b.totalCals, type: 'batch', refId: b.id });
    return;
  }

  batchBeingLogged = b;
  document.getElementById('batch-log-title').textContent = `Logga: ${b.name}`;
  document.getElementById('batch-log-grams').value = '';
  document.getElementById('batch-log-preview').textContent = '';
  batchLogModal.hidden = false;
}
document.getElementById('batch-log-cancel').addEventListener('click', () => batchLogModal.hidden = true);
document.getElementById('batch-log-grams').addEventListener('input', (e) => {
  if (!batchBeingLogged) return;
  const g = parseFloat(e.target.value) || 0;
  const density = batchBeingLogged.totalGrams > 0 ? batchBeingLogged.totalCals / batchBeingLogged.totalGrams : 0;
  document.getElementById('batch-log-preview').textContent = `≈ ${Math.round(g * density)} kcal`;
});
document.getElementById('batch-log-confirm').addEventListener('click', () => {
  if (!batchBeingLogged) return;
  const g = parseFloat(document.getElementById('batch-log-grams').value) || 0;
  if (g <= 0) { alert('Ange gram.'); return; }
  const density = batchBeingLogged.totalGrams > 0 ? batchBeingLogged.totalCals / batchBeingLogged.totalGrams : 0;
  addLog({ description: batchBeingLogged.name, grams: g, calories: g * density, type: 'batch', refId: batchBeingLogged.id });
  batchLogModal.hidden = true;
});

// --- Batch detail / edit modal ---
const batchDetailModal = document.getElementById('batch-detail-modal');
let batchDetailId = null;

function openBatchDetail(batchId) {
  const b = batches.find(x => x.id === batchId);
  if (!b) return;
  batchDetailId = b.id;
  document.getElementById('batch-detail-name').value = b.name;
  renderBatchDetailIngredients(b);
  batchDetailModal.hidden = false;
}

function renderBatchDetailIngredients(b) {
  const container = document.getElementById('batch-detail-ingredients');
  container.innerHTML = '';
  b.ingredients.forEach(ing => {
    const row = document.createElement('div');
    row.className = 'ingredient-row';
    const calPerGram = ing.calsPerGram || 0;
    const cals = Math.round((ing.grams || 0) * calPerGram);
    row.innerHTML = `
      <span class="field-label" style="flex:2;margin:0;">
        ${escapeHtml(ing.name)}
        <span class="log-item-meta">${Math.round(ing.grams)} g · ${cals} kcal · ${(calPerGram * 100).toFixed(0)} kcal/100g</span>
      </span>
    `;
    container.appendChild(row);
  });
  const totalGrams = b.ingredients.reduce((s, i) => s + (i.grams || 0), 0);
  const totalCals = b.ingredients.reduce((s, i) => s + (i.grams || 0) * (i.calsPerGram || 0), 0);
  document.getElementById('batch-detail-total').textContent = `Totalt: ${Math.round(totalGrams)} g · ${Math.round(totalCals)} kcal`;
}

document.getElementById('batch-detail-cancel-btn').addEventListener('click', () => {
  batchDetailModal.hidden = true;
  batchDetailId = null;
});
document.getElementById('batch-detail-save-btn').addEventListener('click', () => {
  const newName = document.getElementById('batch-detail-name').value.trim();
  if (!newName) { alert('Namnet får inte vara tomt.'); return; }
  const idx = batches.findIndex(b => b.id === batchDetailId);
  if (idx === -1) return;
  batches[idx].name = newName;
  persistAll();
  batchDetailModal.hidden = true;
  batchDetailId = null;
  renderBatches();
});

// ---------------------------------------------------------------------------
// FOODS view
// ---------------------------------------------------------------------------
function renderFoods() {
  refreshFoodDatalist();
  const list = document.getElementById('food-list');
  list.innerHTML = '';
  document.getElementById('food-empty').hidden = foods.length > 0;
  foods.forEach(f => {
    const li = document.createElement('li');
    li.className = 'card-item';
    li.innerHTML = `
      <div class="log-item-main">
        <span class="log-item-name">${escapeHtml(f.name)}${f.altName ? ' <span class="muted small">· ' + escapeHtml(f.altName) + '</span>' : ''}</span>
        <span class="log-item-meta">${f.calsPerGram.toFixed(2)} kcal/g</span>
      </div>
      <button class="icon-btn" data-del="${f.id}" title="Ta bort">✕</button>
    `;
    list.appendChild(li);
  });
  list.querySelectorAll('[data-del]').forEach(btn => btn.addEventListener('click', () => {
    if (!confirm('Ta bort det här livsmedlet?')) return;
    foods = foods.filter(f => f.id !== btn.dataset.del);
    persistAll();
    renderFoods();
  }));
}

const foodModal = document.getElementById('food-modal');
document.getElementById('new-food-btn').addEventListener('click', () => {
  document.getElementById('food-name').value = '';
  document.getElementById('food-altname').value = '';
  document.getElementById('food-per100').value = '';
  document.getElementById('food-density-preview').textContent = '';
  document.getElementById('barcode-status').textContent = '';
  stopBarcodeScanner();
  foodModal.hidden = false;
});
document.getElementById('food-cancel-btn').addEventListener('click', () => {
  stopBarcodeScanner();
  foodModal.hidden = true;
});
function updateFoodDensityPreview() {
  const per100 = parseFloat(document.getElementById('food-per100').value) || 0;
  document.getElementById('food-density-preview').textContent = per100 > 0 ? `= ${(per100 / 100).toFixed(3)} kcal/g` : '';
}
document.getElementById('food-per100').addEventListener('input', updateFoodDensityPreview);
document.getElementById('food-save-btn').addEventListener('click', () => {
  const name = document.getElementById('food-name').value.trim();
  const altName = document.getElementById('food-altname').value.trim();
  const per100 = parseFloat(document.getElementById('food-per100').value) || 0;
  if (!name || per100 <= 0) { alert('Fyll i namn och kalorier per 100 gram.'); return; }
  foods.push({ id: uid(), name, altName: altName || null, calsPerGram: per100 / 100 });
  persistAll();
  stopBarcodeScanner();
  foodModal.hidden = true;
  renderFoods();
});

// ---------------------------------------------------------------------------
// Barcode scanning (native BarcodeDetector) + Open Food Facts lookup
// ---------------------------------------------------------------------------
const barcodeScannerEl = document.getElementById('barcode-scanner');
const barcodeVideoEl = document.getElementById('barcode-video');
const barcodeStatusEl = document.getElementById('barcode-status');
let barcodeStream = null;
let barcodeDetectLoopId = null;

function setBarcodeStatus(msg, isError) {
  barcodeStatusEl.textContent = msg || '';
  barcodeStatusEl.style.color = isError ? 'var(--brick)' : 'var(--pine)';
}

function stopBarcodeScanner() {
  if (barcodeDetectLoopId) { cancelAnimationFrame(barcodeDetectLoopId); barcodeDetectLoopId = null; }
  if (barcodeStream) { barcodeStream.getTracks().forEach(t => t.stop()); barcodeStream = null; }
  barcodeVideoEl.srcObject = null;
  barcodeScannerEl.hidden = true;
}

async function startBarcodeScanner() {
  if (!('BarcodeDetector' in window)) {
    setBarcodeStatus('Streckkodsskanning stöds inte i den här webbläsaren/enheten.', true);
    return;
  }
  try {
    barcodeStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
  } catch (e) {
    setBarcodeStatus('Kunde inte komma åt kameran: ' + e.message, true);
    return;
  }
  barcodeVideoEl.srcObject = barcodeStream;
  await barcodeVideoEl.play();
  barcodeScannerEl.hidden = false;
  setBarcodeStatus('Rikta kameran mot streckkoden...');

  const detector = new window.BarcodeDetector({
    formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128'],
  });

  const loop = async () => {
    if (!barcodeStream) return;
    try {
      const codes = await detector.detect(barcodeVideoEl);
      if (codes.length > 0) {
        const value = codes[0].rawValue;
        stopBarcodeScanner();
        lookupBarcode(value);
        return;
      }
    } catch (e) {
      // ignore transient detect errors (e.g. frame not ready yet)
    }
    barcodeDetectLoopId = requestAnimationFrame(loop);
  };
  barcodeDetectLoopId = requestAnimationFrame(loop);
}

document.getElementById('barcode-scan-btn').addEventListener('click', startBarcodeScanner);
document.getElementById('barcode-cancel-btn').addEventListener('click', () => {
  stopBarcodeScanner();
  setBarcodeStatus('');
});

async function lookupBarcode(code) {
  setBarcodeStatus(`Slår upp streckkod ${code}...`);
  try {
    const res = await fetch(`https://se.openfoodfacts.org/api/v2/product/${encodeURIComponent(code)}.json?fields=product_name,brands,nutriments`);
    if (!res.ok) throw new Error('Nätverksfel (' + res.status + ')');
    const data = await res.json();
    if (data.status !== 1 || !data.product) {
      setBarcodeStatus('Hittade ingen produkt för streckkod ' + code + '. Fyll i manuellt istället.', true);
      return;
    }
    const p = data.product;
    const nutr = p.nutriments || {};
    let kcalPer100 = nutr['energy-kcal_100g'];
    if (kcalPer100 == null && nutr['energy_100g'] != null) {
      // energy_100g is in kJ if no kcal value is given — convert.
      kcalPer100 = nutr['energy_100g'] / 4.184;
    }
    if (!p.product_name && !kcalPer100) {
      setBarcodeStatus('Produkten hittades men saknar namn och kalorivärde. Fyll i manuellt.', true);
      return;
    }
    const fullName = [p.brands, p.product_name].filter(Boolean).join(' ') || p.product_name || ('Produkt ' + code);
    document.getElementById('food-name').value = fullName;
    if (kcalPer100) {
      document.getElementById('food-per100').value = Math.round(kcalPer100);
      updateFoodDensityPreview();
    }
    if (!kcalPer100) {
      setBarcodeStatus('Hittade "' + fullName + '" men den saknar kaloriuppgift — fyll i kcal/100g manuellt.', true);
    } else {
      setBarcodeStatus('Hittade "' + fullName + '" · ' + Math.round(kcalPer100) + ' kcal/100g. Kontrollera och spara.');
    }
  } catch (e) {
    setBarcodeStatus('Kunde inte slå upp streckkoden: ' + e.message, true);
  }
}

// ---------------------------------------------------------------------------
// HISTORY view
// ---------------------------------------------------------------------------
function renderHistory() {
  const byDate = {};
  logs.forEach(l => { byDate[l.date] = (byDate[l.date] || 0) + l.calories; });
  const dates = Object.keys(byDate).sort().reverse().slice(0, 30);

  const list = document.getElementById('history-day-list');
  list.innerHTML = '';
  dates.forEach(d => {
    const li = document.createElement('li');
    li.className = 'card-item';
    const over = byDate[d] > (settings.dailyLimit || Infinity);
    li.innerHTML = `
      <div class="log-item-main">
        <span class="log-item-name">${fmtDateLabel(d)}</span>
      </div>
      <span class="log-item-cals mono" style="color:${over ? 'var(--brick)' : 'var(--pine-dark)'}">${Math.round(byDate[d])} kcal</span>
    `;
    list.appendChild(li);
  });

  // chart: last 14 days, chronological
  const chartDates = dates.slice(0, 14).reverse();
  const svg = document.getElementById('history-chart');
  svg.innerHTML = '';
  const limit = settings.dailyLimit || 0;
  const maxVal = Math.max(limit, ...chartDates.map(d => byDate[d]), 1);
  const w = 320, h = 140, padBottom = 18, barGap = 4;
  const barWidth = chartDates.length ? (w / chartDates.length) - barGap : 0;

  if (limit > 0) {
    const y = h - padBottom - (limit / maxVal) * (h - padBottom);
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', 0); line.setAttribute('x2', w);
    line.setAttribute('y1', y); line.setAttribute('y2', y);
    line.setAttribute('stroke', '#C7830F');
    line.setAttribute('stroke-dasharray', '4,3');
    line.setAttribute('stroke-width', '1.5');
    svg.appendChild(line);
  }

  chartDates.forEach((d, i) => {
    const val = byDate[d];
    const barH = (val / maxVal) * (h - padBottom);
    const x = i * (barWidth + barGap);
    const y = h - padBottom - barH;
    const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    rect.setAttribute('x', x);
    rect.setAttribute('y', y);
    rect.setAttribute('width', Math.max(barWidth, 2));
    rect.setAttribute('height', Math.max(barH, 1));
    rect.setAttribute('rx', 3);
    rect.setAttribute('fill', val > limit && limit > 0 ? '#B5533C' : '#1F6F63');
    svg.appendChild(rect);
  });
}

document.getElementById('export-csv-btn').addEventListener('click', () => {
  const header = ['date', 'time', 'description', 'grams', 'calories', 'type'];
  const rows = logs.slice().sort((a, b) => a.date.localeCompare(b.date) || a.time.localeCompare(b.time))
    .map(l => [l.date, l.time, `"${(l.description || '').replace(/"/g, '""')}"`, l.grams || '', Math.round(l.calories), l.type]);
  const csv = [header.join(','), ...rows.map(r => r.join(','))].join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `roadto80-${todayStr()}.csv`;
  a.click();
  URL.revokeObjectURL(url);
});

// ---------------------------------------------------------------------------
// SETTINGS view
// ---------------------------------------------------------------------------
function renderSettings() {
  document.getElementById('setting-limit').value = settings.dailyLimit;
  document.getElementById('setting-proxy-url').value = settings.proxyUrl;
  document.getElementById('setting-proxy-token').value = settings.proxyToken;
  document.getElementById('setting-model').value = settings.model;
  document.getElementById('setting-voice-lang').value = settings.voiceLang;
  document.getElementById('setting-chat-instructions').value = settings.chatInstructions || DEFAULT_CHAT_INSTRUCTIONS;
  document.getElementById('settings-saved-msg').hidden = true;
}
document.getElementById('chat-instructions-reset-btn').addEventListener('click', () => {
  document.getElementById('setting-chat-instructions').value = DEFAULT_CHAT_INSTRUCTIONS;
});
document.getElementById('settings-save-btn').addEventListener('click', () => {
  settings.dailyLimit = parseFloat(document.getElementById('setting-limit').value) || 0;
  settings.proxyUrl = document.getElementById('setting-proxy-url').value.trim();
  settings.proxyToken = document.getElementById('setting-proxy-token').value.trim();
  settings.model = document.getElementById('setting-model').value;
  settings.voiceLang = document.getElementById('setting-voice-lang').value.trim() || 'sv-SE';
  settings.chatInstructions = document.getElementById('setting-chat-instructions').value.trim() || DEFAULT_CHAT_INSTRUCTIONS;
  persistAll();
  document.getElementById('settings-saved-msg').hidden = false;
});

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
document.getElementById('version-tag').textContent = APP_VERSION;
refreshFoodDatalist();
renderToday();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}