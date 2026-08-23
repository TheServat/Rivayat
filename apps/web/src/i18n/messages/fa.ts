/**
 * Persian messages - the default locale, and the *shape* every other locale is checked
 * against.
 *
 * `MessageSchema` is inferred from this object rather than declared beside it, for the
 * same reason `@rv/contracts` infers its types from Zod schemas: a hand-written shape
 * is a second source of truth, and the failure mode is a key that exists in the type
 * and in neither catalogue.
 *
 * Persian is first because it is the language the studio is used in, not because it
 * sorts first. A key added here and forgotten in `en.ts` is a compile error, so the
 * English catalogue can never silently fall behind.
 *
 * Two characters are reserved by the vue-i18n message compiler and must not appear as
 * literal text: `|` separates plural forms and `@` starts a linked message.
 */
const fa = {
  app: {
    name: 'روایت',
    tagline: 'از ایده تا مجموعهٔ انیمیشنی',
  },

  nav: {
    label: 'بخش‌های اصلی',
    // The two rails in the sidebar. The first is the pipeline in the order it runs;
    // the second is everything that is not a stage of it.
    pipeline: 'مسیر ساخت',
    studio: 'کارگاه',
    projects: 'پروژه‌ها',
    styleLab: 'کارگاه سبک',
    story: 'داستان',
    characters: 'شخصیت‌ها',
    assets: 'کتابخانهٔ دارایی‌ها',
    timeline: 'خط زمان',
    render: 'رندر و تحویل',
    settings: 'تنظیمات',
  },

  shell: {
    skipToContent: 'رفتن به محتوای اصلی',
    mainContent: 'محتوای اصلی',
    toolbar: 'ابزارهای نمایش',
    transportFixture: 'دادهٔ نمونه',
    transportFixtureHint:
      'این نشست به هیچ سروری وصل نیست و همهٔ مقادیر از پرونده‌های نمونه خوانده می‌شوند.',
  },

  theme: {
    label: 'پوسته',
    light: 'روشن',
    dark: 'تیره',
    system: 'مطابق سیستم',
  },

  locale: {
    label: 'زبان',
    fa: 'فارسی',
    en: 'English',
  },

  common: {
    save: 'ذخیره',
    saveAll: 'ذخیرهٔ همهٔ تغییرها',
    cancel: 'انصراف',
    discard: 'دور ریختن تغییرها',
    retry: 'تلاش دوباره',
    reload: 'بارگیری دوباره',
    close: 'بستن',
    search: 'جست‌وجو',
    loading: 'در حال بارگیری…',
    none: 'هیچ‌کدام',
    unknown: 'نامشخص',
    optional: 'اختیاری',
    required: 'الزامی',
    yes: 'بله',
    no: 'خیر',
    on: 'روشن',
    off: 'خاموش',
    open: 'باز کردن',
    empty: 'چیزی برای نمایش نیست',
  },

  errors: {
    title: 'خطا',
    unexpected: 'خطای پیش‌بینی‌نشده‌ای رخ داد.',
    network: 'ارتباط با سرور برقرار نشد.',
    schemaMismatch: 'پاسخ سرور با قرارداد داده‌ها نمی‌خواند و پذیرفته نشد.',
    schemaMismatchDetail: 'میدان نامعتبر: {path}',
    kind: {
      validation: 'داده‌های ورودی معتبر نیست.',
      'not-found': 'موردی که خواستید پیدا نشد.',
      conflict: 'وضعیت روی سرور تغییر کرده است.',
      unsupported: 'این قابلیت در پیکربندی فعلی پشتیبانی نمی‌شود.',
      provider: 'ارائه‌دهندهٔ بیرونی خطا داد.',
      timeout: 'مهلت پاسخ سرور به پایان رسید.',
      'rate-limit': 'تعداد درخواست‌ها بیش از حد مجاز است.',
      budget: 'این کار از سقف هزینهٔ تعیین‌شده عبور می‌کند.',
      cancelled: 'عملیات لغو شد.',
      internal: 'خطای داخلی سرور.',
    },
    code: 'کد خطا: {code}',
    retryable: 'تلاش دوباره ممکن است جواب بدهد.',
  },

  sse: {
    connecting: 'در حال اتصال به جریان پیشرفت…',
    connected: 'متصل',
    reconnecting: 'قطع شد؛ تلاش دوباره تا {seconds} ثانیهٔ دیگر',
    failed: 'اتصال به جریان پیشرفت برقرار نشد.',
  },

  projects: {
    title: 'پروژه‌ها',
    subtitle: 'هر پروژه یک مجموعه، یک کتاب سبک و یک کتابخانهٔ دارایی دارد.',
    empty: 'هنوز پروژه‌ای ساخته نشده است.',
    emptyHint: 'اولین پروژه را با یک ایدهٔ کوتاه شروع کنید.',
    columns: {
      name: 'نام',
      status: 'وضعیت',
      episodes: 'قسمت‌ها',
      style: 'کتاب سبک',
      spend: 'هزینهٔ انباشته',
      updated: 'آخرین تغییر',
    },
    styleLocked: 'قفل‌شده',
    styleUnlocked: 'قفل‌نشده',
    styleAbsent: 'انتخاب‌نشده',
    episodeCount: 'بدون قسمت | یک قسمت | {count} قسمت',
    openProject: 'باز کردن پروژهٔ {name}',
  },

  settings: {
    title: 'تنظیمات',
    subtitle:
      'هر گزینه‌ای که کد می‌خواند، اینجا هست. این صفحه از روی فهرست تنظیم‌ها ساخته می‌شود، نه دستی.',
    search: 'جست‌وجو در تنظیم‌ها',
    searchHint: 'نام، کلید یا توضیح',
    noMatches: 'هیچ تنظیمی با این جست‌وجو نمی‌خواند.',
    dirtyCount: 'یک تغییر ذخیره‌نشده | {count} تغییر ذخیره‌نشده',
    unsaved: 'ذخیره‌نشده',
    saved: 'تنظیم‌ها ذخیره شد.',
    saveFailed: 'ذخیره‌سازی انجام نشد.',
    keyLabel: 'کلید: {key}',
    groups: {
      providers: 'ارائه‌دهنده‌ها و کلیدها',
      models: 'انتخاب مدل برای هر مرحله',
      image: 'مسیر تولید تصویر',
      budget: 'بودجه و سقف هزینه',
      render: 'رندر',
      delivery: 'قالب‌های تحویل',
      interface: 'ظاهر و زبان',
      runtime: 'زیرساخت و مسیرها',
    },
    editingLayer: 'در حال ویرایش لایهٔ {layer}',
    readOnly: 'فقط خواندنی',
    readOnlyHint:
      'این گزینه فقط در لایهٔ ماشین نگهداری می‌شود و از رابط کاربری تغییر نمی‌کند؛ آن را در پروندهٔ ‎.env‎ ویرایش کنید.',
    envVariable: 'متغیر محیطی: {name}',
    ignored:
      'لایهٔ {layer} مقداری نامعتبر ذخیره کرده است؛ فعلاً مقدار لایهٔ پایین‌تر به کار می‌رود.',
    warnings: {
      title: 'هشدارهای پروندهٔ محیط',
    },
    provenance: {
      label: 'مقدار از کجا می‌آید',
      default: 'پیش‌فرض',
      machine: 'ماشین',
      global: 'سراسری',
      project: 'پروژه',
      run: 'اجرا',
      from: 'از لایهٔ {layer}',
      overridden: 'در این لایه بازنویسی شده است.',
      inherited: 'از لایهٔ {layer} به ارث رسیده است.',
      shadowed: 'در این لایه مقدار دارد، ولی لایهٔ مشخص‌تری آن را بازنویسی کرده است.',
    },
    scope: {
      label: 'دامنه',
      machine: 'ماشین',
      global: 'سراسری',
      project: 'پروژه',
      run: 'اجرا',
    },
    clearOverride: 'برگرداندن به مقدار ارث‌بری‌شده',
    clearOverrideHint: 'بازنویسی این لایه برداشته می‌شود و مقدار لایهٔ پایین‌تر برمی‌گردد.',
    requiresRestart: 'نیازمند راه‌اندازی دوباره',
    requiresRestartHint: 'تغییر این گزینه تا راه‌اندازی دوبارهٔ سرور اثر نمی‌کند.',
    invalid: 'مقدار نامعتبر است.',
    secret: {
      present: 'ثبت شده است',
      absent: 'ثبت نشده است',
      never: 'مقدار محرمانه هرگز نمایش داده نمی‌شود.',
      set: 'ثبت مقدار تازه',
      clear: 'پاک کردن',
      placeholder: 'مقدار تازه را بنویسید',
    },
    modelPicker: {
      provider: 'ارائه‌دهنده',
      model: 'مدل',
      free: 'رایگان',
      capabilities: 'قابلیت‌ها',
      choose: 'یک مدل انتخاب کنید',
      router: 'مسیریاب انتخاب کند',
      custom: 'مدل دلخواه',
      customLabel: 'شناسهٔ مدل دلخواه',
      empty: 'فهرست مدل‌ها برای این جایگاه خالی است؛ شناسهٔ مدل را دستی بنویسید.',
    },
    multiSelect: {
      hint: 'یک یا چند گزینه را انتخاب کنید.',
      min: 'دست‌کم {count} گزینه باید انتخاب شود.',
      max: 'بیشتر از {count} گزینه نمی‌شود انتخاب کرد.',
    },
    json: {
      hint: 'JSON معتبر بنویسید.',
      invalid: 'JSON نامعتبر است.',
    },
    money: {
      hint: 'مبلغ به دلار. خالی بگذارید تا در این لایه سقفی نباشد.',
      nanoUsd: '{usd} دلار',
      noCeiling: 'بدون سقف',
    },
    slider: {
      value: 'مقدار: {value}',
    },
    loadFailed: 'فهرست تنظیم‌ها بارگیری نشد.',
  },

  placeholder: {
    badge: 'هنوز ساخته نشده',
    heading: 'این صفحه هنوز پیاده‌سازی نشده است.',
    stage: 'مرحلهٔ {index} از {total} مسیر ساخت',
    willContain: 'وقتی ساخته شود، اینجا خواهد بود:',
    dependsOn: 'وابسته به: {stories}',
    styleLab: {
      title: 'کارگاه سبک',
      body: 'انتخاب از میان سبک‌های آماده، ساخت سبک از روی تصویرهای مرجع، جادوگر پرسش‌محور، برگهٔ آزمون سبک، و قفل کردن کتاب سبک به همراه checksum آن.',
    },
    story: {
      title: 'داستان',
      body: 'درخت مجموعه تا فصل، قسمت، پرده، سکانس، صحنه و ضربان؛ ویرایش هر گره، تاریخچهٔ نسخه‌ها و تولید دوبارهٔ همان زیردرخت.',
    },
    characters: {
      title: 'شخصیت‌ها',
      body: 'برگهٔ هر شخصیت با روان‌شناسی، صدا، قوس و امضای حرکتی، به‌همراه شبکهٔ حالت‌های چهره، ژست‌ها و پوشاک و prompt هرکدام؛ و نمای گراف موجودیت‌ها با لغزندهٔ زمان داستانی.',
    },
    assets: {
      title: 'کتابخانهٔ دارایی‌ها',
      body: 'مرور و جست‌وجوی معنایی دارایی‌ها، نسخه‌ها و گونه‌ها، قطعه‌های شفاف با ترتیب لایه، rig، کلیپ‌ها، و دفتر هزینهٔ هر دارایی.',
    },
    timeline: {
      title: 'خط زمان',
      body: 'ویرایشگر track و keyframe روی Animation IR، پارامترهای رفتارها، نشانه‌ها، و پخش‌کنندهٔ PixiJS با scrub قطعی.',
    },
    render: {
      title: 'رندر و تحویل',
      body: 'پیش‌نمای هر قالب با پوشش ناحیهٔ امن، برآورد هزینه پیش از رندر، پایش اجرا روی SSE با لغو و ازسرگیری، و فهرست پرونده‌های تحویل‌شده.',
    },
  },

  notFound: {
    title: 'صفحه پیدا نشد',
    body: 'نشانی‌ای که باز کردید به هیچ صفحه‌ای نمی‌رسد.',
    backToProjects: 'بازگشت به پروژه‌ها',
  },
};

/**
 * The shape of a complete catalogue.
 *
 * Every other locale is typed as this, so a missing key fails `vue-tsc` - the studio
 * never gets the chance to render a raw key path to a user.
 */
export type MessageSchema = typeof fa;

export default fa;
