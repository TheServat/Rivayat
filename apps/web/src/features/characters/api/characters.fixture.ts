/**
 * A cast and a bi-temporal graph that behave like the real ones.
 *
 * Reached only when the whole studio is running on recorded data, which is opt-in and
 * badged in the shell. Everything is parsed through the real `@rv/contracts` schemas on
 * the way out, exactly as the shared fixture transport does: a fixture that has drifted
 * from the contract is a bug worth failing on, and `Entity` is a large enough shape that
 * hand-writing one without validation is how a screen ends up rendering a half-filled
 * character sheet nobody notices.
 *
 * The graph is built around the canonical case the epistemic model exists for. Bibi
 * Golab is Mahtab's mother; the fact is `secret`, and Mahtab is its **object** — which
 * is precisely the person it is kept from. Mahtab instead holds a `believes-falsely`
 * edge about the night of the flood, valid E01 to E08, and a `knows` edge that opens at
 * E08 when the reveal lands. Standing at E05 and standing at E09 therefore produce
 * genuinely different answers for the same viewer, which is the only way to show that a
 * time model is doing anything.
 *
 * The authoring clock is exercised too, by the move serialised fiction actually makes:
 * an `ally-of` edge asserted in the first pass and retracted in the second, and a
 * `resents` edge asserted in the second pass about a story time in the first. Standing
 * "as we believe now" shows the second; standing at an instant between the two passes
 * shows the first.
 */

import {
  type Entity,
  type EntityId,
  type NamedVisualState,
  type ProjectId,
  type SeriesCard,
  type SeriesId,
  type WardrobeSet,
} from '@rv/contracts';

import { ApiError } from '../../../api/errors';
import { FIXTURE_SERIES } from '../../story/api/story.fixture';

import {
  type CharacterStateCell,
  type CharacterStateEdit,
  type CharacterStates,
  type StateCellStatus,
  type NarrativeSnapshot,
  NarrativeSnapshot as NarrativeSnapshotSchema,
} from './graph';

const SERIES_ID = 'ser_01JQZK3M7X8YB4N2VTC6WPHRDF' as SeriesId;

const KEEPER = 'ent_KEEPER00000000000000000001' as EntityId;
const MAHTAB = 'ent_MAHTAB00000000000000000001' as EntityId;
const FARHAD = 'ent_FARHAD00000000000000000001' as EntityId;
const GARDEN = 'ent_WATERS00000000000000000001' as EntityId;
const FLOOD = 'ent_FDNGHT00000000000000000001' as EntityId;
const TIN = 'ent_TNCAN000000000000000000001' as EntityId;

/** The first pass, and the rewrite ten days later. Both fixed; nothing here reads a clock. */
const FIRST_PASS = '2026-08-12T10:00:00+03:30';
const REWRITE = '2026-08-22T16:30:00+03:30';

/**
 * Ids, generated rather than typed out.
 *
 * A `RelationId` is `rel_` plus twenty-six Crockford base32 characters, an alphabet
 * that excludes I, L, O and U — so a readable tag like `FALSEBELIEF` is not a legal id
 * however carefully it is counted. The relations below are addressed by position and
 * described by their `fact`, which is the field anyone actually reads.
 */
const padded = (prefix: string, index: number): string =>
  `${prefix}RVDEM${String(index + 1).padStart(21, '0')}`;

const relationId = (index: number): string => padded('rel_', index);
const episodeId = (index: number): string => padded('ep_', index);

// ── the two clocks, as points worth standing on ─────────────────────────────

/**
 * Twelve episodes, carrying only their ordinal.
 *
 * No label: an episode number is a number, and the interface renders it in the reader's
 * own numerals. A label here would be the fixture deciding what digits a Persian page
 * shows.
 */
const STORY_MARKS = Array.from({ length: 12 }, (_unused, index) => ({
  at: { ordinal: index + 1 },
}));

const REVISIONS = [
  {
    at: FIRST_PASS,
    label: 'نگارش نخست',
    note: 'اولین بار که گراف نوشته شد: فرهاد هم‌پیمان بی‌بی گلاب بود.',
  },
  {
    at: REWRITE,
    label: 'بازنویسی قسمت هفت',
    note: 'تصمیم گرفتیم فرهاد از همان قسمت دو کینه داشته باشد. گذشته عوض نشد؛ چیزی که دربارهٔ گذشته می‌گوییم عوض شد.',
  },
];

// ── the cast ────────────────────────────────────────────────────────────────

function expression(slug: string, label: string, description: string, intensity: number) {
  return { slug, label, description, intensity };
}

const KEEPER_WARDROBE: WardrobeSet[] = [
  {
    slug: 'wardrobe-summer',
    label: 'پیراهن تابستان',
    description:
      'پیراهن نخی بلند نیلی با یقهٔ ساده و آستین‌های تا شده تا آرنج، روسری سیاه گره‌خورده پشت گردن، و یک پیش‌بند کتانی که از آب چاه لکه گرفته است.',
    validity: { from: null, until: null },
    palette: [
      { name: 'نیلی کهنه', hex: '#3a4a6b', role: 'primary' },
      { name: 'سیاه دودی', hex: '#2b2b2e', role: 'secondary' },
    ],
  },
  {
    slug: 'wardrobe-mourning',
    label: 'سیاه سالگرد',
    description:
      'همان برش، تماماً سیاه، بدون پیش‌بند؛ آستین‌ها پایین و بسته، و یک دستمال سفید تا شده در مشت.',
    validity: { from: { ordinal: 8 }, until: null },
    palette: [{ name: 'سیاه مات', hex: '#1e1e21', role: 'primary' }],
  },
];

