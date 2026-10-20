/**
 * Wire conformance: the golden corpus under `conformance/wire/` and the invariants of §3.
 *
 * The fixtures are read **in place** (TW-PKG-002). There is no copy step and there must never be
 * one: `pytest` reads these same files from the same paths, and a fixture that has to be copied is a
 * fixture that can drift between the two languages, which is the whole thing that directory exists
 * to prevent. Each file is one document: `{"kind": ..., "document": ...}`, where `kind` names the
 * shape that parses it.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { REPO_ROOT } from '../test-helpers/sources';

import {
  ACTIVE_STATES,
  type Aggregate,
  exceptionName,
  DIALOG_STATES,
  ENVELOPE_KINDS,
  INPUT_TYPES,
  OPAQUE_KEYS,
  PROGRESS_STATES,
  PUSHED_KINDS,
  TERMINAL_STATES,
  WIRE_VERSION,
  type WireObject,
  nowIso,
  parseAggregate,
  parseDialogAnswer,
  parseDialogReply,
  parseDialogRequest,
  parseEnvelope,
  parseInputField,
  parseOperationSummary,
  parseProgress,
  parseRegister,
  parseResult,
  parseSnapshot,
  parseTaskwireError,
  parseText,
  serializeAggregate,
  serializeDialogReply,
  serializeDialogRequest,
  serializeEnvelope,
  serializeInputField,
  serializeOperationSummary,
  serializeProgress,
  serializeRegister,
  serializeResult,
  serializeSnapshot,
  serializeTaskwireError,
  serializeText,
  toCamel,
  toIso,
  toSnake,
} from './wire';

const WIRE_DIR = join(REPO_ROOT, 'conformance', 'wire');
/** Read in place, never copied (TW-PKG-002). `pytest` reads the same files from the same path. */

const MAX_SAFE_INTEGER = 9007199254740991;
/** TW-REV-004: `rev` must stay inside this so JavaScript can compare it. */

const WALL_CLOCK_MS_FLOOR = 1_000_000_000_000;
/** TW-REV-002: a `rev` seeded from wall-clock milliseconds is thirteen digits, never 0 or 1. */

const RFC3339_Z = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/;
/** TW-CORE-010: RFC 3339 UTC with a `Z` suffix, and no other timestamp format anywhere. */

const TIMESTAMP_KEYS = new Set(['created_at', 'updated_at', 'server_time', 'expires_at']);

type Parse = (raw: unknown) => unknown;
/** `never` as the parameter is what lets one map hold nine differently-typed serializers. */
type Serialize = (value: never) => unknown;

const PARSERS: Record<string, Parse> = {
  text: parseText,
  error: parseTaskwireError,
  result: parseResult,
  progress: parseProgress,
  snapshot: parseSnapshot,
  register: parseRegister,
  aggregate: parseAggregate,
  envelope: parseEnvelope,
  dialog_request: parseDialogRequest,
};

const SERIALIZERS: Record<string, Serialize> = {
  text: serializeText,
  error: serializeTaskwireError,
  result: serializeResult,
  progress: serializeProgress,
  snapshot: serializeSnapshot,
  register: serializeRegister,
  aggregate: serializeAggregate,
  envelope: serializeEnvelope,
  dialog_request: serializeDialogRequest,
};

/** TW-CORE-011 / TW-CORE-012: no document a client can receive is unversioned. */
const VERSIONED_KINDS = new Set(['snapshot', 'register', 'envelope']);

interface Fixture {
  name: string;
  kind: string;
  document: unknown;
}

function loadFixtures(): Fixture[] {
  return readdirSync(WIRE_DIR)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => {
      const raw = JSON.parse(readFileSync(join(WIRE_DIR, name), 'utf-8')) as { kind: string; document: unknown };
      return { name, kind: raw.kind, document: raw.document };
    });
}

const FIXTURES = loadFixtures();

