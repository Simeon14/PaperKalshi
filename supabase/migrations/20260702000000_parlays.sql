-- Same-game parlays (2026-07-02). Applied to the live DB via the Supabase MCP (execute_sql),
-- kept here as the source-of-truth record per the project convention.
--
-- A parlay is a single ticket that pays out only if EVERY leg wins. The user buys `count`
-- tickets at a correlation-aware `price_c` (1..99c) computed server-side by our pricing engine
-- from live Kalshi marginals; each ticket pays $1 if the parlay wins, $0 if any leg loses.
--
-- Money integrity mirrors the rest of the app (see 20260630000000_init.sql): the browser may
-- only READ its own parlays; every cash mutation goes through a SECURITY DEFINER function called
-- with the service_role key after the server has re-priced the order against fresh Kalshi quotes.
-- The client's displayed price is never trusted.

-- ---------------------------------------------------------------------------
-- parlays: one row per placed parlay ticket
-- ---------------------------------------------------------------------------
create table public.parlays (
  id         uuid    primary key default gen_random_uuid(),
  user_id    uuid    not null references auth.users (id) on delete cascade,
  created_ts bigint  not null,
  count      integer not null check (count > 0),
  price_c    integer not null check (price_c between 1 and 99),
  cost_c     bigint  not null,
  status     text    not null default 'open' check (status in ('open','won','lost','void','cashed')),
  payout_c   bigint,
  settled_ts bigint,
  legs       jsonb   not null,   -- [{ticker, side, type, team, matchup, group, mid_c}]
  snapshot   jsonb   not null    -- {marginals, rho, legs_order, corr_version, model_version, mode, seed}
);
create index parlays_user_status_idx on public.parlays (user_id, status);

-- ---------------------------------------------------------------------------
-- Row Level Security: read-own, write-nothing for clients (same model as the rest)
-- ---------------------------------------------------------------------------
alter table public.parlays enable row level security;

create policy "read own parlays" on public.parlays
  for select to authenticated using ((select auth.uid()) = user_id);

-- "Automatically expose new tables" is OFF, so grant read to authenticated explicitly (RLS still
-- limits it to the owner) and full DML to the server's service_role (which bypasses RLS).
grant select on public.parlays to authenticated;
grant select, insert, update, delete on public.parlays to service_role;

-- ---------------------------------------------------------------------------
-- apply_parlay: the atomic money mutation for placing a parlay (modeled on apply_trade)
-- ---------------------------------------------------------------------------
-- The trusted server decides the price/count/cost/legs/snapshot (it has the live quotes and the
-- engine) and passes them in. This function does the integrity-critical part atomically: it locks
-- the account row, checks funds, deducts the stake (p_cost_c), inserts the parlay, and writes a
-- blotter fill. Execute is revoked from PUBLIC and granted only to service_role, so a logged-in
-- user can never call it with a made-up price.
--
-- The stake p_cost_c is passed EXPLICITLY (not derived from count*price_c): in contracts mode it
-- equals count*price_c, but in dollars mode it is the exact dollar stake, so a $20 parlay costs
-- exactly $20 and pays the true stake*multiple on a win. `count` is the (implied) number of
-- $1-payout contracts, kept for the blotter and the per-contract settle price.
create or replace function public.apply_parlay(
  p_user uuid, p_count int, p_price_c int, p_cost_c bigint, p_legs jsonb, p_snapshot jsonb, p_ts bigint
) returns public.parlays
language plpgsql
security definer set search_path = ''
as $$
declare
  v_cash    bigint;
  v_parlay  public.parlays%rowtype;
begin
  if p_cost_c <= 0 then
    raise exception 'invalid parlay cost';
  end if;
  -- Lock the account row; concurrent trades/parlays for this user now serialize on it.
  select cash_c into v_cash from public.accounts where id = p_user for update;
  if not found then
    raise exception 'no account for user';
  end if;

  if p_cost_c > v_cash then
    raise exception 'insufficient cash';
  end if;
  v_cash := v_cash - p_cost_c;

  insert into public.parlays (user_id, created_ts, count, price_c, cost_c, status, legs, snapshot)
    values (p_user, p_ts, p_count, p_price_c, p_cost_c, 'open', p_legs, p_snapshot)
    returning * into v_parlay;

  update public.accounts set cash_c = v_cash, updated_at = now() where id = p_user;

  insert into public.fills (user_id, ts, ticker, matchup, team, side, action,
                            count, price_c, fee_c, realized_c, cash_after_c)
    values (p_user, p_ts, 'PARLAY-' || left(v_parlay.id::text, 8), 'Parlay',
            jsonb_array_length(p_legs)::text || '-leg parlay', 'yes', 'buy',
            p_count, p_price_c, 0, 0, v_cash);

  return v_parlay;
end;
$$;

revoke execute on function public.apply_parlay(uuid,int,int,bigint,jsonb,jsonb,bigint) from public;
grant  execute on function public.apply_parlay(uuid,int,int,bigint,jsonb,jsonb,bigint) to service_role;

