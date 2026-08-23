/**
 * The question tree.
 *
 * The rule this is written under: **a user must be able to answer every question
 * without knowing a single word of the style bible's vocabulary.** Nobody outside this
 * repository knows what `arcBias` is, and asking about it produces either a shrug or a
 * middle value. So the questions are about the finished film - does it feel springy or
 * floaty, do the drawings shimmer, is the background alive - and each answer carries the
 * field set that produces that.
 *
 * Five of the eleven questions are about movement. That ratio is the design: a wizard
 * that only asks about looks composes a bible whose motion block is whatever the base
 * preset happened to have, which is exactly the "the style also covers how things
 * animate" failure the architecture is built to avoid.
 *
 * The first question's options are generated from the preset library rather than
 * written out, so a new preset appears in the wizard automatically and cannot drift
 * from its own description.
 */

import type { LocalisedText, Slug } from '@rv/contracts';

import { STYLE_PRESETS } from '../presets/index';
import type { StyleFieldPatch } from './patch';

export interface WizardOption {
  readonly id: string;
  readonly label: LocalisedText;
  readonly description: LocalisedText;
  /** The fields this answer sets. Empty for the base question, which selects a preset. */
  readonly patch: StyleFieldPatch;
  /** Only on the base question: which preset this answer starts from. */
  readonly presetId?: Slug;
}

/**
 * Declarative visibility.
 *
 * A predicate would be more expressive and completely useless to the UI, which has to
 * render the tree without executing it. This form serialises.
 *
 * Only "hide for these answers" exists, deliberately: a new preset should inherit every
 * question by default and be *excluded* by name where a question would be a control
 * that does nothing. An allow-list would silently drop every new preset out of the
 * gated questions, which is the failure that is invisible until someone notices the
 * wizard never asked about shimmer.
 */
export interface WizardVisibility {
  readonly question: string;
  readonly noneOf: readonly string[];
}

export interface WizardQuestion {
  readonly id: string;
  readonly prompt: LocalisedText;
  readonly help: LocalisedText;
  readonly options: readonly WizardOption[];
  readonly showWhen?: WizardVisibility;
}

/** The base question: pick the medium by how it looks, not by what it is called. */
const LOOK_QUESTION: WizardQuestion = {
  id: 'look',
  prompt: {
    fa: 'کدام‌یک به تصویری که در ذهن دارید نزدیک‌تر است؟',
    en: 'Which of these is closest to the picture in your head?',
  },
  help: {
    fa: 'همه چیز بعداً قابل تغییر است؛ این فقط نقطهٔ شروع را انتخاب می‌کند.',
    en: 'Everything is editable afterwards - this only chooses where to start.',
  },
  options: STYLE_PRESETS.map((preset) => ({
    id: preset.id,
    label: preset.name,
    description: preset.description,
    patch: {},
    presetId: preset.id,
  })),
};

/**
 * Mood palettes.
 *
 * Whole palettes rather than a harmony tweak, because "warmer" is not something a user
 * can see until the swatches change. Each one is medium-agnostic: these are colour
 * relationships, and cut paper in a cold palette is still cut paper.
 */
