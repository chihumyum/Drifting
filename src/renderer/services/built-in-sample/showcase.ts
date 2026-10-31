// The workspace an author might build around Pride and Prejudice: elements,
// relations, storylines, a timeline, notes and review items. Everything here is
// written for the sample and checked against the novel's text; quotations are
// verbatim from the bundled edition (the content test locates each one).
//
// Chapter numbers are the continuous 1–61 of the 1894 edition; Volume I is
// chapters 1–23, Volume II 24–42 and Volume III 43–61.

import type { KvEntry } from '../../domain/kv';

export const SAMPLE_PROJECT_NAME = 'Pride and Prejudice (Sample)';
export const SAMPLE_PROJECT_SUMMARY =
  'Jane Austen’s novel of 1813, taken apart in Drifting: the full text in three volumes, its people and places, four storylines, a timeline and an author’s notes.';

export const PROJECT_FACTS: readonly KvEntry[] = [
  { key: 'Author', value: 'Jane Austen' },
  { key: 'First published', value: '28 January 1813, by Thomas Egerton, in three volumes' },
  { key: 'Working title', value: 'First Impressions (1796–97)' },
  { key: 'Point of view', value: 'Third person, mostly close to Elizabeth, with free indirect style' },
  { key: 'Setting', value: 'Hertfordshire, Kent, London and Derbyshire' },
  { key: 'Edition', value: 'George Allen, 1894, illustrated by Hugh Thomson; public domain' },
];

export const PROJECT_MEMORY =
  'This project holds Jane Austen’s published text. Quote it exactly, keep its spelling and punctuation, and do not rewrite chapters unless I ask. The notes, ideas, summaries and review items are mine and can be edited freely.';

/** The three volumes of the first edition, as acts. */
export const VOLUMES = [
  { name: 'Volume I', firstChapter: 1 },
  { name: 'Volume II', firstChapter: 24 },
  { name: 'Volume III', firstChapter: 43 },
] as const;

export type StorylineKey = 'lizzy-darcy' | 'jane-bingley' | 'lydia-wickham' | 'charlotte-collins';

export interface SampleStoryline {
  key: StorylineKey;
  name: string;
  color: string;
  summary: string;
  body: readonly string[];
}

export const STORYLINES: readonly SampleStoryline[] = [
  {
    key: 'lizzy-darcy',
    name: 'Elizabeth & Darcy',
    color: '#9B4D5A',
    summary: 'From a slight at the Meryton assembly to two proposals: pride and prejudice on both sides, corrected by a letter and by Pemberley.',
    body: [
      'Darcy’s “She is tolerable” at the assembly fixes Elizabeth’s opinion of him, and Wickham’s story confirms it. Darcy, meanwhile, is drawn to her against his judgment, at Netherfield and again at Rosings.',
      'The first proposal fails on both counts: his pride in how he asks, her prejudice in what she believes. His letter answers her charges; Pemberley, and what he quietly does for Lydia, show her who he is. The second proposal, in Volume III, is accepted.',
    ],
  },
  {
    key: 'jane-bingley',
    name: 'Jane & Bingley',
    color: '#5C7FA3',
    summary: 'An easy mutual liking, checked by Darcy’s interference and Caroline Bingley’s coolness, and renewed when Bingley returns to Netherfield.',
    body: [
      'Bingley admires Jane from the first ball, but her composure hides how much she feels. Darcy, believing her indifferent, persuades him to stay in London, and he and Miss Bingley keep Jane’s visit to town from him.',
      'Bingley comes back to Netherfield in the autumn; once Darcy admits that his interference was a mistake, he proposes.',
    ],
  },
  {
    key: 'lydia-wickham',
    name: 'Lydia & Wickham',
    color: '#B07A3B',
    summary: 'Wickham’s charm and his story against Darcy, the Brighton elopement, and the marriage Darcy secretly pays for.',
    body: [
      'Wickham arrives with the militia and wins Meryton with an account of how Darcy cheated him of a living. Darcy’s letter tells the other side, including his attempt on Georgiana at Ramsgate.',
      'Lydia follows the regiment to Brighton and elopes with Wickham, who has no intention of marrying her until Darcy finds them in London and settles his debts.',
    ],
  },
  {
    key: 'charlotte-collins',
    name: 'Charlotte & Collins',
    color: '#6E8B5E',
    summary: 'The heir to Longbourn, refused by Elizabeth, is accepted within days by Charlotte Lucas, who wants a comfortable home.',
    body: [
      'Mr. Collins comes to Longbourn to choose a wife among the cousins whose home he will inherit. Elizabeth refuses him; Charlotte, twenty-seven and without fortune, accepts him with her eyes open.',
      'Her house at Hunsford, under Lady Catherine’s patronage, is where Elizabeth meets Darcy again in Volume II.',
    ],
  },
];

export interface ChapterPlan {
  summary: string;
  /** The first storyline is the chapter's primary lane. */
  storylines: readonly StorylineKey[];
}

const ED = 'lizzy-darcy', JB = 'jane-bingley', LW = 'lydia-wickham', CC = 'charlotte-collins';

