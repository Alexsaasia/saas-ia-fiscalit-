import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import requestIp from 'request-ip';
import Stripe from 'stripe';

// ===== Import des helpers
import { supabase, requireAuth, getUserPlan, updateUserProfile } from './helpers/auth.js';
import { checkAndIncrementQuota } from './helpers/quota.js';
import { openai, generateResponse } from './helpers/llm.js';

// ===== Logs de démarrage (sans dévoiler les secrets)
function preview(v){ if(!v) return 'undefined'; return v.slice(0, 40) + '...'; }
console.log('🔧 OPENAI_API_KEY présent ? ', !!process.env.OPENAI_API_KEY);
console.log('🔧 SUPABASE_URL = ', preview(process.env.SUPABASE_URL));
console.log('🔧 ANON commence par eyJ ? ', (process.env.SUPABASE_ANON_KEY||'').startsWith('eyJ'));
console.log('🔧 STRIPE_SECRET_KEY présent ? ', !!process.env.STRIPE_SECRET_KEY);
console.log('🔧 STRIPE_PRICE_ID présent ? ', !!process.env.STRIPE_PRICE_ID);
console.log('🔧 STRIPE_WEBHOOK_SECRET présent ? ', !!process.env.STRIPE_WEBHOOK_SECRET);

// ===== Stripe
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: '2024-12-18.acacia'
});

// ===== App
const app = express();
app.use(cors());
app.use(express.json());
app.use(requestIp.mw());

// ===== Fichiers statiques
app.use(express.static('public'));

// ===== Routes API

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
    // Vérifier et incrémenter le quota (inclut la vérification du plan)
    const quota = await checkAndIncrementQuota(userId);
    console.log(`✅ Quota vérifié pour ${req.user.email}: plan ${quota.plan}`);

    // Générer la réponse avec OpenAI
    const answer = await generateResponse(question);

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
        plan: quota.plan,
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