const isPlainObject = (value: unknown): value is WireObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The same document with every explicitly-null key removed, at every depth.
 *
 * TW-CORE-010 says absent and `null` are interchangeable, so this transformation MUST NOT be
 * observable to a parser - and it is also what makes "round-trips to the original document" a
 * statement that can be true at all. A required-but-nullable field (`percent`, `result_kind`,
 * `origin_connection`, `aggregate`) is written by the serializer whether or not the fixture spelled
 * it out, so the two documents are compared with the nulls taken off both sides. Everything else -
 * an added key, a dropped key, a changed value, a `false` that became a `null` - still fails.
 */
function stripNulls(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(stripNulls);
  if (!isPlainObject(node)) return node;
  return Object.fromEntries(
    Object.entries(node)
      .filter(([, value]) => value !== null && value !== undefined)
      .map(([key, value]) => [key, stripNulls(value)]),
  );
}

/** One fixture's document, by file name. Throws rather than returning undefined: a test that
 *  silently ran against nothing is worse than a red one. */
function document(name: string): WireObject {
  const fixture = FIXTURES.find((candidate) => candidate.name === name);
  if (fixture === undefined) throw new Error(`missing fixture ${name}`);
  return fixture.document as WireObject;
}

/** The first (and only) register row of `register-v2-with-aggregate.json`, raw. */
function registerRow(): WireObject {
  return (document('register-v2-with-aggregate.json').operations as WireObject[])[0];
}

/** Every `(key, value)` pair anywhere inside a wire document. */
function walk(node: unknown): [string, unknown][] {
  if (Array.isArray(node)) return node.flatMap(walk);
  if (!isPlainObject(node)) return [];
  return Object.entries(node).flatMap(([key, value]) => [[key, value] as [string, unknown], ...walk(value)]);
}

