// ---------------------------------------------------------------------------
// Kaloriloggen — storage helpers
// ---------------------------------------------------------------------------
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
  { dailyLimit: 2000, proxyUrl: '', proxyToken: '', model: 'deepseek-chat', voiceLang: 'sv-SE' },
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
      model: settings.model || 'deepseek-chat',
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
      model: settings.model || 'deepseek-chat',
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

function buildFoodEstimateSystem() {
  return `Du är en assistent som uppskattar kalorier i mat. Svara ENDAST med ett JSON-objekt och ingen övrig text, inga markdown-taggar. Formatet ska vara exakt:
{"valid": boolean, "name": string, "grams": number, "caloriesTotal": number, "calsPerGram": number, "source": "sparat livsmedel" | "AI-uppskattning" | "webbsökning"}

Sätt "valid" till false om texten inte rimligen beskriver ett ätbart livsmedel eller en maträtt (t.ex. om texten är oklar, obegriplig, eller inte handlar om mat, som "ja" eller "hej"). Gissa då INGA kalorivärden, sätt alla siffror till 0.

Användarens sparade livsmedel (använd EXAKT dessa kcal/gram-värden om ett omnämnt livsmedel matchar "name" ELLER "altName" i listan — de är två namn på samma sparade livsmedel — gissa då inte annat, och sätt "source" till "sparat livsmedel"):
${JSON.stringify(savedFoodsForPrompt())}

Om inget sparat livsmedel matchar, avgör enligt denna REGEL (inte efter hur säker du "känner dig" — den känslan är opålitlig, använd istället dessa konkreta kriterier):
- Om namnet innehåller ett varumärke, en butiks-/kedjeprodukt, en restaurang-/snabbmatsrätt, eller en specifik förpackad produkt (t.ex. "IKEA köttbullar", "Snickers", "Marabou mjölkchoklad", "McDonald's Big Mac", "ICA Basic kycklingfilé") — använd ALLTID verktyget web_search för att slå upp exakt värde innan du svarar, oavsett om du tror dig veta svaret. Sätt "source" till "webbsökning".
- Annars, om det är en vanlig råvara eller hemlagad mat utan varumärke (t.ex. "kyckling", "ris", "äpple", "broccoli", "pannkakor") — uppskatta direkt själv utan att söka, och sätt "source" till "AI-uppskattning".

Om användaren anger en mängd i gram, använd den för "grams". Om ingen mängd anges, anta en rimlig portionsstorlek. "calsPerGram" ska ta hänsyn till om maten är tillagad, rå, kokt osv om det nämns eller är underförstått. "caloriesTotal" ska vara grams * calsPerGram.`;
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
- Blanda aldrig fritext och JSON i samma svar.`;

// User-editable reasoning style — how cautious/chatty the AI is, when it asks follow-ups, etc.
const DEFAULT_CHAT_INSTRUCTIONS = `Så här ska du resonera:
1. Om det användaren skriver inte rimligen är en beskrivning av mat eller dryck (t.ex. "ja", "hej", eller annat obegripligt), anta ALDRIG att det är mat — fråga istället kort vad de menar eller vad de åt.
2. Om mängd (gram/antal) saknas för något som nämnts, fråga efter det EN gång. Om användaren svarar att de inte vet, inte mätte, eller liknande — fråga INTE igen. Gör då direkt en rimlig standarduppskattning (t.ex. typisk vikt för den varan) och gå vidare, och nämn kort vilket antagande du gjorde.
3. Fråga bara om tillagningsgrad (kokt/rå/stekt/etc) när det skulle ändra kalorierna MÄRKBART (t.ex. rått vs kokt kött, ris, pasta) och det inte redan är tydligt. Fråga ALDRIG om detaljer som knappt påverkar kalorierna (t.ex. exakt smak på en glass eller godis, märke på liknande produkter) — gör bara en rimlig uppskattning för sånt direkt.
4. Ställ som mest EN uppföljningsfråga per svar, och bara om den faktiskt behövs för att kunna ge en rimlig kaloriuppskattning. Fråga aldrig igen om något du redan frågat om i det här samtalet — använd det användaren redan sagt, eller gör en uppskattning.`;

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
// Voice input (Web Speech API)
// ---------------------------------------------------------------------------
const SpeechRecognitionImpl = window.SpeechRecognition || window.webkitSpeechRecognition;
const aiDescInput = document.getElementById('ai-desc');

function setupVoiceInput(inputEl, btnEl, statusEl) {
  if (!SpeechRecognitionImpl) {
    btnEl.disabled = true;
    statusEl.textContent = 'Röstinmatning stöds inte i den här webbläsaren.';
    return;
  }
  const recognition = new SpeechRecognitionImpl();
  recognition.continuous = false;
  recognition.interimResults = false;
  let listening = false;

  recognition.onresult = (e) => {
    inputEl.value = e.results[0][0].transcript;
  };
  recognition.onerror = (e) => {
    statusEl.textContent = 'Kunde inte höra dig (' + e.error + ').';
  };
  recognition.onend = () => {
    listening = false;
    btnEl.classList.remove('listening');
    if (!statusEl.textContent.startsWith('Kunde inte')) statusEl.textContent = '';
  };

  btnEl.addEventListener('click', () => {
    if (listening) return;
    recognition.lang = settings.voiceLang || 'sv-SE';
    listening = true;
    btnEl.classList.add('listening');
    statusEl.textContent = 'Lyssnar...';
    recognition.start();
  });
}

setupVoiceInput(aiDescInput, document.getElementById('mic-btn'), document.getElementById('mic-status'));
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

function addLog(entry) {
  logs.push(Object.assign({
    id: uid(),
    date: todayStr(),
    time: nowTimeStr(),
  }, entry));
  persistAll();
  renderToday();
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------------------------------------------------------------------------
// ADD view — mode toggle
// ---------------------------------------------------------------------------
document.getElementById('add-mode-toggle').addEventListener('click', (e) => {
  const btn = e.target.closest('.seg');
  if (!btn) return;
  document.querySelectorAll('#add-mode-toggle .seg').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  const mode = btn.dataset.mode;
  document.getElementById('add-ai-panel').hidden = mode !== 'ai';
  document.getElementById('add-chat-panel').hidden = mode !== 'chat';
  document.getElementById('add-manual-panel').hidden = mode !== 'manual';
  if (mode === 'chat') renderChatMessages();
});

// --- AI estimate flow ---
function showAiResult(name, grams, total, source) {
  document.getElementById('ai-error').hidden = true;
  document.getElementById('ai-result-name').textContent = name;
  const badge = document.getElementById('ai-result-source');
  badge.textContent = source;
  badge.classList.toggle('saved', source === 'sparat livsmedel');
  badge.classList.toggle('web', source === 'webbsökning');
  document.getElementById('ai-result-cals').textContent = `${Math.round(total)} kcal`;
  document.getElementById('ai-result-grams').value = Math.round(grams);
  document.getElementById('ai-result-total').value = Math.round(total);
  document.getElementById('ai-result').hidden = false;
  document.getElementById('ai-result').dataset.name = name;
}
function showAiError(message) {
  document.getElementById('ai-result').hidden = true;
  const err = document.getElementById('ai-error');
  err.textContent = message;
  err.hidden = false;
}

document.getElementById('ai-estimate-btn').addEventListener('click', async () => {
  const desc = aiDescInput.value.trim();
  if (!desc) return;

  // Bypass the AI entirely when the text clearly matches a saved food + a gram amount.
  const localFood = findFoodMatch(desc);
  const localGrams = extractGrams(desc);
  if (localFood && localGrams) {
    showAiResult(localFood.name, localGrams, localFood.calsPerGram * localGrams, 'sparat livsmedel');
    return;
  }

  const btn = document.getElementById('ai-estimate-btn');
  btn.disabled = true;
  btn.textContent = 'Frågar AI...';
  try {
    const result = await callDeepSeekJSON(buildFoodEstimateSystem(), desc);
    if (result.valid === false) {
      showAiError('Kunde inte tolka det här som en maträtt. Beskriv gärna vad du åt tydligare.');
      return;
    }
    showAiResult(result.name || desc, result.grams, result.caloriesTotal, result.source || 'AI-uppskattning');
  } catch (err) {
    alert(err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Fråga AI';
  }
});

document.getElementById('ai-confirm-btn').addEventListener('click', () => {
  const name = document.getElementById('ai-result').dataset.name || aiDescInput.value.trim();
  const grams = parseFloat(document.getElementById('ai-result-grams').value) || 0;
  const total = parseFloat(document.getElementById('ai-result-total').value) || 0;
  addLog({ description: name, grams, calories: total, type: 'ai' });
  if (document.getElementById('ai-save-as-food').checked && grams > 0) {
    foods.push({ id: uid(), name, calsPerGram: total / grams });
    persistAll();
  }
  aiDescInput.value = '';
  document.getElementById('ai-result').hidden = true;
  document.getElementById('ai-save-as-food').checked = false;
});

// --- Manual flow ---
const manualNameInput = document.getElementById('manual-name');
const manualGramsInput = document.getElementById('manual-grams');
const manualCalsInput = document.getElementById('manual-cals');
let manualMatchedFood = null;

function refreshFoodDatalist() {
  let dl = document.getElementById('food-options');
  if (!dl) {
    dl = document.createElement('datalist');
    dl.id = 'food-options';
    document.body.appendChild(dl);
    manualNameInput.setAttribute('list', 'food-options');
  }
  dl.innerHTML = foods.map(f => `<option value="${escapeHtml(f.name)}">`
    + (f.altName ? `<option value="${escapeHtml(f.altName)}">` : '')).join('');
}

manualNameInput.addEventListener('input', () => {
  const match = matchFoodByExactName(manualNameInput.value);
  manualMatchedFood = match || null;
  if (match && manualGramsInput.value) {
    manualCalsInput.value = Math.round(match.calsPerGram * parseFloat(manualGramsInput.value));
  }
});
manualGramsInput.addEventListener('input', () => {
  if (manualMatchedFood) {
    const g = parseFloat(manualGramsInput.value) || 0;
    manualCalsInput.value = Math.round(manualMatchedFood.calsPerGram * g);
  }
});

document.getElementById('manual-confirm-btn').addEventListener('click', () => {
  const name = manualNameInput.value.trim();
  const grams = parseFloat(manualGramsInput.value) || 0;
  const cals = parseFloat(manualCalsInput.value) || 0;
  if (!name || !cals) { alert('Fyll i namn och kalorier.'); return; }
  addLog({ description: name, grams, calories: cals, type: 'manual' });
  if (document.getElementById('manual-save-as-food').checked && grams > 0) {
    foods.push({ id: uid(), name, calsPerGram: cals / grams });
    persistAll();
    refreshFoodDatalist();
  }
  manualNameInput.value = '';
  manualGramsInput.value = '';
  manualCalsInput.value = '';
  manualMatchedFood = null;
  document.getElementById('manual-save-as-food').checked = false;
});

// ---------------------------------------------------------------------------
// AI CHAT mode
// ---------------------------------------------------------------------------
const chatMessagesEl = document.getElementById('chat-messages');
const chatInputEl = document.getElementById('chat-input');
const chatPendingEl = document.getElementById('chat-pending');
const chatPendingItemsEl = document.getElementById('chat-pending-items');
let chatPendingDraft = [];

function renderChatMessages() {
  chatMessagesEl.innerHTML = '';
  chatHistory.forEach(m => {
    const div = document.createElement('div');
    const isKlar = m.role === 'assistant' && /KLART:/i.test(m.content);
    div.className = `chat-msg ${m.role}`;
    div.textContent = isKlar ? 'Här är vad jag uppfattade — kolla sammanställningen nedan.' : m.content;
    chatMessagesEl.appendChild(div);
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
  chatPendingDraft.forEach(item => {
    addLog({ description: item.name, grams: item.grams, calories: item.caloriesTotal, type: 'chat' });
  });
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
      <button class="btn-small" data-log="${b.id}">Logga</button>
      <button class="icon-btn" data-del="${b.id}" title="Ta bort">✕</button>
    `;
    list.appendChild(li);
  });
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
  a.download = `kaloriloggen-${todayStr()}.csv`;
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
refreshFoodDatalist();
renderToday();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}