const MOOD_QUESTION: WizardQuestion = {
  id: 'mood',
  prompt: { fa: 'حال‌وهوای رنگی داستان چیست؟', en: 'What is the story’s colour mood?' },
  help: {
    fa: 'رنگ‌ها بعداً تک‌تک قابل ویرایش‌اند؛ اینجا فقط خانوادهٔ رنگی را انتخاب می‌کنید.',
    en: 'Individual colours stay editable - this picks the family they come from.',
  },
  options: [
    {
      id: 'warm-earth',
      label: { fa: 'گرم و خاکی', en: 'Warm and earthy' },
      description: {
        fa: 'خاک، چوب، آفتاب بعدازظهر. آرام و آشنا.',
        en: 'Soil, wood, late afternoon sun. Settled and familiar.',
      },
      patch: {
        palette: {
          colors: [
            { name: 'terracotta', hex: '#c2673f', role: 'primary' },
            { name: 'olive', hex: '#7a8450', role: 'secondary' },
            { name: 'saffron', hex: '#e0a33e', role: 'accent' },
            { name: 'walnut', hex: '#4a3728', role: 'shadow' },
            { name: 'raw-linen', hex: '#eee3ce', role: 'background' },
          ],
          harmony: 'earthy',
          contrastFloor: 0.45,
          organicRamp: ['#f0cdaa', '#cf9d78', '#9a6f52'],
        },
      },
    },
    {
      id: 'cool-quiet',
      label: { fa: 'سرد و آرام', en: 'Cool and quiet' },
      description: {
        fa: 'صبح زود، مه، آب. غمگین و باوقار.',
        en: 'Early morning, mist, water. Wistful and composed.',
      },
      patch: {
        palette: {
          colors: [
            { name: 'slate-blue', hex: '#5b7a99', role: 'primary' },
            { name: 'sea-glass', hex: '#8fb8ad', role: 'secondary' },
            { name: 'pale-amber', hex: '#d9b382', role: 'accent' },
            { name: 'deep-indigo', hex: '#2c3a4f', role: 'shadow' },
            { name: 'fog', hex: '#e4e9ec', role: 'background' },
          ],
          harmony: 'analogous',
          contrastFloor: 0.35,
          organicRamp: ['#e9cdb8', '#c49a83'],
        },
      },
    },
    {
      id: 'bright-playful',
      label: { fa: 'روشن و بازیگوش', en: 'Bright and playful' },
      description: {
        fa: 'رنگ‌های اشباع و شاد؛ مناسب کارهای کودک و کمدی.',
        en: 'Saturated and cheerful - for children’s work and comedy.',
      },
      patch: {
        palette: {
          colors: [
            { name: 'tangerine', hex: '#f57f3d', role: 'primary' },
            { name: 'grape', hex: '#7a5ec4', role: 'secondary' },
            { name: 'lime', hex: '#9ed24a', role: 'accent' },
            { name: 'blueberry', hex: '#2f3a8f', role: 'shadow' },
            { name: 'cream-soda', hex: '#fff4dd', role: 'background' },
          ],
          harmony: 'triadic',
          contrastFloor: 0.55,
          organicRamp: ['#ffd9b8', '#e0a179', '#a86f4e'],
        },
      },
    },
    {
      id: 'stark-graphic',
      label: { fa: 'کم‌رنگ و قاطع', en: 'Stark and graphic' },
      description: {
        fa: 'دو سه رنگ و سیاهی زیاد؛ جدی و بُرنده.',
        en: 'Two or three colours and a lot of black. Serious and cutting.',
      },
      patch: {
        palette: {
          colors: [
            { name: 'signal-red', hex: '#c2262b', role: 'accent' },
            { name: 'iron', hex: '#4d5257', role: 'primary' },
            { name: 'near-black', hex: '#17181a', role: 'shadow' },
            { name: 'bone', hex: '#f2efe9', role: 'background' },
          ],
          harmony: 'high-contrast',
          contrastFloor: 0.75,
          organicRamp: [],
        },
        negative: ['pastel colours', 'muddy midtones'],
      },
    },
  ],
};

const OUTLINE_QUESTION: WizardQuestion = {
  id: 'outline',
  prompt: { fa: 'دور شکل‌ها خط کشیده شود؟', en: 'Should shapes be drawn with an outline?' },
  help: {
    fa: 'خط دور، تصویر را خواناتر می‌کند اما گرافیکی‌ترش هم می‌کند.',
    en: 'An outline makes the picture easier to read, and more graphic.',
  },
  options: [
    {
      id: 'no-outline',
      label: { fa: 'بدون خط', en: 'No outline' },
      description: {
        fa: 'شکل‌ها فقط با رنگ از هم جدا می‌شوند.',
        en: 'Shapes are separated by colour alone.',
      },
      patch: {
        line: {
          present: false,
          weight: 0,
          variability: 0,
          colorMode: 'none',
          taper: 0,
          roughness: 0,
        },
      },
    },
    {
      id: 'thin-clean',
      label: { fa: 'خط نازک و تمیز', en: 'Thin and clean' },
      description: { fa: 'خط یکنواخت و دقیق، مثل خط فنی.', en: 'Even, precise, technical.' },
      patch: {
        line: {
          present: true,
          weight: 0.22,
          variability: 0.05,
          colorMode: 'darker-fill',
          taper: 0.05,
          roughness: 0.03,
        },
      },
    },
    {
      id: 'bold-black',
      label: { fa: 'خط ضخیم و سیاه', en: 'Bold and black' },
      description: {
        fa: 'خط پررنگ کمیک‌طور که همه‌چیز را قاب می‌گیرد.',
        en: 'A heavy comic-book line framing everything.',
      },
      patch: {
        line: {
          present: true,
          weight: 0.78,
          variability: 0.7,
          colorMode: 'black',
          taper: 0.7,
          roughness: 0.2,
        },
      },
    },
    {
      id: 'hand-drawn',
      label: { fa: 'خط دست‌کشیده', en: 'Hand-drawn' },
      description: {
        fa: 'خط لرزان و ناهموار، انگار همین حالا کشیده شده.',
        en: 'Wobbly and uneven, as if just drawn.',
      },
      patch: {
        line: {
          present: true,
          weight: 0.45,
          variability: 0.75,
          colorMode: 'tinted',
          taper: 0.45,
          roughness: 0.8,
        },
      },
    },
  ],
};