describe('the golden corpus', () => {
  afterEach(() => {
    // The strip-nulls invariant freezes the clock; no test may leak a frozen one into the next.
    vi.useRealTimers();
  });

  it('is non-empty and every fixture names a shape', () => {
    // Without this the whole file is vacuous under deletion: `it.each` over an emptied corpus
    // reports nothing at all rather than failing.
    expect(FIXTURES.length).toBeGreaterThanOrEqual(28);
    FIXTURES.forEach((fixture) => {
      expect(Object.keys(PARSERS), `${fixture.name}: unknown fixture kind ${fixture.kind}`).toContain(fixture.kind);
      expect(isPlainObject(fixture.document) || Array.isArray(fixture.document)).toBe(true);
    });
  });

  it('exercises every shape that has a parser', () => {
    // A parser with no fixture is a parser nothing below tests.
    const kindsSeen = new Set(FIXTURES.map((fixture) => fixture.kind));
    expect([...Object.keys(PARSERS)].sort()).toEqual([...kindsSeen].sort());
  });

  it.each(FIXTURES.map((fixture) => [fixture.name, fixture] as const))(
    '%s round-trips: parse -> serialize is the document it came from',
    (_name, fixture) => {
      // TW-CORE-010, TW-CORE-012, TW-TS-000: the camelCase API is a lossless view of the snake_case
      // wire, in both directions. Serializing what was parsed reproduces the fixture.
      const parse = PARSERS[fixture.kind];
      const serialize = SERIALIZERS[fixture.kind];

      const model = parse(fixture.document);
      const serialized = serialize(model as never);

      expect(stripNulls(serialized)).toEqual(stripNulls(fixture.document));

      // ...and the second lap changes nothing: a parser that lost a field on the way out and a
      // serializer that invented one on the way in would both survive the assertion above alone.
      expect(parse(serialized)).toEqual(model);
      expect(serialize(parse(serialized) as never)).toEqual(serialized);
    },
  );

  it.each(FIXTURES.map((fixture) => [fixture.name, fixture] as const))(
    '%s parses identically with every explicit null deleted',
    (_name, fixture) => {
      // TW-CORE-010, and the reason this is a corpus-wide invariant rather than one unit test: the
      // trap is per-field. `raw.percent ?? null` is right; `'percent' in raw ? ... : null` and
      // Python's `raw.get("percent", None)` fire only on a *missing* key, so an explicit null slips
      // past the default into a field whose type does not admit it. Deleting the nulls from a
      // document must not be observable.
      //
      // The clock is frozen because a timestamp that were null in a fixture would otherwise default
      // to two different `nowIso()` values on the two parses and fail for the wrong reason.
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-08-11T09:15:04.317Z'));

      const parse = PARSERS[fixture.kind];
      expect(parse(stripNulls(fixture.document))).toEqual(parse(fixture.document));
    },
  );

  it('carries the wire version on every document a client can receive', () => {
    // TW-CORE-011 / TW-CORE-012: `v` is required on a snapshot, a register and an envelope, and it
    // is the integer 1 until a breaking wire change bumps it.
    const versioned = FIXTURES.filter((fixture) => VERSIONED_KINDS.has(fixture.kind));
    expect(versioned.length).toBeGreaterThan(0);
    versioned.forEach((fixture) => {
      expect((fixture.document as WireObject).v, `${fixture.name}: must carry the wire version`).toBe(WIRE_VERSION);
    });
    expect(WIRE_VERSION).toBe(2);
  });

  it('keeps every rev inside a JavaScript-comparable range', () => {
    // TW-REV-002 / TW-REV-004: seeded from wall-clock milliseconds, and comparable in JavaScript.
    const revs = FIXTURES.flatMap((fixture) => walk(fixture.document))
      .filter(([key]) => key === 'rev')
      .map(([, value]) => value);
    expect(revs.length).toBeGreaterThan(0);
    revs.forEach((rev) => {
      expect(Number.isSafeInteger(rev)).toBe(true);
      expect(rev as number).toBeGreaterThanOrEqual(WALL_CLOCK_MS_FLOOR);
      expect(rev as number).toBeLessThanOrEqual(MAX_SAFE_INTEGER);
    });
  });

  it('spells every timestamp as an RFC 3339 UTC string and keeps it one', () => {
    // TW-CORE-010. Parsing a timestamp into a `Date` would make the round trip lossy in the one
    // direction nobody checks, so the parsed models must still hold strings.
    const stamps = FIXTURES.flatMap((fixture) => walk(fixture.document)).filter(([key]) => TIMESTAMP_KEYS.has(key));
    expect(stamps.length).toBeGreaterThan(0);
    stamps.forEach(([key, value]) => {
      expect(typeof value, `${key} must be a string`).toBe('string');
      expect(value as string).toMatch(RFC3339_Z);
    });

    const progress = parseProgress(document('progress-state-running.json'));
    expect(typeof progress.createdAt).toBe('string');
    expect(typeof progress.updatedAt).toBe('string');
    expect(progress.createdAt).toBe('2026-08-11T09:15:00.000Z');
  });

  it('never grows a percentage on an aggregate', () => {
    // TW-REG-011, checked on the corpus as well as on the type: a fixture is how the field would
    // arrive if some server started sending it, and `Aggregate` has nowhere to put it.
    FIXTURES.filter((fixture) => fixture.kind === 'aggregate').forEach((fixture) => {
      expect(Object.keys(fixture.document as WireObject)).not.toContain('percent');
    });
    const register = parseRegister(document('register-v2-with-aggregate.json'));
    expect(register.aggregate).not.toBeNull();
    expect(Object.keys(register.aggregate as object)).not.toContain('percent');
    expect(Object.keys(serializeAggregate(register.aggregate!) as object)).not.toContain('percent');
  });

  it('converts every wire field name the specification lists as camelCase', () => {
    // TW-TS-000, name by name. A round trip alone would stay green if a field kept its snake_case
    // spelling all the way through the TypeScript side.
    const summary = parseOperationSummary(registerRow());
    expect(summary.resultKind).toBe('acme.import.report');
    expect(summary.originSession).toBe('account:42');
    expect(summary.needsAttention).toBe(false);
    expect(summary.progressDelivery).toBe(true);
    expect(summary.snapshot.cancelRequested).toBe(false);
    expect(summary.snapshot.serverTime).toBe('2026-08-11T09:15:04.317Z');
    expect(summary.snapshot.pollAfterMs).toBe(400);
    expect(summary.snapshot.progress.originConnection).toBe('conn-7');
    expect(summary.snapshot.progress.createdAt).toBe('2026-08-11T09:15:00.000Z');
    expect(summary.snapshot.progress.updatedAt).toBe('2026-08-11T09:15:04.250Z');

    const dialog = parseDialogRequest(document('dialog-request-open.json'));
    expect(dialog.dialogId).toBe('acme.import.conflict');
    expect(dialog.createdAt).toBe('2026-08-11T09:15:00.000Z');

    const ref = parseResult(document('result-ref-with-expires-at.json')).ref!;
    expect(ref.expiresAt).toBe('2026-08-18T09:15:00.000Z');

    // ...and none of the camelCase names leaked back onto the wire.
    const wireKeys = new Set(FIXTURES.flatMap((fixture) => walk(fixture.document)).map(([key]) => key));
    ['dialogId', 'createdAt', 'updatedAt', 'resultKind', 'pollAfterMs', 'expiresAt'].forEach((camel) => {
      expect([...wireKeys]).not.toContain(camel);
    });
  });
});

