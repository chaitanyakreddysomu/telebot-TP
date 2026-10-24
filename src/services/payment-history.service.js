import { supabase } from '../config/supabase.js';
import { env } from '../config/env.js';

export async function recordVerifiedPayment(order) {
  let seriesName = order.series?.series_name;
  if (!seriesName) {
    const { data: series, error: seriesError } = await supabase.from(env.SUPABASE_SERIES_TABLE)
      .select('series_name').eq('id', order.series_id).maybeSingle();
    if (seriesError) throw seriesError;
    seriesName = series?.series_name || null;
  }

  const { error } = await supabase.from('payments').upsert({
    payment_order_id: order.id,
    user_id: String(order.telegram_user_id),
    full_name: order.telegram_first_name || null,
    username: order.telegram_username || null,
    series_name: seriesName,
  }, { onConflict: 'payment_order_id', ignoreDuplicates: true });
  if (error) throw error;
}
