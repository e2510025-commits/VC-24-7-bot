import { getUserLanguage } from '../database/userSettings.js';

const DEFAULT_LANGUAGE = 'ja';
const SUPPORTED_LANGUAGES = ['ja', 'en', 'ko'];

const MESSAGES = {
  ja: {
    'common.guildOnly': '❌ サーバー内で実行してください',
    'common.adminOnly': '❌ このコマンドはサーバー管理者のみ実行できます',
    'common.botNoRolePerm': '❌ Botにロール管理権限がありません',
    'common.commandFailed': '❌ コマンド実行中にエラーが発生しました',
    'common.unknownSubcommand': '❌ 不明なサブコマンドです',
    'language.set': '✅ 言語を {languageLabel} に設定しました',
    'language.current': '✅ 現在の言語は {languageLabel} です',
    'auth.roleNotSet': '❌ 認証ロールが未設定です。管理者に `/auth-admin set-role` を依頼してください。',
    'auth.questionMissing': '❌ 認証問題が見つかりませんでした。もう一度 `/auth` を実行してください。',
    'auth.timeLimit': '❌ 制限時間を超過しました。もう一度 `/auth` を実行してください。',
    'auth.numericOnly': '❌ 数字で回答してください。',
    'auth.wrong': '❌ 不正解です。もう一度 `/auth` を実行してください。',
    'auth.memberMissing': '❌ サーバーメンバー情報の取得に失敗しました。',
    'auth.roleMissing': '❌ 認証ロールが見つかりません。管理者に確認してください。',
    'auth.roleNotManageable': '❌ Botの権限が不足しています。ロールの順序を確認してください。',
    'auth.alreadyVerified': '✅ すでに認証済みです ({role}).',
    'auth.success': '✅ 認証成功！ {role} を付与しました。',
    'auth.failed': '❌ 認証処理でエラーが発生しました',
    'auth.assignFailed': '❌ 認証ロールの付与に失敗しました。',
    'authAdmin.roleSet': '✅ 認証ロールを {role} に設定しました',
    'authAdmin.roleCleared': '✅ 認証ロールを解除しました',
    'authAdmin.show': '✅ 認証ロール: {role}',
    'osuRoleSetup.created': '✅ 作成: {roles}',
    'osuRoleSetup.exists': 'ℹ️ 既存: {roles}',
    'osuRoleSetup.none': '❌ ロールを作成できませんでした。権限やロール上限を確認してください。',
    'osuRoleSetup.failed': '❌ ロール作成中にエラーが発生しました'
  },
  en: {
    'common.guildOnly': '❌ Please run this command in a server.',
    'common.adminOnly': '❌ This command is for server admins only.',
    'common.botNoRolePerm': '❌ The bot lacks Manage Roles permission.',
    'common.commandFailed': '❌ An error occurred while executing the command.',
    'common.unknownSubcommand': '❌ Unknown subcommand.',
    'language.set': '✅ Language set to {languageLabel}.',
    'language.current': '✅ Current language is {languageLabel}.',
    'auth.roleNotSet': '❌ Verification role is not set. Ask an admin to run `/auth-admin set-role`.',
    'auth.questionMissing': '❌ The question was not found. Please run `/auth` again.',
    'auth.timeLimit': '❌ Time limit exceeded. Please run `/auth` again.',
    'auth.numericOnly': '❌ Please answer with a number.',
    'auth.wrong': '❌ Incorrect. Please run `/auth` again.',
    'auth.memberMissing': '❌ Failed to fetch your server member data.',
    'auth.roleMissing': '❌ Verification role not found. Ask an admin to check it.',
    'auth.roleNotManageable': '❌ The bot cannot manage that role. Check role order.',
    'auth.alreadyVerified': '✅ You are already verified ({role}).',
    'auth.success': '✅ Verified! Assigned {role}.',
    'auth.failed': '❌ An error occurred during verification.',
    'auth.assignFailed': '❌ Failed to assign the verification role.',
    'authAdmin.roleSet': '✅ Verification role set to {role}.',
    'authAdmin.roleCleared': '✅ Verification role cleared.',
    'authAdmin.show': '✅ Verification role: {role}',
    'osuRoleSetup.created': '✅ Created: {roles}',
    'osuRoleSetup.exists': 'ℹ️ Existing: {roles}',
    'osuRoleSetup.none': '❌ Could not create roles. Check permissions or role limit.',
    'osuRoleSetup.failed': '❌ An error occurred while creating roles.'
  },
  ko: {
    'common.guildOnly': '❌ 서버에서 실행해 주세요.',
    'common.adminOnly': '❌ 이 명령어는 서버 관리자만 사용할 수 있습니다.',
    'common.botNoRolePerm': '❌ 봇에 역할 관리 권한이 없습니다.',
    'common.commandFailed': '❌ 명령 실행 중 오류가 발생했습니다.',
    'common.unknownSubcommand': '❌ 알 수 없는 하위 명령입니다.',
    'language.set': '✅ 언어를 {languageLabel}(으)로 설정했습니다.',
    'language.current': '✅ 현재 언어는 {languageLabel} 입니다.',
    'auth.roleNotSet': '❌ 인증 역할이 설정되지 않았습니다. 관리자에게 `/auth-admin set-role` 을 요청하세요.',
    'auth.questionMissing': '❌ 인증 문제가 없습니다. `/auth` 를 다시 실행해 주세요.',
    'auth.timeLimit': '❌ 제한 시간이 초과되었습니다. `/auth` 를 다시 실행해 주세요.',
    'auth.numericOnly': '❌ 숫자로 답해주세요.',
    'auth.wrong': '❌ 틀렸습니다. `/auth` 를 다시 실행해 주세요.',
    'auth.memberMissing': '❌ 서버 멤버 정보를 가져오지 못했습니다.',
    'auth.roleMissing': '❌ 인증 역할을 찾을 수 없습니다. 관리자에게 확인해 달라고 요청하세요.',
    'auth.roleNotManageable': '❌ 봇이 해당 역할을 관리할 수 없습니다. 역할 순서를 확인해 주세요.',
    'auth.alreadyVerified': '✅ 이미 인증되었습니다 ({role}).',
    'auth.success': '✅ 인증 성공! {role} 역할이 부여되었습니다.',
    'auth.failed': '❌ 인증 처리 중 오류가 발생했습니다.',
    'auth.assignFailed': '❌ 인증 역할 부여에 실패했습니다.',
    'authAdmin.roleSet': '✅ 인증 역할을 {role}(으)로 설정했습니다.',
    'authAdmin.roleCleared': '✅ 인증 역할을 해제했습니다.',
    'authAdmin.show': '✅ 인증 역할: {role}',
    'osuRoleSetup.created': '✅ 생성됨: {roles}',
    'osuRoleSetup.exists': 'ℹ️ 기존: {roles}',
    'osuRoleSetup.none': '❌ 역할을 만들 수 없습니다. 권한 또는 역할 수 제한을 확인하세요.',
    'osuRoleSetup.failed': '❌ 역할 생성 중 오류가 발생했습니다.'
  }
};

const LANGUAGE_LABELS = {
  ja: '日本語',
  en: 'English',
  ko: '한국어'
};

export function getLanguageLabel(language) {
  return LANGUAGE_LABELS[language] || LANGUAGE_LABELS[DEFAULT_LANGUAGE];
}

export async function resolveUserLanguage(discordId) {
  const lang = await getUserLanguage(discordId).catch(() => null);
  return SUPPORTED_LANGUAGES.includes(lang) ? lang : DEFAULT_LANGUAGE;
}

export function translate(language, key, params = {}) {
  const lang = SUPPORTED_LANGUAGES.includes(language) ? language : DEFAULT_LANGUAGE;
  const dictionary = MESSAGES[lang] || MESSAGES[DEFAULT_LANGUAGE];
  const template = dictionary[key] || MESSAGES[DEFAULT_LANGUAGE][key] || key;

  return template.replace(/\{(\w+)\}/g, (_, token) => {
    return token in params ? String(params[token]) : `{${token}}`;
  });
}