const KEEPER_EXPRESSIONS: NamedVisualState[] = [
  expression(
    'guarded',
    'محتاط',
    'ابروها پایین و صاف، پلک‌ها کمی تنگ، لب‌ها بسته و کشیده، چانه اندکی بالا، شانه‌ها بی‌حرکت.',
    0.6,
  ),
  expression(
    'welcoming',
    'مهمان‌نواز',
    'گوشهٔ چشم‌ها چین خورده، لبخند بسته، سر کمی به یک طرف، دست راست باز به سمت بیرون.',
    0.5,
  ),
  expression(
    'cornered',
    'در تنگنا',
    'مردمک‌ها ثابت، فک منقبض، عضلهٔ گونه بیرون‌زده، دست‌ها پشت کمر گره‌خورده، وزن روی پای عقب.',
    0.85,
  ),
  expression(
    'grief',
    'سوگ',
    'پلک‌ها سنگین و پایین، ابروی داخلی بالا رفته، دهان کمی باز، شانه‌ها افتاده، نگاه به زمین.',
    0.9,
  ),
];

const KEEPER_POSES: NamedVisualState[] = [
  expression(
    'standing-guard',
    'ایستاده جلوی چاه',
    'پاها به عرض شانه، وزن یکنواخت، هر دو دست جلوی شکم گره‌خورده، پشت صاف، رو به دوربین.',
    0.6,
  ),
  expression(
    'pouring-tea',
    'چای ریختن',
    'زانو زده روی یک زانو، تنه کمی جلو، قوری در دست راست بالا، دست چپ زیر آستین.',
    0.4,
  ),
  expression(
    'sitting-down',
    'نشستن',
    'روی لبهٔ چاه فرو نشسته، آرنج‌ها روی زانو، سر پایین، کف دست‌ها باز رو به بالا.',
    0.8,
  ),
];

const MAHTAB_WARDROBE: WardrobeSet[] = [
  {
    slug: 'wardrobe-day',
    label: 'لباس روز',
    description:
      'پیراهن گلی‌رنگ کوتاه تا زانو با وصلهٔ آبی روی جیب، شلوار گشاد نخی، و کفش‌های پاره‌ای که بندشان دو بار گره خورده است.',
    validity: { from: null, until: null },
    palette: [
      { name: 'گِلی روشن', hex: '#c98f63', role: 'primary' },
      { name: 'آبی وصله', hex: '#4b7ea8', role: 'accent' },
    ],
  },
  {
    slug: 'wardrobe-night',
    label: 'لباس شب‌روی',
    description:
      'همان پیراهن زیر یک ژاکت پشمی تیرهٔ بزرگ‌تر از تنش، آستین‌ها تا شده، طنابی دور کمر به جای کمربند.',
    validity: { from: { ordinal: 2 }, until: null },
    palette: [{ name: 'پشمی دود', hex: '#4a4a44', role: 'primary' }],
  },
];

const MAHTAB_EXPRESSIONS: NamedVisualState[] = [
  expression(
    'curious',
    'کنجکاو',
    'ابروها بالا و نامتقارن، چشم‌ها گشاد، دهان کمی باز، سر جلو آمده، شانهٔ چپ بالاتر.',
    0.7,
  ),
  expression(
    'caught',
    'مچ‌گرفته',
    'شانه‌ها بالا رفته و منجمد، ابروها بالا، پلک‌ها گشاد، لب پایین زیر دندان، نفس نگه‌داشته.',
    0.8,
  ),
  expression(
    'stubborn',
    'یک‌دنده',
    'چانه پایین و جلو، ابروها به هم نزدیک، لب‌ها فشرده، پیشانی صاف، نگاه مستقیم.',
    0.75,
  ),
  expression(
    'grinning',
    'خنده‌رو',
    'دندان‌های بالا پیدا، گوشهٔ چشم‌ها جمع، بینی چروک، سر عقب.',
    0.6,
  ),
  expression(
    'afraid',
    'ترسیده',
    'ابروها هر دو بالا و به هم چسبیده، پلک پایین منقبض، لب‌ها کشیده به طرفین، گردن جمع.',
    0.85,
  ),
  expression(
    'betrayed',
    'خیانت‌دیده',
    'پلک‌ها ثابت و بی‌پلک‌زدن، دهان نیمه‌باز، خون از صورت رفته، دست‌ها آویزان.',
    0.95,
  ),
  expression(
    'exhausted',
    'خسته',
    'پلک‌ها نیمه، دهان باز برای نفس، موهای چسبیده به پیشانی، سر تکیه‌داده.',
    0.7,
  ),
  expression(
    'resolved',
    'مصمم',
    'فک آرام ولی بسته، ابروها صاف، نگاه بالا و ثابت، شانه‌ها عقب و پایین.',
    0.65,
  ),
];

