import { createClient } from '@supabase/supabase-js';

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

// ===== Helper pour vérifier le plan de l'utilisateur
export async function getUserPlan(userId) {
  if (!supabase) {
    return 'free'; // Par défaut si Supabase n'est pas configuré
  }

  try {
    const { data: profile, error } = await supabase
      .from('profiles')
      .select('plan')
      .eq('user_id', userId)
      .single();

    if (error && error.code !== 'PGRST116') {
      console.error('❌ Erreur récupération plan utilisateur:', error.message);
      return 'free';
    }

    return profile ? profile.plan : 'free';
  } catch (error) {
    console.error('❌ Erreur générale getUserPlan:', error.message);
    return 'free';
  }
}

// ===== Middleware d'authentification
export async function requireAuth(req, res, next) {
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
}

// ===== Fonction pour mettre à jour le profil utilisateur (webhook Stripe)
export async function updateUserProfile(email, plan, stripeCustomerId = null, stripeSubscriptionId = null) {
  if (!supabase) {
    console.error('❌ Supabase non configuré');
    return;
  }

  try {
    // Trouver l'utilisateur Supabase par email
    const { data: users, error: userError } = await supabase.auth.admin.listUsers();
    
    if (userError) {
      console.error('❌ Erreur récupération utilisateurs:', userError.message);
      return;
    }

    const user = users.users.find(u => u.email === email);
    
    if (!user) {
      console.error(`❌ Utilisateur non trouvé pour l'email: ${email}`);
      return;
    }

    // Vérifier si le profil existe déjà
    const { data: existingProfile, error: selectError } = await supabase
      .from('profiles')
      .select('*')
      .eq('user_id', user.id)
      .single();

    if (selectError && selectError.code !== 'PGRST116') {
      console.error('❌ Erreur vérification profil:', selectError.message);
      return;
    }

    const profileData = {
      user_id: user.id,
      email: email,
      plan: plan,
      updated_at: new Date().toISOString()
    };

    if (stripeCustomerId) {
      profileData.stripe_customer_id = stripeCustomerId;
    }
    if (stripeSubscriptionId) {
      profileData.stripe_subscription_id = stripeSubscriptionId;
    }

    if (existingProfile) {
      // Mettre à jour le profil existant
      const { error: updateError } = await supabase
        .from('profiles')
        .update(profileData)
        .eq('user_id', user.id);

      if (updateError) {
        console.error('❌ Erreur mise à jour profil:', updateError.message);
      } else {
        console.log(`✅ Profil mis à jour pour ${email}: plan ${plan}`);
      }
    } else {
      // Créer un nouveau profil
      const { error: insertError } = await supabase
        .from('profiles')
        .insert(profileData);

      if (insertError) {
        console.error('❌ Erreur création profil:', insertError.message);
      } else {
        console.log(`✅ Nouveau profil créé pour ${email}: plan ${plan}`);
      }
    }
  } catch (error) {
    console.error('❌ Erreur générale updateUserProfile:', error.message);
  }
}

export { supabase };
