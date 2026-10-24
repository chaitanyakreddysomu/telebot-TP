alter table public.payment_orders
  add column if not exists telegram_chat_id bigint,
  add column if not exists telegram_order_message_id bigint;
