create extension if not exists pgcrypto;

create table if not exists public.payment_orders (
  id uuid primary key default gen_random_uuid(),
  telegram_user_id bigint not null,
  telegram_username text,
  telegram_first_name text,
  telegram_chat_id bigint,
  telegram_order_message_id bigint,
  series_id text not null,
  amount_paise bigint not null check (amount_paise > 0),
  merchant_name text not null,
  merchant_upi_id text not null,
  transaction_note text not null unique,
  checkout_token_hash text not null unique,
  status text not null default 'pending' check (status in ('pending','proof_submitted','under_review','verified','rejected','expired','delivery_pending','delivered')),
  verification_source text,
  expires_at timestamptz not null,
  verified_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists payment_orders_user_idx on public.payment_orders(telegram_user_id);
create index if not exists payment_orders_status_idx on public.payment_orders(status);
create index if not exists payment_orders_expiry_idx on public.payment_orders(expires_at) where status in ('pending','proof_submitted');

create table if not exists public.payment_proofs (
  id uuid primary key default gen_random_uuid(), order_id uuid not null references public.payment_orders(id) on delete cascade,
  storage_path text not null, extracted_payment_status text, extracted_amount_paise bigint,
  extracted_transaction_note text, extracted_payer_name text, extracted_payer_upi_id text,
  extracted_transaction_id text, ocr_text text, ocr_status text not null, review_status text not null,
  ocr_match_score integer check (ocr_match_score between 0 and 100), ocr_match_details jsonb,
  created_at timestamptz not null default now()
);
alter table public.payment_proofs add column if not exists ocr_match_score integer check (ocr_match_score between 0 and 100);
alter table public.payment_proofs add column if not exists ocr_match_details jsonb;
drop index if exists public.payment_proofs_transaction_id_unique;
create index if not exists payment_proofs_order_idx on public.payment_proofs(order_id);

create table if not exists public.payment_transaction_refs (
  normalized_transaction_id text primary key,
  order_id uuid not null references public.payment_orders(id) on delete cascade,
  proof_id uuid not null references public.payment_proofs(id) on delete cascade,
  created_at timestamptz not null default now()
);
insert into public.payment_transaction_refs(normalized_transaction_id, order_id, proof_id)
select upper(extracted_transaction_id), order_id, id from public.payment_proofs
where extracted_transaction_id is not null
on conflict (normalized_transaction_id) do nothing;

create table if not exists public.deliveries (
  id uuid primary key default gen_random_uuid(), order_id uuid not null unique references public.payment_orders(id) on delete cascade,
  series_id text not null, telegram_user_id bigint not null, telegram_invite_link text,
  telegram_message_id bigint, status text not null default 'pending', delivered_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists deliveries_user_idx on public.deliveries(telegram_user_id);

create or replace function public.reserve_order_delivery(p_order_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  order_row public.payment_orders%rowtype;
begin
  select * into order_row from public.payment_orders where id = p_order_id for update;
  if not found or order_row.status not in ('verified','delivery_pending') then
    raise exception 'order is not eligible for delivery';
  end if;
  insert into public.deliveries(order_id, series_id, telegram_user_id, status)
  values (order_row.id, order_row.series_id, order_row.telegram_user_id, 'pending')
  on conflict (order_id) do nothing;
  return found;
end;
$$;
revoke all on function public.reserve_order_delivery(uuid) from public, anon, authenticated;
grant execute on function public.reserve_order_delivery(uuid) to service_role;

alter table public.payment_orders enable row level security;
alter table public.payment_orders add column if not exists verification_source text;
alter table public.payment_proofs enable row level security;
alter table public.deliveries enable row level security;
alter table public.payment_transaction_refs enable row level security;