const MAHTAB_POSES: NamedVisualState[] = [
  expression(
    'wall-climb',
    'بالا رفتن از دیوار',
    'نیم‌رخ، انگشتان پا روی شکاف آجر، هر دو دست بالای سر، کمر قوس‌دار، یک زانو بالا.',
    0.8,
  ),
  expression(
    'crouched',
    'چمباتمه',
    'روی پنجهٔ پا نشسته، آرنج‌ها روی زانو، سر پایین‌تر از خط دیوار، کف دست‌ها روی خاک.',
    0.7,
  ),
  expression(
    'rope-descent',
    'پایین رفتن با طناب',
    'یک پا در حلقهٔ طناب، هر دو دست بالای گره، تنه چرخیده، نگاه رو به پایین.',
    0.9,
  ),
  expression(
    'holding-tin',
    'قوطی به بغل',
    'ایستاده، هر دو دست قوطی را به سینه چسبانده، شانه‌ها جمع، وزن روی پای چپ.',
    0.6,
  ),
  expression(
    'running',
    'دویدن',
    'گام بلند، بازوی مخالف جلو، تنه جلو مایل، موها عقب، یک پا کاملاً از زمین جدا.',
    0.8,
  ),
  expression(
    'facing-keeper',
    'رو در رو',
    'ایستاده رو به دوربین، پاها جفت، دست‌ها مشت‌شده کنار بدن، چانه بالا.',
    0.75,
  ),
];