/** One line per chapter and its storylines, indexed by chapter number − 1. */
export const CHAPTER_PLANS: readonly ChapterPlan[] = [
  { summary: 'Mrs. Bennet announces that Netherfield Park is let to Mr. Bingley and urges her husband to call.', storylines: [JB] },
  { summary: 'Mr. Bennet has called on Bingley after all, and teases his family before telling them.', storylines: [JB] },
  { summary: 'The Meryton assembly: Bingley admires Jane; Darcy calls Elizabeth tolerable and is judged the proudest man in the world.', storylines: [ED, JB] },
  { summary: 'Jane confides her liking for Bingley; the Bingley sisters, and the friendship between Bingley and Darcy.', storylines: [JB] },
  { summary: 'The Lucases call to talk over the assembly and Darcy’s pride.', storylines: [ED] },
  { summary: 'Charlotte thinks Jane should show more affection; Darcy begins to admire Elizabeth’s fine eyes, and she declines to dance with him at Lucas Lodge.', storylines: [ED, JB] },
  { summary: 'The entail; the militia comes to Meryton; Jane rides to Netherfield in the rain and falls ill, and Elizabeth walks three miles to nurse her.', storylines: [JB, ED] },
  { summary: 'At Netherfield the Bingley sisters mock Elizabeth’s muddy petticoat; the talk turns to the accomplished woman.', storylines: [ED] },
  { summary: 'Mrs. Bennet visits Netherfield and embarrasses Elizabeth; Lydia holds Bingley to his promise of a ball.', storylines: [JB] },
  { summary: 'Darcy writes to his sister while Miss Bingley flatters him; Elizabeth refuses a reel, and Darcy has never been so bewitched.', storylines: [ED] },
  { summary: 'Miss Bingley walks the room with Elizabeth; Elizabeth and Darcy argue about pride, vanity and his resentful temper.', storylines: [ED] },
  { summary: 'Jane and Elizabeth return to Longbourn; Darcy scarcely speaks ten words to Elizabeth on their last day.', storylines: [ED, JB] },
  { summary: 'Mr. Collins’s letter, and the heir to the entail arrives at Longbourn.', storylines: [CC] },
  { summary: 'Mr. Collins at dinner: praise of Lady Catherine, and Fordyce’s Sermons read aloud until Lydia interrupts.', storylines: [CC] },
  { summary: 'Mr. Collins settles on Elizabeth; in Meryton the sisters meet Wickham, and Darcy and Wickham change colour at the sight of each other.', storylines: [LW, CC] },
  { summary: 'At the Philipses’ Wickham tells Elizabeth how Darcy denied him the living.', storylines: [LW, ED] },
  { summary: 'Jane cannot believe ill of either man; the Netherfield ball is fixed, and Mr. Collins engages Elizabeth for the first two dances.', storylines: [LW, JB] },
  { summary: 'The Netherfield ball: Elizabeth dances with Darcy and raises Wickham, and her family exposes itself one by one.', storylines: [ED, JB, CC] },
  { summary: 'Mr. Collins proposes to Elizabeth and will not believe her refusal.', storylines: [CC] },
  { summary: 'Mrs. Bennet insists, Mr. Bennet sides with Elizabeth, and Mr. Collins withdraws his offer.', storylines: [CC] },
  { summary: 'Wickham explains his absence from the ball; Miss Bingley writes that the whole party has left Netherfield for London.', storylines: [JB, LW] },
  { summary: 'Charlotte draws Mr. Collins’s attentions to herself and accepts him; Elizabeth is astonished.', storylines: [CC] },
  { summary: 'Sir William announces the engagement; Mrs. Bennet laments the entail; nothing is heard from Bingley.', storylines: [CC, JB] },
  { summary: 'Miss Bingley’s letter ends all hope of Bingley’s return; Jane is resigned, and Wickham’s story spreads through Meryton.', storylines: [JB, LW] },
  { summary: 'The Gardiners spend Christmas at Longbourn and invite Jane to London; Mrs. Gardiner, who grew up near Pemberley, watches Elizabeth and Wickham.', storylines: [JB, LW] },
  { summary: 'Mrs. Gardiner warns Elizabeth against Wickham; Mr. Collins marries Charlotte; in London Miss Bingley snubs Jane, and Wickham turns to Miss King.', storylines: [CC, JB, LW] },
  { summary: 'In March Elizabeth travels to Kent with Sir William and Maria, stopping in Gracechurch Street; the Gardiners propose a summer tour.', storylines: [CC] },
  { summary: 'Arrival at Hunsford parsonage: Mr. Collins shows off his house and garden, and Miss de Bourgh stops at the gate.', storylines: [CC] },
  { summary: 'Dinner at Rosings, and Lady Catherine’s interrogation of Elizabeth.', storylines: [CC] },
  { summary: 'Life at the parsonage; Darcy and Colonel Fitzwilliam arrive at Rosings and call on the ladies.', storylines: [ED, CC] },
  { summary: 'An evening at Rosings: Elizabeth plays and teases Darcy about his behaviour in Hertfordshire.', storylines: [ED] },
  { summary: 'Darcy calls when Elizabeth is alone; Charlotte suspects he is in love.', storylines: [ED] },
  { summary: 'Walks in the park; Colonel Fitzwilliam reveals that Darcy saved a friend from an imprudent marriage.', storylines: [ED, JB] },
  { summary: 'Darcy’s first proposal, and Elizabeth’s refusal.', storylines: [ED, JB, LW] },
  { summary: 'Darcy gives Elizabeth a letter: his reasons about Jane and Bingley, and the truth about Wickham.', storylines: [ED, LW, JB] },
  { summary: 'Elizabeth reads the letter again and again, and sees her own prejudice.', storylines: [ED, LW] },
  { summary: 'The gentlemen leave Rosings; Lady Catherine advises on travelling; Elizabeth goes over the letter in her mind.', storylines: [ED] },
  { summary: 'Mr. Collins’s farewell; Elizabeth leaves Hunsford, a little sorry for Charlotte, and joins Jane in London.', storylines: [CC] },
  { summary: 'Kitty and Lydia meet their sisters at the inn: the regiment is leaving for Brighton, and Miss King has gone to Liverpool.', storylines: [LW] },
  { summary: 'Elizabeth tells Jane of the proposal and the letter; they decide not to expose Wickham.', storylines: [ED, LW] },
  { summary: 'The regiment leaves Meryton, and Lydia goes to Brighton with Mrs. Forster despite Elizabeth’s warning to her father.', storylines: [LW] },
  { summary: 'Mr. Bennet’s marriage; the northern tour is shortened to Derbyshire, and Elizabeth agrees to see Pemberley.', storylines: [ED] },
  { summary: 'Pemberley: Mrs. Reynolds praises her master, and Darcy appears, civil to everyone.', storylines: [ED] },
  { summary: 'Darcy brings Georgiana and Bingley to the inn at Lambton; the Gardiners draw their own conclusions.', storylines: [ED, JB] },
  { summary: 'Elizabeth calls at Pemberley; Miss Bingley’s jibe about the militia goes wrong.', storylines: [ED] },
  { summary: 'Jane’s letters: Lydia has eloped with Wickham. Elizabeth tells Darcy, and the party hurries home.', storylines: [LW, ED] },
  { summary: 'On the road the Gardiners and Elizabeth weigh Wickham’s character; at Longbourn, Lydia’s note to Harriet Forster.', storylines: [LW] },
  { summary: 'Mr. Bennet searches London; Mr. Collins sends his condolences; Mr. Bennet comes home and blames himself.', storylines: [LW, CC] },
  { summary: 'Mr. Gardiner’s express: the couple are found and terms agreed; Mr. Bennet assumes his brother has paid.', storylines: [LW] },
  { summary: 'Mr. Bennet regrets never saving; Mrs. Bennet plans; Elizabeth knows Darcy is lost to her; Wickham is to join the regulars in the north.', storylines: [LW, ED] },
  { summary: 'Lydia and Wickham visit Longbourn, and Lydia lets slip that Darcy was at her wedding.', storylines: [LW, ED] },
  { summary: 'Mrs. Gardiner’s letter tells what Darcy did; Elizabeth and Wickham part as brother and sister.', storylines: [ED, LW] },
  { summary: 'Lydia and Wickham leave for the north; Bingley returns to Netherfield and calls at Longbourn with Darcy.', storylines: [JB, ED, LW] },
  { summary: 'Dinner at Longbourn: Bingley sits by Jane, while Darcy is grave and silent.', storylines: [JB, ED] },
  { summary: 'Bingley proposes to Jane, and the Bennets are pronounced the luckiest family in the world.', storylines: [JB] },
  { summary: 'Lady Catherine calls at Longbourn to forbid an engagement; Elizabeth refuses to promise anything.', storylines: [ED] },
  { summary: 'Mr. Bennet reads out Mr. Collins’s warning against Darcy, and laughs.', storylines: [ED, CC] },
  { summary: 'On a walk Elizabeth thanks Darcy for Lydia; he asks again and is accepted.', storylines: [ED] },
  { summary: 'Jane is told; Darcy asks for Mr. Bennet’s consent, and Elizabeth convinces her father.', storylines: [ED] },
  { summary: 'Elizabeth asks Darcy how he came to fall in love; letters to Mrs. Gardiner and to Mr. Collins.', storylines: [ED, CC] },
  { summary: 'Afterwards: the marriages, Kitty’s improvement, Lydia and Wickham, Pemberley and the Gardiners.', storylines: [ED, JB, LW] },
];