describe('absent and null are the same thing (TW-CORE-010)', () => {
  it('defaults an input type on the value, not on the key', () => {
    // The exact bug the Python side carries a comment about: a default that fires only on a missing
    // key leaves `{"type": null}` with a type that is none of TW-DLG-004's four.
    expect(parseInputField({ name: 'comment' }).type).toBe('string');
    expect(parseInputField({ name: 'comment', type: null }).type).toBe('string');
    expect(parseInputField({ name: 'comment', type: 'number' }).type).toBe('number');
    expect(INPUT_TYPES).toContain(parseInputField({ name: 'comment', type: null }).type);
  });

  it('defaults a true-by-default boolean the same way for absent and null', () => {
    // `progress_delivery` defaults to `true`, which is where this trap does visible damage: an
    // explicit null would otherwise read as `false` and stop a progress bar being drawn.
    const row = registerRow();
    const absent = { ...row };
    delete absent.progress_delivery;
    expect(parseOperationSummary(absent).progressDelivery).toBe(true);
    expect(parseOperationSummary({ ...row, progress_delivery: null }).progressDelivery).toBe(true);
    expect(parseOperationSummary({ ...row, progress_delivery: false }).progressDelivery).toBe(false);
  });

  it('defaults poll_after_ms, v and origin_session the same way for absent and null', () => {
    const snapshot = document('snapshot-v2-wall-clock-rev.json');
    const nulled = { ...snapshot, v: null, poll_after_ms: null };
    const stripped = { ...snapshot };
    delete stripped.v;
    delete stripped.poll_after_ms;
    expect(parseSnapshot(nulled)).toEqual(parseSnapshot(stripped));
    expect(parseSnapshot(nulled).v).toBe(WIRE_VERSION);
    expect(parseSnapshot(nulled).pollAfterMs).toBe(5000);

    expect(parseProgress({ ...(snapshot.progress as WireObject), origin_session: null }).originSession).toBe('');
  });

  it('reads a null percent and an absent one as one indeterminate progress', () => {
    const nulled = parseProgress(document('progress-percent-null.json'));
    const absent = parseProgress(document('progress-percent-absent.json'));
    expect(nulled).toEqual(absent);
    expect(nulled.percent).toBeNull();
  });

  it('reads an empty register with a null aggregate as one with none', () => {
    const empty = document('register-empty-null-aggregate.json');
    const stripped = { ...empty };
    delete stripped.aggregate;
    expect(parseRegister(empty).aggregate).toBeNull();
    expect(parseRegister(stripped)).toEqual(parseRegister(empty));
  });
});