const ENTITIES: unknown[] = [
  {
    id: KEEPER,
    seriesId: SERIES_ID,
    kind: 'character',
    canonicalName: 'بی‌بی گلاب',
    aliases: ['گلاب خانم', 'نگهبان چاه'],
    summary:
      'چهل سال است باغ انار را تنها آب می‌دهد و نمی‌گذارد کسی به چاه نزدیک شود. مهمان‌نواز است تا لحظه‌ای که پای چاه وسط بیاید.',
    firstAppearance: { ordinal: 1, label: 'قسمت ۱' },
    importance: 'lead',
    assetRefs: [],
    embedding: [],
    payload: {
      identity: {
        age: 'اواخر شصت',
        ageYears: 68,
        gender: 'زن',
        species: 'human',
        occupation: 'باغبان و نگهبان چاه',
        origin: 'همان باغ؛ هیچ‌وقت بیرون از دیوار زندگی نکرده است.',
      },
      psych: {
        want: 'می‌خواهد چاه بسته بماند و هیچ عددی از آن در هیچ پرونده‌ای ثبت نشود.',
        need: 'باید بپذیرد که پنهان کردن حقیقت از مهتاب، همان بلایی است که سرِ خودش آمد.',
        wound: 'شبی که سیل آمد، تنها یک نفر را توانست از آب بیرون بکشد و آن یک نفر مهتاب بود.',
        lie: 'اگر کسی نداند، کسی هم آسیب نمی‌بیند.',
        ghost: 'شب سیل، سال هزار و سیصد و پنجاه و هفت.',
        virtues: ['وفاداری', 'صبر', 'میهمان‌نوازی بی‌قید'],
        flaws: ['کنترل‌گری', 'سکوت به جای جواب'],
        fears: ['اینکه مهتاب حقیقت را از دیگری بشنود'],
        values: ['آب', 'قول', 'خاک باغ'],
        temperament: {
          warmth: 0.3,
          dominance: 0.8,
          volatility: -0.6,
          openness: -0.5,
          conscientiousness: 0.9,
        },
      },
      voice: {
        register: 'formal',
        verbosity: 'terse',
        idiolect: ['اصطلاحات آبیاری', 'ضرب‌المثل کویری'],
        verbalTics: ['جواب سؤال را با تعارف عوض می‌کند'],
        profanity: 'none',
        sentenceRhythm: 'balanced',
        humourMode: 'dry',
        silenceHabits:
          'وقتی بحث به چاه می‌رسد ساکت می‌شود و چای می‌ریزد. سکوتش یعنی جواب همان است که بود.',
      },
      arc: {
        startState: 'در برابر هر پرسشی چای می‌آورد و جواب نمی‌دهد.',
        endState: 'یک بار می‌نشیند و بی‌آنکه تعارفی در کار باشد، جواب می‌دهد.',
        turningPoints: [],
      },
      visual: {
        silhouetteNote:
          'یک ستون باریک با روسری گره‌خورده که خط شانه را می‌شکند؛ از دور مثل تیرک چاه است.',
        build: 'slight',
        height: 'کوتاه‌تر از همه، ولی هیچ‌وقت به نظر کوچک نمی‌آید.',
        palette: [
          { name: 'نیلی کهنه', hex: '#3a4a6b', role: 'primary' },
          { name: 'خاک انار', hex: '#8c4a3f', role: 'accent' },
        ],
        distinguishingMarks: ['سوختگی قدیمی روی پشت دست چپ'],
        wardrobe: KEEPER_WARDROBE,
        expressionSet: KEEPER_EXPRESSIONS,
        poseSet: KEEPER_POSES,
        propAffinities: [
          { label: 'سطل حلبی چاه', note: 'وقتی نگران است، دستهٔ سطل را صاف می‌کند.' },
        ],
      },
      motionSignature: {
        gaitStyle: 'glide',
        posture: 'upright',
        gestureFrequency: 0.2,
        energy: 0.35,
        idleBehaviour: 'کف دست را روی لبهٔ چاه می‌گذارد و همان‌جا نگه می‌دارد.',
        tellOnLying: 'پیش از جواب دادن، گوشهٔ روسری را دوباره گره می‌زند.',
      },
      knowledgeScope: 'limited',
    },
  },
  {
    id: MAHTAB,
    seriesId: SERIES_ID,
    kind: 'character',
    canonicalName: 'مهتاب',
    aliases: ['دختر دیوار'],
    summary:
      'سیزده ساله، شب‌ها از دیوار باغ بالا می‌رود. باور دارد پدر و مادرش در شب سیل غرق شدند و کسی تا قسمت هشت خلافش را به او نمی‌گوید.',
    firstAppearance: { ordinal: 1, label: 'قسمت ۱' },
    importance: 'lead',
    assetRefs: [],
    embedding: [],
    payload: {
      identity: {
        age: 'سیزده',
        ageYears: 13,
        gender: 'دختر',
        species: 'human',
        occupation: 'شاگرد نانوایی، نیمه‌وقت',
        origin: 'خانهٔ آخر کوچه، پشت دیوار باغ.',
      },
      psych: {
        want: 'می‌خواهد بفهمد ته چاه چیست.',
        need: 'باید بپذیرد که دانستن حقیقت، آدم‌ها را به او پس نمی‌دهد.',
        wound: 'بزرگ شدن با روایتی که هیچ‌کس حاضر نبود دو بار تعریفش کند.',
        lie: 'اگر به اندازهٔ کافی بگردم، معلوم می‌شود همه اشتباه می‌کردند.',
        ghost: 'شب سیل، که خودش یادش نمی‌آید و همه یادشان هست.',
        virtues: ['جسارت', 'وفاداری به دوست'],
        flaws: ['بی‌پروایی', 'دروغ‌های کوچک بی‌دلیل'],
        fears: ['تنها ماندن در تاریکی و ساکت بودن آب'],
        values: ['راست شنیدن'],
        temperament: {
          warmth: 0.5,
          dominance: 0.1,
          volatility: 0.6,
          openness: 0.9,
          conscientiousness: -0.3,
        },
      },
      voice: {
        register: 'colloquial',
        verbosity: 'expansive',
        idiolect: ['واژه‌های نانوایی', 'قیاس با چیزهای خوردنی'],
        verbalTics: ['وسط جمله موضوع را عوض می‌کند و برنمی‌گردد'],
        profanity: 'mild',
        sentenceRhythm: 'staccato',
        humourMode: 'absurd',
        silenceHabits: 'وقتی می‌ترسد پرحرف‌تر می‌شود؛ سکوتش فقط وقتی است که راست شنیده باشد.',
      },
      arc: {
        startState: 'هر شب از دیوار بالا می‌رود تا چیزی را که نمی‌داند پیدا کند.',
        endState: 'یک بار از در جلو می‌آید و می‌پرسد.',
        turningPoints: [],
      },
      visual: {
        silhouetteNote: 'دو دست همیشه بالاتر از خط شانه، مثل کسی که وسط بالا رفتن است.',
        build: 'slight',
        height: 'تا شانهٔ فرهاد',
        palette: [
          { name: 'گِلی روشن', hex: '#c98f63', role: 'primary' },
          { name: 'آبی وصله', hex: '#4b7ea8', role: 'accent' },
        ],
        distinguishingMarks: ['زانوی راست همیشه زخمی', 'یک وصلهٔ آبی روی جیب'],
        wardrobe: MAHTAB_WARDROBE,
        expressionSet: MAHTAB_EXPRESSIONS,
        poseSet: MAHTAB_POSES,
        propAffinities: [{ label: 'طناب سطل', note: 'گره‌ها را بی‌آنکه نگاه کند می‌زند.' }],
      },
      motionSignature: {
        gaitStyle: 'bounce',
        posture: 'loose',
        gestureFrequency: 0.85,
        energy: 0.9,
        idleBehaviour: 'روی پاشنه جلو و عقب می‌رود و با نوک انگشت به چیزی ضرب می‌گیرد.',
        tellOnLying: 'قبل از جواب، یک بار پلک محکم می‌زند.',
      },
      knowledgeScope: 'limited',
    },
  },
  {
    id: FARHAD,
    seriesId: SERIES_ID,
    kind: 'character',
    canonicalName: 'مهندس فرهاد',
    aliases: ['مهمانِ اندازه‌گیر'],
    summary:
      'از ادارهٔ آب پایتخت آمده تا چاه را اندازه بگیرد. مؤدب، دقیق، و تا قسمت هفت هیچ‌کس نمی‌داند چرا این‌قدر اصرار دارد.',
    firstAppearance: { ordinal: 1, label: 'قسمت ۱' },
    importance: 'supporting',
    assetRefs: [],
    embedding: [],
    payload: {
      identity: {
        age: 'اوایل چهل',
        ageYears: 41,
        gender: 'مرد',
        species: 'human',
        occupation: 'مهندس منابع آب',
        origin: 'پایتخت؛ ولی پدرش از همین حوالی بوده است.',
      },
      psych: {
        want: 'می‌خواهد عدد درست را در پرونده بنویسد و برگردد.',
        need: 'باید بپذیرد که هیچ عددی، آنچه را از این باغ گرفته شده جبران نمی‌کند.',
        wound: 'پدرش زمین همین حوالی را به همین اداره باخت.',
        lie: 'اگر روش درست باشد، نتیجه هم عادلانه است.',
        ghost: 'روزی که سند خانوادگی مهر باطل خورد.',
        virtues: ['دقت', 'ادب زیر فشار'],
        flaws: ['پشت مقررات پنهان شدن'],
        fears: ['شبیه پدرش شدن'],
        values: ['اندازه‌گیری درست'],
        temperament: {
          warmth: -0.1,
          dominance: 0.2,
          volatility: -0.4,
          openness: 0.3,
          conscientiousness: 0.85,
        },
      },
      voice: {
        register: 'technical',
        verbosity: 'measured',
        idiolect: ['واژگان اداری', 'واحدها و ارقام'],
        verbalTics: ['هر ادعا را با یک عدد پشتیبانی می‌کند'],
        profanity: 'none',
        sentenceRhythm: 'balanced',
        humourMode: 'self-deprecating',
        silenceHabits: 'وقتی حق با طرف مقابل است، یادداشت برمی‌دارد و حرف نمی‌زند.',
      },
      arc: {
        startState: 'نامه را نشان می‌دهد و منتظر می‌ماند.',
        endState: 'نامه را تا می‌کند و در جیب می‌گذارد.',
        turningPoints: [],
      },
      visual: {
        silhouetteNote: 'یک مستطیل باریک با کیف چرمی که خط پهلو را می‌شکند.',
        build: 'lean',
        height: 'بلندترین آدم قاب',
        palette: [{ name: 'خاکستری اداری', hex: '#6b6f75', role: 'primary' }],
        distinguishingMarks: ['عینک با یک دستهٔ تعمیرشده'],
        wardrobe: [
          {
            slug: 'wardrobe-field',
            label: 'لباس بازدید',
            description: 'پیراهن آستین‌بلند خاکستری، شلوار پارچه‌ای، و کیف چرمی کهنه.',
            validity: { from: null, until: null },
            palette: [{ name: 'خاکستری اداری', hex: '#6b6f75', role: 'primary' }],
          },
        ],
        expressionSet: [],
        poseSet: [],
        propAffinities: [{ label: 'شاقول و متر نواری', note: 'وقتی معذب است اندازه می‌گیرد.' }],
      },
      motionSignature: {
        gaitStyle: 'stride',
        posture: 'rigid',
        gestureFrequency: 0.3,
        energy: 0.5,
        idleBehaviour: 'دستهٔ عینک را با شست صاف می‌کند.',
        tellOnLying: 'به کیفش نگاه می‌کند، نه به آدم.',
      },
      knowledgeScope: 'limited',
    },
  },
  {
    id: GARDEN,
    seriesId: SERIES_ID,
    kind: 'location',
    canonicalName: 'باغ انار',
    aliases: ['باغ دیواربسته'],
    summary: 'یک باغ انار دیواربسته با چاهی در وسط. تنها منبع آب چند کوچه است.',
    firstAppearance: { ordinal: 1, label: 'قسمت ۱' },
    importance: 'lead',
    assetRefs: [],
    embedding: [],
    payload: {
      locationType: 'exterior',
      scale: 'building',
      parentLocation: null,
      establishingNote:
        'یک مربع سبز تیره وسط خاک روشن، با دیوار کاهگلی بلند و یک دهانهٔ سنگی در مرکز که همه از آن فاصله دارند.',
      architecture:
        'دیوار کاهگلی با ردیف آجر روی تاج، چاه سنگ‌چین با قرقرهٔ چوبی، جوی‌های آجری که از چاه به هشت کرت می‌رود.',
      soundscape: ['قرقرهٔ چوبی', 'باد در برگ انار', 'چکهٔ آب روی سنگ'],
      palette: [
        { name: 'سبز انار', hex: '#3f5b3a', role: 'primary' },
        { name: 'کاهگل', hex: '#b79a72', role: 'background' },
      ],
      timeOfDayVariants: ['midday', 'dusk', 'night'],
      weatherVariants: ['clear', 'heat-haze'],
      moodVariants: [],
      affordances: ['بالا رفتن از دیوار', 'پایین رفتن در چاه', 'نشستن زیر انار'],
    },
  },
  {
    id: FLOOD,
    seriesId: SERIES_ID,
    kind: 'event',
    canonicalName: 'شب سیل',
    aliases: ['آن شب'],
    summary: 'سیلی که سیزده سال پیش آمد. هرکس روایت خودش را دارد و روایت‌ها با هم نمی‌خوانند.',
    firstAppearance: { ordinal: 1, label: 'پیش از قسمت ۱' },
    importance: 'recurring',
    assetRefs: [],
    embedding: [],
    payload: {
      eventType: 'disaster',
      occurredAt: { ordinal: 0, label: 'سیزده سال پیش' },
      place: GARDEN,
      participants: [KEEPER, MAHTAB],
      account:
        'آب از جوی بالا زد و خانهٔ آخر کوچه را برد. بی‌بی گلاب یک نفر را از آب بیرون کشید و همان یک نفر مهتاب بود.',
      consequences: 'باغ ماند، خانه رفت، و کسی دیگر دربارهٔ آن شب دو بار حرف نزد.',
      disputed: true,
    },
  },
  {
    id: TIN,
    seriesId: SERIES_ID,
    kind: 'prop',
    canonicalName: 'قوطی حلبی',
    aliases: ['قوطی ته چاه'],
    summary: 'یک قوطی حلبی زنگ‌زده با یک شناسنامه در آن، سیزده سال ته چاه.',
    firstAppearance: { ordinal: 10, label: 'قسمت ۱۰' },
    importance: 'recurring',
    assetRefs: [],
    embedding: [],
    payload: {
      scale: 'handheld',
      materials: ['حلبی زنگ‌زده', 'کاغذ نم‌کشیده'],
      riggable: true,
      articulation: 'درِ قوطی حول لبهٔ پشتی باز می‌شود، حدود صد و ده درجه، با گیر کردن در انتها.',
      isUnique: true,
      significance: 'تنها سندی که روایت شب سیل را نقض می‌کند.',
      palette: [{ name: 'زنگ', hex: '#8a5a33', role: 'primary' }],
      conditionVariants: [],
    },
  },
];

