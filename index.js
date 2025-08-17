import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import OpenAI from 'openai';
import { createClient } from '@supabase/supabase-js';

// ===== Logs de démarrage (sans dévoiler les secrets)
function preview(v){ if(!v) return 'undefined'; return v.slice(0, 40) + '...'; }
console.log('🔧 OPENAI_API_KEY présent ? ', !!process.env.OPENAI_API_KEY);
console.log('🔧 SUPABASE_URL = ', preview(process.env.SUPABASE_URL));
console.log('🔧 ANON commence par eyJ ? ', (process.env.SUPABASE_ANON_KEY||'').startsWith('eyJ'));

// ===== Garde-fou création Supabase
function safeCreateSupabase(url, key) {
  try {
    const cleanUrl = (url || '').trim().replace(/\/+$/, '');
    if (!cleanUrl.startsWith('https://')) throw new Error('URL doit commencer par https://');
    new URL(cleanUrl);
    return createClient(cleanUrl, (key || '').trim());
  } catch (e) {
    console.error('❌ SUPABASE_URL invalide :', e.message);
    console.error('   Vérifie Supabase → Paramètres → API → Project URL.');
    return null;
  }
}
const supabase = safeCreateSupabase(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

// ===== OpenAI
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ===== App
const app = express();
app.use(cors());
app.use(express.json());

// ===== Prompt système
const SYSTEM_PROMPT = `
Tu es une aide fiscale/comptable pour la France. Réponds simplement et en français.
Quand tu fais un calcul (TVA, cotisations, IR), montre la formule et les étapes.
Si la question n'est pas fiscale/comptable FR, dis-le poliment.
`;

// ===== API: poser une question
app.post('/api/ask', async (req, res) => {
  const { question } = req.body || {};
  if (!question || typeof question !== 'string') {
    return res.status(400).json({ ok: false, error: 'question manquante' });
  }
  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0.2,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: question }
      ]
    });
    const answer = completion.choices?.[0]?.message?.content || 'Aucune réponse.';

    if (supabase) {
      const { error } = await supabase.from('messages').insert({
        user_id: 'demo',
        question,
        answer
      });
      if (error) console.error('❌ Supabase insert:', error.message);
    } else {
      console.warn('⚠️ Supabase non initialisé: historique non sauvegardé.');
    }

    console.log('Q:', question);
    console.log('A:', answer.slice(0, 160) + (answer.length > 160 ? '...' : ''));
    res.json({ ok: true, answer });
  } catch (e) {
    console.error('❌ OpenAI:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ===== API: lire historique (10 derniers)
app.get('/api/messages', async (_req, res) => {
  if (!supabase) return res.json({ ok: true, data: [] });
  const { data, error } = await supabase
    .from('messages')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(10);
  if (error) return res.status(500).json({ ok:false, error: error.message });
  res.json({ ok:true, data });
});

// ===== Route santé
app.get('/health', (_req, res) => res.json({ ok: true, ts: Date.now() }));

// ===== Page HTML test
app.get('/', (_req, res) => {
  res.send(`<!doctype html>
<html lang="fr">
<head>
  <meta charset="utf-8" />
  <title>MVP Fiscalité (OpenAI + Supabase)</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
</head>
<body style="font-family:system-ui, sans-serif; max-width:800px; margin:40px auto; padding:0 16px;">
  <h1>MVP Fiscalité (OpenAI + Supabase)</h1>
  <p>Pose une question fiscale/comptable (France) :</p>
  <textarea id="q" rows="6" style="width:100%;"></textarea>
  <br/><button onclick="ask()">Envoyer</button>
  <pre id="a" style="white-space:pre-wrap; background:#f6f6f6; padding:12px; margin-top:16px;"></pre>

  <button onclick="loadHistory()">Voir l'historique (10 derniers)</button>
  <pre id="h" style="white-space:pre-wrap; background:#f6f6f6; padding:12px; margin-top:16px;"></pre>

  <script>
    async function ask(){
      const q = document.getElementById('q').value;
      const r = await fetch('/api/ask', {
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ question: q })
      });
      const j = await r.json();
      document.getElementById('a').textContent = j.ok ? j.answer : ('Erreur: ' + j.error);
    }
    async function loadHistory(){
      const r = await fetch('/api/messages');
      const j = await r.json();
      document.getElementById('h').textContent = j.ok ? JSON.stringify(j.data, null, 2) : ('Erreur: ' + j.error);
    }
  </script>
</body>
</html>`);
});

// ===== Lancement
const port = process.env.PORT || 3010;
const host = '0.0.0.0';
app.listen(port, host, () => {
  console.log(`✅ Serveur démarré sur http://localhost:${port}`);
});