describe('free-form bags keep the keys the application chose', () => {
  const bag = {
    row_count: 5,
    already_camel: 1,
    nested_thing: { deep_key: [{ inner_key: 'kept' }] },
  };

  it('leaves Progress.data alone in both directions', () => {
    // The hazard is a generic key converter walking into application data: an application that
    // stored `{row_count: 5}` must read back `row_count`, not `rowCount`, and must find the same
    // spelling on the wire afterwards.
    const wire = {
      state: 'running',
      percent: null,
      data: bag,
      result_kind: null,
      origin_session: 'account:42',
      origin_connection: null,
      created_at: '2026-08-11T09:15:00.000Z',
      updated_at: '2026-08-11T09:15:04.250Z',
    };
    const progress = parseProgress(wire);
    expect(progress.data).toEqual(bag);
    expect(Object.keys(progress.data)).toEqual(['row_count', 'already_camel', 'nested_thing']);
    expect((serializeProgress(progress) as WireObject).data).toEqual(bag);
  });

  it('leaves Result.params, Result.value and Text.params alone in both directions', () => {
    const wire = { kind: 'acme.import.report', params: bag, value: bag, label: { key: 'k', params: bag } };
    const result = parseResult(wire);
    expect(result.params).toEqual(bag);
    expect(result.value).toEqual(bag);
    expect(result.label?.params).toEqual(bag);
    expect(serializeResult(result)).toEqual(wire);
  });

  it('leaves DialogRequest.params, DialogReply.values and Envelope.body alone', () => {
    const request = parseDialogRequest({
      id: 'd1',
      dialog_id: 'acme.import.conflict',
      buttons: [{ id: 'ok' }],
      params: bag,
      state: 'open',
      created_at: '2026-08-11T09:15:00.000Z',
      reply: { button: 'ok', values: bag },
    });
    expect(request.params).toEqual(bag);
    expect(request.reply?.values).toEqual(bag);
    expect((serializeDialogRequest(request) as WireObject).params).toEqual(bag);

    const envelope = parseEnvelope({ v: 1, token: 't', rev: 1786439700123, kind: 'progress', body: bag });
    expect(envelope.body).toEqual(bag);
    expect((serializeEnvelope(envelope) as WireObject).body).toEqual(bag);

    expect(parseDialogReply({ button: 'ok', values: bag }).values).toEqual(bag);
    expect(parseDialogAnswer({ button: 'ok', values: bag }).values).toEqual(bag);
    expect((serializeDialogReply({ button: 'ok', values: bag }) as WireObject).values).toEqual(bag);
  });

  it("leaves an aggregate's snake_case count keys alone", () => {
    // `waiting_input` is a *count name*, not a field of ours. Renaming it would give the two
    // languages different keys in the same dictionary (TW-SYM-002).
    const aggregate = parseAggregate(document('aggregate-counts.json'));
    expect(Object.keys(aggregate.data)).toEqual(['total', 'queued', 'running', 'waiting_input']);
    expect(aggregate.data.waiting_input).toBe(0);
    expect(Object.keys((serializeAggregate(aggregate) as WireObject).data as object)).toContain('waiting_input');
  });
});

