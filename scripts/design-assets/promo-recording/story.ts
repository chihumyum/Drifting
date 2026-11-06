// The story a promo recording types (README.md, "The story file"): front
// matter, then paragraphs separated by blank lines, typed exactly as written
// so `# ` and `**…**` turn into a scene heading and bold as the author would
// see them. A comment line before a paragraph sets how it is typed:
//
//   <!-- slow -->  <!-- normal -->  <!-- fast -->   its pace
//   <!-- typo 瓜→刮 -->                             mistype the first 瓜 as 刮, then correct it
//   <!-- quick -->                                  typed at a steady quick pace, without resting at punctuation
//   <!-- ask -->                                    before writing it, ask the Agent the front
//                                                   matter's `ask` (a reference to look up)
//
// Without a pace comment a heading is slow, dialogue (opening with a quote
// mark) normal and narration fast.

export type Pace = 'slow' | 'normal' | 'fast';

export interface StoryParagraph {
  text: string;
  pace: Pace;
  typo: { intended: string; typed: string } | null;
  /** Typed at a steady quick pace, without resting at punctuation. */
  quick: boolean;
  /** Ask the Agent the story's `ask` before this paragraph. */
  ask: boolean;
}

export interface Story {
  book: string;
  chapter: string;
  /**
   * `existing: true`: the book and chapter are on the shelf already (a sample
   * the seed writes): the take opens the book and goes on writing the chapter
   * from Project Home's Continue, instead of creating both.
   */
  existing: boolean;
  /** What the author asks the Agent for once the chapter is written. */
  organize: string;
  /** Names to point at once the Agent has made them elements; the first is hovered. */
  links: string[];
  /** Elements opened as tabs from the element list and read (the first down to its relations), then switched between. */
  elements: string[];
  /** Project Memory the book starts with, as an author would have told the Agent before. */
  memory: string | null;
  /** What the author asks the Agent mid-chapter (a reference to look up on the web). */
  ask: string | null;
  paragraphs: StoryParagraph[];
}

const OPENING_QUOTES = ['“', '"', '「', '『', '‘'];

export function defaultPace(text: string): Pace {
  if (/^#{1,3} /.test(text)) return 'slow';
  if (OPENING_QUOTES.some((quote) => text.startsWith(quote))) return 'normal';
  return 'fast';
}

export function parseStory(source: string): Story {
  const text = source.replace(/\r\n?/g, '\n');
  const match = text.match(/^---\n([\s\S]*?)\n---\n/);
  if (!match) throw new Error('The story starts with front matter between --- lines (book, chapter, organize)');
  const meta = new Map<string, string>();
  for (const line of match[1].split('\n')) {
    const field = line.match(/^([a-z]+):\s*(.*)$/);
    if (field) meta.set(field[1], field[2].trim());
  }
  const required = (key: string) => {
    const value = meta.get(key);
    if (!value) throw new Error(`The story's front matter needs ${key}`);
    return value;
  };

  const paragraphs: StoryParagraph[] = [];
  let pace: Pace | null = null;
  let typo: StoryParagraph['typo'] = null;
  let quick = false;
  let ask = false;
  for (const block of text.slice(match[0].length).split(/\n\s*\n/)) {
    const lines = block.split('\n').map((line) => line.trim()).filter(Boolean);
    const prose: string[] = [];
    for (const line of lines) {
      const directive = line.match(/^<!--\s*(.*?)\s*-->$/);
      if (!directive) { prose.push(line); continue; }
      const [word, argument] = directive[1].split(/\s+/, 2);
      if (word === 'slow' || word === 'normal' || word === 'fast') pace = word;
      else if (word === 'typo' && argument?.includes('→')) {
        const [intended, typed] = argument.split('→');
        if (!intended || !typed) throw new Error(`Bad typo directive: ${line}`);
        typo = { intended, typed };
      } else if (word === 'quick') quick = true;
      else if (word === 'ask') ask = true;
      else throw new Error(`Unknown directive: ${line}`);
    }
    if (!prose.length) continue;
    const paragraph = prose.join('');
    if (typo && !paragraph.includes(typo.intended)) throw new Error(`The typo's ${typo.intended} is not in: ${paragraph}`);
    if (quick && typo) throw new Error(`A quick paragraph has no typo to show: ${paragraph}`);
    paragraphs.push({ text: paragraph, pace: pace ?? defaultPace(paragraph), typo, quick, ask });
    pace = null;
    typo = null;
    quick = false;
    ask = false;
  }
  if (!paragraphs.length) throw new Error('The story has no paragraphs');
  if (paragraphs[0].quick) throw new Error('The first paragraph is the opening shot; it cannot be quick');
  if (paragraphs.some((paragraph) => paragraph.ask) && !meta.get('ask')) throw new Error('An <!-- ask --> needs `ask` in the front matter');
  return {
    book: required('book'),
    chapter: required('chapter'),
    existing: meta.get('existing') === 'true',
    organize: required('organize'),
    links: (meta.get('links') ?? '').split(/[,，、]/).map((name) => name.trim()).filter(Boolean),
    elements: (meta.get('elements') ?? '').split(/[,，、]/).map((name) => name.trim()).filter(Boolean),
    memory: meta.get('memory') || null,
    ask: meta.get('ask') || null,
    paragraphs,
  };
}