// ── the edges ───────────────────────────────────────────────────────────────

const RELATION_DRAFTS: unknown[] = [
  {
    seriesId: SERIES_ID,
    from: KEEPER,
    to: MAHTAB,
    type: 'parent-of',
    fact: 'بی‌بی گلاب مادربزرگ مهتاب نیست؛ مادرِ اوست.',
    strength: 0.95,
    validFrom: { ordinal: 0, label: 'پیش از قسمت ۱' },
    validUntil: null,
    assertedAt: FIRST_PASS,
    retractedAt: null,
    sourceRef: { kind: 'author', note: 'ستون فقرات مجموعه. تا قسمت هشت از مهتاب پنهان است.' },
    confidence: 1,
    visibility: 'secret',
  },
  {
    seriesId: SERIES_ID,
    from: MAHTAB,
    to: FLOOD,
    type: 'believes-falsely',
    fact: 'مهتاب باور دارد پدر و مادرش هر دو در شب سیل غرق شدند.',
    strength: 0.9,
    validFrom: { ordinal: 1, label: 'قسمت ۱' },
    validUntil: { ordinal: 8, label: 'قسمت ۸' },
    assertedAt: FIRST_PASS,
    retractedAt: null,
    sourceRef: { kind: 'author' },
    confidence: 1,
    visibility: 'public',
  },
  {
    seriesId: SERIES_ID,
    from: MAHTAB,
    to: KEEPER,
    type: 'knows',
    fact: 'مهتاب می‌داند بی‌بی گلاب مادرِ اوست.',
    strength: 1,
    validFrom: { ordinal: 8, label: 'قسمت ۸' },
    validUntil: null,
    assertedAt: FIRST_PASS,
    retractedAt: null,
    sourceRef: { kind: 'episode', episodeId: episodeId(7) },
    confidence: 1,
    visibility: 'public',
  },
  {
    seriesId: SERIES_ID,
    from: MAHTAB,
    to: FLOOD,
    type: 'suspects',
    fact: 'مهتاب گمان می‌برد روایت شب سیل کامل نیست.',
    strength: 0.5,
    validFrom: { ordinal: 4, label: 'قسمت ۴' },
    validUntil: { ordinal: 8, label: 'قسمت ۸' },
    assertedAt: FIRST_PASS,
    retractedAt: null,
    sourceRef: { kind: 'author' },
    confidence: 0.8,
    visibility: 'public',
  },
  {
    seriesId: SERIES_ID,
    from: MAHTAB,
    to: GARDEN,
    type: 'witnessed',
    fact: 'مهتاب از بالای دیوار دید که بی‌بی گلاب شبانه سر چاه با کسی حرف می‌زند.',
    strength: 1,
    validFrom: { ordinal: 4, label: 'قسمت ۴' },
    validUntil: null,
    assertedAt: FIRST_PASS,
    retractedAt: null,
    sourceRef: { kind: 'episode', episodeId: episodeId(3) },
    confidence: 1,
    visibility: 'public',
  },
  {
    seriesId: SERIES_ID,
    from: KEEPER,
    to: FLOOD,
    type: 'knows',
    fact: 'بی‌بی گلاب می‌داند در شب سیل واقعاً چه گذشت.',
    strength: 1,
    validFrom: { ordinal: 0, label: 'پیش از قسمت ۱' },
    validUntil: null,
    assertedAt: FIRST_PASS,
    retractedAt: null,
    sourceRef: { kind: 'author' },
    confidence: 1,
    visibility: 'private',
  },
  {
    seriesId: SERIES_ID,
    from: KEEPER,
    to: FARHAD,
    type: 'told',
    fact: 'بی‌بی گلاب به فرهاد گفت که این چاه در هیچ پرونده‌ای ثبت نخواهد شد.',
    strength: 0.7,
    validFrom: { ordinal: 3, label: 'قسمت ۳' },
    validUntil: null,
    assertedAt: FIRST_PASS,
    retractedAt: null,
    sourceRef: { kind: 'episode', episodeId: episodeId(2) },
    confidence: 1,
    visibility: 'secret',
  },
  {
    seriesId: SERIES_ID,
    from: KEEPER,
    to: MAHTAB,
    type: 'loves',
    fact: 'بی‌بی گلاب مهتاب را بی‌آنکه بگوید دوست دارد.',
    strength: 0.95,
    validFrom: { ordinal: 0 },
    validUntil: null,
    assertedAt: FIRST_PASS,
    retractedAt: null,
    sourceRef: { kind: 'author' },
    confidence: 1,
    visibility: 'private',
  },
  {
    seriesId: SERIES_ID,
    from: KEEPER,
    to: FARHAD,
    type: 'fears',
    fact: 'بی‌بی گلاب از کاغذی که فرهاد آورده می‌ترسد، نه از خودِ فرهاد.',
    strength: -0.45,
    validFrom: { ordinal: 1 },
    validUntil: null,
    assertedAt: FIRST_PASS,
    retractedAt: null,
    sourceRef: { kind: 'author' },
    confidence: 0.9,
    visibility: 'public',
  },
  {
    seriesId: SERIES_ID,
    from: KEEPER,
    to: GARDEN,
    type: 'located-in',
    fact: 'بی‌بی گلاب در باغ انار زندگی می‌کند.',
    strength: 1,
    validFrom: { ordinal: 0 },
    validUntil: null,
    assertedAt: FIRST_PASS,
    retractedAt: null,
    sourceRef: { kind: 'author' },
    confidence: 1,
    visibility: 'public',
  },
  {
    seriesId: SERIES_ID,
    from: FARHAD,
    to: GARDEN,
    type: 'travels-to',
    fact: 'فرهاد از پایتخت به باغ انار می‌آید.',
    strength: 1,
    validFrom: { ordinal: 1 },
    validUntil: null,
    assertedAt: FIRST_PASS,
    retractedAt: null,
    sourceRef: { kind: 'author' },
    confidence: 1,
    visibility: 'public',
  },
  {
    seriesId: SERIES_ID,
    from: MAHTAB,
    to: TIN,
    type: 'carries',
    fact: 'مهتاب قوطی حلبی را از ته چاه بالا می‌آورد و دیگر زمین نمی‌گذارد.',
    strength: 1,
    validFrom: { ordinal: 10, label: 'قسمت ۱۰' },
    validUntil: null,
    assertedAt: FIRST_PASS,
    retractedAt: null,
    sourceRef: { kind: 'episode', episodeId: episodeId(9) },
    confidence: 1,
    visibility: 'public',
  },

  // ── the retro-fit, on the authoring clock ─────────────────────────────────
  {
    seriesId: SERIES_ID,
    from: FARHAD,
    to: KEEPER,
    type: 'ally-of',
    fact: 'فرهاد از قسمت دو کنار بی‌بی گلاب ایستاد.',
    strength: 0.6,
    validFrom: { ordinal: 2, label: 'قسمت ۲' },
    validUntil: null,
    assertedAt: FIRST_PASS,
    retractedAt: REWRITE,
    sourceRef: { kind: 'author', note: 'نگارش نخست. در بازنویسی قسمت هفت پس گرفته شد.' },
    confidence: 1,
    visibility: 'public',
  },
  {
    seriesId: SERIES_ID,
    from: FARHAD,
    to: KEEPER,
    type: 'resents',
    fact: 'فرهاد از همان قسمت دو کینه‌ای را با خود آورده بود که به بی‌بی گلاب ربط نداشت.',
    strength: -0.55,
    validFrom: { ordinal: 2, label: 'قسمت ۲' },
    validUntil: null,
    assertedAt: REWRITE,
    retractedAt: null,
    sourceRef: { kind: 'author', note: 'بازنویسی قسمت هفت، دربارهٔ زمانی در قسمت دو.' },
    confidence: 1,
    visibility: 'private',
  },
];

