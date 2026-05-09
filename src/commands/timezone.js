import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { resolveUserLanguage, translate } from '../utils/i18n.js';
import { log } from '../utils/logger.js';

const ZONE_DEFINITIONS = [
  {
    id: 'Asia/Tokyo',
    labels: { ja: '日本', en: 'Japan' },
    aliases: ['japan', 'jp', 'jpn', 'tokyo', '日本', '東京']
  },
  {
    id: 'Asia/Seoul',
    labels: { ja: '韓国', en: 'Korea' },
    aliases: ['korea', 'kr', 'kor', 'seoul', '韓国', 'ソウル']
  },
  {
    id: 'Asia/Shanghai',
    labels: { ja: '中国', en: 'China' },
    aliases: ['china', 'cn', 'chn', 'shanghai', '中国', '上海']
  },
  {
    id: 'Asia/Taipei',
    labels: { ja: '台湾', en: 'Taiwan' },
    aliases: ['taiwan', 'tw', 'twn', 'taipei', '台湾', '台北']
  },
  {
    id: 'Asia/Hong_Kong',
    labels: { ja: '香港', en: 'Hong Kong' },
    aliases: ['hong kong', 'hongkong', 'hk', 'hkg', '香港']
  },
  {
    id: 'Asia/Singapore',
    labels: { ja: 'シンガポール', en: 'Singapore' },
    aliases: ['singapore', 'sg', 'sgp', 'シンガポール']
  },
  {
    id: 'Asia/Bangkok',
    labels: { ja: 'タイ', en: 'Thailand' },
    aliases: ['thailand', 'th', 'tha', 'bangkok', 'タイ', 'バンコク']
  },
  {
    id: 'Asia/Ho_Chi_Minh',
    labels: { ja: 'ベトナム', en: 'Vietnam' },
    aliases: ['vietnam', 'vn', 'vnm', 'ho chi minh', 'ベトナム']
  },
  {
    id: 'Asia/Manila',
    labels: { ja: 'フィリピン', en: 'Philippines' },
    aliases: ['philippines', 'ph', 'phl', 'manila', 'フィリピン', 'マニラ']
  },
  {
    id: 'Asia/Kuala_Lumpur',
    labels: { ja: 'マレーシア', en: 'Malaysia' },
    aliases: ['malaysia', 'my', 'mys', 'kuala lumpur', 'マレーシア']
  },
  {
    id: 'Asia/Jakarta',
    labels: { ja: 'インドネシア', en: 'Indonesia' },
    aliases: ['indonesia', 'id', 'idn', 'jakarta', 'インドネシア']
  },
  {
    id: 'Asia/Kolkata',
    labels: { ja: 'インド', en: 'India' },
    aliases: ['india', 'in', 'ind', 'kolkata', 'インド']
  },
  {
    id: 'Asia/Dubai',
    labels: { ja: 'UAE', en: 'UAE' },
    aliases: ['uae', 'united arab emirates', 'dubai', 'アラブ首長国連邦']
  },
  {
    id: 'Asia/Riyadh',
    labels: { ja: 'サウジアラビア', en: 'Saudi Arabia' },
    aliases: ['saudi', 'saudi arabia', 'sa', 'riyadh', 'サウジアラビア']
  },
  {
    id: 'Asia/Jerusalem',
    labels: { ja: 'イスラエル', en: 'Israel' },
    aliases: ['israel', 'il', 'jerusalem', 'イスラエル']
  },
  {
    id: 'Europe/Istanbul',
    labels: { ja: 'トルコ', en: 'Turkey' },
    aliases: ['turkey', 'tr', 'istanbul', 'トルコ']
  },
  {
    id: 'Europe/Moscow',
    labels: { ja: 'ロシア(モスクワ)', en: 'Russia (Moscow)' },
    aliases: ['russia', 'ru', 'moscow', 'ロシア', 'モスクワ']
  },
  {
    id: 'Europe/London',
    labels: { ja: 'イギリス', en: 'United Kingdom' },
    aliases: ['uk', 'united kingdom', 'britain', 'england', 'london', 'イギリス', '英国']
  },
  {
    id: 'Europe/Dublin',
    labels: { ja: 'アイルランド', en: 'Ireland' },
    aliases: ['ireland', 'ie', 'dublin', 'アイルランド']
  },
  {
    id: 'Europe/Paris',
    labels: { ja: 'フランス', en: 'France' },
    aliases: ['france', 'fr', 'paris', 'フランス', 'パリ']
  },
  {
    id: 'Europe/Berlin',
    labels: { ja: 'ドイツ', en: 'Germany' },
    aliases: ['germany', 'de', 'berlin', 'ドイツ', 'ベルリン']
  },
  {
    id: 'Europe/Madrid',
    labels: { ja: 'スペイン', en: 'Spain' },
    aliases: ['spain', 'es', 'madrid', 'スペイン', 'マドリード']
  },
  {
    id: 'Europe/Rome',
    labels: { ja: 'イタリア', en: 'Italy' },
    aliases: ['italy', 'it', 'rome', 'イタリア', 'ローマ']
  },
  {
    id: 'Europe/Amsterdam',
    labels: { ja: 'オランダ', en: 'Netherlands' },
    aliases: ['netherlands', 'nl', 'amsterdam', 'オランダ', 'アムステルダム']
  },
  {
    id: 'Europe/Stockholm',
    labels: { ja: 'スウェーデン', en: 'Sweden' },
    aliases: ['sweden', 'se', 'stockholm', 'スウェーデン']
  },
  {
    id: 'Europe/Oslo',
    labels: { ja: 'ノルウェー', en: 'Norway' },
    aliases: ['norway', 'no', 'oslo', 'ノルウェー']
  },
  {
    id: 'Europe/Helsinki',
    labels: { ja: 'フィンランド', en: 'Finland' },
    aliases: ['finland', 'fi', 'helsinki', 'フィンランド']
  },
  {
    id: 'Europe/Warsaw',
    labels: { ja: 'ポーランド', en: 'Poland' },
    aliases: ['poland', 'pl', 'warsaw', 'ポーランド']
  },
  {
    id: 'Europe/Zurich',
    labels: { ja: 'スイス', en: 'Switzerland' },
    aliases: ['switzerland', 'ch', 'zurich', 'スイス']
  },
  {
    id: 'Africa/Johannesburg',
    labels: { ja: '南アフリカ', en: 'South Africa' },
    aliases: ['south africa', 'za', 'johannesburg', '南アフリカ']
  },
  {
    id: 'Africa/Cairo',
    labels: { ja: 'エジプト', en: 'Egypt' },
    aliases: ['egypt', 'eg', 'cairo', 'エジプト']
  },
  {
    id: 'Africa/Nairobi',
    labels: { ja: 'ケニア', en: 'Kenya' },
    aliases: ['kenya', 'ke', 'nairobi', 'ケニア']
  },
  {
    id: 'America/New_York',
    labels: { ja: 'アメリカ(東部)', en: 'USA (ET)' },
    aliases: ['usa', 'us', 'united states', 'us east', 'us-east', 'new york', 'ny', 'アメリカ', '米国', 'ニューヨーク']
  },
  {
    id: 'America/Chicago',
    labels: { ja: 'アメリカ(中部)', en: 'USA (CT)' },
    aliases: ['us central', 'us-central', 'central us', 'chicago', 'シカゴ']
  },
  {
    id: 'America/Denver',
    labels: { ja: 'アメリカ(山岳)', en: 'USA (MT)' },
    aliases: ['us mountain', 'us-mountain', 'mountain us', 'denver', 'デンバー']
  },
  {
    id: 'America/Los_Angeles',
    labels: { ja: 'アメリカ(西部)', en: 'USA (PT)' },
    aliases: ['us west', 'us-west', 'west us', 'los angeles', 'la', 'ロサンゼルス']
  },
  {
    id: 'America/Toronto',
    labels: { ja: 'カナダ(東部)', en: 'Canada (ET)' },
    aliases: ['canada', 'ca', 'toronto', 'カナダ', 'トロント']
  },
  {
    id: 'America/Mexico_City',
    labels: { ja: 'メキシコ', en: 'Mexico' },
    aliases: ['mexico', 'mx', 'mexico city', 'メキシコ']
  },
  {
    id: 'America/Sao_Paulo',
    labels: { ja: 'ブラジル', en: 'Brazil' },
    aliases: ['brazil', 'br', 'sao paulo', 'サンパウロ', 'ブラジル']
  },
  {
    id: 'America/Argentina/Buenos_Aires',
    labels: { ja: 'アルゼンチン', en: 'Argentina' },
    aliases: ['argentina', 'ar', 'buenos aires', 'アルゼンチン']
  },
  {
    id: 'America/Santiago',
    labels: { ja: 'チリ', en: 'Chile' },
    aliases: ['chile', 'cl', 'santiago', 'チリ']
  },
  {
    id: 'America/Lima',
    labels: { ja: 'ペルー', en: 'Peru' },
    aliases: ['peru', 'pe', 'lima', 'ペルー']
  },
  {
    id: 'Australia/Sydney',
    labels: { ja: 'オーストラリア(東部)', en: 'Australia (Sydney)' },
    aliases: ['australia', 'au', 'sydney', 'オーストラリア', 'シドニー']
  },
  {
    id: 'Australia/Perth',
    labels: { ja: 'オーストラリア(西部)', en: 'Australia (Perth)' },
    aliases: ['perth', 'オーストラリア西部']
  },
  {
    id: 'Pacific/Auckland',
    labels: { ja: 'ニュージーランド', en: 'New Zealand' },
    aliases: ['new zealand', 'nz', 'auckland', 'ニュージーランド']
  }
];

