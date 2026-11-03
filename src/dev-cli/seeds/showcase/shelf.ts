// The other books on the release screenshot shelf (docs/release-screenshots.md):
// titles, genres and storylines an author's shelf might hold, with synthetic
// prose sized to each book's word count. Only the shelf shows them, so their
// chapters are plain generated paragraphs; the book a screenshot opens is
// Pride and Prejudice or 《慢钟》.

import { countWords } from '@drifting/prose-metrics';

import type { BookChapter } from '../../../renderer/services/built-in-sample/book';
import type { SampleBook } from '../../../renderer/services/built-in-sample/sample-book';
import { seedRandom } from '../../../renderer/services/sample-project/presets';
import { createSeedProse, seedProsePlainText } from '../../../renderer/services/sample-project/prose';

export type ShowcaseLocale = 'en' | 'zh-CN';

export interface ShelfBook {
  name: string;
  genre: string;
  summary: string;
  words: number;
  chapters: number;
  storylines: readonly { name: string; color: string }[];
  /** A few elements, so the book does not read as one that never used them. */
  people: readonly string[];
  places: readonly string[];
  /** Days before the screenshot run the book was started and last written in. */
  startedDaysAgo: number;
  lastWrittenDaysAgo: number;
  /** How often the author wrote in it while it was active, 0–1. */
  diligence: number;
}

