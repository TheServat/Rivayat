import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { fixtureId, issuePaths } from './__fixtures__/support';
import {
  AssetInstance,
  AssetInstanceKey,
  CAMERA_MOVES,
  CameraMove,
  FOCUS_PRIORITIES,
  FocusPriority,
  FocusTarget,
  MusicCue,
  ParallaxDepth,
  SHOT_FRAMINGS,
  SceneSpace,
  SfxCue,
  Shot,
  ShotAction,
  ShotAssetPin,
  ShotAudio,
  ShotCamera,
  ShotCompilation,
  ShotFraming,
  ShotLayer,
} from './shot';
import { AssetRef, LoopMode, PinnedAssetRef } from '../asset/asset';

const assetId = fixtureId('ast', 1);
const assetVersionId = fixtureId('asv', 1);

const instance = {
  instance: 'mahtab',
  assetId,
  assetVersionId,
  transform: { position: { x: 1080, y: 1400 } },
};

const focusTarget = {
  instance: 'mahtab',
  region: { x: 0.34, y: 0.18, width: 0.32, height: 0.56 },
};

const sceneSpace = {
  size: { width: 2400, height: 2400 },
  masterAspect: '16:9',
  reframeTargets: ['16:9', '9:16', '1:1'],
};

const shot = {
  id: fixtureId('sht', 1),
  index: 0,
  durationMs: 6800,
  beatRef: fixtureId('bet', 1),
  sceneSpace,
  camera: { framing: 'medium', move: 'dolly-in', focusTarget },
  layout: [{ z: 0, name: 'lamp room', instances: [instance] }],
  audio: { sfx: [], music: null },
  safeArea: { x: 0.14, y: 0.1, width: 0.72, height: 0.8 },
  focusTarget,
};

describe('AssetInstanceKey', () => {
  it('takes a name a writer can remember and re-quote', () => {
    expect(AssetInstanceKey.parse('kael-left')).toBe('kael-left');
    expect(AssetInstanceKey.parse('lantern')).toBe('lantern');
  });

  it('rejects anything that is not a lowercase hyphenated slug', () => {
    for (const bad of ['', 'Kael Left', 'kael_left', 'kael--left', '-kael', 'kael-']) {
      expect(AssetInstanceKey.safeParse(bad).success).toBe(false);
    }
  });
});

describe('ParallaxDepth', () => {
  it('sits on the focal plane unless the shot says otherwise', () => {
    expect(ParallaxDepth.parse(undefined)).toBe(1);
  });

  it('rejects a depth of zero, which would divide the parallax solve by nothing', () => {
    expect(ParallaxDepth.safeParse(0).success).toBe(false);
    expect(ParallaxDepth.safeParse(-1).success).toBe(false);
    expect(ParallaxDepth.safeParse(101).success).toBe(false);
    expect(ParallaxDepth.safeParse(0.01).success).toBe(true);
  });
});

describe('AssetInstance', () => {
  it('fills an empty transform to identity and puts the instance on the focal plane', () => {
    const parsed = AssetInstance.parse({
      instance: 'mahtab',
      assetId,
      assetVersionId,
      transform: {},
    });
    expect(parsed.depth).toBe(1);
    expect(parsed.transform).toEqual({
      position: { x: 0, y: 0 },
      rotation: 0,
      scale: { x: 1, y: 1 },
      skew: { x: 0, y: 0 },
      anchor: { x: 0.5, y: 0.5 },
      opacity: 1,
    });
    expect(parsed.variantId).toBeUndefined();
    expect(parsed.tint).toBeUndefined();
  });

  it('demands a transform, because identity in scene space is the top-left corner', () => {
    expect(
      issuePaths(AssetInstance.safeParse({ instance: 'mahtab', assetId, assetVersionId })),
    ).toEqual(['transform']);
  });

  it('pins the exact version, because "the current version" is not replayable', () => {
    const { assetVersionId: _dropped, ...unpinned } = instance;
    expect(issuePaths(AssetInstance.safeParse(unpinned))).toEqual(['assetVersionId']);
  });

  it('rejects an asset id that is really a version id', () => {
    expect(issuePaths(AssetInstance.safeParse({ ...instance, assetId: assetVersionId }))).toEqual([
      'assetId',
    ]);
  });

  it('rejects a tint that is not a hex colour and an opacity off the unit scale', () => {
    expect(issuePaths(AssetInstance.safeParse({ ...instance, tint: 'moonlight' }))).toEqual([
      'tint',
    ]);
    expect(issuePaths(AssetInstance.safeParse({ ...instance, opacity: 1.5 }))).toEqual(['opacity']);
  });
});