/** Ids assigned by position, so a relation cannot be given one that is not well formed. */
const RELATIONS: unknown[] = RELATION_DRAFTS.map((draft, index) => ({
  id: relationId(index),
  ...(draft as Record<string, unknown>),
}));

/**
 * Parsed once, through the real schemas.
 *
 * A fixture that no longer fits the contract should fail loudly here rather than render
 * a half-filled sheet nobody notices — the same rule the shared fixture transport
 * applies to every payload it serves.
 */
const SNAPSHOT: NarrativeSnapshot = NarrativeSnapshotSchema.parse({
  seriesId: SERIES_ID,
  entities: ENTITIES,
  relations: RELATIONS,
  storyMarks: STORY_MARKS,
  revisions: REVISIONS,
});

// ── the state grid, derived from the sheets ─────────────────────────────────

const STYLE_CLAUSE =
  'کاغذ بریده و مرکب، پالت لاجورد و زعفران، خط بیرونی ضخیم، سایه‌ی تخت، بدون گرادیان.';

/**
 * The prompt, composed rather than stored.
 *
 * The engine composes a state prompt out of the style clause, the character descriptor,
 * the outfit and the state body, precisely so a model does not spend seven of its eight
 * answers retyping the style. The fixture composes it the same way, so an edited prompt
 * here reads like the one the pipeline would have produced.
 */