const ALIAS_MAP = new Map();
for (const entry of ZONE_DEFINITIONS) {
  for (const alias of entry.aliases) {
    ALIAS_MAP.set(String(alias).trim().toLowerCase(), entry);
  }
  ALIAS_MAP.set(entry.id.toLowerCase(), entry);
}

function resolveZone(input) {
  const trimmed = String(input || '').trim();
  if (!trimmed) {
    return null;
  }

  if (/^[A-Za-z]+\/[A-Za-z0-9_+-]+$/.test(trimmed)) {
    return { id: trimmed, labels: { ja: trimmed, en: trimmed } };
  }

  return ALIAS_MAP.get(trimmed.toLowerCase()) || null;
}

function getOffsetMinutes(timeZone, date) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  });

  const parts = formatter.formatToParts(date);
  const lookup = Object.create(null);
  for (const part of parts) {
    if (part.type !== 'literal') {
      lookup[part.type] = part.value;
    }
  }

  const utcTime = Date.UTC(
    Number(lookup.year),
    Number(lookup.month) - 1,
    Number(lookup.day),
    Number(lookup.hour),
    Number(lookup.minute),
    Number(lookup.second)
  );

  return Math.round((utcTime - date.getTime()) / 60000);
}

function formatTimeLabel(date, timeZone, lang) {
  const locale = lang === 'en' ? 'en-US' : 'ja-JP';
  return new Intl.DateTimeFormat(locale, {
    timeZone,
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: lang === 'en'
  }).format(date);
}