describe('ShotLayer', () => {
  it('paints from zero upwards', () => {
    expect(ShotLayer.parse({ z: 0, instances: [instance] }).z).toBe(0);
    expect(ShotLayer.parse({ z: 0, instances: [instance] }).name).toBeUndefined();
  });

  it('rejects a negative paint order and a fractional one', () => {
    expect(issuePaths(ShotLayer.safeParse({ z: -1, instances: [instance] }))).toEqual(['z']);
    expect(ShotLayer.safeParse({ z: 1.5, instances: [instance] }).success).toBe(false);
  });

  it('refuses an empty band', () => {
    expect(issuePaths(ShotLayer.safeParse({ z: 0, instances: [] }))).toEqual(['instances']);
  });
});

describe('FocusTarget', () => {
  it('defends the focus by default', () => {
    expect(FocusPriority.options).toEqual([...FOCUS_PRIORITIES]);
    expect(FocusTarget.parse(focusTarget).priority).toBe('must-keep');
  });

  it('accepts a null instance for a subject that is not an asset', () => {
    expect(FocusTarget.parse({ ...focusTarget, instance: null }).instance).toBeNull();
  });

  it('demands an explicit decision about the instance', () => {
    const { instance: _dropped, ...withoutInstance } = focusTarget;
    expect(issuePaths(FocusTarget.safeParse(withoutInstance))).toEqual(['instance']);
  });

  it('rejects a region expressed in pixels instead of fractions', () => {
    const result = FocusTarget.safeParse({
      ...focusTarget,
      region: { x: 340, y: 180, width: 320, height: 560 },
    });
    expect(issuePaths(result)).toEqual(['region.x', 'region.y', 'region.width', 'region.height']);
  });
});

describe('SceneSpace - the reframing contract', () => {
  it('solves every target automatically until told otherwise', () => {
    expect(SceneSpace.parse(sceneSpace).overrides).toEqual({});
  });

  it('takes a manual crop for one aspect and leaves the others solved', () => {
    const parsed = SceneSpace.parse({
      ...sceneSpace,
      overrides: { '9:16': { x: 0.3, y: 0, width: 0.4, height: 1 } },
    });
    expect(Object.keys(parsed.overrides)).toEqual(['9:16']);
    expect(parsed.overrides['1:1']).toBeUndefined();
  });

  it('rejects an override keyed by an aspect nothing ships in', () => {
    const result = SceneSpace.safeParse({
      ...sceneSpace,
      overrides: { '21:9': { x: 0, y: 0, width: 1, height: 1 } },
    });
    expect(result.success).toBe(false);
  });

  it('refuses a canvas that ships in nothing', () => {
    expect(issuePaths(SceneSpace.safeParse({ ...sceneSpace, reframeTargets: [] }))).toEqual([
      'reframeTargets',
    ]);
  });

  it('refuses a zero-sized authoring canvas', () => {
    expect(
      issuePaths(SceneSpace.safeParse({ ...sceneSpace, size: { width: 0, height: 2400 } })),
    ).toEqual(['size.width']);
  });
});

describe('ShotCamera', () => {
  it('enumerates framing and move so the choreographer can map them', () => {
    expect(ShotFraming.options).toEqual([...SHOT_FRAMINGS]);
    expect(CameraMove.options).toEqual([...CAMERA_MOVES]);
    expect(ShotCamera.parse(shot.camera).framing).toBe('medium');
  });

  it('rejects a framing or a move nobody can choreograph', () => {
    expect(issuePaths(ShotCamera.safeParse({ ...shot.camera, framing: 'cowboy' }))).toEqual([
      'framing',
    ]);
    expect(issuePaths(ShotCamera.safeParse({ ...shot.camera, move: 'snorricam' }))).toEqual([
      'move',
    ]);
  });
});

