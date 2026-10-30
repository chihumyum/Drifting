const zh = {
  loading: '正在打开…',
  notFound: '这个分享链接已失效，或者作者已经停止分享。',
  loadFailed: '暂时打不开这个分享，请稍后再试。',
  retry: '重试',
  sharedBy: (name: string) => (name ? `${name} 分享` : '分享的稿件'),
  updatedAt: (time: string) => `更新于 ${time}`,
  updatedNow: '作者刚刚更新了内容',
  commentsClosed: '作者已关闭评论',
  comments: '评论',
  commentCount: (count: number) => (count ? `评论 ${count}` : '评论'),
  addComment: '评论',
  placeholder: '写下你的想法…',
  post: '发布',
  posting: '发布中…',
  cancel: '取消',
  close: '关闭',
  resolved: '已解决',
  withdraw: '撤回',
  you: '我',
  passageChanged: '原文已改动',
  signIn: '登录',
  signUp: '注册',
  signOut: '退出登录',
  name: '昵称',
  email: '邮箱',
  password: '密码',
  code: '验证码',
  codeSent: (email: string) => `验证码已发送到 ${email}`,
  verify: '验证并登录',
  haveAccount: '已有账号？登录',
  needAccount: '没有账号？注册',
  signedInAs: (name: string) => `已登录：${name}`,
  outline: '大纲',
  hiddenItems: (count: number) => `还有 ${count} 项`,
  chapterNumber: (n: number) => `第 ${n} 章`,
  words: (n: number) => `${n.toLocaleString('zh-CN')} 字`,
  kinds: { chapter: '章节', drift: '构想', element: '要素', storyline: '故事线', category: '类目' } as Record<'chapter' | 'drift' | 'element' | 'storyline' | 'category', string>,
  errors: {
    INVALID_EMAIL_OR_PASSWORD: '邮箱或密码不对。',
    USER_ALREADY_EXISTS: '这个邮箱已经注册过了，请直接登录。',
    INVALID_OTP: '验证码不对或已过期。',
    PASSWORD_TOO_SHORT: '密码至少需要 8 位。',
    RATE_LIMITED: '操作太频繁了，请稍后再试。',
    COMMENTS_DISABLED: '作者已关闭评论。',
    NEEDS_SIGN_IN: '请先登录。',
    OFFLINE: '网络连接不上。',
    fallback: '出了点问题，请再试一次。',
  } as Record<string, string>,
};

type Strings = typeof zh;

const en: Strings = {
  loading: 'Opening…',
  notFound: 'This share link is no longer valid, or the author stopped sharing.',
  loadFailed: 'This share cannot be opened right now. Please try again later.',
  retry: 'Retry',
  sharedBy: (name: string) => (name ? `Shared by ${name}` : 'Shared manuscript'),
  updatedAt: (time: string) => `Updated ${time}`,
  updatedNow: 'The author just updated this text',
  commentsClosed: 'The author has turned comments off',
  comments: 'Comments',
  commentCount: (count: number) => (count ? `Comments ${count}` : 'Comments'),
  addComment: 'Comment',
  placeholder: 'Share your thoughts…',
  post: 'Post',
  posting: 'Posting…',
  cancel: 'Cancel',
  close: 'Close',
  resolved: 'Resolved',
  withdraw: 'Withdraw',
  you: 'You',
  passageChanged: 'Passage changed',
  signIn: 'Sign in',
  signUp: 'Sign up',
  signOut: 'Sign out',
  name: 'Name',
  email: 'Email',
  password: 'Password',
  code: 'Verification code',
  codeSent: (email: string) => `We sent a code to ${email}`,
  verify: 'Verify and sign in',
  haveAccount: 'Have an account? Sign in',
  needAccount: 'No account? Sign up',
  signedInAs: (name: string) => `Signed in as ${name}`,
  outline: 'Outline',
  hiddenItems: (count: number) => `${count} more`,
  chapterNumber: (n: number) => `Chapter ${n}`,
  words: (n: number) => `${n.toLocaleString('en')} words`,
  kinds: { chapter: 'Chapter', drift: 'Drift', element: 'Element', storyline: 'Storyline', category: 'Category' },
  errors: {
    INVALID_EMAIL_OR_PASSWORD: 'The email or password is incorrect.',
    USER_ALREADY_EXISTS: 'This email is already registered. Please sign in.',
    INVALID_OTP: 'The code is wrong or has expired.',
    PASSWORD_TOO_SHORT: 'The password needs at least 8 characters.',
    RATE_LIMITED: 'Too many attempts. Please wait a moment.',
    COMMENTS_DISABLED: 'The author has turned comments off.',
    NEEDS_SIGN_IN: 'Please sign in first.',
    OFFLINE: 'Cannot reach the network.',
    fallback: 'Something went wrong. Please try again.',
  },
};

export const locale = typeof navigator !== 'undefined' && !navigator.language.toLowerCase().startsWith('zh') ? 'en' : 'zh';
export const t: Strings = locale === 'zh' ? zh : en;

const ALIASES: Record<string, string> = {
  HTTP_429: 'RATE_LIMITED',
  USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL: 'USER_ALREADY_EXISTS',
  INVALID_PASSWORD: 'INVALID_EMAIL_OR_PASSWORD',
};

export function errorText(code: string): string {
  return t.errors[ALIASES[code] ?? code] ?? t.errors.fallback!;
}

export function formatTime(iso: string): string {
  const date = new Date(iso);
  const minutes = Math.round((Date.now() - date.getTime()) / 60_000);
  const relative = new Intl.RelativeTimeFormat(locale === 'zh' ? 'zh-CN' : 'en', { numeric: 'auto' });
  if (minutes < 1) return relative.format(0, 'minute');
  if (minutes < 60) return relative.format(-minutes, 'minute');
  if (minutes < 24 * 60) return relative.format(-Math.round(minutes / 60), 'hour');
  return date.toLocaleDateString(locale === 'zh' ? 'zh-CN' : 'en', { month: 'short', day: 'numeric' });
}