export const SHELF_BOOKS: Record<ShowcaseLocale, readonly ShelfBook[]> = {
  en: [
    {
      name: 'The Lantern Keeper', genre: 'Literary fiction', words: 94_000, chapters: 32,
      summary: 'A widowed lighthouse keeper takes in a boy who washed up with no name, and the island decides what to do about them.',
      people: ['Edda Marr', 'The boy', 'Tomas Rell', 'Mother Agnes', 'Kit Farrow'], places: ['Skerry Light', 'The harbour', 'Gull Rock'],
      storylines: [{ name: 'The keeper', color: '#9B6A4F' }, { name: 'The boy', color: '#5C7FA3' }, { name: 'The island', color: '#6E8B5E' }],
      startedDaysAgo: 340, lastWrittenDaysAgo: 0, diligence: 0.62,
    },
    {
      name: 'Salt and Static', genre: 'Science fiction', words: 61_000, chapters: 24,
      summary: 'On a drowned Earth, a radio operator hears a broadcast that should have stopped a hundred years ago.',
      people: ['Mara Quell', 'Old Bishop', 'Juno', 'The Voice'], places: ['Rig Seven', 'The Shallows', 'Drowned Station'],
      storylines: [{ name: 'Mara', color: '#5C7FA3' }, { name: 'The signal', color: '#7A6A96' }, { name: 'The rig', color: '#B07A3B' }],
      startedDaysAgo: 260, lastWrittenDaysAgo: 2, diligence: 0.48,
    },
    {
      name: 'Night Train to Vell', genre: 'Mystery', words: 71_000, chapters: 28,
      summary: 'Nine passengers, one sleeper car and a conductor who swears the tenth berth was empty when they left.',
      people: ['Inspector Hale', 'Ada Brisk', 'The conductor', 'Dr. Penrose', 'Lena Voss', 'Mr. Szabo'], places: ['Sleeper car 4', 'Vell station', 'The dining car'],
      storylines: [{ name: 'Inspector Hale', color: '#9B4D5A' }, { name: 'The passengers', color: '#5F7D74' }, { name: 'The tenth berth', color: '#7A6A96' }, { name: 'Vell', color: '#B07A3B' }],
      startedDaysAgo: 300, lastWrittenDaysAgo: 5, diligence: 0.4,
    },
    {
      name: 'A Map of Small Rivers', genre: 'Short stories', words: 38_000, chapters: 14,
      summary: 'Fourteen stories set along one river, from its source in the hills to the estuary.',
      people: ['Nell', 'The miller', 'Ruth Abbot'], places: ['The source', 'Millbrook', 'Hatch Bridge', 'The estuary'],
      storylines: [{ name: 'Upstream', color: '#6E8B5E' }, { name: 'Downstream', color: '#5C7FA3' }],
      startedDaysAgo: 420, lastWrittenDaysAgo: 21, diligence: 0.3,
    },
    {
      name: 'The Orchard Year', genre: 'Memoir', words: 22_000, chapters: 12,
      summary: 'Twelve months on my grandmother’s apple farm, the year before it was sold.',
      people: ['Gran', 'Uncle Pete'], places: ['The orchard', 'The cider barn'],
      storylines: [{ name: 'The seasons', color: '#B07A3B' }],
      startedDaysAgo: 360, lastWrittenDaysAgo: 64, diligence: 0.35,
    },
    {
      name: 'Glasswing', genre: 'Fantasy', words: 8_400, chapters: 6,
      summary: 'A glassblower’s apprentice finds that what she makes remembers who held it.',
      people: ['Ilse', 'Master Brann'], places: ['The furnace hall'],
      storylines: [{ name: 'Ilse', color: '#A0596B' }, { name: 'The guild', color: '#5F7D74' }],
      startedDaysAgo: 12, lastWrittenDaysAgo: 1, diligence: 0.8,
    },
  ],
  'zh-CN': [
    {
      name: '北岬灯塔', genre: '悬疑', words: 86_000, chapters: 30,
      summary: '新来的守灯人发现，灯塔日志里有一页记着一艘从没靠过岸的船。',
      people: ['守灯人老周', '阿岚', '邮差', '船长遗孀'], places: ['北岬灯塔', '小码头', '礁石滩'],
      storylines: [{ name: '守灯人', color: '#5C7FA3' }, { name: '无名船', color: '#7A6A96' }, { name: '岛上的人', color: '#6E8B5E' }],
      startedDaysAgo: 330, lastWrittenDaysAgo: 3, diligence: 0.5,
    },
    {
      name: '盐与星', genre: '科幻', words: 61_000, chapters: 24,
      summary: '海平面上升后的第一百年，盐田上的女孩收到了一段来自旧卫星的广播。',
      people: ['阿盐', '老主教', '朱诺'], places: ['七号盐田', '浅滩', '沉没的站'],
      storylines: [{ name: '阿盐', color: '#5C7FA3' }, { name: '信号', color: '#7A6A96' }, { name: '盐田', color: '#B07A3B' }],
      startedDaysAgo: 280, lastWrittenDaysAgo: 6, diligence: 0.42,
    },
    {
      name: '夜车', genre: '推理', words: 71_000, chapters: 28,
      summary: '一节卧铺车厢，九个乘客，列车员坚称第十张铺位出发时是空的。',
      people: ['何警官', '白小姐', '列车员', '彭医生', '沈太太', '萨先生'], places: ['四号卧铺车厢', '终点站', '餐车'],
      storylines: [{ name: '何警官', color: '#9B4D5A' }, { name: '乘客', color: '#5F7D74' }, { name: '第十张铺位', color: '#7A6A96' }, { name: '终点站', color: '#B07A3B' }],
      startedDaysAgo: 310, lastWrittenDaysAgo: 12, diligence: 0.38,
    },
    {
      name: '小河地图', genre: '短篇集', words: 38_000, chapters: 14,
      summary: '十四个短篇，沿着同一条河，从山里的源头写到入海口。',
      people: ['阿宁', '磨坊主', '茹老师'], places: ['源头', '磨坊镇', '闸桥', '入海口'],
      storylines: [{ name: '上游', color: '#6E8B5E' }, { name: '下游', color: '#5C7FA3' }],
      startedDaysAgo: 400, lastWrittenDaysAgo: 24, diligence: 0.3,
    },
    {
      name: '果园那一年', genre: '散文', words: 22_000, chapters: 12,
      summary: '外婆的果园卖掉之前的最后一年，按月份写下来。',
      people: ['外婆', '舅舅'], places: ['果园', '酒窖'],
      storylines: [{ name: '四季', color: '#B07A3B' }],
      startedDaysAgo: 365, lastWrittenDaysAgo: 70, diligence: 0.35,
    },
    {
      name: '玻璃翅', genre: '奇幻', words: 8_400, chapters: 6,
      summary: '吹玻璃的学徒发现，她做出来的东西记得握过它的每一只手。',
      people: ['伊尔', '布兰师傅'], places: ['熔炉大厅'],
      storylines: [{ name: '伊尔', color: '#A0596B' }, { name: '行会', color: '#5F7D74' }],
      startedDaysAgo: 12, lastWrittenDaysAgo: 1, diligence: 0.8,
    },
  ],
};

const EN_SENTENCES = [
  'The light had gone grey by the time she reached the end of the road.',
  'He kept the letter folded in his coat, where he could feel it when he breathed.',
  'Nobody in the village remembered who had planted the hedge, only that it had always been there.',
  'She wrote the date at the top of the page and then sat for a long time without adding anything.',
  'The wind came in off the water and found every gap in the window frame.',
  'It was not an answer, but it was the first thing anyone had said that sounded true.',
  'They walked the rest of the way in silence, the gravel loud under their boots.',
  'Somewhere below, a door closed, and the whole house seemed to settle around the sound.',
  'He counted the steps again, as if the number might have changed since morning.',
  'The map was older than the town it described, and wrong in ways that felt deliberate.',
  'She left the lamp burning in the kitchen, though there was no one left to wait for.',
  'By noon the rain had stopped and the fields smelled of iron and cut grass.',
  '“You can stay,” the old woman said, “but you will have to earn the bread.”',
  'The clock in the hall was always four minutes fast, and nobody had ever thought to fix it.',
  'He had expected the place to be smaller, the way places are when you come back to them.',
  'There were footprints in the frost, leading to the gate and not away from it.',
];