/** The chapter an author has marked finished. */
export const FINISHED_CHAPTER = 1;

export type CategoryKey = 'characters' | 'places' | 'lore';

export const CATEGORIES: readonly { key: CategoryKey; name: string; color: string; body: readonly string[] }[] = [
  { key: 'characters', name: 'Characters', color: '#9B6A4F', body: ['The Bennets, their neighbours and the people who visit Netherfield, Hunsford and Pemberley.'] },
  { key: 'places', name: 'Places', color: '#5F7D74', body: ['Houses and towns in Hertfordshire, Kent, London and Derbyshire.'] },
  { key: 'lore', name: 'Objects & lore', color: '#7A6A96', body: ['The law, the letters and the occasions that move the plot.'] },
];

export interface SampleElement {
  key: string;
  category: CategoryKey;
  name: string;
  aliases: readonly string[];
  summary: string;
  facts: readonly KvEntry[];
  body: readonly string[];
  /** A bundled illustration crop used as the element's portrait. */
  portrait?: string;
}

export const ELEMENTS: readonly SampleElement[] = [
  {
    key: 'elizabeth', category: 'characters', name: 'Elizabeth Bennet', aliases: ['Lizzy', 'Eliza'],
    summary: 'The second Bennet daughter: quick, playful, proud of her judgment, and wrong about Darcy and Wickham.',
    facts: [{ key: 'Home', value: 'Longbourn' }, { key: 'Age', value: 'Not yet twenty-one (ch. 29)' }, { key: 'First mentioned', value: 'Chapter I' }],
    body: [
      'Her father’s favourite and the novel’s centre of consciousness. She laughs at follies and inconsistencies, which makes her quick to judge and slow to doubt her first impressions.',
      'Darcy’s letter is the turn: “Till this moment, I never knew myself.” She refuses Mr. Collins and Darcy in Volume I and II, and accepts Darcy in Volume III.',
    ],
    portrait: 'portrait-elizabeth',
  },
  {
    key: 'darcy', category: 'characters', name: 'Fitzwilliam Darcy', aliases: ['Mr. Darcy', 'Darcy'],
    summary: 'Master of Pemberley, ten thousand a year; reserved, proud, and better than his manners.',
    facts: [{ key: 'Home', value: 'Pemberley, Derbyshire' }, { key: 'Income', value: '£10,000 a year' }, { key: 'Age', value: 'Twenty-eight (ch. 58)' }, { key: 'First mentioned', value: 'Chapter III' }],
    body: [
      'Bingley’s friend and Lady Catherine’s nephew. His pride offends Meryton at the first assembly, and Wickham’s story makes him a villain there.',
      'His housekeeper calls him the best landlord and the best master. After Elizabeth’s refusal he changes his manners, and he finds Lydia and Wickham in London and pays for their marriage without wanting it known.',
    ],
    portrait: 'portrait-darcy',
  },
  {
    key: 'jane', category: 'characters', name: 'Jane Bennet', aliases: ['Miss Bennet', 'Jane'],
    summary: 'The eldest and handsomest Bennet sister, who thinks well of everyone and shows little of what she feels.',
    facts: [{ key: 'Home', value: 'Longbourn' }, { key: 'Age', value: 'Almost twenty-three in the spring (ch. 39)' }, { key: 'First mentioned', value: 'Chapter I' }],
    body: [
      'Her composure persuades Darcy that she does not care for Bingley. In London she learns how little Miss Bingley’s friendship was worth, and bears it quietly.',
    ],
  },
  {
    key: 'bingley', category: 'characters', name: 'Charles Bingley', aliases: ['Mr. Bingley', 'Bingley'],
    summary: 'The good-humoured young man who takes Netherfield, four or five thousand a year, and too easily guided by his friend.',
    facts: [{ key: 'Home', value: 'Netherfield Park (tenant)' }, { key: 'Income', value: 'Four or five thousand a year' }, { key: 'First mentioned', value: 'Chapter I' }],
    body: [
      'His father left him nearly a hundred thousand pounds and the wish to buy an estate. He falls for Jane at once, leaves for London in November, and returns in the autumn to propose.',
    ],
  },
  {
    key: 'mr-bennet', category: 'characters', name: 'Mr. Bennet', aliases: [],
    summary: 'A clever, ironic father who retreats to his library and leaves his family to its follies.',
    facts: [{ key: 'Home', value: 'Longbourn' }, { key: 'Estate', value: '£2,000 a year, entailed' }, { key: 'First mentioned', value: 'Chapter I' }],
    body: [
      'Married twenty-three years to a woman he stopped respecting early. His detachment is funny until Lydia elopes, when he admits, “let me once in my life feel how much I have been to blame.”',
    ],
  },
  {
    key: 'mrs-bennet', category: 'characters', name: 'Mrs. Bennet', aliases: [],
    summary: 'A woman of mean understanding and uncertain temper whose business in life is getting her daughters married.',
    facts: [{ key: 'Home', value: 'Longbourn' }, { key: 'Fortune', value: '£4,000 from her father, an attorney in Meryton' }, { key: 'First mentioned', value: 'Chapter I' }],
    body: [
      'Sister to Mrs. Philips and Mr. Gardiner. Her nerves, her boasting at the Netherfield ball and her indulgence of Lydia do more harm to her daughters’ prospects than the entail she complains of.',
    ],
  },
  {
    key: 'lydia', category: 'characters', name: 'Lydia Bennet', aliases: ['Lydia', 'Mrs. Wickham'],
    summary: 'The youngest Bennet sister, fifteen and fearless, who follows the officers to Brighton and elopes with Wickham.',
    facts: [{ key: 'Home', value: 'Longbourn' }, { key: 'Age', value: 'Fifteen; sixteen by June (ch. 9, 49)' }, { key: 'First mentioned', value: 'Chapter I' }],
    body: [
      'Her mother’s favourite. She returns married and unashamed, and lets slip that Darcy was at her wedding.',
    ],
  },
  {
    key: 'kitty', category: 'characters', name: 'Kitty Bennet', aliases: ['Kitty', 'Catherine Bennet'],
    summary: 'The fourth sister, who follows Lydia’s lead and improves once she is away from her.',
    facts: [{ key: 'Home', value: 'Longbourn' }, { key: 'First mentioned', value: 'Chapter II' }],
    body: ['After the marriages she spends most of her time with her two eldest sisters, and becomes less irritable, less ignorant and less insipid.'],
  },
  {
    key: 'mary', category: 'characters', name: 'Mary Bennet', aliases: ['Mary'],
    summary: 'The bookish middle sister, the only plain one in the family, given to extracts and moral observations.',
    facts: [{ key: 'Home', value: 'Longbourn' }, { key: 'First mentioned', value: 'Chapter II' }],
    body: ['Her song at the Netherfield ball ends with her father’s “You have delighted us long enough.”'],
  },
  {
    key: 'wickham', category: 'characters', name: 'George Wickham', aliases: ['Mr. Wickham', 'Wickham'],
    summary: 'A charming militia officer, son of old Mr. Darcy’s steward, with a grievance and debts.',
    facts: [{ key: 'Regiment', value: 'The ——shire militia, then the regulars in the north' }, { key: 'First mentioned', value: 'Chapter XV' }],
    body: [
      'Godson of Darcy’s father, who meant him for the church. He took three thousand pounds instead of the living, squandered it, and tried to elope with Georgiana Darcy for her thirty thousand pounds.',
      'In Meryton he tells Elizabeth the opposite story, and she believes him until Darcy’s letter.',
    ],
  },
  {
    key: 'collins', category: 'characters', name: 'William Collins', aliases: ['Mr. Collins'],
    summary: 'Mr. Bennet’s cousin and heir to the entail, rector of Hunsford, devoted to his patroness.',
    facts: [{ key: 'Home', value: 'Hunsford parsonage, Kent' }, { key: 'Age', value: 'Twenty-five (ch. 13)' }, { key: 'Patron', value: 'Lady Catherine de Bourgh' }, { key: 'First mentioned', value: 'Chapter XIII' }],
    body: [
      'A mixture of pride and obsequiousness, self-importance and humility. He comes to Longbourn meaning to marry one of the cousins he will disinherit, proposes to Elizabeth, and is engaged to Charlotte Lucas three days later.',
    ],
  },
  {
    key: 'charlotte', category: 'characters', name: 'Charlotte Lucas', aliases: ['Charlotte', 'Mrs. Collins'],
    summary: 'Elizabeth’s sensible friend, twenty-seven and plain, who marries Mr. Collins for a home of her own.',
    facts: [{ key: 'Home', value: 'Lucas Lodge, then Hunsford' }, { key: 'Age', value: 'About twenty-seven (ch. 5)' }, { key: 'First mentioned', value: 'Chapter V' }],
    body: [
      'The eldest daughter of Sir William Lucas. She has no illusions about marriage and none about Mr. Collins, and she arranges her parsonage so that she sees as little of him as possible.',
    ],
  },
  {
    key: 'lady-catherine', category: 'characters', name: 'Lady Catherine de Bourgh', aliases: ['Lady Catherine'],
    summary: 'Darcy’s aunt and Mr. Collins’s patroness, mistress of Rosings, who likes to have the distinction of rank preserved.',
    facts: [{ key: 'Home', value: 'Rosings Park, Kent' }, { key: 'First mentioned', value: 'Chapter XIII' }],
    body: [
      'Widow of Sir Lewis de Bourgh. She means her sickly daughter Anne for Darcy, and her visit to Longbourn to forbid his marriage tells him that Elizabeth would not promise to refuse him.',
    ],
  },
  {
    key: 'georgiana', category: 'characters', name: 'Georgiana Darcy', aliases: ['Miss Darcy', 'Georgiana'],
    summary: 'Darcy’s shy younger sister, little more than sixteen, whom Wickham tried to persuade into an elopement.',
    facts: [{ key: 'Home', value: 'Pemberley and London' }, { key: 'Fortune', value: '£30,000' }, { key: 'First mentioned', value: 'Chapter VIII' }],
    body: ['Wickham’s story makes her proud; at Lambton Elizabeth finds her only exceedingly shy. Pemberley becomes her home with Elizabeth after the marriage.'],
  },
  {
    key: 'fitzwilliam', category: 'characters', name: 'Colonel Fitzwilliam', aliases: [],
    summary: 'Darcy’s cousin, the younger son of an earl, who shares the guardianship of Georgiana.',
    facts: [{ key: 'First mentioned', value: 'Chapter XXX' }],
    body: ['Easy and well-bred where Darcy is stiff. In the park at Rosings he tells Elizabeth, without knowing whom it concerns, that Darcy saved a friend from a most imprudent marriage.'],
  },
  {
    key: 'mr-gardiner', category: 'characters', name: 'Mr. Gardiner', aliases: [],
    summary: 'Mrs. Bennet’s brother, a sensible, gentlemanlike man in trade in London.',
    facts: [{ key: 'Home', value: 'Gracechurch Street, London' }, { key: 'First mentioned', value: 'Chapter IX' }],
    body: ['He searches London for Lydia and is credited with the settlement that Darcy paid for.'],
  },
  {
    key: 'mrs-gardiner', category: 'characters', name: 'Mrs. Gardiner', aliases: [],
    summary: 'Elizabeth’s aunt and confidante, who once lived at Lambton, near Pemberley.',
    facts: [{ key: 'Home', value: 'Gracechurch Street, London' }, { key: 'First mentioned', value: 'Chapter XXV' }],
    body: ['She warns Elizabeth against Wickham, takes her to Derbyshire, and later writes the letter that tells her what Darcy did.'],
  },
  {
    key: 'caroline', category: 'characters', name: 'Caroline Bingley', aliases: ['Miss Bingley'],
    summary: 'Bingley’s fashionable sister, with twenty thousand pounds, who wants Darcy and dislikes Elizabeth.',
    facts: [{ key: 'Fortune', value: '£20,000' }, { key: 'First mentioned', value: 'Chapter III' }],
    body: ['Her sarcasm about Elizabeth’s fine eyes and her relations near Cheapside only fixes Darcy’s attention. She keeps Jane at a distance in London.'],
  },
  {
    key: 'longbourn', category: 'places', name: 'Longbourn', aliases: [],
    summary: 'The Bennets’ house and estate in Hertfordshire, a mile from Meryton, entailed on Mr. Collins.',
    facts: [{ key: 'County', value: 'Hertfordshire' }, { key: 'Owner', value: 'Mr. Bennet' }],
    body: ['Two thousand a year, entailed in default of heirs male. Most of Volume I and the end of the book are set here.'],
  },
  {
    key: 'netherfield', category: 'places', name: 'Netherfield Park', aliases: ['Netherfield'],
    summary: 'The house three miles from Longbourn that Bingley takes before Michaelmas.',
    facts: [{ key: 'County', value: 'Hertfordshire' }, { key: 'Tenant', value: 'Charles Bingley' }],
    body: ['Jane falls ill here, Elizabeth nurses her here, and the ball of 26 November is given here.'],
  },
  {
    key: 'meryton', category: 'places', name: 'Meryton', aliases: [],
    summary: 'The market town near Longbourn: assemblies, the Philipses’ house, and the militia in winter quarters.',
    facts: [{ key: 'County', value: 'Hertfordshire' }],
    body: ['Lydia and Kitty walk here to see their aunt Philips and the officers. Wickham’s story spreads from here.'],
  },
  {
    key: 'hunsford', category: 'places', name: 'Hunsford', aliases: [],
    summary: 'Mr. Collins’s parsonage in Kent, “separated only by a lane from Rosings Park.”',
    facts: [{ key: 'County', value: 'Kent' }, { key: 'Patron', value: 'Lady Catherine de Bourgh' }],
    body: ['Charlotte’s home after her marriage. Darcy proposes to Elizabeth at the parsonage in Volume II.'],
  },
  {
    key: 'rosings', category: 'places', name: 'Rosings Park', aliases: ['Rosings'],
    summary: 'Lady Catherine de Bourgh’s seat in Kent.',
    facts: [{ key: 'County', value: 'Kent' }, { key: 'Owner', value: 'Lady Catherine de Bourgh' }],
    body: ['Darcy and Colonel Fitzwilliam spend Easter here. Elizabeth walks in its park, and Darcy gives her his letter at the edge of its grove.'],
  },
  {
    key: 'pemberley', category: 'places', name: 'Pemberley', aliases: [],
    summary: 'Darcy’s great house in Derbyshire, five miles from Lambton.',
    facts: [{ key: 'County', value: 'Derbyshire' }, { key: 'Owner', value: 'Fitzwilliam Darcy' }],
    body: ['Elizabeth has never seen a place for which nature had done more, or where natural beauty had been so little counteracted by an awkward taste. Seeing it, and him in it, changes her view.'],
  },
  {
    key: 'lambton', category: 'places', name: 'Lambton', aliases: [],
    summary: 'The small Derbyshire town where Mrs. Gardiner grew up; the party stays at its inn.',
    facts: [{ key: 'County', value: 'Derbyshire' }],
    body: ['Darcy brings Georgiana and Bingley to the inn here. Jane’s letters about Lydia reach Elizabeth here.'],
  },
  {
    key: 'gracechurch', category: 'places', name: 'Gracechurch Street', aliases: [],
    summary: 'The Gardiners’ house in the City of London, within sight of their warehouses.',
    facts: [{ key: 'City', value: 'London' }],
    body: ['Miss Bingley sneers at the Bennets’ relations near Cheapside. Jane stays here for the winter, and Mr. Gardiner’s letters about Lydia are dated from here.'],
  },
  {
    key: 'brighton', category: 'places', name: 'Brighton', aliases: [],
    summary: 'The seaside camp where the militia spends the summer and Lydia goes with Mrs. Forster.',
    facts: [{ key: 'County', value: 'Sussex' }],
    body: ['In Lydia’s imagination a visit here “comprised every possibility of earthly happiness”; Elizabeth warns her father against it. Lydia elopes from here.'],
  },
  {
    key: 'entail', category: 'lore', name: 'The entail', aliases: [],
    summary: 'Longbourn passes to the nearest male heir, Mr. Collins, not to the Bennet daughters.',
    facts: [{ key: 'Explained', value: 'Chapter VII' }],
    body: ['Mrs. Bennet can never be made to understand it. It is why the daughters need husbands, and why Mr. Collins comes to Longbourn with an olive branch.'],
  },
  {
    key: 'letter', category: 'lore', name: 'Darcy’s letter', aliases: [],
    summary: 'Darcy’s answer to Elizabeth’s charges, written at Rosings and given to her in the park the morning after his proposal.',
    facts: [{ key: 'Chapter', value: 'XXXV, read again in XXXVI' }],
    body: ['It explains his part in separating Bingley from Jane and gives Wickham’s real history. Elizabeth reads it in anger and then again, and it changes her mind.'],
  },
  {
    key: 'militia', category: 'lore', name: 'The militia', aliases: ['the regiment'],
    summary: 'The ——shire regiment, quartered in Meryton for the winter and at Brighton for the summer.',
    facts: [{ key: 'Commander', value: 'Colonel Forster' }, { key: 'Arrives', value: 'Chapter VII' }],
    body: ['The officers turn Kitty’s and Lydia’s heads and bring Wickham into the neighbourhood.'],
  },
  {
    key: 'ball', category: 'lore', name: 'The Netherfield ball', aliases: [],
    summary: 'The ball Bingley gives on Tuesday, 26 November, where Darcy watches the Bennets expose themselves.',
    facts: [{ key: 'Chapter', value: 'XVIII' }, { key: 'Date', value: 'Tuesday, 26 November' }],
    body: ['Wickham stays away; Elizabeth dances with Darcy; Mrs. Bennet, Mary, Mr. Bennet and Mr. Collins each embarrass her in turn. Darcy’s letter cites what he saw that night.'],
  },
];