function composePrompt(
  characterName: string,
  silhouette: string,
  outfit: WardrobeSet,
  state: NamedVisualState,
  framing: string,
): string {
  return [
    `${framing}: ${characterName}، ${state.label}.`,
    state.description,
    `پوشاک: ${outfit.description}`,
    `خط بیرونی: ${silhouette}`,
    `سبک: ${STYLE_CLAUSE}`,
    `شدت: ${state.intensity.toFixed(2)}`,
  ].join('\n');
}

/**
 * A deterministic spread of cell states.
 *
 * A grid where every cell is `ready` hides every state this screen has to handle:
 * the placeholder, the flagged identity score, the cache miss an edit produces. Seven
 * is coprime with the fourteen states per outfit, so the pattern does not line up with
 * the rows and read as a stripe.
 */
const CELL_STATUS_CYCLE = [
  'ready',
  'ready',
  'missing',
  'ready',
  'stale',
  'ready',
  'rejected',
] as const satisfies readonly StateCellStatus[];

function buildStates(entity: Entity): CharacterStates {
  if (entity.kind !== 'character') return { identityFloor: 0.82, imageModel: null, cells: [] };

  const slug = entity.id === MAHTAB ? 'mahtab' : 'golab';
  const { visual } = entity.payload;
  const cells: CharacterStateCell[] = [];
  let index = 0;

  for (const outfit of visual.wardrobe) {
    cells.push({
      semanticKey: `char/${slug}/wardrobe`,
      variantKey: `${outfit.slug}-turnaround`,
      wardrobeSlug: outfit.slug,
      stateSlug: 'turnaround',
      stateKind: 'wardrobe',
      label: outfit.label,
      prompt: [
        `نمای تمام‌قد و چرخش سه‌نما: ${entity.canonicalName}.`,
        `پوشاک: ${outfit.description}`,
        `سبک: ${STYLE_CLAUSE}`,
      ].join('\n'),
      intensity: 0.5,
      status: 'ready',
      imageHash: `sha256-${slug}-${outfit.slug}`,
      identityMatch: 0.94,
      estimateNanoUsd: 34_000_000,
    });

    for (const [kind, states, framing] of [
      ['expression', visual.expressionSet, 'نمای نزدیک صورت'],
      ['pose', visual.poseSet, 'نمای تمام‌قد'],
    ] as const) {
      for (const state of states) {
        const status = CELL_STATUS_CYCLE[index % CELL_STATUS_CYCLE.length] ?? 'ready';
        const ready = status === 'ready' || status === 'rejected';
        cells.push({
          semanticKey: `char/${slug}/${kind}`,
          variantKey: `${outfit.slug}-${state.slug}`,
          wardrobeSlug: outfit.slug,
          stateSlug: state.slug,
          stateKind: kind,
          label: `${outfit.label} / ${state.label}`,
          prompt: composePrompt(
            entity.canonicalName,
            visual.silhouetteNote,
            outfit,
            state,
            framing,
          ),
          intensity: state.intensity,
          status,
          ...(ready ? { imageHash: `sha256-${slug}-${outfit.slug}-${state.slug}` } : {}),
          // One cell deliberately below the floor, so the flag is not dead markup.
          ...(ready
            ? { identityMatch: status === 'rejected' ? 0.61 : 0.88 + (index % 5) / 100 }
            : {}),
          estimateNanoUsd: 34_000_000,
        });
        index += 1;
      }
    }
  }

  return { identityFloor: 0.82, imageModel: 'gemini:gemini-3-flash-image', cells };
}