describe('toCamel / toSnake', () => {
  it('renames wire field names in both directions and is its own inverse', () => {
    const wire = { dialog_id: 'a', created_at: 'b', poll_after_ms: 400, v: 1, nested: [{ result_kind: 'k' }] };
    const camel = toCamel(wire);
    expect(camel).toEqual({ dialogId: 'a', createdAt: 'b', pollAfterMs: 400, v: 1, nested: [{ resultKind: 'k' }] });
    expect(toSnake(camel)).toEqual(wire);
  });

  it('stops at the free-form bags rather than renaming what is inside them', () => {
    // This is the rule stated once, in one place, for the one converter: `OPAQUE_KEYS` values are
    // application data. Without it, every parser built on the converter would have to remember.
    const wire = {
      origin_session: 'x',
      data: { row_count: 5 },
      params: { dialog_id: 'd' },
      body: { result_kind: 'k' },
    };
    expect(toCamel(wire)).toEqual({
      originSession: 'x',
      data: { row_count: 5 },
      params: { dialog_id: 'd' },
      body: { result_kind: 'k' },
    });
    expect(toSnake({ originSession: 'x', data: { rowCount: 5 } })).toEqual({
      origin_session: 'x',
      data: { rowCount: 5 },
    });
    expect([...OPAQUE_KEYS].sort()).toEqual(['body', 'data', 'params', 'value', 'values']);
  });

  it('walks arrays and passes everything that is not a plain object through untouched', () => {
    expect(toCamel([{ a_b: 1 }, { c_d: [2, 3] }])).toEqual([{ aB: 1 }, { cD: [2, 3] }]);
    expect(toCamel('a_b')).toBe('a_b');
    expect(toCamel(null)).toBeNull();
    expect(toCamel(42)).toBe(42);
    const date = new Date('2026-08-11T09:15:00.000Z');
    expect(toCamel({ made_at: date })).toEqual({ madeAt: date });
  });
});

describe('shape invariants of §3', () => {
  it('closes the vocabularies at what the specification lists', () => {
    // TW-CORE-007: six kinds plus `snapshot`, which is not a seventh (TW-CORE-008). TW-PROG-001,
    // §4.2, TW-DLG-004 for the rest. A seventh kind is a breaking change that bumps the wire version.
    expect([...ENVELOPE_KINDS]).toEqual([
      'progress',
      'dialog.open',
      'dialog.close',
      'dialog.reply',
      'cancel',
      'watch',
      'snapshot',
    ]);
    expect([...PUSHED_KINDS].sort()).toEqual(['cancel', 'dialog.close', 'dialog.open', 'progress', 'snapshot']);
    expect(PUSHED_KINDS.has('dialog.reply')).toBe(false);
    expect(PUSHED_KINDS.has('watch')).toBe(false);
    expect([...PROGRESS_STATES]).toEqual(['queued', 'running', 'waiting_input', 'done', 'failed', 'cancelled']);
    expect([...TERMINAL_STATES].sort()).toEqual(['cancelled', 'done', 'failed']);
    expect([...ACTIVE_STATES].sort()).toEqual(['queued', 'running']);
    expect([...DIALOG_STATES]).toEqual(['open', 'answered', 'cancelled']);
    expect([...INPUT_TYPES]).toEqual(['string', 'number', 'boolean', 'date']);
  });

  it('covers all six progress states, both privacies and all three result shapes in the corpus', () => {
    // The corpus itself is part of the acceptance criterion: everything above round-trips only the
    // documents that are actually there.
    const progressFixtures = FIXTURES.filter((fixture) => fixture.kind === 'progress');
    const states = new Set(progressFixtures.map((fixture) => parseProgress(fixture.document).state));
    expect([...states].sort()).toEqual([...PROGRESS_STATES].sort());

    const privacies = new Set(progressFixtures.map((fixture) => parseProgress(fixture.document).resultKind === null));
    expect(privacies).toEqual(new Set([true, false]));

    const resultShapes = FIXTURES.filter((fixture) => fixture.kind === 'result').map((fixture) => {
      const result = parseResult(fixture.document);
      return [result.params !== null, result.ref !== null, result.value !== null].join('/');
    });
    expect(new Set(resultShapes).size).toBe(3);

    const textShapes = FIXTURES.filter((fixture) => fixture.kind === 'text').map((fixture) => {
      const text = parseText(fixture.document);
      return [text.key !== null, text.text !== null].join('/');
    });
    expect(new Set(textShapes).size).toBeGreaterThanOrEqual(3);
  });

  it('rejects a document that is missing a required field', () => {
    // Python raises `KeyError` here; the point is that neither language invents a value for a field
    // the shape declares required. A silent default would put a made-up token or state on the wire.
    expect(() => parseProgress({})).toThrow(/state/);
    expect(() => parseProgress({ state: 'started' })).toThrow(/unknown value/);
    expect(() => parseSnapshot({ v: 1, rev: 1, progress: {} })).toThrow(/token/);
    expect(() => parseEnvelope({ token: 't', rev: 1, kind: 'command' })).toThrow(/unknown value/);
    expect(() => parseResult({})).toThrow(/kind/);
    expect(() => parseText(7)).toThrow(/expected an object/);
    expect(() => parseSnapshot({ v: 1, token: 't', rev: MAX_SAFE_INTEGER + 2, progress: {} })).toThrow(/safe integer/);
  });

  it('serializes a hand-built model into the wire spelling', () => {
    // The other direction of TW-TS-000: an application builds camelCase and the wire gets
    // snake_case, with the required-but-nullable fields written out rather than omitted.
    const serialized = serializeProgress({
      state: 'queued',
      percent: null,
      data: {},
      resultKind: null,
      originSession: 'account:42',
      originConnection: null,
      createdAt: '2026-08-11T09:15:00.000Z',
      updatedAt: '2026-08-11T09:15:00.000Z',
    }) as WireObject;
    expect(Object.keys(serialized).sort()).toEqual([
      'created_at',
      'data',
      'origin_connection',
      'origin_session',
      'percent',
      'result_kind',
      'state',
      'updated_at',
    ]);
    expect(serialized.result_kind).toBeNull();

    expect(serializeText({ key: 'k', params: {} })).toEqual({ key: 'k' });
    expect(serializeInputField({ name: 'n', type: 'date', required: true })).toEqual({
      name: 'n',
      type: 'date',
      required: true,
    });
    expect(serializeOperationSummary(parseOperationSummary(registerRow()))).toEqual(registerRow());
  });

  it('keeps an aggregate unable to express a percentage', () => {
    // TW-REG-011 as a compile-time fact, not only a runtime one. `percent?: never` means the
    // assignment below cannot type-check, and `@ts-expect-error` fails the build the day it starts
    // to - which is the only defence that survives a well-meaning contributor, because a runtime
    // assertion about a field nobody sets passes just as happily after the field is added.
    const aggregate: Aggregate = {
      state: 'running',
      title: { key: 'taskwire.aggregate.title' },
      data: { total: 1, queued: 0, running: 1, waiting_input: 0 },
      updatedAt: '2026-08-11T09:15:04.250Z',
    };
    // @ts-expect-error TW-REG-011: an aggregate has nowhere to put a percentage.
    aggregate.percent = 50;
    expect(serializeAggregate(aggregate)).not.toHaveProperty('percent');
  });
});

