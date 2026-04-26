import osu from 'osu.js';
import { log } from './logger.js';

const OSU_BASE_URL = 'https://osu.ppy.sh';
const TOKEN_ENDPOINT = `${OSU_BASE_URL}/oauth/token`;
const OSU_API_CACHE_SECONDS = Math.max(0, Number(process.env.OSU_API_CACHE_SECONDS || 20));
const OSU_API_MIN_INTERVAL_MS = Math.max(0, Number(process.env.OSU_API_MIN_INTERVAL_MS || 120));
const OSU_API_MAX_RETRIES = Math.max(0, Number(process.env.OSU_API_MAX_RETRIES || 3));

let accessToken = null;
let accessTokenExpiresAt = 0;
let requestChain = Promise.resolve();
let lastApiRequestAt = 0;
const responseCache = new Map();

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
const MODE_ALIAS_MAP = {
  std: 'osu',
  standard: 'osu',
  osu: 'osu',
  mania: 'mania',
  catch: 'fruits',
  fruits: 'fruits',
  taiko: 'taiko'
};
const MODE_LABEL_MAP = {
  osu: 'std',
  mania: 'mania',
  fruits: 'catch',
  taiko: 'taiko'
};

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

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function deepClone(value) {
  if (typeof globalThis.structuredClone === 'function') {
    return globalThis.structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value));
}

function sortedQueryEntries(query) {
  return Object.entries(query || {})
    .filter(([, value]) => value !== undefined && value !== null)
    .sort(([a], [b]) => a.localeCompare(b));
}

function buildCacheKey(path, query) {
  const serialized = sortedQueryEntries(query)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join('&');
  return `${path}?${serialized}`;
}

function getCachedResponse(cacheKey) {
  if (OSU_API_CACHE_SECONDS <= 0) {
    return null;
  }

  const cached = responseCache.get(cacheKey);
  if (!cached) {
    return null;
  }

  if (cached.expiresAt <= Date.now()) {
    responseCache.delete(cacheKey);
    return null;
  }

  return deepClone(cached.payload);
}

function setCachedResponse(cacheKey, payload) {
  if (OSU_API_CACHE_SECONDS <= 0) {
    return;
  }

  responseCache.set(cacheKey, {
    payload: deepClone(payload),
    expiresAt: Date.now() + OSU_API_CACHE_SECONDS * 1000
  });
}

function shouldRetryStatus(status) {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

async function scheduleApiRequest(task) {
  const run = requestChain.then(async () => {
    const now = Date.now();
    const waitMs = OSU_API_MIN_INTERVAL_MS - (now - lastApiRequestAt);
    if (waitMs > 0) {
      await sleep(waitMs);
    }
    lastApiRequestAt = Date.now();
    return task();
  });

  requestChain = run.then(
    () => undefined,
    () => undefined
  );

  return run;
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

async function osuGet(path, query = {}, options = {}) {
  const canRetryAuth = options.canRetryAuth !== false;
  const retryCount = Number(options.retryCount || 0);
  const noCache = options.noCache === true;
  const cacheKey = buildCacheKey(path, query);

  if (!noCache) {
    const cached = getCachedResponse(cacheKey);
    if (cached) {
      return cached;
    }
  }

  const token = await getOsuAccessToken();
  const url = new URL(path, OSU_BASE_URL);

  for (const [key, value] of sortedQueryEntries(query)) {
      url.searchParams.set(key, String(value));
  }

  let response;

  try {
    const request = () =>
      fetch(url, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json'
        }
      });

    response = await scheduleApiRequest(request);
  } catch (error) {
    throw new OsuApiError(`osu! API への接続に失敗しました: ${error.message}`, 503, error);
  }

  const payload = await safeJson(response);

  if (response.status === 401 && canRetryAuth) {
    await getOsuAccessToken(true);
    return osuGet(path, query, { ...options, canRetryAuth: false });
  }

  if (!response.ok && shouldRetryStatus(response.status) && retryCount < OSU_API_MAX_RETRIES) {
    const retryAfterHeader = Number(response.headers.get('retry-after'));
    const backoffMs = Number.isFinite(retryAfterHeader)
      ? Math.max(500, retryAfterHeader * 1000)
      : Math.min(5000, 500 * (retryCount + 1));
    await sleep(backoffMs);
    return osuGet(path, query, {
      ...options,
      retryCount: retryCount + 1,
      canRetryAuth: false,
      noCache: true
    });
  }

  if (!response.ok) {
    throw toOsuApiError(response.status, payload);
  }

  if (!noCache) {
    setCachedResponse(cacheKey, payload);
  }

  return payload;
}

