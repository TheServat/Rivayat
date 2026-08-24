/**
 * The bytes behind a content hash.
 *
 * Every image the pipeline makes is stored content-addressed: a generated take, a matted
 * canvas, each split part, a baked atlas page. The registry rows reference them by
 * `Sha256Hex` and nothing served those bytes, so the asset library showed hashes where
 * pictures belong, the character state grid could not show a face, and the rig editor
 * could not be built at all because a bone overlay would have sat on an empty canvas.
 * One route unblocks all three.
 *
 * ## Why this is safe enough for a local studio, and where it stops being safe
 *
 * A sha256 is not guessable, so a caller cannot ask for a blob it has not already been
 * told about. That is the whole of the protection and it is the right amount of ceremony
 * for a single-operator studio on loopback. It is **not** authorisation, and this route
 * must not outlive the day the studio grows accounts.
 *
 * The path parameter is checked against 64 lowercase hex characters *before* it reaches
 * the store, because the store maps a hash onto a file path - so an unchecked `..` would
 * be a directory traversal straight out of the workspace.
 *
 * ## Immutability is the whole caching story
 *
 * Content-addressed bytes cannot change under their own name, so this answers `immutable`
 * with a year. A studio scrubbing a timeline asks for the same part hundreds of times and
 * should pay for it once.
 */

import { Controller, Get, Header, Inject, Param, Res, StreamableFile } from '@nestjs/common';
import type { BlobStore } from '@rv/asset-registry';
import { Sha256Hex } from '@rv/contracts';
import { NotFoundError, ValidationError, isErr } from '@rv/shared-kernel';
import type { Response } from 'express';

import { BLOB_STORE } from '../../tokens';

function startsWith(bytes: Uint8Array, ...signature: number[]): boolean {
  if (bytes.length < signature.length) return false;
  return signature.every((byte, index) => bytes[index] === byte);
}

/**
 * The media type, read from the bytes.
 *
 * `BlobStore` addresses content and deliberately records nothing about it, so there is no
 * stored type to serve and a caller-declared one would be a second source of truth that
 * can disagree with the file. The way that disagreement shows up is a browser refusing to
 * paint a part that is on disk and perfectly correct.
 *
 * Exported because the interesting behaviour is the sniffing, not the plumbing around it.
 */
export function sniffMediaType(bytes: Uint8Array): string {
  if (startsWith(bytes, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png';
  if (startsWith(bytes, 0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (startsWith(bytes, 0x47, 0x49, 0x46, 0x38)) return 'image/gif';

  // `RIFF` alone is a WAV as often as a WebP - the format name lives four bytes later, past
  // the length field. Answering `image/webp` on the container alone would make a browser
  // try to paint an audio file and fail in a way nobody can trace back to here.
  if (
    startsWith(bytes, 0x52, 0x49, 0x46, 0x46) &&
    bytes.length >= 12 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return 'image/webp';
  }

  // Atlas maps and the produce chain's step records have no magic number, so they are
  // recognised by shape. Only the two characters that can legally open JSON, and only
  // after leading whitespace - which is narrow enough that a binary file cannot fall in.
  const first = bytes.find(
    (byte) => byte !== 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d,
  );
  if (first === 0x7b || first === 0x5b) return 'application/json';

  // What "we do not know" means over HTTP. A plausible guess is worse than none, because
  // a client that trusts it renders the wrong thing rather than reporting a problem.
  return 'application/octet-stream';
}

@Controller('blobs')
export class BlobsController {
  readonly #blobs: BlobStore;

  constructor(@Inject(BLOB_STORE) blobs: BlobStore) {
    this.#blobs = blobs;
  }

  @Get(':hash')
  @Header('Cache-Control', 'public, max-age=31536000, immutable')
  async read(
    @Param('hash') hash: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    // `Sha256Hex` from the contracts rather than a regex written here. What counts as a
    // content address is decided in one place, and this route cannot drift from the
    // schema the rest of the system stores and validates against.
    if (!Sha256Hex.safeParse(hash).success) {
      throw new ValidationError({
        message: 'a blob is addressed by 64 lowercase hex characters',
        context: { hash },
      });
    }

    const bytes = await this.#blobs.get(hash);
    if (isErr(bytes)) {
      // The store cannot tell "absent" from "unreadable" through its own Result, and to a
      // caller both mean the same thing: this hash yields nothing.
      throw new NotFoundError('blob', hash);
    }

    res.setHeader('Content-Type', sniffMediaType(bytes.value));
    res.setHeader('Content-Length', String(bytes.value.byteLength));
    return new StreamableFile(bytes.value);
  }
}