-- ---------------------------------------------------------------------------
-- settle_parlay: settle an open parlay (won / lost / void), atomically
-- ---------------------------------------------------------------------------
-- Called by the server (service_role) once it has evaluated the legs against resolved Kalshi
-- markets and computed the payout (won pays the void-adjusted potential; lost pays 0; void
-- refunds cost). Credits the payout, books payout-cost as realized P&L, stamps the row, and
-- writes a 'settle' fill. Idempotent: the status guard means a second call is a no-op.
create or replace function public.settle_parlay(
  p_parlay uuid, p_status text, p_payout_c bigint, p_ts bigint
) returns public.parlays
language plpgsql
security definer set search_path = ''
as $$
declare
  v_parlay public.parlays%rowtype;
  v_cash   bigint;
  v_realized_total bigint;
  v_pnl    bigint;
  v_price  integer;
begin
  if p_status not in ('won','lost','void') then
    raise exception 'invalid parlay status: %', p_status;
  end if;

  -- Lock the parlay row and bail if it is already settled (idempotence).
  select * into v_parlay from public.parlays where id = p_parlay for update;
  if not found or v_parlay.status <> 'open' then
    return v_parlay;
  end if;

  select cash_c, realized_pnl_c into v_cash, v_realized_total
    from public.accounts where id = v_parlay.user_id for update;
  if not found then
    return v_parlay;
  end if;

  v_pnl  := p_payout_c - v_parlay.cost_c;
  v_cash := v_cash + p_payout_c;
  v_realized_total := v_realized_total + v_pnl;
  -- Settle-fill price is the realized value per ticket (0 on a loss, 100 on a clean win,
  -- the entry price on a full void); always within 0..100 since removing legs only raises the
  -- joint probability, so the per-ticket payout can never exceed 100c.
  v_price := round(p_payout_c::numeric / v_parlay.count);

  update public.parlays
    set status = p_status, payout_c = p_payout_c, settled_ts = p_ts
    where id = p_parlay;

  update public.accounts
    set cash_c = v_cash, realized_pnl_c = v_realized_total, updated_at = now()
    where id = v_parlay.user_id;

  insert into public.fills (user_id, ts, ticker, matchup, team, side, action,
                            count, price_c, fee_c, realized_c, cash_after_c)
    values (v_parlay.user_id, p_ts, 'PARLAY-' || left(v_parlay.id::text, 8), 'Parlay',
            jsonb_array_length(v_parlay.legs)::text || '-leg parlay', 'yes', 'settle',
            v_parlay.count, v_price, 0, v_pnl, v_cash);

  v_parlay.status := p_status;
  v_parlay.payout_c := p_payout_c;
  v_parlay.settled_ts := p_ts;
  return v_parlay;
end;
$$;

revoke execute on function public.settle_parlay(uuid,text,bigint,bigint) from public;
grant  execute on function public.settle_parlay(uuid,text,bigint,bigint) to service_role;

-- ---------------------------------------------------------------------------
-- cashout_parlay: close an OPEN parlay early at the current marked value
-- ---------------------------------------------------------------------------
-- Lets a user cash out before the legs resolve. Credits the server-computed marked value, books
-- value - cost as realized P&L, stamps the row 'cashed', and writes a 'cashout' fill. Idempotent
-- via the status guard. The trusted server computes p_value_c from fresh Kalshi quotes (the
-- client value is never trusted), and refuses to cash out a parlay that has already resolved (a
-- lost leg settles it as a loss instead).
create or replace function public.cashout_parlay(p_parlay uuid, p_value_c bigint, p_ts bigint)
returns public.parlays
language plpgsql
security definer set search_path = ''
as $$
declare
  v_parlay public.parlays%rowtype;
  v_cash   bigint;
  v_realized_total bigint;
  v_pnl    bigint;
  v_price  integer;
begin
  if p_value_c < 0 then
    raise exception 'invalid cashout value';
  end if;
  select * into v_parlay from public.parlays where id = p_parlay for update;
  if not found or v_parlay.status <> 'open' then
    return v_parlay;
  end if;
  select cash_c, realized_pnl_c into v_cash, v_realized_total
    from public.accounts where id = v_parlay.user_id for update;
  if not found then
    return v_parlay;
  end if;

  v_pnl  := p_value_c - v_parlay.cost_c;
  v_cash := v_cash + p_value_c;
  v_realized_total := v_realized_total + v_pnl;
  v_price := round(p_value_c::numeric / v_parlay.count);

  update public.parlays
    set status = 'cashed', payout_c = p_value_c, settled_ts = p_ts
    where id = p_parlay;
  update public.accounts
    set cash_c = v_cash, realized_pnl_c = v_realized_total, updated_at = now()
    where id = v_parlay.user_id;
  insert into public.fills (user_id, ts, ticker, matchup, team, side, action,
                            count, price_c, fee_c, realized_c, cash_after_c)
    values (v_parlay.user_id, p_ts, 'PARLAY-' || left(v_parlay.id::text, 8), 'Parlay',
            jsonb_array_length(v_parlay.legs)::text || '-leg parlay', 'yes', 'cashout',
            v_parlay.count, v_price, 0, v_pnl, v_cash);

  v_parlay.status := 'cashed';
  v_parlay.payout_c := p_value_c;
  v_parlay.settled_ts := p_ts;
  return v_parlay;
end;
$$;

revoke execute on function public.cashout_parlay(uuid,bigint,bigint) from public;
grant  execute on function public.cashout_parlay(uuid,bigint,bigint) to service_role;