describe('ShotAction', () => {
  const action = { instance: 'mahtab', clip: 'light-the-lamp', startMs: 400, durationMs: 3600 };

  it('plays once at full speed with no blend unless told otherwise', () => {
    expect(LoopMode.options).toEqual(['once', 'loop', 'ping-pong', 'hold-last']);
    const parsed = ShotAction.parse(action);
    expect(parsed.loop).toBe('once');
    expect(parsed.speed).toBe(1);
    expect(parsed.blendMs).toBe(0);
  });

  it('rejects an action that occupies no time', () => {
    expect(issuePaths(ShotAction.safeParse({ ...action, durationMs: 0 }))).toEqual(['durationMs']);
    expect(ShotAction.safeParse({ ...action, durationMs: -1 }).success).toBe(false);
  });

  it('rejects a start before the shot begins', () => {
    expect(issuePaths(ShotAction.safeParse({ ...action, startMs: -1 }))).toEqual(['startMs']);
  });

  it('allows a start of zero, which is the common case', () => {
    expect(ShotAction.parse({ ...action, startMs: 0 }).startMs).toBe(0);
  });

  it('rejects a frozen or absurd playback rate', () => {
    expect(issuePaths(ShotAction.safeParse({ ...action, speed: 0 }))).toEqual(['speed']);
    expect(ShotAction.safeParse({ ...action, speed: 9 }).success).toBe(false);
    expect(ShotAction.safeParse({ ...action, speed: 0.5 }).success).toBe(true);
  });

  it('rejects a clip name that is not a slug and an instance that is not one either', () => {
    expect(issuePaths(ShotAction.safeParse({ ...action, clip: 'Light The Lamp' }))).toEqual([
      'clip',
    ]);
    expect(issuePaths(ShotAction.safeParse({ ...action, instance: 'Mahtab' }))).toEqual([
      'instance',
    ]);
  });
});

describe('ShotAudio', () => {
  it('defaults to silence, which has to be chosen rather than fallen into', () => {
    const parsed = ShotAudio.parse({});
    expect(parsed.sfx).toEqual([]);
    expect(parsed.music).toBeNull();
  });

  it('fills an effect cue in at full gain, one-shot', () => {
    const parsed = SfxCue.parse({ key: 'sfx/sea/heavy-swell', startMs: 0 });
    expect(parsed.gain).toBe(1);
    expect(parsed.loop).toBe(false);
  });

  it('rejects an effect that is not addressable in the library', () => {
    expect(issuePaths(SfxCue.safeParse({ key: 'doorcreak', startMs: 0 }))).toEqual(['key']);
  });

  it('takes a music transition rather than a track', () => {
    const parsed = MusicCue.parse({
      key: 'music/tide-theme/low',
      action: 'continue',
      mood: 'unresolved',
      intensity: 0.35,
    });
    expect(parsed.action).toBe('continue');
  });

  it('rejects a music action the mixer has no handler for', () => {
    const result = MusicCue.safeParse({
      key: 'music/tide-theme/low',
      action: 'crescendo',
      mood: 'unresolved',
      intensity: 0.35,
    });
    expect(issuePaths(result)).toEqual(['action']);
  });
});

