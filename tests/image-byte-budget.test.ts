/**
 * DECODED IMAGE BYTES are a second budget, and the count cap does not stand in
 * for them.
 *
 * The provider's documented limit is 100 images, and pxpipe enforced only that.
 * A long session can assemble a request that is legal by count and fails by
 * weight: production traffic degrades sharply somewhere around 20 MiB, and it
 * degrades as 500s, 502s, empty 200s and stalls, which read as flakiness rather
 * than as "too big" (#157). `/compact` traverses the same oversized path, so the
 * session cannot recover by compacting either.
 *
 * Two properties matter more than the exact ceiling:
 *
 *  - admission is atomic per semantic group. A group is imaged whole or kept as
 *    text whole, because half a group ships pages without the text they replaced;
 *  - the caller's own images are counted first and never removed. A user's
 *    screenshot outranks our compression.
 *
 * Run just this file:  pnpm vitest run tests/image-byte-budget.test.ts
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  countNativeImageBytes,
  imageByteHeadroom,
  transformRequest,
} from '../src/core/transform.js';
import { resetSessionState } from '../src/core/session-state.js';
import type { Message } from '../src/core/types.js';

const big = (n: number) => 'x'.repeat(n);
const enc = (obj: unknown) => new TextEncoder().encode(JSON.stringify(obj));
const dec = (b: Uint8Array): any => JSON.parse(new TextDecoder().decode(b));

/** A caller image whose decoded payload is about `bytes` long. */
function callerImage(bytes: number) {
  const b64Chars = Math.ceil(bytes / 3) * 4;
  return {
    type: 'image' as const,
    source: {
      type: 'base64' as const,
      media_type: 'image/png' as const,
      data: 'A'.repeat(b64Chars),
    },
  };
}

function toolResult(id: string, chars = 40_000): Message {
  return {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: id, content: `RESULT ${id}\n` + big(chars) }],
  } as unknown as Message;
}

function withSlab(messages: Message[], slabChars = 60_000) {
  return enc({
    model: 'claude-3-5-sonnet',
    system: [{ type: 'text', text: 'SLAB\n' + big(slabChars) }],
    messages,
  });
}

/** Total decoded image bytes actually on the wire, at both nesting levels. */
function wireImageBytes(msgs: any[]): number {
  let total = 0;
  const add = (b: any): void => {
    if (b?.type === 'image' && typeof b.source?.data === 'string') {
      const d = b.source.data as string;
      const pad = d.endsWith('==') ? 2 : d.endsWith('=') ? 1 : 0;
      total += Math.floor((d.length * 3) / 4) - pad;
    }
  };
  for (const m of msgs) {
    if (!Array.isArray(m.content)) continue;
    for (const b of m.content) {
      add(b);
      if (b?.type === 'tool_result' && Array.isArray(b.content)) for (const ib of b.content) add(ib);
    }
  }
  return total;
}

/**
 * Wire bytes a fixture renders to under the default ceiling. Budgets below are
 * derived from this instead of hard-coded, because PNG size is a property of
 * the runtime's zlib build, not of pxpipe: Homebrew Node links macOS zlib 1.2.12
 * while official Node bundles 1.3.x, and the same slab comes out ~25% apart.
 */
async function renderedBytes(body: Uint8Array): Promise<number> {
  resetSessionState();
  const { body: out } = await transformRequest(body);
  resetSessionState();
  return wireImageBytes(dec(out).messages);
}

/** A budget that admits the slab and leaves the first tool group without room. */
async function slabOnlyBudget(): Promise<number> {
  const slab = await renderedBytes(withSlab([{ role: 'user', content: 'go' }]));
  const both = await renderedBytes(withSlab([{ role: 'user', content: 'go' }, toolResult('t1')]));
  expect(both).toBeGreaterThan(slab); // the fixture must leave a gap to aim into
  return Math.floor((slab + both) / 2);
}

