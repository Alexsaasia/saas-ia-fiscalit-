import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import OpenAI from 'openai';
import { createClient } from '@supabase/supabase-js';
import requestIp from 'request-ip';

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
app.use(requestIp.mw());

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

  // 1. Récupérer l'IP du client avec request-ip
  const userIP = req.clientIp || 'unknown';
  console.log(`🌐 IP client: ${userIP}`);

  // 2. Vérifier dans la table "usage_limits" de Supabase
  if (supabase) {
    try {
      // Vérifier si cet IP existe déjà
      const { data: existingUser, error: selectError } = await supabase
        .from('usage_limits')
        .select('*')
        .eq('user_ip', userIP)
        .single();

      if (selectError && selectError.code !== 'PGRST116') {
        console.error('❌ Erreur vérification usage:', selectError.message);
        return res.status(500).json({ ok: false, error: 'Erreur serveur' });
      }

      // Vérifier si on doit réinitialiser (nouveau mois)
      const now = new Date();
      const lastReset = new Date(existingUser.last_reset);
      const isNewMonth = now.getMonth() !== lastReset.getMonth() || 
                        now.getFullYear() !== lastReset.getFullYear();

      if (isNewMonth) {
        // Réinitialiser pour un nouveau mois
        const { error: resetError } = await supabase
          .from('usage_limits')
          .update({ 
            question_count: 0, 
            last_reset: now.toISOString() 
          })
          .eq('user_ip', userIP);
        
        if (resetError) {
          console.error('❌ Erreur réinitialisation mensuelle:', resetError.message);
        } else {
          console.log(`🔄 Réinitialisation mensuelle pour ${userIP}`);
          existingUser.question_count = 0;
        }
      }

      // Si l'utilisateur existe et a atteint la limite
      if (existingUser && existingUser.question_count >= 5) {
        console.log(`🚫 Limite atteinte pour ${userIP}: ${existingUser.question_count}/5`);
        return res.status(429).json({ 
          ok: false, 
          error: 'Vous avez atteint la limite gratuite de 5 questions. Réinitialisation le mois prochain.',
          usage: { count: existingUser.question_count, limit: 5 }
        });
      }

      // 4. Générer la réponse avec OpenAI
      const completion = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        temperature: 0.2,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: question }
        ]
      });
      const answer = completion.choices?.[0]?.message?.content || 'Aucune réponse.';

      // Enregistrer dans la table "messages"
      const { error: insertError } = await supabase.from('messages').insert({
        user_id: userIP,
        question,
        answer
      });
      if (insertError) console.error('❌ Erreur insertion message:', insertError.message);

      // Incrémenter le compteur question_count
      if (existingUser) {
        // Utilisateur existe déjà, incrémenter le compteur
        const { error: updateError } = await supabase
          .from('usage_limits')
          .update({ question_count: existingUser.question_count + 1 })
          .eq('user_ip', userIP);
        
        if (updateError) {
          console.error('❌ Erreur mise à jour compteur:', updateError.message);
        } else {
          console.log(`✅ Compteur incrémenté pour ${userIP}: ${existingUser.question_count + 1}/5`);
        }
      } else {
        // Créer une nouvelle ligne pour cet IP
        const { error: insertLimitError } = await supabase
          .from('usage_limits')
          .insert({ 
            user_ip: userIP, 
            question_count: 1 
          });
        
        if (insertLimitError) {
          console.error('❌ Erreur création usage:', insertLimitError.message);
        } else {
          console.log(`✅ Nouvel utilisateur créé pour ${userIP}: 1/5`);
        }
      }

      console.log(`Q (${userIP}):`, question);
      console.log('A:', answer.slice(0, 160) + (answer.length > 160 ? '...' : ''));
      
      const currentCount = existingUser ? existingUser.question_count + 1 : 1;
      res.json({ 
        ok: true, 
        answer,
        usage: { count: currentCount, limit: 5 }
      });

    } catch (error) {
      console.error('❌ Erreur générale:', error.message);
      res.status(500).json({ ok: false, error: 'Erreur serveur' });
    }
  } else {
    // Supabase non configuré, générer seulement la réponse OpenAI
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

      console.log(`Q (${userIP}, sans limite):`, question);
      console.log('A:', answer.slice(0, 160) + (answer.length > 160 ? '...' : ''));
      
      res.json({ 
        ok: true, 
        answer,
        usage: { count: 0, limit: 5, note: 'Limites désactivées' }
      });
    } catch (e) {
      console.error('❌ OpenAI:', e.message);
      res.status(500).json({ ok: false, error: e.message });
    }
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

// ===== API: vérifier l'usage de l'utilisateur
app.get('/api/usage', async (req, res) => {
  const userIP = req.clientIp || 'unknown';
  
  if (!supabase) {
    return res.json({ ok: true, usage: { count: 0, limit: 5 } });
  }
  
  try {
    const { data: user } = await supabase
      .from('usage_limits')
      .select('*')
      .eq('user_ip', userIP)
      .single();
    
    if (user) {
      res.json({ 
        ok: true, 
        usage: { 
          count: user.question_count, 
          limit: 5,
          remaining: Math.max(0, 5 - user.question_count)
        }
      });
    } else {
      res.json({ 
        ok: true, 
        usage: { 
          count: 0, 
          limit: 5,
          remaining: 5
        }
      });
    }
  } catch (error) {
    console.error('❌ Erreur vérification usage:', error.message);
    res.json({ 
      ok: true, 
      usage: { 
        count: 0, 
        limit: 5,
        remaining: 5
      }
    });
  }
});

// ===== API: réinitialiser manuellement l'usage (admin)
app.post('/api/reset-usage', async (req, res) => {
  const userIP = req.clientIp || 'unknown';
  
  if (!supabase) {
    return res.status(500).json({ ok: false, error: 'Supabase non configuré' });
  }
  
  try {
    const { error } = await supabase
      .from('usage_limits')
      .update({ 
        question_count: 0, 
        last_reset: new Date().toISOString() 
      })
      .eq('user_ip', userIP);
    
    if (error) {
      console.error('❌ Erreur réinitialisation manuelle:', error.message);
      return res.status(500).json({ ok: false, error: 'Erreur serveur' });
    }
    
    console.log(`🔄 Réinitialisation manuelle pour ${userIP}`);
    res.json({ 
      ok: true, 
      message: 'Usage réinitialisé avec succès',
      usage: { count: 0, limit: 5, remaining: 5 }
    });
  } catch (error) {
    console.error('❌ Erreur générale:', error.message);
    res.status(500).json({ ok: false, error: 'Erreur serveur' });
  }
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

