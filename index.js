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

// ===== Helper pour vérifier et incrémenter le quota utilisateur
async function checkAndIncrementQuota(userId) {
  if (!supabase) {
    throw new Error('Supabase non configuré');
  }

  // Calculer le mois/année courant (format: YYYY-MM)
  const now = new Date();
  const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  
  try {
    // Vérifier si l'utilisateur a déjà des questions ce mois-ci
    const { data: existingRecord, error: selectError } = await supabase
      .from('usage_limits_user')
      .select('question_count')
      .eq('user_id', userId)
      .eq('ym', ym)
      .single();

    if (selectError && selectError.code !== 'PGRST116') {
      throw new Error(`Erreur vérification quota: ${selectError.message}`);
    }

    const currentCount = existingRecord ? existingRecord.question_count : 0;
    
    // Vérifier si la limite est atteinte
    if (currentCount >= 5) {
      throw new Error(`Limite de 5 questions atteinte pour ${ym}`);
    }

    // Incrémenter le compteur (UPSERT)
    const newCount = currentCount + 1;
    const { error: upsertError } = await supabase
      .from('usage_limits_user')
      .upsert({
        user_id: userId,
        ym: ym,
        question_count: newCount,
        updated_at: now.toISOString()
      }, {
        onConflict: 'user_id,ym'
      });

    if (upsertError) {
      throw new Error(`Erreur mise à jour quota: ${upsertError.message}`);
    }

    return {
      currentCount: newCount,
      limit: 5,
      remaining: 5 - newCount,
      ym: ym
    };
  } catch (error) {
    throw error;
  }
}

// ===== Middleware d'authentification
const requireAuth = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ 
      ok: false, 
      error: 'non authentifié' 
    });
  }
  
  const access_token = authHeader.split(' ')[1];
  
  if (!supabase) {
    return res.status(500).json({ 
      ok: false, 
      error: 'Supabase non configuré' 
    });
  }
  
  try {
    const { data: { user }, error } = await supabase.auth.getUser(access_token);
    
    if (error || !user) {
      console.error('❌ Erreur authentification:', error?.message);
      return res.status(401).json({ 
        ok: false, 
        error: 'non authentifié' 
      });
    }
    
    // Attacher l'utilisateur à la requête
    req.user = {
      id: user.id,
      email: user.email
    };
    
    console.log(`🔐 Utilisateur authentifié: ${user.email}`);
    next();
  } catch (error) {
    console.error('❌ Erreur générale authentification:', error.message);
    res.status(401).json({ 
      ok: false, 
      error: 'non authentifié' 
    });
  }
};

// ===== Prompt système
const SYSTEM_PROMPT = `
Tu es une aide fiscale/comptable pour la France. Réponds simplement et en français.
Quand tu fais un calcul (TVA, cotisations, IR), montre la formule et les étapes.
Si la question n'est pas fiscale/comptable FR, dis-le poliment.
`;



// ===== API: poser une question (authentifiée - par utilisateur)
app.post('/api/ask', requireAuth, async (req, res) => {
  const { question } = req.body || {};
  if (!question || typeof question !== 'string') {
    return res.status(400).json({ ok: false, error: 'question manquante' });
  }

  // Utiliser l'ID utilisateur connecté
  const userId = req.user.id;
  console.log(`🌐 Utilisateur connecté: ${req.user.email} (${userId})`);

  try {
    // Vérifier et incrémenter le quota utilisateur
    const quota = await checkAndIncrementQuota(userId);
    console.log(`✅ Quota vérifié pour ${req.user.email}: ${quota.currentCount}/${quota.limit} (${quota.ym})`);

    // Générer la réponse avec OpenAI
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0.2,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: question }
      ]
    });
    const answer = completion.choices?.[0]?.message?.content || 'Aucune réponse.';

    // Enregistrer dans la table "messages" avec l'ID utilisateur
    if (supabase) {
      const { error: insertError } = await supabase.from('messages').insert({
        user_id: userId,
        question,
        answer
      });
      if (insertError) console.error('❌ Erreur insertion message:', insertError.message);
    }

    console.log(`Q (${req.user.email}):`, question);
    console.log('A:', answer.slice(0, 160) + (answer.length > 160 ? '...' : ''));
    
    res.json({ 
      ok: true, 
      answer,
      usage: {
        count: quota.currentCount,
        limit: quota.limit,
        remaining: quota.remaining,
        ym: quota.ym
      }
    });

  } catch (error) {
    console.error('❌ Erreur:', error.message);
    
    // Si c'est une erreur de quota, retourner 429
    if (error.message.includes('Limite de 5 questions atteinte')) {
      return res.status(429).json({ 
        ok: false, 
        error: 'Vous avez atteint la limite gratuite de 5 questions ce mois-ci.',
        usage: { count: 5, limit: 5, remaining: 0 }
      });
    }
    
    res.status(500).json({ ok: false, error: 'Erreur serveur' });
  }
});

