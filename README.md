# SaaS Fiscalité FR — MVP
## Prérequis
- Node.js LTS
- Compte OpenAI (clé API)
- Compte Supabase (URL + anon key)
## Lancer
1. Copier `.env.example` en `.env` et remplir les 3 variables :
   - OPENAI_API_KEY=...
   - SUPABASE_URL=https://...supabase.co
   - SUPABASE_ANON_KEY=eyJ...
2. Installer et démarrer :
   - npm install
   - npm start
3. Ouvrir http://localhost:3010
4. (Optionnel) Test santé : http://localhost:3010/health
## SQL (créer la table messages dans Supabase)
create extension if not exists pgcrypto;
create table if not exists messages (
  id uuid primary key default gen_random_uuid(),
  user_id text not null default 'demo',
  question text not null,
  answer text not null,
  created_at timestamp with time zone default now()
);
alter table messages disable row level security;
## Dépannage rapide
- Invalid URL: vérifie SUPABASE_URL (https://...supabase.co), pas de clef eyJ...
- Rien en BDD: table non créée ou RLS activée → exécuter le SQL ci-dessus.
- Port occupé: change PORT=3020 dans .env (optionnel) et relance.