// ===== AUTHENTIFICATION SUPABASE

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
      return res.status(400).json({ 
        ok: false, 
        error: error.message 
      });
    }
    
    console.log(`✅ Utilisateur connecté: ${email}`);
    res.json({ 
      ok: true, 
      message: 'Connexion réussie',
      access_token: data.session.access_token,
      user: {
        id: data.user.id,
        email: data.user.email
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
app.post('/auth/signout', requireAuth, async (req, res) => {
  const authHeader = req.headers.authorization;
  const access_token = authHeader.split(' ')[1];
  
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
  try {
    const userPlan = await getUserPlan(req.user.id);
    
    res.json({ 
      ok: true, 
      user: {
        id: req.user.id,
        email: req.user.email,
        plan: userPlan
      }
    });
  } catch (error) {
    console.error('❌ Erreur récupération plan:', error.message);
    res.json({ 
      ok: true, 
      user: {
        id: req.user.id,
        email: req.user.email,
        plan: 'free'
      }
    });
  }
});

// ===== Routes de facturation Stripe

// ===== POST /billing/create-checkout-session - Créer une session Checkout
app.post('/billing/create-checkout-session', requireAuth, async (req, res) => {
  const userId = req.user.id;
  const userEmail = req.user.email;
  
  if (!stripe || !process.env.STRIPE_PRICE_ID) {
    return res.status(500).json({ 
      ok: false, 
      error: 'Stripe non configuré' 
    });
  }

  try {
    // Créer la session Checkout
    const session = await stripe.checkout.sessions.create({
      customer_email: userEmail,
      line_items: [
        {
          price: process.env.STRIPE_PRICE_ID,
          quantity: 1,
        },
      ],
      mode: 'subscription',
      success_url: `${process.env.APP_BASE_URL}/billing/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.APP_BASE_URL}/billing/cancel`,
      metadata: {
        user_id: userId,
        user_email: userEmail
      },
      subscription_data: {
        metadata: {
          user_id: userId,
          user_email: userEmail
        }
      }
    });

    console.log(`💳 Session Checkout créée pour ${userEmail}: ${session.id}`);
    
    res.json({ 
      ok: true, 
      session_id: session.id,
      checkout_url: session.url 
    });

  } catch (error) {
    console.error('❌ Erreur création session Checkout:', error.message);
    res.status(500).json({ 
      ok: false, 
      error: 'Erreur création session de paiement' 
    });
  }
});

// ===== GET /billing/portal - Rediriger vers le portail client Stripe
app.get('/billing/portal', requireAuth, async (req, res) => {
  const userId = req.user.id;
  const userEmail = req.user.email;

  if (!stripe) {
    return res.status(500).json({ 
      ok: false, 
      error: 'Stripe non configuré' 
    });
  }

  try {
    // Trouver le client Stripe par email
    const customers = await stripe.customers.list({
      email: userEmail,
      limit: 1
    });

    if (customers.data.length === 0) {
      return res.status(404).json({ 
        ok: false, 
        error: 'Aucun abonnement trouvé pour cet utilisateur' 
      });
    }

    const customer = customers.data[0];

    // Créer la session du portail client
    const session = await stripe.billingPortal.sessions.create({
      customer: customer.id,
      return_url: `${process.env.APP_BASE_URL}/billing/portal-return`,
    });

    console.log(`🔗 Session portail créée pour ${userEmail}: ${session.id}`);
    
    res.json({ 
      ok: true, 
      portal_url: session.url 
    });

  } catch (error) {
    console.error('❌ Erreur création session portail:', error.message);
    res.status(500).json({ 
      ok: false, 
      error: 'Erreur accès au portail client' 
    });
  }
});

// ===== GET /billing/success - Page de succès après paiement
app.get('/billing/success', (req, res) => {
  const sessionId = req.query.session_id;
  
  res.send(`<!doctype html>
<html lang="fr">
<head>
  <meta charset="utf-8" />
  <title>Paiement réussi - Fiscalité FR</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
</head>
<body style="font-family:system-ui, sans-serif; max-width:800px; margin:40px auto; padding:0 16px; text-align:center;">
  <h1>✅ Paiement réussi !</h1>
  <p>Votre abonnement Premium a été activé avec succès.</p>
  <p>Vous avez maintenant un accès illimité aux questions de fiscalité française.</p>
  <p><strong>Session ID:</strong> ${sessionId || 'Non disponible'}</p>
  <br/>
  <a href="/" style="background:#007bff; color:white; padding:12px 24px; text-decoration:none; border-radius:4px;">
    Retour à l'accueil
  </a>
</body>
</html>`);
});

// ===== GET /billing/cancel - Page d'annulation
app.get('/billing/cancel', (req, res) => {
  res.send(`<!doctype html>
<html lang="fr">
<head>
  <meta charset="utf-8" />
  <title>Paiement annulé - Fiscalité FR</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
</head>
<body style="font-family:system-ui, sans-serif; max-width:800px; margin:40px auto; padding:0 16px; text-align:center;">
  <h1>❌ Paiement annulé</h1>
  <p>Votre paiement a été annulé. Aucun montant n'a été débité.</p>
  <p>Vous pouvez réessayer à tout moment.</p>
  <br/>
  <a href="/" style="background:#007bff; color:white; padding:12px 24px; text-decoration:none; border-radius:4px;">
    Retour à l'accueil
  </a>
</body>
</html>`);
});

// ===== GET /billing/portal-return - Retour du portail client
app.get('/billing/portal-return', (req, res) => {
  res.send(`<!doctype html>
<html lang="fr">
<head>
  <meta charset="utf-8" />
  <title>Portail client - Fiscalité FR</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
</head>
<body style="font-family:system-ui, sans-serif; max-width:800px; margin:40px auto; padding:0 16px; text-align:center;">
  <h1>🔗 Portail client</h1>
  <p>Vous êtes revenu du portail client Stripe.</p>
  <p>Vos modifications d'abonnement ont été prises en compte.</p>
  <br/>
  <a href="/" style="background:#007bff; color:white; padding:12px 24px; text-decoration:none; border-radius:4px;">
    Retour à l'accueil
  </a>
</body>
</html>`);
});

// ===== Webhook Stripe pour gérer les abonnements
app.post('/webhooks/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  
  if (!process.env.STRIPE_WEBHOOK_SECRET) {
    console.error('❌ STRIPE_WEBHOOK_SECRET non configuré');
    return res.status(500).json({ ok: false, error: 'Webhook non configuré' });
  }

  let event;

  try {
    // Vérifier la signature du webhook
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
    console.log(`🔔 Webhook reçu: ${event.type}`);
  } catch (err) {
    console.error('❌ Erreur signature webhook:', err.message);
    return res.status(400).json({ ok: false, error: 'Signature invalide' });
  }

  try {
    // Traiter les événements d'abonnement
    switch (event.type) {
      case 'checkout.session.completed':
        await handleCheckoutSessionCompleted(event.data.object);
        break;
      
      case 'customer.subscription.updated':
        await handleSubscriptionUpdated(event.data.object);
        break;
      
      case 'customer.subscription.deleted':
        await handleSubscriptionDeleted(event.data.object);
        break;
      
      default:
        console.log(`ℹ️ Événement non traité: ${event.type}`);
    }

    res.json({ ok: true, received: true });
  } catch (error) {
    console.error('❌ Erreur traitement webhook:', error.message);
    res.status(500).json({ ok: false, error: 'Erreur traitement webhook' });
  }
});

// ===== Fonctions de traitement des événements Stripe

async function handleCheckoutSessionCompleted(session) {
  const customerEmail = session.customer_details?.email;
  const customerId = session.customer;
  const subscriptionId = session.subscription;
  
  if (!customerEmail) {
    console.error('❌ Email client manquant dans la session');
    return;
  }

  console.log(`💳 Session Checkout complétée pour ${customerEmail}`);
  
  // Mettre à jour ou créer le profil utilisateur
  await updateUserProfile(customerEmail, 'pro', customerId, subscriptionId);
}

async function handleSubscriptionUpdated(subscription) {
  const customerId = subscription.customer;
  const subscriptionId = subscription.id;
  const status = subscription.status;
  
  console.log(`📅 Abonnement mis à jour: ${subscriptionId} (${status})`);
  
  // Récupérer l'email du client depuis Stripe
  try {
    const customer = await stripe.customers.retrieve(customerId);
    const customerEmail = customer.email;
    
    if (status === 'active') {
      await updateUserProfile(customerEmail, 'pro', customerId, subscriptionId);
    } else if (status === 'canceled' || status === 'unpaid') {
      await updateUserProfile(customerEmail, 'free', customerId, subscriptionId);
    }
  } catch (error) {
    console.error('❌ Erreur récupération client Stripe:', error.message);
  }
}

async function handleSubscriptionDeleted(subscription) {
  const customerId = subscription.customer;
  const subscriptionId = subscription.id;
  
  console.log(`🗑️ Abonnement supprimé: ${subscriptionId}`);
  
  // Récupérer l'email du client depuis Stripe
  try {
    const customer = await stripe.customers.retrieve(customerId);
    const customerEmail = customer.email;
    
    await updateUserProfile(customerEmail, 'free', customerId, subscriptionId);
  } catch (error) {
    console.error('❌ Erreur récupération client Stripe:', error.message);
  }
}

// ===== Route santé
app.get('/health', (_req, res) => res.json({ ok: true, ts: Date.now() }));

// ===== Lancement
const port = process.env.PORT || 3010;
const host = '0.0.0.0';
app.listen(port, host, () => {
  console.log(`✅ Serveur démarré sur http://localhost:${port}`);
});
