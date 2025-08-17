import OpenAI from 'openai';

// ===== Configuration OpenAI
export const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ===== Prompt système
export const SYSTEM_PROMPT = `
Tu es une aide fiscale/comptable pour la France. Réponds simplement et en français.
Quand tu fais un calcul (TVA, cotisations, IR), montre la formule et les étapes.
Si la question n'est pas fiscale/comptable FR, dis-le poliment.
`;

// ===== Fonction pour générer une réponse
export async function generateResponse(question) {
  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0.2,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: question }
      ]
    });
    
    return completion.choices?.[0]?.message?.content || 'Aucune réponse.';
  } catch (error) {
    console.error('❌ Erreur OpenAI:', error.message);
    throw new Error(`Erreur génération réponse: ${error.message}`);
  }
}
