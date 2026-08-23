/**
 * The four things every candidate style is tested on.
 *
 * Fixed, and fixed forever. The probe sheet's job is comparison - between two candidate
 * styles, and between the same style before and after an edit - and a comparison whose
 * subjects change is not one. The four are chosen because between them they exercise
 * every part of the style that can go wrong:
 *
 *  - a **character** is the only subject with an identity to keep, and the only one
 *    whose proportions and silhouette rule are testable;
 *  - a **tree** is the standing test of whether the style can produce something that
 *    splits into riggable parts rather than one baked mass;
 *  - a **prop** shows whether the style survives at thumbnail size with no context;
 *  - a **sky** is the one subject with no line work at all, so it is where a palette
 *    and a shading model are exposed with nothing to hide behind.
 *
 * The subjects are deliberately plain and culture-neutral in their description: the
 * probe is testing the *style*, and an interesting subject makes a sheet that is
 * pleasant to look at and useless to judge.
 */

import type { LocalisedText, SemanticKey, Slug, SubjectClass } from '@rv/contracts';

export interface ProbeSubject {
  readonly key: Slug;
  /** Library address, so a probe tile can be traced in the registry like any other asset. */
  readonly semanticKey: SemanticKey;
  readonly subjectClass: SubjectClass;
  readonly label: LocalisedText;
  /** The subject half of the prompt. The style half comes from the compiled fragments. */
  readonly subject: string;
}

export const PROBE_SUBJECTS: readonly ProbeSubject[] = [
  {
    key: 'character',
    semanticKey: 'probe/standing-figure',
    subjectClass: 'character',
    label: { fa: 'شخصیت ایستاده', en: 'Standing figure' },
    subject:
      'a single standing figure in a plain tunic, arms relaxed at the sides, neutral expression, full body visible',
  },
  {
    key: 'tree',
    semanticKey: 'probe/broadleaf-tree',
    subjectClass: 'foliage',
    label: { fa: 'درخت پهن‌برگ', en: 'Broadleaf tree' },
    subject: 'a single mature broadleaf tree with a visible trunk and three main boughs',
  },
  {
    key: 'prop',
    semanticKey: 'probe/water-jug',
    subjectClass: 'prop',
    label: { fa: 'کوزهٔ آب', en: 'Water jug' },
    subject: 'a single hand-thrown ceramic water jug with one handle, standing upright',
  },
  {
    key: 'sky',
    semanticKey: 'probe/daytime-sky',
    subjectClass: 'sky',
    label: { fa: 'آسمان روز', en: 'Daytime sky' },
    subject: 'an empty daytime sky with three or four scattered clouds and no horizon',
  },
];
