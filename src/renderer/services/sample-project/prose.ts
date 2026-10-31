import { countWords } from '@drifting/prose-metrics';
import { seedRandom } from './presets';

export interface SeedProseNode {
  type: string;
  attrs?: Record<string, unknown>;
  text?: string;
  content?: SeedProseNode[];
}

const places = ['北岬灯塔', '旧码头', '盐仓', '气象站', '白沙湾', '档案室', '防波堤', '修船厂'];
const people = ['林潮', '老船长', '值班员', '档案员', '领航员', '修灯人', '邮递员', '观潮员'];
const objects = ['航海日志', '潮位记录', '黄铜钥匙', '旧海图', '玻璃浮标', '未寄出的信', '值班表', '检修手册'];
const details = ['门框上新留下的盐渍', '窗玻璃中一闪而过的倒影', '钟摆停止时指向的刻度', '船票背面被折起的蓝边', '绳结中夹着的一小片贝壳', '抽屉里没有寄出的便笺', '石阶上被潮水抹平的脚印', '灯镜边缘反复擦拭的痕迹'];
const headings = ['潮声与记录', '尚待核对的证词', '灯下的观察', '返航之前', '档案中的时间差', '沿着堤岸寻访'];
const sentences = [
  '潮水正在退去，远处的灯塔亮了一下，又被低云遮住。',
  '屋里有盐、柴油和旧纸混在一起的气味，窗外的海面看不见边。',
  '这还不能算作证据，至多说明原来的解释遗漏了一段没有被记录的航程。',
  '她把可以确认的事实写在左边，把没有答案的问题留在右边，中间隔着一道窄窄的空白。',
  '那人说话前先看了一眼海，似乎只有等到下一阵浪声过去，才能继续说下去。',
  '如果两份抄本出自同一只手，那么字迹的差异就不能简单归咎于匆忙。',
  '灯光每隔九秒扫过一次窗户，这是整件事里少数可以重复核对的事实。',
  '她决定沿着旧路线再走一遍，把每一个转角与纸上的标记分别对照。',
  '雨停以后，堤岸上的水线还会留下片刻，但没有人能保证它一直等在那里。',
  '“先不要替别人补上答案。”她合起笔记本，示意对方把刚才的话从头再说一遍。',
];

function takeWords(text: string, limit: number): string {
  let words = 0;
  let output = '';
  for (const character of text) {
    if (/[\u3400-\u4DBF\u4E00-\u9FFF]/u.test(character)) {
      if (words === limit) break;
      words++;
    }
    output += character;
  }
  return output;
}

/** Original Han-only fiction; paragraph/heading/list boundaries vary by seed. */
export function createSeedProse(words: number, seed: number, note = false): SeedProseNode {
  if (!Number.isSafeInteger(words) || words < 20) throw new Error('Seed prose requires at least twenty words');
  const random = seedRandom(seed);
  const pick = <T,>(values: readonly T[]): T => values[Math.floor(random() * values.length)];
  const content: SeedProseNode[] = [];
  let remaining = words;
  const addText = (type: string, text: string, attrs?: Record<string, unknown>) => {
    const fitted = takeWords(text, remaining);
    remaining -= countWords(fitted);
    content.push({ type, ...(attrs ? { attrs } : {}), content: [{ type: 'text', text: fitted }] });
  };
  addText('heading', pick(headings), { level: 2 });
  if (note && remaining > 60) {
    const tasks = ['核对值班记录与潮位变化', '补充现场光线和人物动作', '检查证词之间尚未解释的时间差'];
    content.push({ type: 'taskList', content: tasks.map((text, index) => ({
      type: 'taskItem', attrs: { checked: (seed + index) % 3 === 0 },
      content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
    })) });
    remaining -= tasks.reduce((sum, text) => sum + countWords(text), 0);
  }
  let paragraph = 0;
  while (remaining > 0) {
    if (paragraph > 0 && paragraph % 9 === 0 && remaining > 40)
      addText('heading', pick(headings), { level: 3 });
    const actor = pick(people), place = pick(places), object = pick(objects);
    let text = `${actor}到达${place}时，先记下了${pick(details)}。她翻开${object}，把眼前的情形与上一次的记录放在一起。`;
    const sentenceCount = 2 + Math.floor(random() * 6);
    for (let i = 0; i < sentenceCount; i++) text += pick(sentences);
    addText('paragraph', text);
    paragraph++;
  }
  return { type: 'doc', content };
}

export function seedProseMarkdown(document: SeedProseNode): string {
  const render = (node: SeedProseNode): string => {
    if (node.type === 'text') return node.text ?? '';
    const text = (node.content ?? []).map(render).join(node.type === 'doc' || node.type === 'taskList' ? '\n\n' : '');
    if (node.type === 'heading') return `${'#'.repeat(Number(node.attrs?.level ?? 2))} ${text}`;
    if (node.type === 'taskItem') return `- [${node.attrs?.checked ? 'x' : ' '}] ${text}`;
    return text;
  };
  return render(document);
}

export function createSeedMarkdown(words: number, seed: number): string {
  return seedProseMarkdown(createSeedProse(words, seed));
}

export function seedProsePlainText(document: SeedProseNode): string {
  return document.text ?? (document.content ?? []).map(seedProsePlainText).join('\n');
}