export interface SampleRelationType {
  key: string;
  name: string;
  description: string;
  orientation: 'directed' | 'symmetric';
  sourceRole: string;
  targetRole: string;
  sourceKinds: readonly ('element' | 'node')[];
  targetKinds: readonly ('element' | 'node')[];
}

export const RELATION_TYPES: readonly SampleRelationType[] = [
  { key: 'family', name: 'Family', description: 'Blood relations and marriages.', orientation: 'symmetric', sourceRole: 'Relative', targetRole: 'Relative', sourceKinds: ['element'], targetKinds: ['element'] },
  { key: 'courtship', name: 'Courtship', description: 'Admiration, proposals and engagements, accepted or not.', orientation: 'symmetric', sourceRole: 'Suitor', targetRole: 'Suitor', sourceKinds: ['element'], targetKinds: ['element'] },
  { key: 'friendship', name: 'Friendship', description: 'Friends and confidants.', orientation: 'symmetric', sourceRole: 'Friend', targetRole: 'Friend', sourceKinds: ['element'], targetKinds: ['element'] },
  { key: 'rivalry', name: 'Rivalry', description: 'Open or hidden hostility.', orientation: 'symmetric', sourceRole: 'Rival', targetRole: 'Rival', sourceKinds: ['element'], targetKinds: ['element'] },
  { key: 'patronage', name: 'Patronage', description: 'Who owes a living or a position to whom.', orientation: 'directed', sourceRole: 'Patron', targetRole: 'Dependant', sourceKinds: ['element'], targetKinds: ['element'] },
  { key: 'deception', name: 'Deception', description: 'Who misleads whom, and about what.', orientation: 'directed', sourceRole: 'Deceiver', targetRole: 'Deceived', sourceKinds: ['element'], targetKinds: ['element'] },
  { key: 'home', name: 'Lives at', description: 'Where a character lives during the novel.', orientation: 'directed', sourceRole: 'Resident', targetRole: 'Home', sourceKinds: ['element'], targetKinds: ['element'] },
  { key: 'key-scene', name: 'Key scene', description: 'The chapter where an object or event matters most.', orientation: 'directed', sourceRole: 'Element', targetRole: 'Chapter', sourceKinds: ['element'], targetKinds: ['node'] },
];