// ── the gateway ─────────────────────────────────────────────────────────────

export function createCharactersFixtureGateway(): {
  listSeries: (projectId: ProjectId) => Promise<readonly SeriesCard[]>;
  loadGraph: (seriesId: SeriesId) => Promise<NarrativeSnapshot>;
  loadStates: (seriesId: SeriesId, entityId: string) => Promise<CharacterStates>;
  editStatePrompt: (
    seriesId: SeriesId,
    entityId: string,
    variantKey: string,
    edit: CharacterStateEdit,
  ) => Promise<CharacterStateCell>;
  generateState: (
    seriesId: SeriesId,
    entityId: string,
    variantKey: string,
  ) => Promise<CharacterStateCell>;
} {
  const states = new Map<string, CharacterStates>();

  function statesFor(entityId: string): CharacterStates {
    const existing = states.get(entityId);
    if (existing !== undefined) return existing;
    const entity = SNAPSHOT.entities.find((candidate) => candidate.id === entityId);
    if (entity === undefined) {
      throw new ApiError({
        failure: 'api',
        code: 'entity-not-found',
        kind: 'not-found',
        status: 404,
        message: `no entity ${entityId}`,
      });
    }
    const built = buildStates(entity);
    states.set(entityId, built);
    return built;
  }

  function replaceCell(entityId: string, next: CharacterStateCell): CharacterStateCell {
    const current = statesFor(entityId);
    states.set(entityId, {
      ...current,
      cells: current.cells.map((cell) => (cell.variantKey === next.variantKey ? next : cell)),
    });
    return next;
  }

  function cellOf(entityId: string, variantKey: string): CharacterStateCell {
    const found = statesFor(entityId).cells.find((cell) => cell.variantKey === variantKey);
    if (found === undefined) {
      throw new ApiError({
        failure: 'api',
        code: 'state-cell-not-found',
        kind: 'not-found',
        status: 404,
        message: `no state ${variantKey}`,
      });
    }
    return found;
  }

  async function settle<T>(value: T): Promise<T> {
    await Promise.resolve();
    return value;
  }

  return {
    listSeries: (projectId) =>
      settle(FIXTURE_SERIES.filter((series) => series.projectId === projectId)),

    loadGraph: () => settle(SNAPSHOT),

    loadStates: (_seriesId, entityId) => settle(statesFor(entityId)),

    editStatePrompt: (_seriesId, entityId, variantKey, edit) => {
      const current = cellOf(entityId, variantKey);
      // An edited prompt is a new `specHash`, so exactly this cell becomes a miss. The
      // grid says so before anything is regenerated, which is the whole of RV-206's
      // second criterion.
      return settle(replaceCell(entityId, { ...current, prompt: edit.prompt, status: 'stale' }));
    },

    generateState: (_seriesId, entityId, variantKey) => {
      const current = cellOf(entityId, variantKey);
      return settle(
        replaceCell(entityId, {
          ...current,
          status: 'ready',
          imageHash: `sha256-${variantKey}-take2`,
          identityMatch: 0.91,
        }),
      );
    },
  };
}