const DETAIL_QUESTION: WizardQuestion = {
  id: 'detail',
  prompt: { fa: 'چقدر جزئیات؟', en: 'How much detail?' },
  help: {
    fa: 'جزئیات کمتر یعنی تولید ارزان‌تر، خوانایی بهتر در موبایل و ریگ سالم‌تر.',
    en: 'Less detail is cheaper to generate, reads better on a phone, and rigs more cleanly.',
  },
  options: [
    {
      id: 'very-simple',
      label: { fa: 'خیلی ساده', en: 'Very simple' },
      description: {
        fa: 'فقط شکل‌های اصلی، نزدیک به نشانه.',
        en: 'Main shapes only, near-pictographic.',
      },
      patch: { shape: { detailDensity: 0.15 }, negative: ['busy background clutter'] },
    },
    {
      id: 'balanced',
      label: { fa: 'متعادل', en: 'Balanced' },
      description: {
        fa: 'به‌اندازهٔ لازم جزئیات، نه بیشتر.',
        en: 'As much detail as the shot needs.',
      },
      patch: { shape: { detailDensity: 0.45 } },
    },
    {
      id: 'rich',
      label: { fa: 'پرجزئیات', en: 'Rich' },
      description: {
        fa: 'دنیای شلوغ و تصویرسازی‌شده؛ گران‌تر و کندتر.',
        en: 'A dense, illustrated world. Costlier and slower.',
      },
      patch: { shape: { detailDensity: 0.8 } },
    },
  ],
};

const FIGURE_QUESTION: WizardQuestion = {
  id: 'figures',
  prompt: { fa: 'شخصیت‌ها چه هیکلی دارند؟', en: 'What are the characters built like?' },
  help: {
    fa: 'نسبت سر به بدن، لحن کل مجموعه را تعیین می‌کند.',
    en: 'Head-to-body ratio sets the tone of the whole series.',
  },
  options: [
    {
      id: 'chibi',
      label: { fa: 'سر بزرگ و بامزه', en: 'Big-headed and cute' },
      description: {
        fa: 'دو تا سه سر قد؛ کودکانه و بامزه.',
        en: 'Two to three heads tall. Childlike.',
      },
      patch: { shape: { headToBodyRatio: 2.5, exaggeration: 0.8, roundness: 0.9 } },
    },
    {
      id: 'stylised',
      label: { fa: 'کمی اغراق‌شده', en: 'Lightly stylised' },
      description: {
        fa: 'پنج سر قد؛ کارتونی اما متعادل.',
        en: 'Five heads tall. Cartoon, but grounded.',
      },
      patch: { shape: { headToBodyRatio: 5, exaggeration: 0.45, roundness: 0.6 } },
    },
    {
      id: 'naturalistic',
      label: { fa: 'واقع‌گرا', en: 'Naturalistic' },
      description: {
        fa: 'هفت تا هشت سر قد؛ جدی و بزرگ‌سالانه.',
        en: 'Seven to eight heads. Adult, serious.',
      },
      patch: { shape: { headToBodyRatio: 7.5, exaggeration: 0.15, roundness: 0.4 } },
    },
  ],
};

