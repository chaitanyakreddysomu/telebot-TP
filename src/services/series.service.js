import { supabase } from '../config/supabase.js';
import { env } from '../config/env.js';
import { rupeesToPaise } from '../utils/money.js';

const columns = 'id,series_name,platform,duration,price,channel_id,is_active';
function mapSeries(row) {
  return { id: String(row.id), name: row.series_name, platform: row.platform, episodeCount: Number(row.duration || 0),
    pricePaise: rupeesToPaise(row.price), channelId: row.channel_id || null };
}
export async function listSeries(page = 0, pageSize = 8) {
  const from = page * pageSize;
  const { data, error } = await supabase.from(env.SUPABASE_SERIES_TABLE).select(columns).eq('is_active', true)
    .ilike('platform', '%pocket%').order('series_name').range(from, from + pageSize);
  if (error) throw error;
  const rows = data || [];
  return { items: rows.slice(0, pageSize).map(mapSeries), hasNext: rows.length > pageSize };
}
export async function getSeries(id) {
  const { data, error } = await supabase.from(env.SUPABASE_SERIES_TABLE).select(columns).eq('id', id).eq('is_active', true).maybeSingle();
  if (error) throw error;
  return data ? mapSeries(data) : null;
}

export async function getSeriesByName(payload) {
  let seriesName = String(payload || '').trim();
  try { seriesName = decodeURIComponent(seriesName); } catch {}
  // Telegram deep-link payloads cannot contain spaces; underscores are treated as spaces.
  seriesName = seriesName.replace(/_/g, ' ');
  if (!seriesName) return null;

  const { data, error } = await supabase.from(env.SUPABASE_SERIES_TABLE).select(columns)
    .eq('is_active', true).ilike('platform', '%pocket%').ilike('series_name', seriesName).limit(2);
  if (error) throw error;
  if (!data?.length) return null;
  if (data.length > 1) throw new Error('More than one series matches this start link.');
  return mapSeries(data[0]);
}
