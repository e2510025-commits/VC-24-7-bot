import osu from 'osu.js';
import { log } from './logger.js';

const OSU_BASE_URL = 'https://osu.ppy.sh';
const TOKEN_ENDPOINT = `${OSU_BASE_URL}/oauth/token`;

let accessToken = null;
let accessTokenExpiresAt = 0;

// osu.js is requested as a dependency, but v2 data fetching is done via official OAuth2 REST endpoints.
if (typeof osu?.api !== 'function') {
  throw new Error('osu.js の読み込みに失敗しました');
}

export class OsuApiError extends Error {
  constructor(message, status = 500, details = null) {
    super(message);
    this.name = 'OsuApiError';
    this.status = status;
    this.details = details;
  }
}

const numberFormatter = new Intl.NumberFormat('ja-JP');

function parseOsuClientId(rawValue) {
  const clientId = Number(rawValue);
  if (!Number.isFinite(clientId)) {
    throw new OsuApiError('OSU_CLIENT_ID が数値ではありません', 500);
  }
  return clientId;
}

function getOsuCredentials() {
  const rawClientId = process.env.OSU_CLIENT_ID;
  const clientSecret = process.env.OSU_CLIENT_SECRET;

  if (!rawClientId || !clientSecret) {
    throw new OsuApiError('OSU_CLIENT_ID と OSU_CLIENT_SECRET を設定してください', 500);
  }

  return {
    clientId: parseOsuClientId(rawClientId),
    clientSecret
  };
}

async function safeJson(response) {
  const body = await response.text();
  if (!body) {
    return null;
  }

  try {
    return JSON.parse(body);
  } catch {
    return { raw: body };
  }
}

function toOsuApiError(status, payload) {
  if (status === 404) {
    return new OsuApiError('指定した osu! ユーザーが見つかりませんでした', status, payload);
  }

  if (status === 429) {
    return new OsuApiError('osu! API のレート制限に達しました。時間をおいて再実行してください', status, payload);
  }

  if (status === 401 || status === 403) {
    return new OsuApiError('osu! API 認証に失敗しました。Client ID / Secret を確認してください', status, payload);
  }

  const details = payload?.error || payload?.message;
  const suffix = details ? `: ${details}` : '';
  return new OsuApiError(`osu! API エラー (${status})${suffix}`, status, payload);
}

export async function getOsuAccessToken(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && accessToken && now < accessTokenExpiresAt - 60_000) {
    return accessToken;
  }

  const { clientId, clientSecret } = getOsuCredentials();
  let response;

  try {
    response = await fetch(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json'
      },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: 'client_credentials',
        scope: 'public'
      })
    });
  } catch (error) {
    throw new OsuApiError(`osu! API への接続に失敗しました: ${error.message}`, 503, error);
  }

  const payload = await safeJson(response);
  if (!response.ok || !payload?.access_token) {
    throw toOsuApiError(response.status, payload);
  }

  accessToken = payload.access_token;
  const expiresIn = Number(payload.expires_in) || 3600;
  accessTokenExpiresAt = now + expiresIn * 1000;
  log('osu! API トークンを更新しました', 'info');

  return accessToken;
}

async function osuGet(path, query = {}, canRetry = true) {
  const token = await getOsuAccessToken();
  const url = new URL(path, OSU_BASE_URL);

  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null) {
      url.searchParams.set(key, String(value));
    }
  }

  let response;

  try {
    response = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json'
      }
    });
  } catch (error) {
    throw new OsuApiError(`osu! API への接続に失敗しました: ${error.message}`, 503, error);
  }

  const payload = await safeJson(response);

  if (response.status === 401 && canRetry) {
    await getOsuAccessToken(true);
    return osuGet(path, query, false);
  }

  if (!response.ok) {
    throw toOsuApiError(response.status, payload);
  }

  return payload;
}

export async function fetchOsuUser(usernameOrId, mode = 'osu') {
  const target = String(usernameOrId || '').trim();
  if (!target) {
    throw new OsuApiError('osu! ユーザー名を指定してください', 400);
  }

  const isNumericId = /^\d+$/.test(target);

  if (isNumericId) {
    try {
      return await osuGet(`/api/v2/users/${encodeURIComponent(target)}/${mode}`);
    } catch (error) {
      if (!(error instanceof OsuApiError) || error.status !== 404) {
        throw error;
      }
      // Numeric usernames exist, so retry as username lookup when ID lookup fails.
      return osuGet(`/api/v2/users/${encodeURIComponent(`@${target}`)}/${mode}`);
    }
  }

  return osuGet(`/api/v2/users/${encodeURIComponent(`@${target}`)}/${mode}`);
}

export async function fetchRecentScores(userIdOrName, mode = 'osu', limit = 1) {
  const target = String(userIdOrName || '').trim();
  if (!target) {
    throw new OsuApiError('osu! ユーザー名を指定してください', 400);
  }

  return osuGet(`/api/v2/users/${encodeURIComponent(target)}/scores/recent`, {
    mode,
    include_fails: 1,
    limit
  });
}

export async function fetchBeatmap(beatmapId) {
  const target = String(beatmapId || '').trim();
  if (!target) {
    return null;
  }

  return osuGet(`/api/v2/beatmaps/${encodeURIComponent(target)}`);
}

export function formatNumber(value) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) {
    return 'N/A';
  }
  return numberFormatter.format(numericValue);
}

export function formatPercent(value) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) {
    return 'N/A';
  }
  return `${numericValue.toFixed(2)}%`;
}

export function formatRatioPercent(value) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) {
    return 'N/A';
  }
  return `${(numericValue * 100).toFixed(2)}%`;
}

export function formatPlayTime(seconds) {
  const total = Number(seconds);
  if (!Number.isFinite(total) || total < 0) {
    return 'N/A';
  }

  const days = Math.floor(total / 86_400);
  const hours = Math.floor((total % 86_400) / 3_600);
  const minutes = Math.floor((total % 3_600) / 60);

  const parts = [];
  if (days > 0) parts.push(`${days}日`);
  if (hours > 0) parts.push(`${hours}時間`);
  parts.push(`${minutes}分`);

  return parts.join(' ');
}

export function toDiscordTimestamp(dateLike) {
  if (!dateLike) {
    return 'N/A';
  }

  const timestamp = new Date(dateLike).getTime();
  if (!Number.isFinite(timestamp)) {
    return 'N/A';
  }

  const unix = Math.floor(timestamp / 1000);
  return `<t:${unix}:F> (<t:${unix}:R>)`;
}