const LIGHT_QUESTION: WizardQuestion = {
  id: 'light',
  prompt: { fa: 'نور صحنه چگونه است؟', en: 'What is the light like?' },
  help: {
    fa: 'جهت نور در کل مجموعه ثابت می‌ماند تا سایه‌ها با هم بخوانند.',
    en: 'The light direction stays fixed across the series so shadows agree with each other.',
  },
  // Only meaningful where there is shading at all - a flat-shaded medium has no
  // shadow to point anywhere, and asking would be a control that does nothing.
  showWhen: { question: 'look', noneOf: ['flat-vector', 'paper-cutout', 'woodblock-print'] },
  options: [
    {
      id: 'soft-daylight',
      label: { fa: 'روز ملایم', en: 'Soft daylight' },
      description: {
        fa: 'نور از بالا و کمی از راست؛ سایه‌های ملایم.',
        en: 'From above and slightly right; gentle shadows.',
      },
      patch: { shading: { lightDirection: 60, rimLight: 0.1, occlusionStrength: 0.3 } },
    },
    {
      id: 'dramatic-side',
      label: { fa: 'نور کناری تند', en: 'Hard side light' },
      description: {
        fa: 'نور از یک پهلو؛ نصف صورت در سایه.',
        en: 'From one side; half the face in shadow.',
      },
      patch: { shading: { lightDirection: 175, rimLight: 0.6, occlusionStrength: 0.7 } },
    },
    {
      id: 'flat-even',
      label: { fa: 'نور یکنواخت', en: 'Flat and even' },
      description: {
        fa: 'بدون جهت مشخص؛ همه‌چیز به یک اندازه روشن.',
        en: 'No direction; everything equally lit.',
      },
      patch: { shading: { lightDirection: 90, rimLight: 0, occlusionStrength: 0.12 } },
    },
  ],
};

// ── movement ────────────────────────────────────────────────────────────────

const FEEL_QUESTION: WizardQuestion = {
  id: 'movement-feel',
  prompt: { fa: 'چیزها چطور حرکت کنند؟', en: 'How should things move?' },
  help: {
    fa: 'این مهم‌ترین انتخاب حرکتی است و روی هر انیمیشنی در کل مجموعه اثر می‌گذارد.',
    en: 'The most consequential motion choice; it touches every animation in the series.',
  },
  options: [
    {
      id: 'springy',
      label: { fa: 'فنری و سرزنده', en: 'Springy' },
      description: {
        fa: 'قبل از هر حرکت کمی عقب می‌کشد و کمی از هدف رد می‌شود.',
        en: 'Winds up before a move and passes the target before settling.',
      },
      patch: {
        motion: {
          tempo: 1.2,
          principles: {
            anticipation: 0.7,
            overshoot: 0.6,
            squashStretch: 0.55,
            followThrough: 0.5,
            weight: 0.45,
          },
        },
      },
    },
    {
      id: 'floaty',
      label: { fa: 'نرم و شناور', en: 'Soft and floating' },
      description: {
        fa: 'همه‌چیز روی قوس حرکت می‌کند و آرام می‌ایستد.',
        en: 'Everything travels on an arc and comes to rest slowly.',
      },
      patch: {
        motion: {
          tempo: 0.85,
          principles: {
            anticipation: 0.2,
            overshoot: 0.1,
            squashStretch: 0.2,
            followThrough: 0.75,
            secondaryMotion: 0.8,
            arcBias: 0.9,
            weight: 0.2,
          },
        },
      },
    },
    {
      id: 'heavy',
      label: { fa: 'سنگین و باوقار', en: 'Heavy and deliberate' },
      description: {
        fa: 'همه‌چیز وزن دارد؛ حرکت‌ها کند شروع و محکم تمام می‌شوند.',
        en: 'Everything has mass; moves start slowly and land hard.',
      },
      patch: {
        motion: {
          tempo: 0.8,
          principles: {
            weight: 0.9,
            squashStretch: 0.5,
            holdBias: 0.6,
            followThrough: 0.6,
            overshoot: 0.2,
          },
        },
      },
    },
    {
      id: 'mechanical',
      label: { fa: 'پله‌ای و ماشینی', en: 'Stepped and mechanical' },
      description: {
        fa: 'حرکت‌های مستقیم و بریده، با مکث‌های واضح بین‌شان.',
        en: 'Straight-line, clipped moves with clear pauses between them.',
      },
      patch: {
        motion: {
          tempo: 1,
          principles: {
            arcBias: 0.08,
            holdBias: 0.75,
            overshoot: 0.12,
            secondaryMotion: 0.12,
            squashStretch: 0.05,
          },
        },
      },
    },
  ],
};

