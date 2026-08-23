/**
 * Column types shared by every table.
 *
 * Two of them encode decisions worth stating once here rather than arguing about at
 * each call site.
 *
 * **`jsonDoc` stores canonical JSON, not `JSON.stringify` output.** The domain has a
 * lot of sub-documents that are only ever read whole - a `Rig`, a `Provenance`, a
 * `StyleBible`'s visual block - and shredding them into columns would buy nothing but
 * joins. Storing them with `stableStringify` means two logically identical documents
 * are byte-identical rows, so `hash(row) == hash(row)` holds, a diff between two
 * versions is a text diff, and a row can be fed straight to `contentHash` without a
 * re-canonicalisation pass. Plain `JSON.stringify` would make all three false as soon
 * as two writers built the same object in a different key order.
 *
 * **Embeddings are float64 blobs.** ADR-0006 accepts that there is no vector index and
 * similarity is computed in process. Float64 rather than float32 because the round
 * trip must be exact: RV-103 requires that the same query against the same index
 * revision ranks identically, and a lossy store makes that a property of the rounding.
 */

import { stableStringify } from '@rv/shared-kernel';
import { customType } from 'drizzle-orm/sqlite-core';

/** A whole sub-document, stored as canonical JSON text. */
export function jsonDoc<TData>(): ReturnType<
  typeof customType<{ data: TData; driverData: string }>
> {
  return customType<{ data: TData; driverData: string }>({
    dataType() {
      return 'text';
    },
    toDriver(value: TData): string {
      return stableStringify(value);
    },
    fromDriver(value: string): TData {
      return JSON.parse(value) as TData;
    },
  });
}

/** A semantic vector, stored as a little-endian float64 blob. */
export function embeddingVector(): ReturnType<
  typeof customType<{ data: number[]; driverData: Buffer }>
> {
  return customType<{ data: number[]; driverData: Buffer }>({
    dataType() {
      return 'blob';
    },
    toDriver(value: number[]): Buffer {
      return Buffer.from(Float64Array.from(value).buffer);
    },
    fromDriver(value: Buffer): number[] {
      const view = new Float64Array(
        value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength),
      );
      return Array.from(view);
    },
  });
}