function formatDiffMinutes(diffMinutes) {
  const sign = diffMinutes >= 0 ? '+' : '-';
  const abs = Math.abs(diffMinutes);
  const hours = Math.floor(abs / 60);
  const minutes = abs % 60;
  return `${sign}${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

export const data = new SlashCommandBuilder()
  .setName('timezone')
  .setDescription('指定した国/タイムゾーンの時差を表示します')
  .addStringOption(option =>
    option
      .setName('base')
      .setDescription('基準となる国/タイムゾーン')
      .setRequired(true)
  )
  .addStringOption(option =>
    option
      .setName('target')
      .setDescription('知りたい国/タイムゾーン')
      .setRequired(true)
  );

export async function execute(interaction) {
  await interaction.deferReply();
  const lang = await resolveUserLanguage(interaction.user.id);

  try {
    const baseInput = interaction.options.getString('base');
    const targetInput = interaction.options.getString('target');

    const baseZone = resolveZone(baseInput);
    const targetZone = resolveZone(targetInput);

    if (!baseZone || !targetZone) {
      return interaction.editReply(
        translate(lang, 'timezone.invalidZone', {
          base: baseInput,
          target: targetInput
        })
      );
    }

    const now = new Date();
    const baseOffset = getOffsetMinutes(baseZone.id, now);
    const targetOffset = getOffsetMinutes(targetZone.id, now);
    const diffMinutes = targetOffset - baseOffset;

    const baseLabel = baseZone.labels[lang] || baseZone.labels.ja || baseZone.id;
    const targetLabel = targetZone.labels[lang] || targetZone.labels.ja || targetZone.id;

    const embed = new EmbedBuilder()
      .setColor('#5865F2')
      .setTitle(translate(lang, 'timezone.title'))
      .addFields(
        {
          name: translate(lang, 'timezone.baseLabel'),
          value: `${baseLabel} (${baseZone.id})\n${formatTimeLabel(now, baseZone.id, lang)}`,
          inline: true
        },
        {
          name: translate(lang, 'timezone.targetLabel'),
          value: `${targetLabel} (${targetZone.id})\n${formatTimeLabel(now, targetZone.id, lang)}`,
          inline: true
        },
        {
          name: translate(lang, 'timezone.diffLabel'),
          value: translate(lang, 'timezone.diffFormat', {
            diff: formatDiffMinutes(diffMinutes),
            base: baseLabel,
            target: targetLabel
          })
        }
      )
      .setTimestamp(now);

    return interaction.editReply({ embeds: [embed] });
  } catch (error) {
    log(`/timezone エラー: ${error.message}`, 'error');
    return interaction.editReply(translate(lang, 'timezone.failed'));
  }
}