async function osuGetOrNull(path, query = {}) {
  try {
    return await osuGet(path, query);
  } catch (error) {
    if (error instanceof OsuApiError && error.status === 404) {
      return null;
    }
    throw error;
  }
}

function buildUserPath(identifier, mode = null) {
  const suffix = mode ? `/${mode}` : '';
  return `/api/v2/users/${encodeURIComponent(identifier)}${suffix}`;
}

export function normalizeOsuMode(mode = 'osu') {
  const key = String(mode || 'osu').trim().toLowerCase();
  return MODE_ALIAS_MAP[key] || 'osu';
}

export function getModeLabel(mode = 'osu') {
  const normalized = normalizeOsuMode(mode);
  return MODE_LABEL_MAP[normalized] || normalized;
}

export async function fetchOsuUser(usernameOrId, mode = null) {
  const rawTarget = String(usernameOrId || '').trim();
  if (!rawTarget) {
    throw new OsuApiError('osu! ユーザー名を指定してください', 400);
  }

  const target = rawTarget.startsWith('@') ? rawTarget.slice(1) : rawTarget;
  if (!target) {
    throw new OsuApiError('osu! ユーザー名を指定してください', 400);
  }

  const normalizedMode = mode ? normalizeOsuMode(mode) : null;
  const isNumericId = /^\d+$/.test(target);
  const atTarget = `@${target}`;

  const attempts = [];

  if (isNumericId) {
    attempts.push({ path: buildUserPath(target, normalizedMode) });
    attempts.push({ path: buildUserPath(atTarget, normalizedMode) });
    attempts.push({ path: buildUserPath(target, normalizedMode), query: { key: 'username' } });
  } else {
    attempts.push({ path: buildUserPath(atTarget, normalizedMode) });
    attempts.push({ path: buildUserPath(target, normalizedMode), query: { key: 'username' } });
    attempts.push({ path: buildUserPath(target, normalizedMode) });
  }

  for (const attempt of attempts) {
    const user = await osuGetOrNull(attempt.path, attempt.query || {});
    if (user) {
      return user;
    }
  }

  const lookedUpUser = await osuGetOrNull('/api/v2/users/lookup', {
    key: 'username',
    username: target
  });

  if (lookedUpUser?.id) {
    if (normalizedMode) {
      const userByMode = await osuGetOrNull(buildUserPath(String(lookedUpUser.id), normalizedMode));
      if (userByMode) {
        return userByMode;
      }
    }
    return lookedUpUser;
  }

  throw new OsuApiError('指定した osu! ユーザーが見つかりませんでした', 404);
}

export async function fetchRecentScores(userIdOrName, mode = 'osu', limit = 1) {
  const target = String(userIdOrName || '').trim();
  if (!target) {
    throw new OsuApiError('osu! ユーザー名を指定してください', 400);
  }

  const normalizedMode = normalizeOsuMode(mode);

  return osuGet(`/api/v2/users/${encodeURIComponent(target)}/scores/recent`, {
    mode: normalizedMode,
    include_fails: 1,
    limit
  }, { noCache: true });
}

export async function fetchBestScores(userIdOrName, mode = 'osu', limit = 1) {
  const target = String(userIdOrName || '').trim();
  if (!target) {
    throw new OsuApiError('osu! ユーザー名を指定してください', 400);
  }

  const normalizedMode = normalizeOsuMode(mode);

  return osuGet(`/api/v2/users/${encodeURIComponent(target)}/scores/best`, {
    mode: normalizedMode,
    limit
  }, { noCache: true });
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