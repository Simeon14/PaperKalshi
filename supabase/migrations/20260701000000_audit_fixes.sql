-- Audit fixes (2026-07-01), applied to the live DB via the Supabase MCP (execute_sql),
-- kept here as the source-of-truth record per the project convention.
--
--   1. Username policy is enforced IN the database, not just in the signup route. Anyone
--      holding the public URL + publishable key can call auth.signup directly with arbitrary
--      user_metadata, so the trigger and a check constraint are the real gate.
--   2. settle_market learns 'void': Kalshi occasionally voids a market (result = 'void');
--      a void unwinds the trade, refunding exactly what was paid with zero P&L. Without
--      this, positions on voided markets were pinned forever.
--   3. accounts.equity_c was never written after signup (the leaderboard table holds the
--      real snapshot), so the dead column is dropped.

-- ---------------------------------------------------------------------------
-- 1a. profiles.username must match the app's username policy at the DB level
-- ---------------------------------------------------------------------------
-- Pre-checked: no existing row violates this.
alter table public.profiles
  add constraint profiles_username_format check (username ~ '^[a-z0-9_]{3,20}$');

-- ---------------------------------------------------------------------------
-- 1b. handle_new_user: never trust raw_user_meta_data verbatim
-- ---------------------------------------------------------------------------
-- Normalizes the requested username and falls back to a generated name when it does not
-- match the policy, so a direct-API signup can neither impersonate ("AJS" next to "ajs")
-- nor break with an opaque constraint error. Legit signups already validated in the route.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = ''
as $$
declare
  v_username text;
begin
  v_username := lower(trim(coalesce(new.raw_user_meta_data->>'username', '')));
  if v_username !~ '^[a-z0-9_]{3,20}$' then
    v_username := 'player_' || left(new.id::text, 8);
  end if;
  insert into public.profiles (id, username) values (new.id, v_username);
  insert into public.accounts (id) values (new.id);  -- column defaults give the $100k account
  return new;
end;
$$;

revoke execute on function public.handle_new_user() from public;

-- ---------------------------------------------------------------------------
-- 2. settle_market: add the 'void' result (refund at cost, zero P&L)
-- ---------------------------------------------------------------------------
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
  v_price          integer;
  v_n              integer := 0;
begin
  if p_result not in ('yes','no','void') then
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
    if p_result = 'void' then
      -- A void unwinds the trade: refund exactly what was paid (fees included in cost_c).
      v_payout := v_pos.cost_c;
      v_pnl    := 0;
      v_price  := round(v_pos.cost_c::numeric / v_pos.contracts);
    else
      v_payout := case when v_pos.side = p_result then v_pos.contracts::bigint * 100 else 0 end;
      v_pnl    := v_payout - v_pos.cost_c;
      v_price  := case when v_pos.side = p_result then 100 else 0 end;
    end if;
    v_cash := v_cash + v_payout;
    v_realized_total := v_realized_total + v_pnl;
    delete from public.positions
      where user_id = p_user and ticker = p_ticker and side = v_pos.side;
    insert into public.fills (user_id, ts, ticker, matchup, team, side, action,
                              count, price_c, fee_c, realized_c, cash_after_c)
      values (p_user, p_ts, p_ticker, v_pos.matchup, v_pos.team, v_pos.side, 'settle',
              v_pos.contracts, v_price, 0, v_pnl, v_cash);
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
-- 3. Drop the dead equity snapshot column (the leaderboard table is the snapshot)
-- ---------------------------------------------------------------------------
alter table public.accounts drop column equity_c;
