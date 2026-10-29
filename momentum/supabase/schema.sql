-- Momentum GPW: stan portfela użytkownika (Supabase → SQL Editor → Run).
-- Każdy zalogowany użytkownik widzi i zmienia wyłącznie własny wiersz (Row Level Security).

create table if not exists public.portfolios (
    user_id    uuid primary key references auth.users (id) on delete cascade,
    data       jsonb not null,
    updated_at timestamptz not null default now()
);

alter table public.portfolios enable row level security;

drop policy if exists "własny portfel: odczyt" on public.portfolios;
drop policy if exists "własny portfel: zapis" on public.portfolios;
drop policy if exists "własny portfel: zmiana" on public.portfolios;

create policy "własny portfel: odczyt" on public.portfolios
    for select using (auth.uid() = user_id);
create policy "własny portfel: zapis" on public.portfolios
    for insert with check (auth.uid() = user_id);
create policy "własny portfel: zmiana" on public.portfolios
    for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
