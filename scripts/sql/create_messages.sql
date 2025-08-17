create extension if not exists pgcrypto;
create table if not exists messages (
  id uuid primary key default gen_random_uuid(),
  user_id text not null default 'demo',
  question text not null,
  answer text not null,
  created_at timestamp with time zone default now()
);
alter table messages disable row level security;