describe('Shot', () => {
  it('parses a complete shot and fills the optional halves', () => {
    const parsed = Shot.parse(shot);
    expect(parsed.index).toBe(0);
    expect(parsed.blocking).toEqual([]);
    expect(parsed.dialogue).toEqual([]);
    expect(parsed.layout).toHaveLength(1);
  });

  it('rejects a negative index but allows the first shot at zero', () => {
    expect(issuePaths(Shot.safeParse({ ...shot, index: -1 }))).toEqual(['index']);
    expect(Shot.safeParse({ ...shot, index: 0 }).success).toBe(true);
  });

  it('rejects a zero-length shot, which is a deleted shot', () => {
    expect(issuePaths(Shot.safeParse({ ...shot, durationMs: 0 }))).toEqual(['durationMs']);
    expect(Shot.safeParse({ ...shot, durationMs: -100 }).success).toBe(false);
  });

  it('refuses a shot staged on nothing', () => {
    expect(issuePaths(Shot.safeParse({ ...shot, layout: [] }))).toEqual(['layout']);
  });

  it('ties the shot to exactly one beat, by beat id', () => {
    expect(issuePaths(Shot.safeParse({ ...shot, beatRef: fixtureId('scn', 1) }))).toEqual([
      'beatRef',
    ]);
  });

  it('names the exact instance and field when a placement deep in the layout is wrong', () => {
    const result = Shot.safeParse({
      ...shot,
      layout: [{ z: 0, instances: [{ ...instance, depth: 0 }] }],
    });
    expect(issuePaths(result)).toEqual(['layout.0.instances.0.depth']);
  });

  it('names the offending line and delivery field inside the dialogue', () => {
    const result = Shot.safeParse({
      ...shot,
      dialogue: [
        {
          speakerRef: fixtureId('ent', 1),
          text: 'I am not talking to you.',
          subtext: 'She is.',
          delivery: { emotion: 'braced', intensity: 2, pace: 'measured', volume: 'low' },
        },
      ],
    });
    expect(issuePaths(result)).toEqual(['dialogue.0.delivery.intensity']);
  });

  it('carries everything a reframer needs, without loading the bible', () => {
    // This is the whole format-agnostic claim, asserted as data rather than as prose:
    // canvas + target aspects + protected region + subject anchor is a complete crop
    // problem, and a shot that parses always has all four.
    const parsed = Shot.parse(shot);
    expect(parsed.sceneSpace.size).toEqual({ width: 2400, height: 2400 });
    expect(parsed.sceneSpace.reframeTargets).toEqual(['16:9', '9:16', '1:1']);
    expect(parsed.safeArea).toEqual({ x: 0.14, y: 0.1, width: 0.72, height: 0.8 });
    expect(parsed.focusTarget.priority).toBe('must-keep');
    expect(parsed.focusTarget.instance).toBe('mahtab');
    // The anchor names a placement that actually exists in this shot.
    const placed = parsed.layout.flatMap((layer) => layer.instances.map((each) => each.instance));
    expect(placed).toContain(parsed.focusTarget.instance);
  });

  it('rejects an unknown key rather than absorbing a hallucinated field', () => {
    const result = Shot.safeParse({ ...shot, transition: 'cut' });
    expect(result.success).toBe(false);
    expect(issuePaths(result)).toEqual(['']);
  });
});

describe('JSON Schema for the sequence model', () => {
  it('emits a closed object for every schema the model fills', () => {
    for (const schema of [
      AssetInstance,
      ShotLayer,
      FocusTarget,
      SceneSpace,
      ShotCamera,
      ShotAction,
      SfxCue,
      MusicCue,
      ShotAudio,
      Shot,
    ]) {
      const json = z.toJSONSchema(schema) as { additionalProperties?: unknown };
      expect(json.additionalProperties).toBe(false);
    }
  });

  it('describes every field of a shot except the ids the pipeline mints', () => {
    const json = z.toJSONSchema(Shot) as {
      properties?: Record<string, { description?: string }>;
    };
    const properties = json.properties ?? {};
    expect(Object.keys(properties).length).toBeGreaterThan(0);
    for (const [key, property] of Object.entries(properties)) {
      if (key === 'id') continue;
      expect(property.description ?? '', `${key} has no instruction`).not.toBe('');
    }
  });

  it('offers the target aspects as a closed enum so a model cannot invent one', () => {
    const json = z.toJSONSchema(SceneSpace) as {
      properties?: { masterAspect?: { enum?: string[] } };
    };
    expect(json.properties?.masterAspect?.enum).toEqual(['16:9', '9:16', '1:1', '4:5']);
  });
});

// ── the authoring/render seam ───────────────────────────────────────────────
//
// `AssetRef` is floating and `AssetInstance` is pinned, and the two were written by
// different hands with opposite justifications. These tests pin the resolution: both
// forms are representable, compilation is the step between them, and nothing that
// renders will accept the floating one.

