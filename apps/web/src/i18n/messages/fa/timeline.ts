/**
 * Persian messages for the Timeline screen.
 *
 * One file per screen, so more than one person can work on the studio without
 * meeting in the middle of a single catalogue. Merged into the locale's catalogue
 * in `../fa.ts`.
 *
 * The English mirror is `../en/timeline.ts`. `MessageSchema` is inferred from the
 * Persian catalogue, so a key added here and forgotten there is a compile error
 * rather than a raw key path rendered to a user.
 *
 * Two characters are reserved by the vue-i18n compiler and must not appear as
 * literal text: `|` separates plural forms and `@` starts a linked message.
 */
export default {
  title: 'خط زمان',
  subtitle: 'حرکت را ببینید و تغییر دهید؛ آنچه اینجا می‌بینید همان است که رندر می‌شود.',

  loading: 'در حال خواندن سند حرکت…',

  empty: {
    heading: 'هنوز حرکتی برای ویرایش نیست.',
    body: 'وقتی یک نما به Animation IR ترجمه شود، همین‌جا باز می‌شود: track ها، keyframe ها، رفتارها و دوربین.',
  },

  unavailable: {
    heading: 'این بخش هنوز روی سرور ساخته نشده است.',
    body: 'سرور هیچ مسیری برای خواندن Animation IR ندارد؛ صفحه آماده است و به محض افزوده شدن آن مسیر کار می‌کند.',
    endpoint: 'مسیر نبود: {method} {path}',
    story: 'داستان مربوطه: {story}',
  },

  picker: {
    label: 'انتخاب حرکت',
  },

  agreement: {
    heading: 'پیش‌نما همان چیزی است که رندر می‌شود',
    body: 'این پیش‌نما مستقیماً از evaluate(ir, t) در anim-engine خوانده می‌شود؛ همان تابعی که رندرکننده، پخت sprite sheet و خروجی Lottie از آن استفاده می‌کنند. هیچ منحنی تقریبی‌ای اینجا وجود ندارد.',
  },

  transport: {
    label: 'کنترل پخش',
    play: 'پخش',
    pause: 'مکث',
    toStart: 'به ابتدا',
    toEnd: 'به انتها',
    back: 'یک فریم عقب',
    forward: 'یک فریم جلو',
    loop: 'تکرار',
    time: 'زمان',
    frame: 'فریم {frame} از {total}',
    fps: '{fps} فریم بر ثانیه',
    duration: 'مدت {seconds} ثانیه',
  },

  scrub: {
    label: 'مکان‌نمای زمان',
    hint: 'با کلیدهای جهت یک فریم، با Shift ده فریم، و با Home و End به ابتدا و انتها بروید.',
    position: 'فریم {frame} از {total}، ثانیهٔ {seconds}',
    rtlNote:
      'در فارسی زمان از راست به چپ می‌رود؛ کلید جهتِ راست به عقب و کلید جهتِ چپ به جلو می‌برد.',
    ltrNote: 'زمان از چپ به راست می‌رود؛ کلید جهتِ راست به جلو و کلید جهتِ چپ به عقب می‌برد.',
  },

  stage: {
    label: 'پیش‌نمای صحنه',
    scene: 'فضای صحنه',
    sceneSpace: '{width} در {height}',
    camera: 'دوربین',
    zoom: 'بزرگ‌نمایی {value}',
    nodes: 'بدون گره | یک گره | {count} گره قابل ترسیم',
    origin: 'مبدأ فضای صحنه در مرکز بوم است، دقیقاً مثل رندرکننده.',
    noCanvas: 'این مرورگر بوم دوبعدی نمی‌دهد؛ مقادیر فریم زیر همچنان درست‌اند.',
  },

  motion: {
    heading: 'منشأ حرکت',
    keyframe: 'keyframe',
    'keyframe-over-procedural': 'keyframe روی رفتار',
    'keyframe-with-procedural': 'keyframe به‌علاوهٔ رفتار',
    unknown: 'نامشخص',
    consequence: {
      replaces:
        'این کانال را رفتارِ {behaviours} هم می‌راند. چون این track افزایشی نیست، مقدار keyframe جای رفتار را می‌گیرد.',
      sums: 'این کانال را رفتارِ {behaviours} هم می‌راند. چون این track افزایشی است، مقدار keyframe با رفتار جمع می‌شود.',
    },
  },

  tracks: {
    heading: 'track ها',
    none: 'این حرکت هیچ track دستی ندارد؛ همه‌چیز از رفتارهای پروسیجرال می‌آید.',
    node: 'گره',
    channel: 'کانال',
    keyframes: 'بدون keyframe | یک keyframe | {count} keyframe',
    ruler: 'خط‌کش زمان',
    markers: 'نشانه‌ها',
    select: 'انتخاب keyframe شمارهٔ {index} روی {channel}',
  },

  keyframe: {
    heading: 'keyframe انتخاب‌شده',
    none: 'یک keyframe را انتخاب کنید تا اینجا ویرایش شود.',
    time: 'زمان به میلی‌ثانیه',
    value: 'مقدار',
    easing: 'منحنی خروج',
    hint: 'با کشیدن یا با کلیدهای جهت جابه‌جا می‌شود. هر تغییر یک عملیات است و undo دارد.',
    at: 'در {ms} میلی‌ثانیه، مقدار {value}',
  },

  easing: {
    none: 'خطی',
    named: 'منحنی نام‌دار: {name}',
    cubic: 'بزیه سفارشی',
    stepped: 'پله‌ای، {steps} پله',
  },

  behaviour: {
    heading: 'رفتارها',
    none: 'این حرکت رفتار پروسیجرالی ندارد.',
    enabled: 'فعال',
    weight: 'وزن',
    seed: 'seed',
    select: 'انتخاب رفتار {kind}',
    onNode: 'روی {node}',
    param: 'پارامتر {name}',
  },

  behaviourKind: {
    wind: 'باد',
    breathe: 'نفس',
    blink: 'پلک',
    sway: 'تاب',
    'walk-cycle': 'چرخهٔ راه رفتن',
    flap: 'بال زدن',
    orbit: 'مدار',
    parallax: 'اختلاف منظر',
    boil: 'جوشش خط',
    spring: 'فنر',
    'look-at': 'نگاه به',
    'follow-path': 'دنبال مسیر',
    'lip-sync': 'هم‌زمانی لب',
  },

  markerKind: {
    beat: 'ضربان',
    cut: 'برش',
    dialogue: 'گفت‌وگو',
    sfx: 'افکت صوتی',
    music: 'موسیقی',
    custom: 'دلخواه',
  },

  history: {
    undo: 'برگرداندن',
    redo: 'انجام دوباره',
    none: 'هنوز تغییری داده نشده است.',
    edits: 'بدون تغییر | یک تغییر | {count} تغییر',
    unsaved: 'ذخیره‌نشده',
    unsavedHint:
      'سرور هنوز مسیری برای ذخیرهٔ عملیات‌های IR ندارد؛ این تغییرها فقط در همین صفحه‌اند.',
  },

  op: {
    moveKeyframe: 'جابه‌جایی keyframe',
    setEasing: 'تغییر منحنی',
    setBehaviourParam: 'تغییر پارامتر رفتار',
  },

  refusal: {
    'unknown-track': 'چنین track ای وجود ندارد: {subject}',
    'unknown-keyframe': 'چنین keyframe ای وجود ندارد: {subject}',
    'unknown-behaviour': 'چنین رفتاری وجود ندارد: {subject}',
    'unknown-param': 'این پارامتر روی این رفتار قابل تغییر نیست: {subject}',
    'not-a-number': 'مقدار عددی معتبر نیست: {subject}',
    'out-of-order': 'keyframe از همسایه‌اش رد می‌شود؛ ترتیب زمانی باید حفظ شود: {subject}',
    'past-duration': 'زمان بیرون از مدت این حرکت است: {subject}',
    'before-zero': 'زمان نمی‌تواند منفی باشد: {subject}',
  },
};