/** Plain English paragraphs adding up to exactly `words` words. */
function englishParagraphs(words: number, seed: number): string[] {
  const random = seedRandom(seed);
  const paragraphs: string[] = [];
  let remaining = words;
  while (remaining > 0) {
    const sentences: string[] = [];
    for (let count = 2 + Math.floor(random() * 5); count > 0 && remaining > 0; count--) {
      const tokens = EN_SENTENCES[Math.floor(random() * EN_SENTENCES.length)].split(' ');
      const taken = tokens.slice(0, remaining);
      remaining -= taken.length;
      sentences.push(taken.join(' '));
    }
    paragraphs.push(sentences.join(' '));
  }
  return paragraphs;
}

/** Han paragraphs from the development seed's corpus, adding up to `words`. */
function chineseParagraphs(words: number, seed: number): string[] {
  const document = createSeedProse(Math.max(20, words), seed);
  return (document.content ?? []).filter((node) => node.type === 'paragraph').map(seedProsePlainText);
}

/** Chapter lengths that vary around the mean and add up to the book's words. */
function chapterLengths(book: ShelfBook, random: () => number): number[] {
  const weights = Array.from({ length: book.chapters }, () => 0.6 + random() * 0.8);
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  const lengths = weights.map((weight) => Math.max(40, Math.floor((book.words * weight) / total)));
  lengths[lengths.length - 1] += book.words - lengths.reduce((sum, length) => sum + length, 0);
  return lengths;
}

export function shelfBookDefinition(book: ShelfBook, locale: ShowcaseLocale, seed: number): SampleBook {
  const random = seedRandom(seed);
  const keys = book.storylines.map((_, index) => `line-${index}`);
  const lengths = chapterLengths(book, random);
  const chapters: BookChapter[] = lengths.map((words, index) => ({
    number: index + 1,
    roman: String(index + 1),
    blocks: locale === 'en' ? englishParagraphs(words, seed + index) : chineseParagraphs(words, seed + index),
  }));
  return {
    summary: book.summary,
    // The shelf reads the genre from the book's 体裁 fact.
    facts: [{ key: '体裁', value: book.genre }],
    memory: null,
    chapters,
    chapterTitle: (number) => (locale === 'en' ? `Chapter ${number}` : `第${number}章`),
    // Each chapter runs in one or two storylines, the first chosen in turn.
    chapterPlans: chapters.map((chapter) => {
      const primary = keys[(chapter.number - 1 + Math.floor(random() * 2)) % keys.length];
      const second = keys.length > 1 && random() < 0.35 ? keys.find((key) => key !== primary) : undefined;
      return { summary: '', storylines: second ? [primary, second] : [primary] };
    }),
    volumes: [],
    storylines: book.storylines.map((line, index) => ({ key: keys[index], name: line.name, color: line.color, summary: '', body: [''] })),
    categories: [
      { key: 'people', name: locale === 'en' ? 'Characters' : '人物', color: '#9B6A4F', body: [''] },
      { key: 'places', name: locale === 'en' ? 'Places' : '地点', color: '#5F7D74', body: [''] },
    ],
    elements: [
      ...book.people.map((name) => ({ key: `people:${name}`, category: 'people', name, aliases: [], summary: '', facts: [], body: [''] })),
      ...book.places.map((name) => ({ key: `places:${name}`, category: 'places', name, aliases: [], summary: '', facts: [], body: [''] })),
    ],
    relationTypes: [],
    relations: [],
    timelinePins: [],
    ideas: [],
    comments: [],
    elementPatches: [],
    finishedChapters: [],
    plotGrid: null,
    materialNotes: [],
    illustrationFolder: null,
    illustrationNotes: {},
    illustrations: [],
    linkForms: [],
    linkBoundaries: locale === 'en' ? 'word' : 'none',
  };
}

/** The words a definition's chapters really hold, as the prose metric counts them. */
export function definitionWords(book: SampleBook): number {
  return book.chapters.reduce((sum, chapter) =>
    sum + chapter.blocks.reduce<number>((words, block) => words + countWords(typeof block === 'string' ? block : block.join('')), 0), 0);
}