describe('counting what the caller already spent', () => {
  it('sees caller images at both nesting levels', () => {
    const msgs = [
      { role: 'user', content: [callerImage(3_000)] },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 't1', content: [callerImage(6_000)] }],
      },
    ] as unknown as Message[];
    const counted = countNativeImageBytes(msgs);
    expect(counted).toBeGreaterThan(8_800);
    expect(counted).toBeLessThan(9_200);
  });

  it('is safe on absent, empty and string content', () => {
    expect(countNativeImageBytes(undefined)).toBe(0);
    expect(countNativeImageBytes([])).toBe(0);
    expect(countNativeImageBytes([{ role: 'user', content: 'plain' }])).toBe(0);
  });

  it('deducts caller bytes from the headroom, and never reports a deficit', () => {
    const info = { imageBytes: 100, nativeImageBytes: 400 } as any;
    expect(imageByteHeadroom(info, 1_000)).toBe(500);
    expect(imageByteHeadroom(info, 100)).toBe(0);
  });
});

describe('a group that does not fit keeps its text', () => {
  beforeEach(() => resetSessionState());

  it('skips the slab whole rather than imaging part of it', async () => {
    const { body: out, info } = await transformRequest(
      withSlab([{ role: 'user', content: 'go' }]),
      { maxImageBytes: 1_000 },
    );
    // Nothing imaged at all: the slab is part of the cache prefix, so a partial
    // slab would re-key that prefix whenever the budget arithmetic moved.
    expect(info.imageCount).toBe(0);
    expect(info.reason).toMatch(/^image_bytes/);
    expect(JSON.stringify(dec(out))).toContain('SLAB');
  });

  it('keeps a tool_result as text when its pages do not fit', async () => {
    // A budget between the slab and slab+tool admits the slab and leaves the
    // tool group without room, which is the case worth pinning: partial
    // admission is what must not happen.
    const maxImageBytes = await slabOnlyBudget();
    const { body: out, info } = await transformRequest(
      withSlab([{ role: 'user', content: 'go' }, toolResult('t1')]),
      { maxImageBytes },
    );
    expect(info.imageCount ?? 0).toBeGreaterThan(0); // the slab was admitted
    expect(info.toolResultImgs ?? 0).toBe(0); // the tool group was not
    expect(info.imageByteSkips ?? 0).toBeGreaterThan(0);
    // Degrading must never drop content.
    expect(JSON.stringify(dec(out).messages)).toContain('RESULT t1');
  });

  it('stays within the budget it was given', async () => {
    const limit = await slabOnlyBudget();
    const { body: out } = await transformRequest(
      withSlab([{ role: 'user', content: 'go' }, toolResult('t1'), toolResult('t2')]),
      { maxImageBytes: limit },
    );
    expect(wireImageBytes(dec(out).messages)).toBeLessThanOrEqual(limit);
  });
});

describe('the caller outranks us', () => {
  beforeEach(() => resetSessionState());

  it('never removes a caller image to make room', async () => {
    const before = callerImage(30_000);
    const { body: out, info } = await transformRequest(
      withSlab([
        { role: 'user', content: [before] } as unknown as Message,
        { role: 'user', content: 'go' },
      ]),
      { maxImageBytes: 32_000 },
    );
    expect(info.nativeImageBytes ?? 0).toBeGreaterThan(29_000);
    // The caller's image is still on the wire, and we added nothing on top.
    const wire = dec(out).messages;
    expect(wireImageBytes(wire)).toBeGreaterThan(29_000);
    expect(info.imageCount).toBe(0);
  });
});

describe('telemetry distinguishes the two ceilings', () => {
  beforeEach(() => resetSessionState());

  it('reports a byte skip, not a count skip, when weight is what ran out', async () => {
    const { info } = await transformRequest(
      withSlab([{ role: 'user', content: 'go' }, toolResult('t1')]),
      { maxImageBytes: await slabOnlyBudget() },
    );
    expect(info.imageCount ?? 0).toBeGreaterThan(0); // weight ran out mid-request, not at zero
    // Five images is far under the 100-image cap, so nothing here is a count
    // problem. The two ceilings need different fixes and must not be conflated.
    expect(info.imageByteSkips ?? 0).toBeGreaterThan(0);
    expect(info.imageBudgetSkips ?? 0).toBe(0);
  });

  it('warns before the next turn walks into the wall', async () => {
    const slab = await renderedBytes(withSlab([{ role: 'user', content: 'go' }]));
    const { info } = await transformRequest(withSlab([{ role: 'user', content: 'go' }]), {
      // Admits the slab at 95% full: nothing is dropped this turn, and the
      // next one will be.
      maxImageBytes: Math.ceil(slab / 0.95),
    });
    expect(info.imageCount ?? 0).toBeGreaterThan(0);
    expect(info.imageBytesNearLimit).toBe(true);
  });
});
