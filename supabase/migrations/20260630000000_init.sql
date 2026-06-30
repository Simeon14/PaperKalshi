-- PaperKalshi: multi-user schema (Supabase Postgres + Auth)
--
-- One database backs every player. Supabase Auth owns identity (auth.users); the game
-- state below is keyed per user. The security model is the whole point:
--
--   * The browser may READ its own rows and the public leaderboard.
--   * The browser may NEVER WRITE cash/positions/fills.
--   * Every mutation goes through the trusted server (a Next.js route using the
--     service_role key, which bypasses RLS) after it re-prices the order against a
--     fresh Kalshi quote. So RLS here is simply "read-own, write-nothing" for clients.
--
-- Money is integer cents (bigint), matching the original SQLite broker. A fresh account
-- starts at $100,000.00 = 10,000,000 cents.

-- ---------------------------------------------------------------------------
-- profiles: public-facing identity (username) for each auth user
-- ---------------------------------------------------------------------------
create table public.profiles (
  id         uuid primary key references auth.users (id) on delete cascade,
  username   text not null unique check (char_length(username) between 3 and 20),
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- accounts: one paper-trading account per user
-- ---------------------------------------------------------------------------
create table public.accounts (
  id             uuid primary key references auth.users (id) on delete cascade,
  cash_c         bigint  not null default 10000000,
  starting_c     bigint  not null default 10000000,
  realized_pnl_c bigint  not null default 0,
  equity_c       bigint  not null default 10000000,  -- snapshot refreshed for the leaderboard
  realistic      boolean not null default false,      -- the "Realistic fills" toggle, per account
  updated_at     timestamptz not null default now(),
  created_at     timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- positions: open contracts, keyed by (user, market, side)
-- ---------------------------------------------------------------------------
create table public.positions (
  user_id   uuid    not null references auth.users (id) on delete cascade,
  ticker    text    not null,
  side      text    not null check (side in ('yes','no')),
  team      text    not null,
  contracts integer not null check (contracts > 0),
  cost_c    bigint  not null,        -- total cash paid to open (incl. fees)
  matchup   text    not null,
  primary key (user_id, ticker, side)
);

-- ---------------------------------------------------------------------------
-- fills: immutable blotter of every executed order and settlement
-- ---------------------------------------------------------------------------
create table public.fills (
  id           bigint generated always as identity primary key,
  user_id      uuid    not null references auth.users (id) on delete cascade,
  ts           bigint  not null,
  ticker       text    not null,
  matchup      text    not null,
  team         text    not null,
  side         text    not null,
  action       text    not null,     -- 'buy' | 'sell' | 'settle'
  count        integer not null,
  price_c      integer not null,
  fee_c        integer not null,
  realized_c   bigint  not null,
  cash_after_c bigint  not null
);
create index fills_user_ts_idx on public.fills (user_id, ts desc);

-- ---------------------------------------------------------------------------
-- Row Level Security: read-own, write-nothing for clients
-- ---------------------------------------------------------------------------
-- Policies pin the target role with TO and an ownership predicate (role-only checks are
-- BOLA/IDOR holes). auth.uid() is wrapped in a scalar subselect so the planner caches it.
-- There are deliberately NO insert/update/delete policies: clients cannot write game state
-- at all. The server writes with the service_role key, which bypasses RLS entirely.
alter table public.profiles  enable row level security;
alter table public.accounts  enable row level security;
alter table public.positions enable row level security;
alter table public.fills     enable row level security;

create policy "profiles are publicly readable" on public.profiles
  for select to anon, authenticated using (true);        -- usernames (for the leaderboard)

create policy "read own account" on public.accounts
  for select to authenticated using ((select auth.uid()) = id);

create policy "read own positions" on public.positions
  for select to authenticated using ((select auth.uid()) = user_id);

create policy "read own fills" on public.fills
  for select to authenticated using ((select auth.uid()) = user_id);

-- The Data API is set to NOT auto-expose new tables, so grant read access explicitly.
grant select on public.profiles  to anon, authenticated;
grant select on public.accounts  to authenticated;   -- RLS still limits to the own row
grant select on public.positions to authenticated;
grant select on public.fills     to authenticated;

-- The public leaderboard (which must expose a curated slice of EVERY user's stats) is built
-- in its own migration alongside the scheduled equity refresh, so it can be a cron-maintained
-- table with public-read RLS rather than an RLS-bypassing view.

-- ---------------------------------------------------------------------------
-- Seed a profile + a fresh $100k account whenever a user signs up
-- ---------------------------------------------------------------------------
-- search_path is pinned to '' and every name is schema-qualified (prevents search_path
-- hijacking of a SECURITY DEFINER function). Execute is revoked from PUBLIC; the trigger
-- mechanism still fires it on insert without any direct grant.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = ''
as $$
begin
  insert into public.profiles (id, username)
  values (new.id, coalesce(new.raw_user_meta_data->>'username', 'player_' || left(new.id::text, 8)));
  insert into public.accounts (id) values (new.id);  -- column defaults give the $100k account
  return new;
end;
$$;

revoke execute on function public.handle_new_user() from public;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- apply_trade: the atomic money mutation (a faithful port of paper.py's trade())
-- ---------------------------------------------------------------------------
-- The trusted server decides the fill price and fee (it has the live Kalshi quote and the
-- fee model) and passes them in. This function does the integrity-critical part atomically:
-- it locks the account row (so concurrent trades serialize), checks funds / holdings, updates
-- the position, and writes the fill. Execute is revoked from PUBLIC and granted ONLY to
-- service_role, so a logged-in user can never call it with a made-up price.
create or replace function public.apply_trade(
  p_user uuid, p_ticker text, p_side text, p_action text, p_count int,
  p_price_c int, p_fee_c int, p_team text, p_matchup text, p_ts bigint
) returns public.fills
language plpgsql
security definer set search_path = ''
as $$
declare
  v_cash           bigint;
  v_realized_total bigint;
  v_pos            public.positions%rowtype;
  v_cost           bigint;
  v_proceeds       bigint;
  v_basis          bigint;
  v_realized       bigint := 0;
  v_fill           public.fills%rowtype;
begin
  -- Lock the account row; concurrent trades for this user now serialize on it.
  select cash_c, realized_pnl_c into v_cash, v_realized_total
    from public.accounts where id = p_user for update;
  if not found then
    raise exception 'no account for user';
  end if;

  if p_action = 'buy' then
    v_cost := p_count::bigint * p_price_c + p_fee_c;
    if v_cost > v_cash then
      raise exception 'insufficient cash';
    end if;
    v_cash := v_cash - v_cost;
    select * into v_pos from public.positions
      where user_id = p_user and ticker = p_ticker and side = p_side;
    if not found then
      insert into public.positions (user_id, ticker, side, team, contracts, cost_c, matchup)
        values (p_user, p_ticker, p_side, p_team, p_count, v_cost, p_matchup);
    else
      update public.positions
        set contracts = contracts + p_count, cost_c = cost_c + v_cost
        where user_id = p_user and ticker = p_ticker and side = p_side;
    end if;

  elsif p_action = 'sell' then
    select * into v_pos from public.positions
      where user_id = p_user and ticker = p_ticker and side = p_side;
    if not found or v_pos.contracts < p_count then
      raise exception 'cannot sell more than held';
    end if;
    v_proceeds := p_count::bigint * p_price_c - p_fee_c;
    v_basis    := round((v_pos.cost_c::numeric / v_pos.contracts) * p_count);
    v_realized := v_proceeds - v_basis;
    v_cash := v_cash + v_proceeds;
    v_realized_total := v_realized_total + v_realized;
    if v_pos.contracts - p_count = 0 then
      delete from public.positions
        where user_id = p_user and ticker = p_ticker and side = p_side;
    else
      update public.positions
        set contracts = contracts - p_count, cost_c = cost_c - v_basis
        where user_id = p_user and ticker = p_ticker and side = p_side;
    end if;

  else
    raise exception 'invalid action: %', p_action;
  end if;

  update public.accounts
    set cash_c = v_cash, realized_pnl_c = v_realized_total, updated_at = now()
    where id = p_user;

  insert into public.fills (user_id, ts, ticker, matchup, team, side, action,
                            count, price_c, fee_c, realized_c, cash_after_c)
    values (p_user, p_ts, p_ticker, p_matchup, p_team, p_side, p_action,
            p_count, p_price_c, p_fee_c, v_realized, v_cash)
    returning * into v_fill;

  return v_fill;
end;
$$;

revoke execute on function public.apply_trade(uuid,text,text,text,int,int,int,text,text,bigint) from public;
grant  execute on function public.apply_trade(uuid,text,text,text,int,int,int,text,text,bigint) to service_role;

-- The "Enable automatic RLS" project setting installs public.rls_auto_enable() as a
-- SECURITY DEFINER event-trigger function; by default PUBLIC can call it over the API.
-- Revoke that (the event trigger still fires on DDL). Guarded so this file applies on
-- projects that don't have the setting enabled.
do $$
begin
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'rls_auto_enable'
  ) then
    execute 'revoke execute on function public.rls_auto_enable() from public, anon, authenticated';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- settle_market: settle a user's positions on a resolved market (port of paper.py settle())
-- ---------------------------------------------------------------------------
-- Called lazily by the server (service_role) when it sees a held market has resolved: each
-- held side pays $1/contract if it won else $0, the position closes, and a 'settle' fill is
-- recorded. Returns the number of positions settled.
create or replace function public.settle_market(p_user uuid, p_ticker text, p_result text, p_ts bigint)
returns integer
language plpgsql
security definer set search_path = ''
as $$
declare
  v_pos            public.positions%rowtype;
  v_cash           bigint;
  v_realized_total bigint;
  v_payout         bigint;
  v_pnl            bigint;
  v_n              integer := 0;
begin
  if p_result not in ('yes','no') then
    return 0;
  end if;
  select cash_c, realized_pnl_c into v_cash, v_realized_total
    from public.accounts where id = p_user for update;
  if not found then
    return 0;
  end if;

  for v_pos in
    select * from public.positions where user_id = p_user and ticker = p_ticker
  loop
    v_payout := case when v_pos.side = p_result then v_pos.contracts::bigint * 100 else 0 end;
    v_pnl := v_payout - v_pos.cost_c;
    v_cash := v_cash + v_payout;
    v_realized_total := v_realized_total + v_pnl;
    delete from public.positions
      where user_id = p_user and ticker = p_ticker and side = v_pos.side;
    insert into public.fills (user_id, ts, ticker, matchup, team, side, action,
                              count, price_c, fee_c, realized_c, cash_after_c)
      values (p_user, p_ts, p_ticker, v_pos.matchup, v_pos.team, v_pos.side, 'settle',
              v_pos.contracts, case when v_pos.side = p_result then 100 else 0 end, 0, v_pnl, v_cash);
    v_n := v_n + 1;
  end loop;

  if v_n > 0 then
    update public.accounts
      set cash_c = v_cash, realized_pnl_c = v_realized_total, updated_at = now()
      where id = p_user;
  end if;
  return v_n;
end;
$$;

revoke execute on function public.settle_market(uuid,text,text,bigint) from public;
grant  execute on function public.settle_market(uuid,text,text,bigint) to service_role;

-- ---------------------------------------------------------------------------
-- leaderboard: a public-read snapshot of each player's standings
-- ---------------------------------------------------------------------------
-- Only non-sensitive columns live here (username + equity/P&L), so public SELECT is safe
-- without an RLS-bypassing view. The server (service_role) maintains it; clients only read.
create table public.leaderboard (
  id             uuid primary key references auth.users(id) on delete cascade,
  username       text   not null,
  equity_c       bigint not null,
  realized_pnl_c bigint not null,
  total_pnl_c    bigint not null,
  updated_at     timestamptz not null default now()
);
alter table public.leaderboard enable row level security;
create policy "leaderboard is public" on public.leaderboard
  for select to anon, authenticated using (true);
grant select on public.leaderboard to anon, authenticated;

-- ---------------------------------------------------------------------------
-- service_role grants
-- ---------------------------------------------------------------------------
-- service_role (the server's secret key) bypasses RLS but still needs table-level
-- privileges, and "Automatically expose new tables" is off, so grant them explicitly.
-- This role is server-only (never shipped to a browser), so full DML here is expected.
grant select, insert, update, delete on public.accounts    to service_role;
grant select, insert, update, delete on public.positions   to service_role;
grant select, insert, update, delete on public.fills       to service_role;
grant select, insert, update, delete on public.profiles    to service_role;
grant select, insert, update, delete on public.leaderboard to service_role;
grant usage, select on all sequences in schema public to service_role;