const CADENCE_QUESTION: WizardQuestion = {
  id: 'cadence',
  prompt: { fa: 'حرکت روان باشد یا پله‌پله؟', en: 'Smooth motion, or stepped?' },
  help: {
    fa: 'انیمیشن دستی معمولاً هر نقاشی را دو فریم نگه می‌دارد؛ همین تفاوت «انیمیشن» و «درون‌یابی کامپیوتری» است.',
    en: 'Hand animation holds each drawing for two frames. This one choice is most of the difference between "animated" and "interpolated".',
  },
  options: [
    {
      id: 'smooth',
      label: { fa: 'کاملاً روان', en: 'Fully smooth' },
      description: { fa: '۲۴ فریم بر ثانیه بدون نگه‌داشتن.', en: '24 fps with no holds.' },
      patch: { motion: { fps: 24, stepMode: 'smooth' } },
    },
    {
      id: 'on-twos',
      label: { fa: 'هر نقاشی دو فریم', en: 'On twos' },
      description: { fa: 'کادنس کلاسیک انیمیشن دستی.', en: 'The classic hand-animation cadence.' },
      patch: { motion: { fps: 24, stepMode: 'on-2s' } },
    },
    {
      id: 'chunky',
      label: { fa: 'درشت و بریده', en: 'Chunky' },
      description: {
        fa: '۱۲ فریم بر ثانیه با نگه‌داشت؛ حس استاپ‌موشن و بازی قدیمی.',
        en: '12 fps with holds - stop motion and old games.',
      },
      patch: { motion: { fps: 12, stepMode: 'on-2s' } },
    },
  ],
};

const SHIMMER_QUESTION: WizardQuestion = {
  id: 'shimmer',
  prompt: {
    fa: 'خطوط بلرزند، انگار هر فریم دوباره کشیده شده؟',
    en: 'Should the drawing shimmer, as if redrawn each frame?',
  },
  help: {
    fa: 'به آن «boil» می‌گویند؛ ارزان‌ترین راه برای اینکه حرکتِ ریگ‌محور ماشینی به نظر نرسد.',
    en: 'It is called boil, and it is the cheapest way to stop rig-driven motion looking mechanical.',
  },
  // Pointless on a strict lattice or a vector fill: a boiling pixel is an artefact and
  // a boiling vector edge is a rendering bug.
  showWhen: { question: 'look', noneOf: ['pixel-art', 'flat-vector'] },
  options: [
    {
      id: 'none',
      label: { fa: 'بدون لرزش', en: 'No shimmer' },
      description: { fa: 'خطوط کاملاً ثابت.', en: 'Perfectly steady lines.' },
      patch: { motion: { boil: { enabled: false, amplitude: 0, affectsFills: false } } },
    },
    {
      id: 'subtle',
      label: { fa: 'لرزش کم', en: 'Subtle' },
      description: {
        fa: 'فقط آن‌قدر که بی‌جان به نظر نرسد.',
        en: 'Just enough that it does not look dead.',
      },
      patch: { motion: { boil: { enabled: true, amplitude: 0.15, hz: 10, affectsFills: false } } },
    },
    {
      id: 'strong',
      label: { fa: 'لرزش زیاد', en: 'Strong' },
      description: {
        fa: 'خط و رنگ هر دو می‌جوشند؛ کاملاً دست‌ساز.',
        en: 'Line and fill both boil - unmistakably handmade.',
      },
      patch: { motion: { boil: { enabled: true, amplitude: 0.5, hz: 6, affectsFills: true } } },
    },
  ],
};

const LIFE_QUESTION: WizardQuestion = {
  id: 'scene-life',
  prompt: { fa: 'پس‌زمینه چقدر زنده باشد؟', en: 'How alive is the background?' },
  help: {
    fa: 'درختِ کاملاً ساکن در صحنه‌ای متحرک، به چشم خطا می‌آید.',
    en: 'A perfectly still tree in a moving scene reads as a bug.',
  },
  options: [
    {
      id: 'still',
      label: { fa: 'تقریباً ساکن', en: 'Almost still' },
      description: { fa: 'فقط پلک زدن و نفس کشیدن.', en: 'Blinking and breathing only.' },
      patch: {
        motion: {
          ambient: { windHz: 0.1, windAmplitude: 0.06, windGustiness: 0.1, idleAmplitude: 0.05 },
        },
      },
    },
    {
      id: 'breathing',
      label: { fa: 'کمی جان دارد', en: 'Gently breathing' },
      description: { fa: 'نسیم ملایم و مداوم.', en: 'A steady, gentle breeze.' },
      patch: {
        motion: {
          ambient: { windHz: 0.35, windAmplitude: 0.3, windGustiness: 0.25, idleAmplitude: 0.22 },
        },
      },
    },
    {
      id: 'windy',
      label: { fa: 'بادخیز', en: 'Windy' },
      description: {
        fa: 'وزش‌های نامنظم؛ همه‌چیز تکان می‌خورد.',
        en: 'Irregular gusts; everything moves.',
      },
      patch: {
        motion: {
          ambient: { windHz: 0.9, windAmplitude: 0.6, windGustiness: 0.85, idleAmplitude: 0.35 },
        },
      },
    },
  ],
};