export interface SampleRelation {
  type: string;
  from: string;
  /** An element key, or a chapter number for chapter targets. */
  to: string | number;
}

export const RELATIONS: readonly SampleRelation[] = [
  { type: 'family', from: 'mr-bennet', to: 'mrs-bennet' },
  { type: 'family', from: 'jane', to: 'elizabeth' },
  { type: 'family', from: 'mr-bennet', to: 'elizabeth' },
  { type: 'family', from: 'mrs-bennet', to: 'lydia' },
  { type: 'family', from: 'lydia', to: 'kitty' },
  { type: 'family', from: 'mary', to: 'elizabeth' },
  { type: 'family', from: 'mrs-bennet', to: 'mr-gardiner' },
  { type: 'family', from: 'mr-gardiner', to: 'mrs-gardiner' },
  { type: 'family', from: 'darcy', to: 'georgiana' },
  { type: 'family', from: 'lady-catherine', to: 'darcy' },
  { type: 'family', from: 'fitzwilliam', to: 'darcy' },
  { type: 'family', from: 'bingley', to: 'caroline' },
  { type: 'family', from: 'collins', to: 'mr-bennet' },
  { type: 'courtship', from: 'elizabeth', to: 'darcy' },
  { type: 'courtship', from: 'jane', to: 'bingley' },
  { type: 'courtship', from: 'lydia', to: 'wickham' },
  { type: 'courtship', from: 'charlotte', to: 'collins' },
  { type: 'courtship', from: 'collins', to: 'elizabeth' },
  { type: 'friendship', from: 'darcy', to: 'bingley' },
  { type: 'friendship', from: 'elizabeth', to: 'charlotte' },
  { type: 'rivalry', from: 'caroline', to: 'elizabeth' },
  { type: 'rivalry', from: 'darcy', to: 'wickham' },
  { type: 'patronage', from: 'lady-catherine', to: 'collins' },
  { type: 'deception', from: 'wickham', to: 'elizabeth' },
  { type: 'deception', from: 'wickham', to: 'georgiana' },
  { type: 'deception', from: 'wickham', to: 'lydia' },
  { type: 'deception', from: 'darcy', to: 'bingley' },
  { type: 'home', from: 'elizabeth', to: 'longbourn' },
  { type: 'home', from: 'bingley', to: 'netherfield' },
  { type: 'home', from: 'darcy', to: 'pemberley' },
  { type: 'home', from: 'lady-catherine', to: 'rosings' },
  { type: 'home', from: 'collins', to: 'hunsford' },
  { type: 'home', from: 'mr-gardiner', to: 'gracechurch' },
  { type: 'key-scene', from: 'entail', to: 13 },
  { type: 'key-scene', from: 'ball', to: 18 },
  { type: 'key-scene', from: 'letter', to: 35 },
  { type: 'key-scene', from: 'militia', to: 41 },
];

