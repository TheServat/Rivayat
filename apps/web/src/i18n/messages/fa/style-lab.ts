/**
 * Persian messages for the Style Lab screen.
 *
 * One file per screen, so more than one person can work on the studio without
 * meeting in the middle of a single catalogue. Merged into the locale's catalogue
 * in `../fa.ts`.
 *
 * The English mirror is `../en/style-lab.ts`. `MessageSchema` is inferred from the
 * Persian catalogue, so a key added here and forgotten there is a compile error
 * rather than a raw key path rendered to a user.
 *
 * Two characters are reserved by the vue-i18n compiler and must not appear as
 * literal text: `|` separates plural forms and `@` starts a linked message.
 */
export default {
  title: 'کارگاه سبک',
  subtitle: 'سبک را پیش از هر چیز دیگری انتخاب و قفل کنید — هم ظاهر، هم شیوهٔ حرکت.',
  loading: 'در حال آوردن سبک‌ها…',

  state: {
    label: 'وضعیت سبک',
    none: 'هنوز سبکی انتخاب نشده',
    draft: 'پیش‌نویس',
    locked: 'قفل‌شده',
  },

  steps: {
    choose: 'یک سبک انتخاب کنید',
    chooseHint: 'یازده سبک آماده. هر کارت دقیقاً همان‌طور حرکت می‌کند که آن سبک حرکت می‌کند.',
  },

  gallery: {
    label: 'سبک‌های آماده',
    chosen: 'انتخاب‌شده',
    adopting: 'در حال ساختن پیش‌نویس سبک…',
  },

  motion: {
    // Not "frame rate": a style at 24 fps held on 3s shows eight drawings a second, and
    // eight is the number that decides whether it reads as animated or as interpolated.
    fps: 'تصویر بر ثانیه',
    step: 'گام فریم',
    stepMode: {
      smooth: 'پیوسته',
      'on-2s': 'روی ۲ فریم',
      'on-3s': 'روی ۳ فریم',
      'on-4s': 'روی ۴ فریم',
    },
    tempo: 'ضرب‌آهنگ',
    tempoValue: '×{value}',
    boil: 'جوشش خط',
    boilOn: '{hz} هرتز',
    boilOff: 'ندارد',
    easing: 'منحنی شتاب',
    easingNamed: '«{name}»',
  },

  playback: {
    label: 'نحوهٔ نمایش حرکت',
    play: 'پخش',
    step: 'گام‌به‌گام',
    playHint: 'هر کارت حلقهٔ حرکت خودش را پخش می‌کند.',
    stepHint: 'حرکت متوقف است؛ فریم‌ها را یکی‌یکی جلو ببرید.',
    frame: 'فریم {index} از {total}',
    previous: 'فریم قبلی',
    next: 'فریم بعدی',
    reduced: 'چون سیستم شما «حرکت کمتر» را خواسته است، نمایش گام‌به‌گام است.',
  },

  palette: {
    swatch: '{name} — {hex}',
  },

  checksum: {
    label: 'اثر انگشت سبک',
    none: 'هنوز ساخته نشده',
    pending: 'با قفل‌کردن نهایی می‌شود',
    hint: 'کلید یکتای هر دارایی از این مقدار ساخته می‌شود.',
  },

  probe: {
    heading: 'برگهٔ آزمون',
    hint: 'چهار موضوع ثابت: یک شخصیت، یک درخت، یک شیء و یک آسمان. همیشه همین چهارتا، تا دو سبک واقعاً قابل مقایسه باشند.',
    lane: 'مسیر تولید تصویر',
    laneFree: 'محلی',
    laneFreeHint: 'روی کارت گرافیک خودتان. رایگان و بدون محدودیت.',
    lanePaid: 'ابری',
    lanePaidHint: 'مدل ابری با کیفیت بالاتر. هر تصویر هزینه دارد.',
    recommended: 'پیشنهاد',
    estimate: 'برآورد پیش از اجرا',
    estimateLine: '{images} تصویر روی مسیر {lane}',
    estimateFree: 'رایگان',
    run: 'گرفتن برگهٔ آزمون',
    running: 'در حال ساختن چهار تصویر…',
    again: 'یک بار دیگر',
    sheetHeading: 'نتیجهٔ آزمون',
    ranOn: 'روی مسیر {lane}',
    total: 'هزینهٔ این برگه',
    unpriced: 'قیمت نامعلوم',
    needsStyle: 'اول یک سبک انتخاب کنید.',
    tileAlt: '{subject} در سبک {style}',
  },

  lock: {
    heading: 'قفل کردن',
    hint: 'تنها کار برگشت‌ناپذیر این صفحه.',
    action: 'قفل کردن سبک',
    locking: 'در حال قفل کردن…',
    locked: 'این سبک قفل شده است.',
    lockedAt: 'قفل‌شده در {when}',
    needsStyle: 'اول یک سبک انتخاب کنید.',
    confirmTitle: 'سبک قفل شود؟',
    confirmBody:
      'اثر انگشت این سبک ثابت می‌شود و کلید یکتای هر دارایی‌ای که از این پس ساخته شود از آن مشتق خواهد شد. اگر بعداً سبک را عوض کنید، کتابخانهٔ دارایی‌ها دوشاخه می‌شود و چیزی از آن دوباره استفاده نمی‌شود.',
    confirmName: 'سبکی که قفل می‌شود: {name}',
    confirm: 'بله، قفلش کن',
    forProject: 'برای «{project}»',
    noProject: 'پروژه‌ای انتخاب نشده، پس این قفل روی هیچ پروژه‌ای ثبت نمی‌شود.',
    detached: 'سبک قفل شده، ولی این پروژه هنوز به آن اشاره نمی‌کند.',
    attach: 'پروژه را به آن وصل کن',
    attaching: 'در حال وصل کردن…',
  },

  empty: {
    heading: 'هیچ سبکی روی قفسه نیست.',
    body: 'کارگاه سبک از فهرست سبک‌های آمادهٔ سرور تغذیه می‌شود و این فهرست خالی برگشت.',
  },
};