// ===== API: lire historique (authentifié - messages de l'utilisateur connecté)
app.get('/api/messages', requireAuth, async (req, res) => {
  const userId = req.user.id;
  
  if (!supabase) return res.json({ ok: true, data: [] });
  
  const { data, error } = await supabase
    .from('messages')
    .select('*')
    .eq('user_id', userId) // Filtrer par l'utilisateur connecté
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

// ===== AUTHENTIFICATION SUPABASE =====

// ===== POST /auth/signup - Créer un compte utilisateur
app.post('/auth/signup', async (req, res) => {
  const { email, password } = req.body || {};
  
  // Validation des données
  if (!email || !password) {
    return res.status(400).json({ 
      ok: false, 
      error: 'Email et mot de passe requis' 
    });
  }
  
  if (password.length < 6) {
    return res.status(400).json({ 
      ok: false, 
      error: 'Le mot de passe doit contenir au moins 6 caractères' 
    });
  }
  
  if (!supabase) {
    return res.status(500).json({ 
      ok: false, 
      error: 'Supabase non configuré' 
    });
  }
  
  try {
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        emailRedirectTo: `${req.protocol}://${req.get('host')}/auth/callback`
      }
    });
    
    if (error) {
      console.error('❌ Erreur inscription:', error.message);
      return res.status(400).json({ 
        ok: false, 
        error: error.message 
      });
    }
    
    console.log(`✅ Nouvel utilisateur inscrit: ${email}`);
    res.json({ 
      ok: true, 
      message: 'Inscription réussie. Vérifiez votre email pour confirmer votre compte.',
      user: {
        id: data.user?.id,
        email: data.user?.email
      }
    });
  } catch (error) {
    console.error('❌ Erreur générale inscription:', error.message);
    res.status(500).json({ 
      ok: false, 
      error: 'Erreur serveur' 
    });
  }
});

// ===== POST /auth/signin - Connecter un utilisateur
app.post('/auth/signin', async (req, res) => {
  const { email, password } = req.body || {};
  
  // Validation des données
  if (!email || !password) {
    return res.status(400).json({ 
      ok: false, 
      error: 'Email et mot de passe requis' 
    });
  }
  
  if (!supabase) {
    return res.status(500).json({ 
      ok: false, 
      error: 'Supabase non configuré' 
    });
  }
  
  try {
    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password
    });
    
    if (error) {
      console.error('❌ Erreur connexion:', error.message);
      return res.status(401).json({ 
        ok: false, 
        error: 'Email ou mot de passe incorrect' 
      });
    }
    
    console.log(`✅ Utilisateur connecté: ${email}`);
    res.json({ 
      ok: true, 
      message: 'Connexion réussie',
      user: {
        id: data.user?.id,
        email: data.user?.email
      },
      session: {
        access_token: data.session?.access_token,
        refresh_token: data.session?.refresh_token,
        expires_at: data.session?.expires_at
      }
    });
  } catch (error) {
    console.error('❌ Erreur générale connexion:', error.message);
    res.status(500).json({ 
      ok: false, 
      error: 'Erreur serveur' 
    });
  }
});

// ===== POST /auth/signout - Déconnecter un utilisateur
app.post('/auth/signout', async (req, res) => {
  const { access_token } = req.body || {};
  
  if (!access_token) {
    return res.status(400).json({ 
      ok: false, 
      error: 'Token d\'accès requis' 
    });
  }
  
  if (!supabase) {
    return res.status(500).json({ 
      ok: false, 
      error: 'Supabase non configuré' 
    });
  }
  
  try {
    // Créer un client Supabase avec le token pour la déconnexion
    const { error } = await supabase.auth.admin.signOut(access_token);
    
    if (error) {
      console.error('❌ Erreur déconnexion:', error.message);
      return res.status(400).json({ 
        ok: false, 
        error: error.message 
      });
    }
    
    console.log('✅ Utilisateur déconnecté');
    res.json({ 
      ok: true, 
      message: 'Déconnexion réussie' 
    });
  } catch (error) {
    console.error('❌ Erreur générale déconnexion:', error.message);
    res.status(500).json({ 
      ok: false, 
      error: 'Erreur serveur' 
    });
  }
});

// ===== GET /auth/me - Vérifier l'utilisateur connecté (avec middleware)
app.get('/auth/me', requireAuth, async (req, res) => {
  res.json({ 
    ok: true, 
    user: {
      id: req.user.id,
      email: req.user.email
    }
  });
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