describe('floating authoring references and pinned render placements', () => {
  const otherVersionId = fixtureId('asv', 9);
  const variantId = fixtureId('vnt', 1);
  const styleChecksum = 'c'.repeat(64);
  const compiledAt = '2026-08-23T09:00:00.000Z';

  it('lets an author write a reference with no version, meaning "whatever is current"', () => {
    const floating = AssetRef.parse({ assetId });
    expect(floating.versionId).toBeUndefined();
  });

  it('lets a shot place the same asset at one exact version', () => {
    expect(AssetInstance.parse(instance).assetVersionId).toBe(assetVersionId);
  });

  it('refuses to treat a floating reference as a pinned one', () => {
    expect(issuePaths(PinnedAssetRef.safeParse({ assetId }))).toEqual(['versionId']);
    expect(PinnedAssetRef.safeParse({ assetId, versionId: assetVersionId }).success).toBe(true);
  });

  it('records what the author wrote beside what compilation resolved it to', () => {
    const pin = ShotAssetPin.parse({
      instance: 'mahtab',
      authored: { assetId },
      pinned: { assetId, versionId: assetVersionId },
    });
    expect(pin.authored.versionId).toBeUndefined();
    expect(pin.pinned.versionId).toBe(assetVersionId);
  });

  it('refuses a pin that re-points the reference at a different asset', () => {
    expect(
      issuePaths(
        ShotAssetPin.safeParse({
          instance: 'mahtab',
          authored: { assetId },
          pinned: { assetId: fixtureId('ast', 7), versionId: assetVersionId },
        }),
      ),
    ).toEqual(['pinned']);
  });

  it('refuses a pin that overrides a version the author deliberately froze', () => {
    expect(
      issuePaths(
        ShotAssetPin.safeParse({
          instance: 'mahtab',
          authored: { assetId, versionId: assetVersionId },
          pinned: { assetId, versionId: otherVersionId },
        }),
      ),
    ).toEqual(['pinned']);
  });

  it('honours a version the author already froze', () => {
    expect(
      ShotAssetPin.safeParse({
        instance: 'mahtab',
        authored: { assetId, versionId: assetVersionId },
        pinned: { assetId, versionId: assetVersionId },
      }).success,
    ).toBe(true);
  });

  it('refuses a pin that quietly changes the variant', () => {
    expect(
      issuePaths(
        ShotAssetPin.safeParse({
          instance: 'mahtab',
          authored: { assetId, variantKey: 'winter' },
          pinned: { assetId, versionId: assetVersionId, variantKey: 'summer' },
        }),
      ),
    ).toEqual(['pinned']);
  });

  it('carries the variant through unchanged when compilation only resolves the version', () => {
    const pin = ShotAssetPin.parse({
      instance: 'mahtab',
      authored: { assetId, variantKey: 'winter' },
      pinned: { assetId, versionId: assetVersionId, variantKey: 'winter' },
    });
    expect(pin.pinned.variantKey).toBe('winter');
  });

  it('binds a compilation to the style its versions were resolved against', () => {
    const compilation = ShotCompilation.parse({
      shotId: fixtureId('sht', 1),
      styleChecksum,
      compiledAt,
      pins: [
        {
          instance: 'mahtab',
          authored: { assetId },
          pinned: { assetId, versionId: assetVersionId },
        },
      ],
    });
    expect(compilation.styleChecksum).toBe(styleChecksum);
    expect(compilation.pins).toHaveLength(1);
  });

  it('refuses a compilation that pins the same instance twice', () => {
    const pin = {
      instance: 'mahtab',
      authored: { assetId },
      pinned: { assetId, versionId: assetVersionId },
    };
    expect(
      issuePaths(
        ShotCompilation.safeParse({
          shotId: fixtureId('sht', 1),
          styleChecksum,
          compiledAt,
          pins: [pin, { ...pin, pinned: { assetId, versionId: otherVersionId } }],
        }),
      ),
    ).toEqual(['pins.1.instance']);
  });

  it('refuses a compilation that pinned nothing', () => {
    expect(
      issuePaths(
        ShotCompilation.safeParse({
          shotId: fixtureId('sht', 1),
          styleChecksum,
          compiledAt,
          pins: [],
        }),
      ),
    ).toEqual(['pins']);
  });

  it('refuses a compilation with no style to resolve against', () => {
    expect(
      issuePaths(
        ShotCompilation.safeParse({
          shotId: fixtureId('sht', 1),
          styleChecksum: 'not-a-checksum',
          compiledAt,
          pins: [
            {
              instance: 'mahtab',
              authored: { assetId },
              pinned: { assetId, versionId: assetVersionId },
            },
          ],
        }),
      ),
    ).toEqual(['styleChecksum']);
  });

  it('keeps the pinned form addressing the variant the way a render needs it', () => {
    expect(AssetInstance.parse({ ...instance, variantId }).variantId).toBe(variantId);
  });
});

