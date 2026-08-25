/**
 * Persian messages for the Story screen.
 *
 * One file per screen, so more than one person can work on the studio without
 * meeting in the middle of a single catalogue. Merged into the locale's catalogue
 * in `../fa.ts`.
 *
 * The English mirror is `../en/story.ts`. `MessageSchema` is inferred from the
 * Persian catalogue, so a key added here and forgotten there is a compile error
 * rather than a raw key path rendered to a user.
 *
 * Two characters are reserved by the vue-i18n compiler and must not appear as
 * literal text: `|` separates plural forms and `@` starts a linked message.
 */
export default {
  title: 'داستان',
  subtitle: 'یک ایده به درختی از فصل، قسمت، پرده، سکانس، صحنه و ضربان تبدیل می‌شود.',

  intake: {
    heading: 'S0 برای این مجموعه اجرا نشده است.',
    body: 'همان چیزی است که فهرست کوتاه شخصیت‌ها را می‌سازد، و صفحهٔ شخصیت‌ها بدون آن چیزی نمی‌سازد.',
    run: 'اجرای S0',
    running: 'در حال خواندن ایده…',
    done: 'S0 برای این مجموعه {count} شخصیت یافت.',
    defaultAudience: 'بزرگ‌سالان',
    defaultTone: 'واقع‌گرا',
  },
  start: {
    heading: 'مجموعه را آغاز کنید',
    hint: 'هر پروژه یک مجموعه دارد و همهٔ صفحه‌های بعدی به آن نیاز دارند. تا وقتی ساخته نشود، هیچ‌چیز دیگری نمی‌تواند شروع شود.',
    titleLabel: 'عنوان',
    titlePlaceholder: 'قرضِ چراغ‌بان',
    premiseLabel: 'ایدهٔ اصلی',
    premisePlaceholder:
      'چراغ‌بانی در شهری کنار آب، چراغی را روشن نگه می‌دارد که صنف دستور خاموشی‌اش را داده است.',
    premiseHint: 'طرح‌ریز داستان از روی همین می‌نویسد؛ هرچه دقیق‌تر باشد، کمتر از خودش می‌سازد.',
    audienceLabel: 'مخاطب',
    audiencePlaceholder: 'بزرگ‌سالانی که با انیمیشن آرام اروپایی بزرگ شده‌اند',
    audienceHint:
      'گروه سنی و سلیقه را مشخص کنید. «همه» هیچ‌چیز را کنار نمی‌گذارد و هیچ‌چیز را هدایت نمی‌کند.',
    toneLabel: 'واژه‌های لحن',
    tonePlaceholder: 'دلگیر، طعنه‌آمیز، گرم',
    toneHint: 'با ویرگول جدا کنید. واژه‌هایی بردارید که چیزی را کنار می‌گذارند.',
    minutesLabel: 'دقیقه در هر قسمت',
    seasonsLabel: 'فصل‌ها',
    perSeasonLabel: 'قسمت در هر فصل',
    action: 'آغاز مجموعه',
    starting: 'در حال آغاز…',
  },
  context: {
    project: 'پروژه',
    series: 'مجموعه',
    chooseSeries: 'مجموعه را انتخاب کنید',
    noSeries: 'این پروژه هنوز مجموعه‌ای ندارد.',
    noProject: 'پروژه‌ای انتخاب نشده، پس جایی برای آغاز مجموعه وجود ندارد.',
    premise: 'خلاصهٔ مجموعه',
  },

  empty: {
    lead: 'هنوز درخت داستانی ساخته نشده است.',
    hint: 'ایدهٔ خود را در یک بند بنویسید. ساخت از ریشه شروع می‌شود و هر بار فقط یک سطح پایین‌تر می‌رود.',
    ideaLabel: 'ایدهٔ مجموعه',
    ideaHint: 'یک بند: چه کسی چه می‌خواهد، و چه چیزی سر راه است.',
    start: 'ساختن سطح نخست',
  },

  loading: {
    tree: 'در حال بارگیری درخت داستان…',
  },

  // The seven levels, in descent order. Also used as the label of the next
  // expansion, so they read as a noun on their own.
  levels: {
    series: 'مجموعه',
    season: 'فصل',
    episode: 'قسمت',
    act: 'پرده',
    sequence: 'سکانس',
    scene: 'صحنه',
    beat: 'ضربان',
  },

  tree: {
    heading: 'درخت داستان',
    ariaLabel: 'درخت داستان، از مجموعه تا ضربان',
    plannedSummary: 'سطح بالاتر چه خواسته بود',
    summary: 'این گره چه شد',
    childCount: 'بدون فرزند | یک فرزند | {count} فرزند',
    expandNext: 'ساختن سطح بعدی: {level}',
    expandNextHint:
      'ساخت هر بار یک سطح پایین می‌رود و هر فرزند به خواستهٔ والدش گره می‌خورد. برای همین دکمهٔ «همه را دوباره بساز» وجود ندارد — پرش از یک سطح، همان چیزی است که پیوستگی داستان را از بین می‌برد.',
    complete: 'هر هفت سطح ساخته شده است.',
    disclose: 'باز و بستهٔ زیرشاخهٔ {title}',
    selectNode: 'باز کردن {title}',
    selected: 'گرهٔ باز',
    noSelection: 'یک گره را از درخت انتخاب کنید تا اینجا باز شود.',
  },

  status: {
    label: 'وضعیت',
    planned: 'برنامه‌ریزی‌شده',
    expanded: 'ساخته‌شده',
    stale: 'کهنه',
    generating: 'در حال ساخت',
    staleHint: 'والد این گره بعد از ساخته شدن آن ویرایش شده است؛ محتوایش دست‌نخورده مانده.',
  },

  stream: {
    heading: 'در حال ساخت',
    level: 'سطح {level}',
    building: 'در حال نوشتن سطح {level}…',
    done: 'سطح {level} آماده شد.',
    progress: '{done} از {total} سطح',
    cancel: 'توقف',
    cancelled: 'ساخت متوقف شد. هر سطحی که تمام شده بود، سر جایش می‌ماند.',
    keepReading: 'می‌توانید همین حالا گره‌های آماده را باز کنید و بخوانید.',
  },

  node: {
    heading: 'گرهٔ انتخاب‌شده',
    titleLabel: 'عنوان',
    summaryLabel: 'متن گره',
    edit: 'ویرایش',
    cancel: 'انصراف',
    review: 'بررسی اثر این ویرایش',
    saving: 'در حال ذخیره…',
    saved: 'ویرایش ذخیره شد.',
    saveFailed: 'ویرایش ذخیره نشد.',
    unchanged: 'چیزی تغییر نکرده است.',
    regenerate: 'ساخت دوبارهٔ همین گره',
    regenerateHint:
      'فقط زیردرخت همین گره دوباره ساخته می‌شود؛ خواهرها و برادرهایش دست‌نخورده می‌مانند.',
    save: 'ذخیرهٔ ویرایش',
    regenerateEstimate: 'برآورد از روی هزینهٔ دفعهٔ پیش: {amount}',
    regenerateConfirm: 'ساختن دوباره',
    history: 'تاریخچهٔ نسخه‌ها',
    historyEmpty: 'هنوز نسخهٔ پیشینی ثبت نشده است.',
    historyEntry: 'نسخهٔ {ordinal}',
    restore: 'برگرداندن این نسخه',
  },

  provenance: {
    heading: 'چه کسی این را نوشت',
    role: 'نقش',
    model: 'مدل',
    cost: 'هزینه',
    at: 'زمان',
    handwritten: 'دست‌نویس نویسنده',
    notGenerated: 'هنوز ساخته نشده',
  },

  impact: {
    heading: 'این ویرایش چه چیزی را تحت تأثیر می‌گذارد',
    none: 'این گره فرزندی ندارد؛ ویرایش چیز دیگری را تحت تأثیر نمی‌گذارد.',
    affects: 'زیر این گره {count} فرزند هست.',
    levels: 'سطح‌های درگیر: {levels}',
    stages: 'مرحله‌های کهنه‌شونده: از {from} به بعد',
    choose: 'با فرزندها چه کنیم',
    keep: 'فرزندها بمانند',
    keepHint:
      'محتوای فرزندها دست‌نخورده می‌ماند و فقط «کهنه» علامت می‌خورد. هیچ هزینه‌ای ندارد و هر وقت خواستید می‌توانید یکی‌یکی دوباره بسازید.',
    reexpand: 'فرزندها دوباره ساخته شوند',
    reexpandHint:
      'زیردرخت دور ریخته و از روی متن تازه دوباره نوشته می‌شود. نسخهٔ پیشین در تاریخچه می‌ماند.',
    costDelta: 'هزینهٔ تخمینی: {amount}',
    costNone: 'هزینهٔ تخمینی: بدون هزینه',
    confirmKeep: 'ذخیره و نگه‌داشتن فرزندها',
    confirmReexpand: 'ذخیره و ساخت دوبارهٔ فرزندها',
    back: 'بازگشت به ویرایش',
  },

  bindings: {
    heading: 'کدام مدل کدام بخش را می‌نویسد',
    hint: 'هر مرحله مدل خودش را دارد. انتخاب یک مدل قوی برای ساختار و یک مدل ارزان برای بازخوانی، کار عادی‌ای در میانهٔ نوشتن است.',
    role: 'نقش',
    stage: 'مرحله',
    model: 'مدل',
    price: 'نرخ فعلی',
    tier: 'سطح کیفیت',
    free: 'رایگان',
    router: 'انتخاب با مسیریاب',
    unknownPrice: 'نرخ منتشر نشده است',
    layer: 'نوشتن در لایهٔ {layer}',
    readOnly: 'این گزینه از رابط کاربری تغییر نمی‌کند.',
    save: 'ذخیرهٔ انتخاب مدل‌ها',
    saving: 'در حال ذخیره…',
    saved: 'انتخاب مدل‌ها ذخیره شد.',
    unsaved: 'یک تغییر ذخیره‌نشده | {count} تغییر ذخیره‌نشده',
    loadFailed: 'فهرست مدل‌ها بارگیری نشد.',
    roles: {
      producer: 'تهیه‌کننده',
      screenwriter: 'فیلم‌نامه‌نویس',
      'art-director': 'مدیر هنری',
      director: 'کارگردان',
      actor: 'بازیگر',
      'continuity-editor': 'ویراستار تداوم',
    },
    roleHelp: {
      producer: 'ایده را می‌خواند و دامنهٔ کار را می‌بندد.',
      screenwriter: 'ساختار: پرده، سکانس، صحنه و ضربان.',
      'art-director': 'ظاهر شخصیت‌ها و prompt هر حالت.',
      director: 'صحنه را از اجراهای جداگانه یکدست می‌کند.',
      actor: 'به ازای هر شخصیت یکی؛ به صدای همان شخصیت بسته است.',
      'continuity-editor': 'تناقض با canon پخش‌شده را پیدا می‌کند.',
    },
    stages: {
      intake: 'دریافت',
      story: 'داستان',
      cast: 'شخصیت‌ها',
      sequence: 'توالی نماها',
    },
  },

  errors: {
    treeFailed: 'درخت داستان بارگیری نشد.',
    seriesFailed: 'فهرست مجموعه‌ها بارگیری نشد.',
    expandFailed: 'ساخت سطح بعدی انجام نشد.',
    notImplemented: 'این بخش هنوز روی سرور ساخته نشده است.',
    notImplementedHint:
      'رابط کاربری آماده است، ولی سرور هنوز مسیر {path} را ندارد. تا وقتی این مسیر اضافه نشود، درخت داستان خوانده یا نوشته نمی‌شود.',
  },
};
