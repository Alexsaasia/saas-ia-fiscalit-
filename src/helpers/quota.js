import { supabase, getUserPlan } from './auth.js';

// ===== Helper pour vérifier et incrémenter le quota utilisateur
export async function checkAndIncrementQuota(userId) {
  if (!supabase) {
    throw new Error('Supabase non configuré');
  }

  try {
    // 1. Vérifier le plan de l'utilisateur dans la table profiles
    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('plan')
      .eq('user_id', userId)
      .single();

    if (profileError && profileError.code !== 'PGRST116') {
      console.error('❌ Erreur lecture profil utilisateur:', profileError.message);
      throw new Error(`Erreur lecture profil: ${profileError.message}`);
    }

    const userPlan = profile ? profile.plan : 'free';
    console.log(`📋 Plan utilisateur ${userId}: ${userPlan}`);

    // 2. Si l'utilisateur est "pro", pas de limite
    if (userPlan === 'pro') {
      console.log(`⭐ Utilisateur Premium ${userId}: accès illimité`);
      return {
        currentCount: 0,
        limit: 'illimité',
        remaining: 'illimité',
        plan: 'pro',
        ym: `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}`
      };
    }

    // 3. Si l'utilisateur est "free", appliquer la limite de 5 questions/mois
    console.log(`🆓 Utilisateur Free ${userId}: limite de 5 questions/mois`);
    
    // Calculer le mois/année courant (format: YYYY-MM)
    const now = new Date();
    const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    
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

    console.log(`✅ Quota incrémenté pour ${userId}: ${newCount}/5 (${ym})`);

    return {
      currentCount: newCount,
      limit: 5,
      remaining: 5 - newCount,
      plan: 'free',
      ym: ym
    };
  } catch (error) {
    throw error;
  }
}