// ── the shot's own internal references ──────────────────────────────────────

describe('shot-local handles resolve', () => {
  const second = { ...instance, instance: 'lantern' };

  it('accepts a shot whose blocking and focus both name placed instances', () => {
    expect(
      Shot.safeParse({
        ...shot,
        layout: [{ z: 0, instances: [instance, second] }],
        blocking: [{ instance: 'lantern', clip: 'flicker', startMs: 0, durationMs: 1000 }],
      }).success,
    ).toBe(true);
  });

  it('rejects an action played on an instance that is not in the layout', () => {
    expect(
      issuePaths(
        Shot.safeParse({
          ...shot,
          blocking: [{ instance: 'ghost', clip: 'walk', startMs: 0, durationMs: 500 }],
        }),
      ),
    ).toEqual(['blocking.0.instance']);
  });

  it('rejects a reframe anchored on an instance that is not in the layout', () => {
    expect(
      issuePaths(Shot.safeParse({ ...shot, focusTarget: { ...focusTarget, instance: 'ghost' } })),
    ).toEqual(['focusTarget.instance']);
  });

  it('rejects a camera pointed at an instance that is not in the layout', () => {
    expect(
      issuePaths(
        Shot.safeParse({
          ...shot,
          camera: { ...shot.camera, focusTarget: { ...focusTarget, instance: 'ghost' } },
        }),
      ),
    ).toEqual(['camera.focusTarget.instance']);
  });

  it('accepts a null focus instance, which resolves against nothing by design', () => {
    const nowhere = { ...focusTarget, instance: null };
    expect(
      Shot.safeParse({
        ...shot,
        focusTarget: nowhere,
        camera: { ...shot.camera, focusTarget: nowhere },
      }).success,
    ).toBe(true);
  });

  it('rejects the same handle used for two placements, across bands as well as within one', () => {
    expect(
      issuePaths(Shot.safeParse({ ...shot, layout: [{ z: 0, instances: [instance, instance] }] })),
    ).toEqual(['layout.0.instances.1.instance']);
    expect(
      issuePaths(
        Shot.safeParse({
          ...shot,
          layout: [
            { z: 0, instances: [instance] },
            { z: 1, instances: [instance] },
          ],
        }),
      ),
    ).toEqual(['layout.1.instances.0.instance']);
  });

  it('rejects two bands claiming the same paint order', () => {
    expect(
      issuePaths(
        Shot.safeParse({
          ...shot,
          layout: [
            { z: 0, instances: [instance] },
            { z: 0, instances: [second] },
          ],
        }),
      ),
    ).toEqual(['layout.1.z']);
  });

  it('reports the empty layout once, not once per handle it orphans', () => {
    expect(issuePaths(Shot.safeParse({ ...shot, layout: [] }))).toEqual(['layout']);
  });
});

describe('the crops a shot owes are internally consistent', () => {
  it('rejects a master aspect the shot does not undertake to ship', () => {
    expect(
      issuePaths(
        SceneSpace.safeParse({ ...sceneSpace, masterAspect: '4:5', reframeTargets: ['16:9'] }),
      ),
    ).toEqual(['reframeTargets']);
  });

  it('rejects a repeated target, which would solve the same crop twice', () => {
    expect(
      issuePaths(SceneSpace.safeParse({ ...sceneSpace, reframeTargets: ['16:9', '16:9'] })),
    ).toEqual(['reframeTargets']);
  });

  it('rejects a manual crop for an aspect this shot does not ship', () => {
    expect(
      issuePaths(
        SceneSpace.safeParse({
          ...sceneSpace,
          reframeTargets: ['16:9'],
          overrides: { '4:5': { x: 0, y: 0, width: 1, height: 1 } },
        }),
      ),
    ).toEqual(['overrides.4:5']);
  });

  it('accepts a manual crop for an aspect it does ship', () => {
    expect(
      SceneSpace.safeParse({
        ...sceneSpace,
        overrides: { '9:16': { x: 0.3, y: 0, width: 0.4, height: 1 } },
      }).success,
    ).toBe(true);
  });

  it('reports an empty target list once, not also as a missing master', () => {
    expect(issuePaths(SceneSpace.safeParse({ ...sceneSpace, reframeTargets: [] }))).toEqual([
      'reframeTargets',
    ]);
  });
});