/** Pins on the narrative timeline, placed just before the chapter they date. */
export const TIMELINE_PINS: readonly { beforeChapter: number; label: string }[] = [
  { beforeChapter: 1, label: 'Sept 1811 · Netherfield is let' },
  { beforeChapter: 13, label: 'Nov 1811 · Mr. Collins arrives' },
  { beforeChapter: 25, label: 'Christmas 1811' },
  { beforeChapter: 30, label: 'Easter 1812 · Rosings' },
  { beforeChapter: 41, label: 'May 1812 · Brighton' },
  { beforeChapter: 43, label: 'July 1812 · Pemberley' },
  { beforeChapter: 53, label: 'Autumn 1812 · Bingley returns' },
];

/** Changes to an element, anchored to the passage that makes them. */
export const ELEMENT_PATCHES: readonly { element: string; chapter: number; quotation: string; title: string; body: string }[] = [
  {
    element: 'elizabeth', chapter: 36, quotation: 'Till this moment, I never knew myself.',
    title: 'She sees her own prejudice',
    body: 'Rereading the letter, she accepts Darcy’s account of Wickham and admits she has been “blind, partial, prejudiced, absurd.” From here she judges Darcy by evidence, not by the slight at the assembly.',
  },
  {
    element: 'wickham', chapter: 35, quotation: 'Mr. Wickham’s chief object was unquestionably my sister’s fortune, which is thirty thousand pounds',
    title: 'His history, as Darcy tells it',
    body: 'The legacy, the three thousand pounds taken instead of the living, and the plan to elope with Georgiana at Ramsgate. His charm in Meryton now reads as calculation.',
  },
  {
    element: 'darcy', chapter: 43, quotation: 'He is the best landlord, and the best master,',
    title: 'Seen by those who know him',
    body: 'Mrs. Reynolds has known him since he was four years old and never had a cross word from him. Elizabeth begins to measure him by his effect on others.',
  },
  {
    element: 'charlotte', chapter: 22, quotation: 'I am not romantic, you know. I never was.',
    title: 'She accepts Mr. Collins',
    body: 'She takes him for a comfortable home, knowing exactly what he is. Marriage was “the only honourable provision for well-educated young women of small fortune.”',
  },
];