describe('timestamps', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('produces RFC 3339 UTC with a Z suffix and nothing else', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-11T09:15:04.317Z'));
    expect(nowIso()).toBe('2026-08-11T09:15:04.317Z');
    expect(nowIso()).toMatch(RFC3339_Z);
    expect(toIso(new Date('2026-08-11T09:15:04.317Z'))).toBe('2026-08-11T09:15:04.317Z');
    expect(toIso('2026-08-11T09:15:04.317Z')).toBe('2026-08-11T09:15:04.317Z');
    expect(toIso(null)).toBeNull();
    expect(toIso(undefined)).toBeNull();
  });

  it('defaults a missing timestamp rather than leaving a hole', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-11T09:15:04.317Z'));
    const progress = parseProgress({ state: 'queued', origin_session: 'ns' });
    expect(progress.createdAt).toBe('2026-08-11T09:15:04.317Z');
    expect(progress.updatedAt).toBe('2026-08-11T09:15:04.317Z');
  });
});

describe('exceptionName()', () => {
  it("follows the cases Python's exception_name() follows, acronyms included", () => {
    const { cases } = JSON.parse(readFileSync(join(REPO_ROOT, 'conformance', 'exception-names.json'), 'utf8')) as {
      cases: [string, string][];
    };
    expect(cases.map(([name]) => exceptionName(name))).toEqual(cases.map(([, snake]) => snake));
  });
});
