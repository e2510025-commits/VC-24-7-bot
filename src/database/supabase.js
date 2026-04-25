import { createClient } from '@supabase/supabase-js';

let supabaseClient = null;

function getSupabaseKey() {
  return process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
}

export function getSupabaseClient() {
  if (supabaseClient) {
    return supabaseClient;
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = getSupabaseKey();

  if (!supabaseUrl || !supabaseKey) {
    throw new Error('SUPABASE_URL と SUPABASE_SERVICE_ROLE_KEY (または SUPABASE_ANON_KEY) を設定してください');
  }

  supabaseClient = createClient(supabaseUrl, supabaseKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false
    }
  });

  return supabaseClient;
}

export async function upsertUserLink(discordId, osuUsername) {
  const client = getSupabaseClient();
  const { data, error } = await client
    .from('user_links')
    .upsert(
      {
        discord_id: discordId,
        osu_username: osuUsername
      },
      { onConflict: 'discord_id' }
    )
    .select('discord_id, osu_username')
    .single();

  if (error) {
    throw error;
  }

  return data;
}

export async function getLinkedOsuUsername(discordId) {
  const client = getSupabaseClient();
  const { data, error } = await client
    .from('user_links')
    .select('osu_username')
    .eq('discord_id', discordId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data?.osu_username ?? null;
}