const PACE_QUESTION: WizardQuestion = {
  id: 'pace',
  prompt: { fa: 'ریتم تدوین چطور باشد؟', en: 'How fast does it cut?' },
  help: {
    fa: 'طول پیش‌فرض هر نما و اجازهٔ زوم دوربین را تعیین می‌کند.',
    en: 'Sets the default shot length and whether the camera may zoom.',
  },
  options: [
    {
      id: 'calm',
      label: { fa: 'آرام', en: 'Calm' },
      description: {
        fa: 'نماهای بلند، دوربین تقریباً ثابت.',
        en: 'Long shots, a nearly static camera.',
      },
      patch: {
        motion: {
          camera: {
            defaultShotMs: 5200,
            cutRhythm: 'languid',
            shakeAmplitude: 0.01,
            allowZoom: false,
          },
        },
      },
    },
    {
      id: 'balanced',
      label: { fa: 'متعادل', en: 'Balanced' },
      description: { fa: 'ریتم معمول روایت.', en: 'Ordinary narrative pacing.' },
      patch: {
        motion: {
          camera: {
            defaultShotMs: 3200,
            cutRhythm: 'measured',
            shakeAmplitude: 0.04,
            allowZoom: true,
          },
        },
      },
    },
    {
      id: 'punchy',
      label: { fa: 'تند و ضربه‌ای', en: 'Punchy' },
      description: { fa: 'نماهای کوتاه، دوربین پرانرژی.', en: 'Short shots, an energetic camera.' },
      patch: {
        motion: {
          camera: {
            defaultShotMs: 1600,
            cutRhythm: 'frenetic',
            shakeAmplitude: 0.14,
            allowZoom: true,
          },
        },
      },
    },
  ],
};

/**
 * The tree, in asking order.
 *
 * Look and colour first because they are the questions a user already has an opinion
 * about; movement last because by then they have seen enough of the vocabulary to have
 * formed one.
 */
export const WIZARD_QUESTIONS: readonly WizardQuestion[] = [
  LOOK_QUESTION,
  MOOD_QUESTION,
  OUTLINE_QUESTION,
  DETAIL_QUESTION,
  FIGURE_QUESTION,
  LIGHT_QUESTION,
  FEEL_QUESTION,
  CADENCE_QUESTION,
  SHIMMER_QUESTION,
  LIFE_QUESTION,
  PACE_QUESTION,
];

/** The id of the question whose answer selects the starting preset. */
export const BASE_QUESTION_ID = LOOK_QUESTION.id;

export type WizardAnswers = Readonly<Record<string, string>>;

function isVisible(question: WizardQuestion, answers: WizardAnswers): boolean {
  const condition = question.showWhen;
  if (condition === undefined) return true;
  const answer = answers[condition.question];
  if (answer === undefined) return false;
  return !condition.noneOf.includes(answer);
}

/** The questions that apply given the answers so far, in order. */
export function visibleQuestions(answers: WizardAnswers): readonly WizardQuestion[] {
  return WIZARD_QUESTIONS.filter((question) => isVisible(question, answers));
}

/** The next unanswered visible question, or `null` when the tree is exhausted. */
export function nextQuestion(answers: WizardAnswers): WizardQuestion | null {
  return visibleQuestions(answers).find((question) => answers[question.id] === undefined) ?? null;
}

/** Every question answered with its first option - the shortest path through the tree. */
export function defaultAnswers(baseId: string): WizardAnswers {
  const answers: Record<string, string> = { [BASE_QUESTION_ID]: baseId };
  for (;;) {
    const question = nextQuestion(answers);
    if (question === null) return answers;
    const first = question.options[0];
    if (first === undefined) return answers;
    answers[question.id] = first.id;
  }
}
