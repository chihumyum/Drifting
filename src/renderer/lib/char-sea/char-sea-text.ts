/**
 * What the sea of characters is written in: one passage of prose per script,
 * laid one character to a cell in the reader's direction. The passages are
 * original to Drifting (no author's text is read): the same scene in each
 * interface language. Fonts are the bundled structure faces where the app
 * ships them; Traditional Chinese, Korean, Japanese and Arabic fall back to
 * the system's serif faces. The Latin passages share English's narrow cells.
 */

export type CharSeaScript = 'zh' | 'zh-TW' | 'ja' | 'ko' | 'en' | 'es' | 'de' | 'fr' | 'pt' | 'ar';

/** The Latin passages' face and cells: narrow, like rows of movable type. */
const LATIN = {
  font: '"Newsreader Variable", Georgia, serif',
  loadFace: '"Newsreader Variable"',
  cellWidth: 6.5,
  cellHeight: 10,
  size: 0.72,
  rtl: false,
} as const;

export interface CharSeaLanguage {
  /** Canvas font stack for the glyph atlas. */
  font: string;
  /** The face to wait for before drawing the atlas again. */
  loadFace: string;
  /** Cell size in CSS px: 10px rows, fine enough for the loading word's serifs to land on. */
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
    cellWidth: 10,
    cellHeight: 10,
    size: 0.8,
    rtl: false,
    text:
      '雾从港口那边漫过来的时候，林岚正把第三封信压在灯座底下。灯塔的铁梯被潮气浸得发凉，她每往上走一级，脚下就响一声，像有人在楼下跟着数。' +
      '守塔人说今晚不会有船。她没有回答，只是把窗推开一道缝，让海风翻动桌上的信纸。纸角卷起来，露出背面一行很淡的铅笔字，那是她自己的笔迹，可她不记得什么时候写过。' +
      '远处的雾笛响了两声，停了，又响了一声。她数着灯转过的圈数，数到第七圈的时候，海面上亮起一点很小的光，像有人在水底下划了一根火柴。' +
      '那光不往岸边来，也不往外走，只在原地一明一灭。她想起父亲说过，雾最浓的夜里，旧码头会自己记起从前的船。信封上的邮戳已经洇开了，只剩一个“北”字还看得清。',
  },
  'zh-TW': {
    font: '"Songti TC", "Noto Serif CJK TC", "PMingLiU", serif',
    loadFace: '"Songti TC"', cellWidth: 10, cellHeight: 10, size: 0.8, rtl: false,
    text: '霧從港口那邊漫過來的時候，林嵐正把第三封信壓在燈座底下。燈塔的鐵梯被潮氣浸得發涼，她每往上走一級，腳下就響一聲，像有人在樓下跟著數。守塔人說今晚不會有船。她沒有回答，只是把窗推開一道縫，讓海風翻動桌上的信紙。紙角捲起來，露出背面一行很淡的鉛筆字，那是她自己的筆跡，可她不記得什麼時候寫過。遠處的霧笛響了兩聲，停了，又響了一聲。她數著燈轉過的圈數，數到第七圈的時候，海面上亮起一點很小的光，像有人在水底下劃了一根火柴。',
  },
  ko: {
    font: '"AppleMyungjo", "Batang", "Noto Serif CJK KR", serif',
    loadFace: '"AppleMyungjo"', cellWidth: 10, cellHeight: 10, size: 0.8, rtl: false,
    text: '항구에서 안개가 밀려올 때, 린은 세 번째 편지를 등잔 밑에 끼워 두었다. 등대의 철제 계단은 습기를 머금어 차가웠다. 한 계단을 오를 때마다 아래에서 누군가 발걸음을 세는 듯 작은 소리가 났다. 등대지기는 오늘 밤 배가 오지 않을 거라고 말했다. 린은 대답 대신 창문을 조금 열었다. 바닷바람이 책상 위 편지지를 넘기자 뒷면에 희미한 연필 글씨가 드러났다. 분명 자신의 글씨였지만 언제 썼는지는 기억나지 않았다. 멀리서 안개 속 뱃고동이 두 번 울렸다. 등대의 빛이 일곱 번째로 바다를 비추었을 때, 물속에서 성냥을 켠 것처럼 작은 불빛 하나가 나타났다.',
  },
  ja: {
    font: '"Hiragino Mincho ProN", "Yu Mincho", "Noto Serif JP", serif',
    loadFace: '"Hiragino Mincho ProN"',
    cellWidth: 10,
    cellHeight: 10,
    size: 0.8,
    rtl: false,
    text:
      '霧が港のほうから流れてきたとき、リンは三通目の手紙を灯台のランプの下にはさんでいた。鉄の階段は湿気で冷たく、一段のぼるたびに小さな音がして、まるで誰かが下で数えているようだった。' +
      '灯台守は今夜は船が来ないと言った。彼女は答えずに、窓を少しだけ開けて、海風に机の上の便箋をめくらせた。紙の端がめくれて、裏にうすい鉛筆の字が一行あらわれた。自分の字なのに、いつ書いたのか思い出せない。' +
      '遠くで霧笛が二度鳴り、止まり、また一度鳴った。光が七回めぐったころ、海の上に小さな明かりがともった。水の底で誰かがマッチをすったように。',
  },
  en: {
    ...LATIN,
    text:
      'The fog came in from the harbour while Lin was tucking the third letter under the lamp. The iron stairs of the lighthouse were cold with damp, and every step gave a small sound, as if someone below were counting. ' +
      'The keeper said no boats would come tonight. She did not answer. She opened the window a crack and let the sea wind turn the pages on the desk, and a corner lifted to show a faint line of pencil on the back, in her own hand, though she could not remember writing it. ' +
      'Far off the foghorn sounded twice, stopped, and sounded once more. On the seventh turn of the light a small glow rose on the water, as if someone under the sea had struck a match. ',
  },
  es: {
    ...LATIN,
    text:
      'La niebla entró desde el puerto mientras Lin metía la tercera carta bajo la lámpara. La escalera de hierro del faro estaba fría de humedad, y cada peldaño daba un sonido pequeño, como si alguien abajo fuera contando. ' +
      'El farero dijo que esta noche no vendría ningún barco. Ella no respondió. Abrió apenas la ventana y dejó que el viento del mar pasara las hojas sobre la mesa, y una esquina se levantó y mostró en el reverso una línea tenue de lápiz, con su propia letra, aunque no recordaba haberla escrito. ' +
      'A lo lejos la sirena de niebla sonó dos veces, calló, y sonó una vez más. En la séptima vuelta de la luz se encendió sobre el agua un brillo pequeño, como si alguien bajo el mar hubiera prendido una cerilla. ',
  },
  de: {
    ...LATIN,
    text:
      'Der Nebel kam vom Hafen herein, während Lin den dritten Brief unter die Lampe schob. Die eiserne Treppe des Leuchtturms war kalt vor Feuchtigkeit, und jede Stufe gab einen leisen Laut, als zählte unten jemand mit. ' +
      'Der Wärter sagte, heute Nacht komme kein Schiff. Sie antwortete nicht. Sie öffnete das Fenster einen Spalt und ließ den Seewind die Blätter auf dem Tisch wenden, und eine Ecke hob sich und zeigte auf der Rückseite eine blasse Zeile in Bleistift, in ihrer eigenen Schrift, obwohl sie sich nicht erinnern konnte, sie geschrieben zu haben. ' +
      'In der Ferne tönte das Nebelhorn zweimal, verstummte und tönte noch einmal. Bei der siebten Drehung des Lichts glomm auf dem Wasser ein kleiner Schein auf, als hätte jemand unter dem Meer ein Streichholz angerissen. ',
  },
  fr: {
    ...LATIN,
    text:
      'Le brouillard arriva du port pendant que Lin glissait la troisième lettre sous la lampe. L’escalier de fer du phare était froid d’humidité, et chaque marche rendait un petit bruit, comme si quelqu’un en bas comptait. ' +
      'Le gardien dit qu’aucun bateau ne viendrait cette nuit. Elle ne répondit pas. Elle entrouvrit la fenêtre et laissa le vent du large tourner les feuilles sur la table, et un coin se souleva pour montrer au dos une ligne pâle au crayon, de sa propre main, bien qu’elle ne se souvînt pas de l’avoir écrite. ' +
      'Au loin la corne de brume sonna deux fois, se tut, puis sonna encore. Au septième tour de la lumière, une petite lueur monta sur l’eau, comme si quelqu’un sous la mer avait frotté une allumette. ',
  },
  pt: {
    ...LATIN,
    text:
      'A neblina veio do porto enquanto Lin colocava a terceira carta debaixo da lâmpada. A escada de ferro do farol estava fria de umidade, e cada degrau fazia um som pequeno, como se alguém lá embaixo estivesse contando. ' +
      'O faroleiro disse que nenhum barco viria esta noite. Ela não respondeu. Abriu uma fresta da janela e deixou o vento do mar virar as folhas sobre a mesa, e um canto se ergueu e mostrou no verso uma linha fraca de lápis, com a letra dela, embora não se lembrasse de tê-la escrito. ' +
      'Ao longe a buzina de neblina soou duas vezes, parou, e soou mais uma vez. Na sétima volta da luz, um brilho pequeno surgiu sobre a água, como se alguém debaixo do mar tivesse riscado um fósforo. ',
  },
  ar: {
    font: '"Geeza Pro", "Noto Naskh Arabic", "Traditional Arabic", serif',
    loadFace: '"Geeza Pro"',
    cellWidth: 7,
    cellHeight: 10,
    size: 0.7,
    rtl: true,
    text:
      'جاء الضباب من جهة الميناء حين كانت لينا تضع الرسالة الثالثة تحت قاعدة المصباح. كان درج المنارة الحديدي باردا من الرطوبة، وكلما صعدت درجة سمعت صوتا خافتا، كأن أحدا في الأسفل يعد خطواتها. ' +
      'قال حارس المنارة إن السفن لن تأتي الليلة. لم تجب، بل فتحت النافذة قليلا وتركت ريح البحر تقلب الأوراق على الطاولة، فظهر على ظهر إحداها سطر باهت بالقلم الرصاص، بخطها هي، ولم تتذكر متى كتبته. ' +
      'من بعيد انطلق بوق الضباب مرتين، ثم سكت، ثم انطلق مرة أخرى. وفي الدورة السابعة للضوء لمع على الماء نور صغير، كأن أحدا تحت البحر أشعل عود ثقاب. ',
  },
};

/** The passage for an interface language; a language without one of its own reads the English. */
export function charSeaScript(locale: string | undefined): CharSeaScript {
  const code = (locale ?? '').toLowerCase();
  if (code.startsWith('zh') && /(?:tw|hk|mo|hant)/u.test(code)) return 'zh-TW';
  if (code.startsWith('zh')) return 'zh';
  if (code.startsWith('ko')) return 'ko';
  if (code.startsWith('ja')) return 'ja';
  if (code.startsWith('ar')) return 'ar';
  if (code.startsWith('es')) return 'es';
  if (code.startsWith('de')) return 'de';
  if (code.startsWith('fr')) return 'fr';
  if (code.startsWith('pt')) return 'pt';
  return 'en';
}