export interface SampleComment {
  kind: 'note' | 'todo';
  chapter?: number;
  element?: string;
  quotation?: string;
  body: string;
  resolved?: boolean;
}

export const COMMENTS: readonly SampleComment[] = [
  {
    kind: 'note', chapter: 1, quotation: 'It is a truth universally acknowledged, that a single man in possession of a good fortune must be in want of a wife.',
    body: 'The “truth” belongs to the neighbourhood, not to the single man: the next paragraph calls him “the rightful property of some one or other of their daughters.” Every proposal in the book tests this sentence.',
  },
  {
    kind: 'note', chapter: 3, quotation: 'She is tolerable: but not handsome enough to tempt me',
    body: 'Elizabeth overhears this and makes a story of it for her friends. Darcy has to unsay it at Pemberley: “one of the handsomest women of my acquaintance.”',
    resolved: true,
  },
  {
    kind: 'todo', chapter: 18, quotation: 'That will do extremely well, child. You have delighted us long enough.',
    body: 'List every embarrassment Darcy witnesses at the ball (Mr. Collins, Mrs. Bennet at supper, Mary, Mr. Bennet). His letter cites them.',
    resolved: true,
  },
  {
    kind: 'todo', chapter: 34, quotation: 'In vain have I struggled. It will not do.',
    body: 'Set the two proposals side by side (chapters XXXIV and LVIII): what Darcy says about her family each time, and what he leaves out.',
  },
  {
    kind: 'note', chapter: 43, quotation: 'to be mistress of Pemberley might be something!',
    body: 'Irony at her own expense rather than second thoughts about money: she has already refused him, and the house shows her his taste.',
  },
  {
    kind: 'todo', element: 'wickham',
    body: 'Trace where Wickham’s version of the Darcy story is repeated before the letter (chapters XVI and XXIV) and who believes it.',
  },
];

/** Ideas (构想): the author's loose notes, not part of the book. */
export const IDEAS: readonly { title: string; summary: string; body: readonly string[] }[] = [
  {
    title: 'First Impressions',
    summary: 'The working title, and why it fits Volume I better than the book.',
    body: [
      'Austen drafted the novel in 1796–97 as First Impressions. The old title is the plot of Volume I: everyone, Elizabeth most of all, judges at first sight.',
      'Pride and Prejudice describes the correction instead, and makes both main characters answerable for it.',
    ],
  },
  {
    title: 'The letter is the hinge',
    summary: 'Chapter XXXV sits near the middle; the second half rereads the first.',
    body: [
      'After the letter, almost every scene from Volume I comes back with a different meaning: the assembly, Wickham at the Philipses’, the Netherfield ball.',
      'Worth marking each callback in the margin when reading Volume III.',
    ],
  },
  {
    title: 'Which year?',
    summary: 'Austen never names one; the timeline pins assume 1811–12.',
    body: [
      'The weekdays given for November, Monday the 18th and Tuesday the 26th, fit 1811, which is the year the timeline pins use. Later dates in the letters do not all fit one calendar, so the pins after Christmas are seasons, not days.',
    ],
  },
  {
    title: 'Mr. Bennet’s share',
    summary: 'The witty father is also the negligent one.',
    body: [
      'He lets Lydia go to Brighton to keep the peace at home, and says so. When she elopes he blames himself, and is teasing Kitty again by teatime.',
      'Compare the account of his marriage at the start of Volume II, chapter XIX.',
    ],
  },
  {
    title: 'Charlotte as a mirror',
    summary: 'Elizabeth’s friend makes the choice Elizabeth refuses.',
    body: [
      'Charlotte accepts the proposal Elizabeth turned down, for reasons the narrator states without irony. Hunsford then shows what that bargain looks like from the inside.',
    ],
  },
];

/** Material notes, written in the material-note Markdown the Agent uses. */
export const MATERIAL_NOTES: readonly { title: string; markdown: string }[] = [
  {
    title: 'The entail, explained',
    markdown: [
      'Longbourn, worth **£2,000 a year**, is entailed “in default of heirs male”: it can only pass to a man, so it goes to Mr. Bennet’s nearest male relation, his cousin **Mr. Collins**.',
      '',
      '## Why it matters',
      '',
      '- When Mr. Bennet dies, his wife and daughters lose their home.',
      '- They will have only the £5,000 settled by marriage articles on Mrs. Bennet and the children.',
      '- So the daughters need husbands, and Mr. Collins arrives offering to marry one of them as amends.',
      '',
      '## Why nothing was done',
      '',
      'The Bennets married expecting a son, who would join his father in cutting off the entail when he came of age. The son never came, and Mr. Bennet saved nothing (chapter L).',
    ].join('\n'),
  },
  {
    title: 'Money and rank',
    markdown: [
      'Incomes and fortunes the novel states, for reading the marriages.',
      '',
      '- **Darcy**: £10,000 a year.',
      '- **Bingley**: four or five thousand a year; nearly £100,000 inherited.',
      '- **Mr. Bennet**: an estate of £2,000 a year, entailed.',
      '- **Georgiana Darcy**: £30,000. **Caroline Bingley**: £20,000. **Miss King**: £10,000.',
      '- **Elizabeth**: £1,000 in the 4 per cents after her mother’s death, as Mr. Collins reminds her.',
      '- **Wickham**: a £1,000 legacy and £3,000 instead of the living, all spent.',
      '- **Lydia’s settlement**: her share of the £5,000 and £100 a year from her father.',
    ].join('\n'),
  },
];

