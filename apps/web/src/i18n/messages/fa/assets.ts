/**
 * Persian messages for the Asset library screen.
 *
 * One file per screen, so more than one person can work on the studio without
 * meeting in the middle of a single catalogue. Merged into the locale's catalogue
 * in `../fa.ts`.
 *
 * The English mirror is `../en/assets.ts`. `MessageSchema` is inferred from the
 * Persian catalogue, so a key added here and forgotten there is a compile error
 * rather than a raw key path rendered to a user.
 *
 * Two characters are reserved by the vue-i18n compiler and must not appear as
 * literal text: `|` separates plural forms and `@` starts a linked message.
 *
 * One string is deliberately **not** here: the engine's own diagnosis of a failed
 * step ("removed nothing: alpha coverage 0.9912 is above 0.98"). It is data, not
 * interface text - it carries a number the reader has to act on, and translating it
 * would mean either paraphrasing the number away or maintaining a Persian copy of a
 * sentence the engine composes at runtime.
 */
export default {
  title: 'کتابخانهٔ دارایی‌ها',
  subtitle: 'هر دارایی یک بار ساخته می‌شود و برای همیشه استفاده می‌شود.',

  summary: {
    count: 'بدون دارایی | یک دارایی | {count} دارایی',
    spend: 'هزینهٔ انباشتهٔ کتابخانه: {amount}',
  },

  loading: 'در حال خواندن کتابخانه…',

  empty: {
    heading: 'هنوز هیچ دارایی‌ای ساخته نشده است.',
    body: 'وقتی یک قسمت اجرا شود، هر چیزی که در صحنه دیده می‌شود اینجا یک بار ساخته می‌شود و برای همیشه می‌ماند.',
  },

  unavailable: {
    heading: 'این بخش هنوز روی سرور ساخته نشده است.',
    body: 'سرور فهرست دارایی‌ها را ارائه نمی‌دهد؛ صفحه آماده است و به محض افزوده شدن این مسیر کار می‌کند.',
    endpoint: 'مسیر نبود: {method} {path}',
    story: 'داستان مربوطه: {story}',
  },

  search: {
    label: 'جست‌وجوی معنایی',
    hint: 'به فارسی یا انگلیسی بنویسید؛ پیش از ساختن، نزدیک‌ترین دارایی‌های موجود پیدا می‌شوند.',
    placeholder: 'مثلاً: درخت کهنسال',
    submit: 'جست‌وجو',
    clear: 'پاک کردن جست‌وجو',
    running: 'در حال جست‌وجو…',
    results: 'بدون نتیجه | یک نتیجه | {count} نتیجه',
    none: 'چیزی به اندازهٔ کافی نزدیک نبود. یک پیشنهاد نادرست از نبودِ پیشنهاد گران‌تر است.',
    similarity: 'شباهت {value}',
    costNote: 'این جست‌وجو یک فراخوانی embedding دارد، پس با فشردن دکمه اجرا می‌شود نه با هر حرف.',
  },

  columns: {
    asset: 'دارایی',
    key: 'کلید یکتاسازی',
    status: 'وضعیت',
    versions: 'نسخه‌ها',
    variants: 'گونه‌ها',
    clips: 'کلیپ‌ها',
    parts: 'قطعه‌ها',
    spend: 'هزینه',
    updated: 'آخرین تغییر',
  },

  open: 'باز کردن {label}',

  status: {
    generating: 'در حال تولید',
    matting: 'در حال جداسازی',
    rigging: 'در حال rig',
    ready: 'آماده',
    rejected: 'ردشده',
    failed: 'شکست‌خورده',
  },

  representation: {
    heading: 'نحوهٔ ساخت',
    hint: 'این از روی قطعه‌ها و rig استنتاج شده است، نه اعلام‌شده در قرارداد. سبک می‌گوید چطور دیده می‌شود؛ این می‌گوید چطور ساخته و متحرک می‌شود.',
    derived: 'استنتاجی',
    flat: 'تصویر تخت',
    cutout: 'کاغذ بریده',
    'cutout-mesh': 'کاغذ بریده با مش',
    unknown: 'نامشخص',
  },

  key: {
    heading: 'کلید یکتاسازی',
    hint: 'کلید از چهار جزء ساخته می‌شود. وقتی چیزی که باید cache-hit می‌شد miss شد، همین چهار جزء را مقایسه کنید.',
    semanticKey: 'کلید معنایی',
    styleChecksum: 'checksum سبک',
    variantKey: 'کلید گونه',
    specHash: 'hash مشخصات',
  },

  plan: {
    heading: 'برنامه، پیش از خرج',
    hint: 'این محاسبه چیزی نمی‌نویسد و هیچ ارائه‌دهنده‌ای را صدا نمی‌زند، پس تا وقتی تصمیم بگیرید می‌توان بارها آن را دید.',
    hits: 'موجود در cache',
    misses: 'باید ساخته شود',
    estimate: 'برآورد هزینه',
    free: 'رایگان',
    freeNote: 'همه‌چیز از قبل ساخته شده است؛ این اجرا هیچ هزینه‌ای ندارد.',
    requiresConfirmation: 'نیازمند تأیید صریح',
    reload: 'محاسبهٔ دوباره',
    resolutions: 'تفکیک برنامه',
    reason: 'چرا',
    outcome: {
      'cache-hit': 'موجود',
      'variant-of-hit': 'گونهٔ موجود',
      miss: 'ساخته می‌شود',
      'blocked-by-budget': 'بستهٔ بودجه',
    },
    unavailable: 'سرور هنوز برآورد کتابخانه را ارائه نمی‌دهد.',
  },

  produce: {
    heading: 'مسیر ساخت',
    hint: 'هشت گام، به همان ترتیبی که موتور اجرا می‌کند.',
    stepOf: 'گام {index} از {total}',
    stoppedAt: 'در گام {step} متوقف شد',
    complete: 'هر هشت گام کامل شد.',
    diagnosis: 'تشخیص موتور',
    spent: 'هزینهٔ این تلاش: {amount}',
    duration: '{ms} میلی‌ثانیه',
    step: {
      generate: 'تولید',
      matte: 'جداسازی پس‌زمینه',
      split: 'تفکیک قطعه‌ها',
      score: 'ارزیابی کیفیت',
      rig: 'ساخت rig',
      clips: 'استخراج کلیپ‌ها',
      bake: 'پخت sprite sheet',
      register: 'ثبت در registry',
    },
    outcome: {
      ran: 'اجرا شد',
      resumed: 'از checkpoint برداشته شد',
      failed: 'شکست خورد',
      'not-reached': 'به آن نرسید',
    },
  },

  incomplete: {
    heading: 'تلاش‌هایی که ثبت نشدند',
    hint: 'اینها دارایی نیستند، ولی واقعاً اتفاق افتاده‌اند و هزینه داشته‌اند. دلیل توقف هرکدام اینجاست.',
    none: 'هر تلاشی به ثبت رسید.',
  },

  detail: {
    close: 'بستن جزئیات',
    heading: 'جزئیات دارایی',
    provenance: 'تبار',
    source: 'منبع',
    model: 'مدل',
    seed: 'seed',
    promptHash: 'hash پرامپت',
    cost: 'هزینه',
    created: 'ساخته‌شده در',
    parents: 'برگرفته از',
    description: 'توضیح',
    archetype: 'کهن‌الگو',
    tags: 'برچسب‌ها',
  },

  versions: {
    heading: 'نسخه‌ها',
    hint: 'نسخهٔ تازه همیشه افزوده می‌شود؛ هیچ نسخه‌ای بازنویسی نمی‌شود.',
    ordinal: 'نسخهٔ {ordinal}',
    current: 'نسخهٔ جاری',
    select: 'دیدن نسخهٔ {ordinal}',
    cost: 'هزینه {amount}',
    none: 'هنوز نسخه‌ای ثبت نشده است.',
  },

  parts: {
    image: 'تصویر',
    heading: 'قطعه‌ها',
    hint: 'لایه‌های شفاف با ترتیب z؛ rig روی همین‌ها می‌نشیند.',
    name: 'نام',
    role: 'نقش',
    zOrder: 'ترتیب z',
    coverage: 'پوشش آلفا',
    deformable: 'مش‌پذیر',
    size: 'اندازه',
    none: 'هنوز قطعه‌ای جدا نشده است.',
    lowCoverage: 'پوشش پایین',
  },

  rig: {
    heading: 'rig',
    template: 'قالب',
    bones: 'استخوان‌ها',
    meshes: 'مش‌ها',
    anchors: 'لنگرها',
    ikChains: 'زنجیره‌های IK',
    root: 'ریشه',
    childOf: 'فرزند {parent}',
    binds: 'به {count} قطعه بسته شده',
    none: 'این نسخه هنوز rig ندارد.',
  },

  clips: {
    heading: 'کلیپ‌ها',
    hint: 'حرکت روی rig محاسبه می‌شود، پس ثانیه‌های بیشتر هزینه‌ای ندارند.',
    name: 'نام',
    duration: 'مدت',
    fps: 'فریم بر ثانیه',
    loop: 'تکرار',
    source: 'منشأ',
    baked: 'پخته‌شده',
    notBaked: 'پخته نشده',
    seconds: '{value} ثانیه',
    none: 'هنوز کلیپی مشتق نشده است.',
  },

  variants: {
    heading: 'گونه‌ها',
    hint: 'گونه یک ویرایش است، نه یک ساخت تازه؛ فقط قطعه‌های نام‌برده عوض می‌شوند.',
    replaces: 'جایگزین: {parts}',
    none: 'گونه‌ای ساخته نشده است.',
  },

  scores: {
    heading: 'نمره‌های کیفیت',
    styleMatch: 'هم‌خوانی با سبک',
    alphaCleanliness: 'پاکی لبهٔ آلفا',
    silhouetteReadability: 'خوانایی سایه‌نما',
    identityMatch: 'هم‌خوانی هویت',
    partCompleteness: 'کامل بودن قطعه‌ها',
    overall: 'مجموع',
    none: 'این نسخه ارزیابی نشده است.',
  },

  regenerate: {
    open: 'ساخت دوبارهٔ این دارایی',
    title: 'ساخت یک نسخهٔ تازه',
    lead: 'این کار یک نسخهٔ تازه به {label} می‌افزاید و پول خرج می‌کند.',
    keepsPrevious: 'نسخهٔ {ordinal} دست‌نخورده می‌ماند و همچنان قابل باز کردن است.',
    reasonLabel: 'دلیل',
    reasonRequired: 'بدون انتخاب دلیل، این دکمه کار نمی‌کند.',
    reason: {
      'new-take': 'برداشت تازه',
      'style-changed': 'سبک عوض شده',
      'quality-reject': 'کیفیت پذیرفته نشد',
      'spec-changed': 'مشخصات عوض شده',
      'manual-override': 'تصمیم دستی',
    },
    reasonHint: {
      'new-take': 'همان مشخصات، شانس دیگر.',
      'style-changed': 'کتاب سبک قفل تازه‌ای دارد و این دارایی با آن نمی‌خواند.',
      'quality-reject': 'نمره‌های کیفیت زیر کف قابل قبول‌اند.',
      'spec-changed': 'توضیح یا فهرست قطعه‌ها عوض شده است.',
      'manual-override': 'دلیلی که در فهرست نیست؛ در یادداشت بنویسید.',
    },
    note: 'یادداشت',
    noteHint: 'اختیاری. در تبار نسخهٔ تازه ثبت می‌شود.',
    estimate: 'برآورد هزینه پیش از اجرا: {amount}',
    confirm: 'ساخت نسخهٔ تازه',
    cancel: 'انصراف',
    sending: 'در حال فرستادن…',
    failed: 'ساخت دوباره انجام نشد.',
    appended: 'نسخهٔ {ordinal} افزوده شد',
    appendedBody: 'نسخهٔ تازه ثبت شد و نسخهٔ پیشین سر جای خود است.',
    previousStill: 'نسخهٔ پیشین: {id}',
    newVersion: 'نسخهٔ تازه: {id}',
  },
  image: {
    none: 'تصویری ثبت نشده',
    missing: 'تصویر در انبار نیست',
  },
};
