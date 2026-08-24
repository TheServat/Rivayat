/**
 * Persian messages for the Render and delivery screen.
 *
 * One file per screen, so more than one person can work on the studio without
 * meeting in the middle of a single catalogue. Merged into the locale's catalogue
 * in `../fa.ts`.
 *
 * The English mirror is `../en/render.ts`. `MessageSchema` is inferred from the
 * Persian catalogue, so a key added here and forgotten there is a compile error
 * rather than a raw key path rendered to a user.
 *
 * Two characters are reserved by the vue-i18n compiler and must not appear as
 * literal text: `|` separates plural forms and `@` starts a linked message.
 *
 * The vocabulary is the creator's, not the pipeline's. A `FormatProfile` is a
 * «قالب تحویل», a `ReframeStrategy` of `pan-scan` is «قاب همراه سوژه», and
 * `safeAreaViolation` is «کانون بیرون ناحیهٔ امن می‌افتد» - which says what the
 * viewer will see rather than which boolean was true.
 */
export default {
  title: 'رندر و تحویل',
  subtitle: 'یک ترکیب‌بندی، هفت قالب — هرکدام با ناحیهٔ امن خودش.',

  project: {
    label: 'پروژه',
    choose: 'یک پروژه انتخاب کنید',
    empty: 'هنوز پروژه‌ای ساخته نشده است.',
    emptyHint: 'برای دیدن اجراها و هزینهٔ تحویل، اول یک پروژه بسازید.',
  },

  targets: {
    heading: 'قالب‌های تحویل',
    lead: 'هر قالب یک برش از همان ترکیب‌بندی است. کادر خاکستری چیزی است که رمزگذاری می‌شود و کادر طلایی آن بخشی که رابط خودِ پلتفرم رویش نمی‌افتد.',
    count:
      'هیچ قالبی انتخاب نشده | یک قالب از {total} انتخاب شده | {count} قالب از {total} انتخاب شده',
    selectAll: 'انتخاب همه',
    clearAll: 'برداشتن همه',
    choose: 'تحویل به {format}',
    size: '{width} در {height} پیکسل',
    ratio: 'نسبت {ratio}',
    encode: '{codec} در {container}، {fps} فریم بر ثانیه',
    bitrate: '{min} تا {max} مگابیت بر ثانیه',
    encodeLabel: 'رمزگذاری',
    allowed: 'پلتفرم این کدک‌ها را می‌پذیرد: {codecs}',
    limitLabel: 'محدودیت زمان',
    limit: 'حداکثر {duration}',
    noLimit: 'بدون محدودیت زمان',
    verified: 'مشخصات پلتفرم‌ها در ۲ شهریور ۱۴۰۵ راستی‌آزمایی شده است.',
  },

  safeArea: {
    label: 'ناحیهٔ امن',
    size: '{width} در {height} پیکسل',
    share: '{percent} از کادر',
    whole: 'تمام کادر امن است',
    explain: 'هرچه بیرون این کادر بیفتد ممکن است زیر دکمه‌ها و نوشته‌های خود پلتفرم پنهان شود.',
  },

  chrome: {
    label: 'پوشش رابط پلتفرم',
    none: 'این پلتفرم چیزی روی کادر نمی‌گذارد.',
    share: '{percent} از کادر را می‌پوشاند',
    zones: {
      top: 'نوار بالای صفحه',
      captions: 'نوار زیرنویس پایین',
      actions: 'ستون دکمه‌های کناری',
    },
  },

  legend: {
    heading: 'راهنمای نقشه',
    frame: 'کادر تحویل',
    safeArea: 'ناحیهٔ امن',
    chrome: 'پوشش پلتفرم',
    composition: 'ترکیب‌بندی',
    focus: 'کانون تصویر',
  },

  reframe: {
    label: 'قاب‌بندی دوباره',
    unplanned: 'قاب‌بندی هنوز حساب نشده است',
    unplannedHint:
      'قاب‌بندی وقتی حساب می‌شود که یک ترکیب‌بندی برای تحویل انتخاب شده باشد. تا آن وقت فقط مشخصات پلتفرم را می‌بینید.',
    strategy: {
      crop: 'برش ثابت',
      panScan: 'قاب همراه سوژه',
      letterbox: 'نوار بالا و پایین',
      pillarbox: 'نوار چپ و راست',
      reflow: 'چیدمان تازه',
    },
    explain: {
      crop: 'این برش کانون تصویر را داخل ناحیهٔ امن نگه می‌دارد.',
      panScan: 'برش در طول نما حرکت می‌کند تا سوژه داخل ناحیهٔ امن بماند.',
      letterbox: 'هیچ برشی کانون را نگه نمی‌داشت، پس تمام کادر با نوار بالا و پایین می‌ماند.',
      pillarbox: 'هیچ برشی کانون را نگه نمی‌داشت، پس تمام کادر با نوار دو طرف می‌ماند.',
      reflow: 'به‌جای حرکت دوربین، عناصر چیدمان برای این قالب جابه‌جا شده‌اند.',
    },
    held: 'کانون داخل ناحیهٔ امن می‌ماند',
    missed: 'کانون بیرون ناحیهٔ امن می‌افتد',
    review: 'پیش از انتشار باید دیده شود',
    shot: 'نمای {shot}',
  },

  spec: {
    label: 'سنجش با مشخصات پلتفرم',
    passed: 'قبول',
    failed: 'رد',
    awaiting: 'هنوز سنجیده نشده',
    awaitingHint:
      'پرونده‌های تحویلی پس از رندر با مشخصات پلتفرمشان سنجیده می‌شوند؛ هنوز پرونده‌ای برای سنجیدن نیست.',
  },

  run: {
    heading: 'اجرای تحویل',
    lead: 'رندر چند دقیقه طول می‌کشد. لازم نیست اینجا بمانید.',
    picker: 'اجرا',
    none: 'هنوز اجرایی برای این پروژه ثبت نشده است.',
    noneHint: 'وقتی یک قسمت برای تحویل آماده شد، اجرای آن اینجا دیده و کنترل می‌شود.',
    started: 'آغاز {when}',
    finished: 'پایان {when}',
    elapsed: 'زمان سپری‌شده',
    seed: 'دانهٔ تصادفی {seed}',
    stagesHeading: 'مرحله‌ها',
    progress: 'پیشرفت {percent}',
    artifacts: 'آنچه روی دیسک نوشته شد',
    noArtifacts: 'این اجرا هنوز پرونده‌ای ننوشته است.',
    issues: 'رویدادهای گزارش‌شده',
    cancel: 'لغو اجرا',
    cancelling: 'در حال لغو…',
    resume: 'ادامه از ایست‌بازرسی',
    resuming: 'در حال ادامه…',
    resumeHint:
      'از نخستین مرحله‌ای که ایست‌بازرسی ندارد ادامه می‌دهد؛ فریم‌های نوشته‌شده دوباره کشیده نمی‌شوند.',
    resumeBlocked: 'اجرای لغوشده یا موفق ادامه پیدا نمی‌کند.',
    failedNote: 'این اجرا خودش متوقف شد. ادامه، از آخرین ایست‌بازرسی پی می‌گیرد.',
    cancelledNote:
      'شما این اجرا را متوقف کردید. اجرای تازه از همان فریم‌هایی که نوشته شده ادامه می‌دهد و چیزی دوباره کشیده نمی‌شود.',
    recoverHint:
      'اگر رندر بدون تمام‌شدن ایستاده — مثلاً ماشین دوباره راه‌اندازی شده — ادامه آن را از آخرین ایست‌بازرسی برمی‌دارد.',
    checkpoint: 'ایست‌بازرسی دارد',
    survivable:
      'می‌توانید این صفحه را ببندید. اجرا روی سرور ادامه دارد و همین نشانی شما را به آن برمی‌گرداند.',
    liveLabel: 'جریان زنده',
    live: {
      idle: 'دنبال نمی‌شود',
      connecting: 'در حال اتصال…',
      open: 'زنده',
      reconnecting: 'قطع شد؛ در حال اتصال دوباره…',
      failed: 'اتصال زنده برقرار نشد',
    },
    errorCode: 'کد خطا {code}',
  },

  status: {
    queued: 'در صف',
    running: 'در حال اجرا',
    paused: 'متوقف',
    succeeded: 'موفق',
    failed: 'ناموفق',
    cancelled: 'لغوشده',
  },

  stage: {
    intake: 'دریافت ایده',
    style: 'سبک',
    story: 'داستان',
    cast: 'شخصیت‌ها',
    world: 'جهان داستان',
    resolve: 'تعیین دارایی‌ها',
    produce: 'تولید دارایی‌ها',
    sequence: 'نماها',
    choreograph: 'حرکت',
    preview: 'پیش‌نما',
    render: 'رندر',
    deliver: 'تحویل',
  },

  cost: {
    heading: 'هزینه',
    lead: 'هزینهٔ هر اجرا با طول قسمت عوض می‌شود؛ آنچه در طول یک مجموعه معنا دارد هزینهٔ هر دقیقه است.',
    perMinute: 'هزینهٔ هر دقیقهٔ تحویل‌شده',
    perMinuteNone: 'هنوز دقیقه‌ای تحویل نشده است',
    total: 'هزینهٔ کل پروژه',
    delivered: 'ویدئوی تحویل‌شده',
    deliveredNone: 'هیچ',
    runsHeading: 'اجراها و هزینهٔ هرکدام',
    columns: {
      run: 'اجرا',
      status: 'وضعیت',
      delivered: 'تحویل‌شده',
      cost: 'هزینه',
      perMinute: 'هر دقیقه',
    },
    budget: {
      label: 'سقف هزینهٔ این اجرا',
      spent: '{spent} از {ceiling}',
      none: 'برای این اجرا سقف جداگانه‌ای تعیین نشده است.',
      over: 'از سقف عبور کرده است.',
      remaining: 'باقی‌مانده {amount}',
    },
    free: 'رایگان',
  },

  duration: {
    seconds: 'بدون زمان | یک ثانیه | {count} ثانیه',
    minutes: 'بدون زمان | یک دقیقه | {count} دقیقه',
  },

  errors: {
    formats: 'فهرست قالب‌های تحویل بارگیری نشد.',
    runs: 'فهرست اجراها بارگیری نشد.',
    cost: 'گزارش هزینه بارگیری نشد.',
  },
};