export const ILLUSTRATION_FOLDER = 'Hugh Thomson’s illustrations (1894)';

/** The note shown with each illustration material, by bundled illustration name. */
export const ILLUSTRATION_NOTES: Readonly<Record<string, string>> = {
  'mr-and-mrs-bennet': 'Hugh Thomson, for the George Allen edition of 1894. Faces chapter I.',
  'she-is-tolerable': 'Hugh Thomson, 1894. Chapter III: Darcy declines to dance with Elizabeth at the Meryton assembly.',
  'never-read-novels': 'Hugh Thomson, 1894. Chapter XIV: Mr. Collins chooses Fordyce’s Sermons.',
  'hearing-herself-called': 'Hugh Thomson, 1894. Heading to chapter XXXV: Darcy gives Elizabeth his letter.',
  'after-a-short-survey': 'Hugh Thomson, 1894. Chapter LVI: Lady Catherine at Longbourn.',
};

/** A plot grid for the Netherfield ball. Empty strings are empty cells. */
export const PLOT_GRID = {
  chapter: 18,
  columns: ['Arrival', 'The dancing', 'Before supper', 'Supper and after'],
  rows: [
    {
      label: 'Elizabeth',
      cells: [
        'Looks for Wickham in vain; Denny hints he is avoiding a certain gentleman.',
        'Two dances of mortification with Mr. Collins, then a set with Darcy in which she raises Wickham.',
        'Miss Bingley warns her against Wickham; Jane reports what Bingley knows.',
        'Watches her mother, Mary and Mr. Collins expose the family in turn.',
      ],
    },
    {
      label: 'Darcy',
      cells: [
        'Blamed, in Elizabeth’s mind, for Wickham’s absence.',
        'Sir William’s hint about Jane and Bingley makes him look at them gravely.',
        'Mr. Collins introduces himself; Darcy answers with distant civility.',
        'Overhears Mrs. Bennet; his face changes from contempt to steady gravity.',
      ],
    },
    {
      label: 'Jane & Bingley',
      cells: [
        '',
        'Their marriage is already talked of as settled.',
        'Bingley vouches for Darcy but knows little of Wickham’s history.',
        'Mrs. Bennet tells Lady Lucas the match is certain.',
      ],
    },
    {
      label: 'The family',
      cells: [
        'Lydia asks Denny where Wickham is.',
        'Mr. Collins dances badly and apologises often.',
        'Mr. Collins insists on introducing himself to Darcy.',
        'Mary sings too long; Mr. Bennet stops her; the Bennets are the last to leave.',
      ],
    },
  ],
};

/**
 * How the chapters name each element, linked as an author would have done:
 * every whole-word, case-sensitive occurrence, the longest form winning where
 * forms overlap. A `null` element marks a form that must stay unlinked because
 * a shorter form inside it would point at the wrong person (Darcy's father,
 * Lady Anne Darcy, Mary King). "Miss Bennet" stays unlinked: it is Jane
 * except when Lady Catherine addresses Elizabeth.
 */
export const LINK_FORMS: readonly { form: string; element: string | null }[] = [
  { form: 'late Mr. Darcy', element: null },
  { form: 'Lady Anne Darcy', element: null },
  { form: 'Mary King', element: null },
  { form: 'Miss Bennet', element: null },
  { form: 'Elizabeth', element: 'elizabeth' },
  { form: 'Lizzy', element: 'elizabeth' },
  { form: 'Eliza', element: 'elizabeth' },
  { form: 'Mrs. Darcy', element: 'elizabeth' },
  { form: 'Fitzwilliam Darcy', element: 'darcy' },
  { form: 'Mr. Darcy', element: 'darcy' },
  { form: 'Darcy', element: 'darcy' },
  { form: 'Miss Darcy', element: 'georgiana' },
  { form: 'Georgiana', element: 'georgiana' },
  { form: 'Jane', element: 'jane' },
  { form: 'Mrs. Bingley', element: 'jane' },
  { form: 'Mr. Bingley', element: 'bingley' },
  { form: 'Bingley', element: 'bingley' },
  { form: 'Miss Bingley', element: 'caroline' },
  { form: 'Caroline', element: 'caroline' },
  { form: 'Mr. Bennet', element: 'mr-bennet' },
  { form: 'Mrs. Bennet', element: 'mrs-bennet' },
  { form: 'Lydia', element: 'lydia' },
  { form: 'Mrs. Wickham', element: 'lydia' },
  { form: 'Kitty', element: 'kitty' },
  { form: 'Catherine', element: 'kitty' },
  { form: 'Mary', element: 'mary' },
  { form: 'Mr. Wickham', element: 'wickham' },
  { form: 'Wickham', element: 'wickham' },
  { form: 'Mr. Collins', element: 'collins' },
  { form: 'Charlotte', element: 'charlotte' },
  { form: 'Mrs. Collins', element: 'charlotte' },
  { form: 'Miss Lucas', element: 'charlotte' },
  { form: 'Lady Catherine de Bourgh', element: 'lady-catherine' },
  { form: 'Lady Catherine', element: 'lady-catherine' },
  { form: 'Colonel Fitzwilliam', element: 'fitzwilliam' },
  { form: 'Fitzwilliam', element: 'fitzwilliam' },
  { form: 'Mr. Gardiner', element: 'mr-gardiner' },
  { form: 'Mrs. Gardiner', element: 'mrs-gardiner' },
  { form: 'Longbourn', element: 'longbourn' },
  { form: 'Netherfield Park', element: 'netherfield' },
  { form: 'Netherfield', element: 'netherfield' },
  { form: 'Meryton', element: 'meryton' },
  { form: 'Hunsford', element: 'hunsford' },
  { form: 'Rosings Park', element: 'rosings' },
  { form: 'Rosings', element: 'rosings' },
  { form: 'Pemberley', element: 'pemberley' },
  { form: 'Lambton', element: 'lambton' },
  { form: 'Gracechurch Street', element: 'gracechurch' },
  { form: 'Brighton', element: 'brighton' },
  { form: 'entail', element: 'entail' },
  { form: 'militia', element: 'militia' },
];
