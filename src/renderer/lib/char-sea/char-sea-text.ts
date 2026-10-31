/**
 * What the sea of characters is written in: one passage of prose per script,
 * laid one character to a cell in the reader's direction. The passages are
 * original to Drifting (no author's text is read). Fonts are the bundled
 * structure faces where the app ships them; Japanese and Arabic fall back to
 * the system's serif faces.
 */

export type CharSeaScript = 'zh' | 'ja' | 'en' | 'ar';

export interface CharSeaLanguage {
  /** Canvas font stack for the glyph atlas. */
  font: string;
  /** The face to wait for before drawing the atlas again. */
  loadFace: string;
  /** Cell size in CSS px. */
  cellWidth: number;
  cellHeight: number;
  /** Glyph size as a share of the cell height. */
  size: number;
  rtl: boolean;
  text: string;
}

export const CHAR_SEA_LANGUAGES: Record<CharSeaScript, CharSeaLanguage> = {
  zh: {
    font: '"Noto Serif SC Variable", "Songti SC", serif',
    loadFace: '"Noto Serif SC Variable"',
    cellWidth: 14,
    cellHeight: 14,
    size: 0.74,
    rtl: false,
    text:
      '雾从港口那边漫过来的时候，林岚正把第三封信压在灯座底下。灯塔的铁梯被潮气浸得发凉，她每往上走一级，脚下就响一声，像有人在楼下跟着数。' +
      '守塔人说今晚不会有船。她没有回答，只是把窗推开一道缝，让海风翻动桌上的信纸。纸角卷起来，露出背面一行很淡的铅笔字，那是她自己的笔迹，可她不记得什么时候写过。' +
      '远处的雾笛响了两声，停了，又响了一声。她数着灯转过的圈数，数到第七圈的时候，海面上亮起一点很小的光，像有人在水底下划了一根火柴。' +
      '那光不往岸边来，也不往外走，只在原地一明一灭。她想起父亲说过，雾最浓的夜里，旧码头会自己记起从前的船。信封上的邮戳已经洇开了，只剩一个“北”字还看得清。',
  },
  ja: {
    font: '"Hiragino Mincho ProN", "Yu Mincho", "Noto Serif JP", serif',
    loadFace: '"Hiragino Mincho ProN"',
    cellWidth: 14,
    cellHeight: 14,
    size: 0.74,
    rtl: false,
    text:
      '霧が港のほうから流れてきたとき、リンは三通目の手紙を灯台のランプの下にはさんでいた。鉄の階段は湿気で冷たく、一段のぼるたびに小さな音がして、まるで誰かが下で数えているようだった。' +
      '灯台守は今夜は船が来ないと言った。彼女は答えずに、窓を少しだけ開けて、海風に机の上の便箋をめくらせた。紙の端がめくれて、裏にうすい鉛筆の字が一行あらわれた。自分の字なのに、いつ書いたのか思い出せない。' +
      '遠くで霧笛が二度鳴り、止まり、また一度鳴った。光が七回めぐったころ、海の上に小さな明かりがともった。水の底で誰かがマッチをすったように。',
  },
  en: {
    font: '"Newsreader Variable", Georgia, serif',
    loadFace: '"Newsreader Variable"',
    cellWidth: 9,
    cellHeight: 14,
    size: 0.7,
    rtl: false,
    text:
      'The fog came in from the harbour while Lin was tucking the third letter under the lamp. The iron stairs of the lighthouse were cold with damp, and every step gave a small sound, as if someone below were counting. ' +
      'The keeper said no boats would come tonight. She did not answer. She opened the window a crack and let the sea wind turn the pages on the desk, and a corner lifted to show a faint line of pencil on the back, in her own hand, though she could not remember writing it. ' +
      'Far off the foghorn sounded twice, stopped, and sounded once more. On the seventh turn of the light a small glow rose on the water, as if someone under the sea had struck a match. ',
  },
  ar: {
    font: '"Geeza Pro", "Noto Naskh Arabic", "Traditional Arabic", serif',
    loadFace: '"Geeza Pro"',
    cellWidth: 10,
    cellHeight: 14,
    size: 0.68,
    rtl: true,
    text:
      'جاء الضباب من جهة الميناء حين كانت لينا تضع الرسالة الثالثة تحت قاعدة المصباح. كان درج المنارة الحديدي باردا من الرطوبة، وكلما صعدت درجة سمعت صوتا خافتا، كأن أحدا في الأسفل يعد خطواتها. ' +
      'قال حارس المنارة إن السفن لن تأتي الليلة. لم تجب، بل فتحت النافذة قليلا وتركت ريح البحر تقلب الأوراق على الطاولة، فظهر على ظهر إحداها سطر باهت بالقلم الرصاص، بخطها هي، ولم تتذكر متى كتبته. ' +
      'من بعيد انطلق بوق الضباب مرتين، ثم سكت، ثم انطلق مرة أخرى. وفي الدورة السابعة للضوء لمع على الماء نور صغير، كأن أحدا تحت البحر أشعل عود ثقاب. ',
  },
};

/** The script for an interface language: Chinese, Japanese and Arabic write their own; everything else Latin. */
export function charSeaScript(locale: string | undefined): CharSeaScript {
  const code = (locale ?? '').toLowerCase();
  if (code.startsWith('zh')) return 'zh';
  if (code.startsWith('ja')) return 'ja';
  if (code.startsWith('ar')) return 'ar';
  return 'en';
}
