import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';

import { createPersistedYjsUpdateOrigin } from '../lib/yjs-persistence-origin';
import type { ParsedYjsUpdatePayload, YjsTransactionDeleteRange } from '../sync/protocol/yjs-update-payload';
import { captureYjsTransactionEvidence, type YjsTransactionEvidenceResult } from './yjs-transaction-evidence';

const INPUT = Symbol('synthetic-input');

function document(clientID = 47001): Y.Doc {
  const doc = new Y.Doc();
  doc.clientID = clientID;
  return doc;
}

function captured(result: YjsTransactionEvidenceResult): ParsedYjsUpdatePayload {
  expect(result.status).toBe('captured');
  if (result.status !== 'captured') throw result.error;
  return result.payload;
}

function provenance(result: YjsTransactionEvidenceResult) {
  const value = captured(result).sourceRetentionProvenance;
  expect(value?.kind).toBe('transaction-event');
  if (!value || value.kind !== 'transaction-event') throw new Error('Missing transaction evidence');
  return value;
}

function ranges(transaction: Y.Transaction): YjsTransactionDeleteRange[] {
  return [...transaction.deleteSet.clients].flatMap(([client, items]) =>
    items.map(({ clock, len }) => ({ client, clock, length: len })),
  ).sort((left, right) => left.client - right.client || left.clock - right.clock);
}

describe('actual Yjs transaction evidence capture', () => {
  it('captures the exact eligible local insert event and the preceding snapshot', () => {
    const doc = document();
    const text = doc.getText('body');
    const before = Y.encodeSnapshot(Y.snapshot(doc));
    const log = captureYjsTransactionEvidence(doc, (_transaction, origin) => origin === INPUT);
    let event: Uint8Array | undefined;
    doc.on('update', (bytes) => { event = bytes; });
    doc.transact(() => text.insert(0, '潮🙂e\u0301'), INPUT);
    const entries = log.drain();
    expect(entries).toHaveLength(1);
    expect(captured(entries[0]).update).toEqual(event);
    expect(captured(entries[0]).update).not.toBe(event);
    expect(provenance(entries[0])).toEqual({
      version: 1, kind: 'transaction-event', beforeSnapshot: before, transactionDeletes: [],
    });
    const replica = document(47002);
    Y.applyUpdate(replica, captured(entries[0]).update);
    expect(replica.getText('body').toString()).toBe('潮🙂e\u0301');
    expect(log.drain()).toEqual([]);
    log.dispose();
  });

  it('distinguishes consecutive pure deletes whose state vectors are identical', () => {
    const doc = document();
    const text = doc.getText('body');
    text.insert(0, '甲乙丙');
    const log = captureYjsTransactionEvidence(doc, () => true);
    const beforeFirst = Y.encodeSnapshot(Y.snapshot(doc));
    doc.transact(() => text.delete(0, 1), INPUT);
    const beforeSecond = Y.encodeSnapshot(Y.snapshot(doc));
    doc.transact(() => text.delete(0, 1), INPUT);
    const entries = log.drain();
    expect(entries).toHaveLength(2);
    const first = provenance(entries[0]);
    const second = provenance(entries[1]);
    expect(first.beforeSnapshot).toEqual(beforeFirst);
    expect(second.beforeSnapshot).toEqual(beforeSecond);
    expect(first.beforeSnapshot).not.toEqual(second.beforeSnapshot);
    expect(Y.decodeSnapshot(first.beforeSnapshot).sv).toEqual(Y.decodeSnapshot(second.beforeSnapshot).sv);
    expect(first.transactionDeletes).toEqual([{ client: doc.clientID, clock: 0, length: 1 }]);
    expect(second.transactionDeletes).toEqual([{ client: doc.clientID, clock: 1, length: 1 }]);
    expect(Y.decodeSnapshot(first.beforeSnapshot).ds.clients.size).toBe(0);
    expect(Y.decodeSnapshot(second.beforeSnapshot).ds.clients.get(doc.clientID)).toEqual([{ clock: 0, len: 1 }]);
    log.dispose();
  });

  it('keeps rapid event bases and bytes independent of later events and listeners', () => {
    const doc = document();
    const text = doc.getText('body');
    const log = captureYjsTransactionEvidence(doc, () => true);
    const before = [Y.encodeSnapshot(Y.snapshot(doc))];
    doc.on('update', (bytes) => bytes.fill(0));
    text.insert(0, '甲');
    before.push(Y.encodeSnapshot(Y.snapshot(doc)));
    text.insert(1, '乙');
    const entries = log.drain();
    expect(entries).toHaveLength(2);
    const replica = document(47002);
    entries.forEach((entry, index) => {
      expect(provenance(entry).beforeSnapshot).toEqual(before[index]);
      Y.applyUpdate(replica, captured(entry).update);
    });
    expect(replica.getText('body').toString()).toBe('甲乙');
    provenance(entries[0]).beforeSnapshot.fill(0);
    expect(provenance(entries[1]).beforeSnapshot).toEqual(before[1]);
    log.dispose();
  });

  it('excludes non-approved, remote, full-state and already-persisted transactions', () => {
    const doc = document();
    const peer = document(47002);
    peer.getText('body').insert(0, '远');
    const origins: unknown[] = [];
    const log = captureYjsTransactionEvidence(doc, (_transaction, origin) => {
      origins.push(origin);
      return origin === INPUT;
    });
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(peer), INPUT);
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(peer), INPUT);
    doc.transact(() => doc.getText('body').insert(0, '缓存'), createPersistedYjsUpdateOrigin(1, 'synthetic-receipt'));
    doc.getText('body').insert(0, '未批准');
    expect(log.drain()).toEqual([]);
    expect(origins).toEqual([null]);
    log.dispose();
  });

  it('rechecks locality after a remote apply nested inside an eligible local transaction', () => {
    const doc = document();
    const peer = document(47002);
    peer.getText('body').insert(0, '远');
    const log = captureYjsTransactionEvidence(doc, () => true);
    doc.transact(() => {
      doc.getText('body').insert(0, '本');
      Y.applyUpdate(doc, Y.encodeStateAsUpdate(peer), INPUT);
    }, INPUT);
    expect(doc.getText('body').length).toBe(2);
    expect(log.drain()).toEqual([]);
    log.dispose();
  });

  it('uses one outer transaction basis for nested local transact calls', () => {
    const doc = document();
    const text = doc.getText('body');
    const before = Y.encodeSnapshot(Y.snapshot(doc));
    const origins: unknown[] = [];
    const log = captureYjsTransactionEvidence(doc, (_transaction, origin) => {
      origins.push(origin);
      return origin === INPUT;
    });
    doc.transact(() => {
      text.insert(0, '甲');
      doc.transact(() => text.insert(1, '乙'), 'nested');
    }, INPUT);
    const entries = log.drain();
    expect(origins).toEqual([INPUT]);
    expect(entries).toHaveLength(1);
    expect(provenance(entries[0]).beforeSnapshot).toEqual(before);
    const replica = document(47002);
    Y.applyUpdate(replica, captured(entries[0]).update);
    expect(replica.getText('body').toString()).toBe('甲乙');
    log.dispose();
  });

  it('preserves distinct observer-transaction bases without claiming event bytes are transaction-exclusive', () => {
    const doc = document();
    const text = doc.getText('body');
    const log = captureYjsTransactionEvidence(doc, () => true);
    let observerBasis: Uint8Array | undefined;
    let changed = false;
    text.observe(() => {
      if (changed) return;
      changed = true;
      observerBasis = Y.encodeSnapshot(Y.snapshot(doc));
      doc.transact(() => text.insert(1, '乙'), 'observer');
    });
    doc.transact(() => text.insert(0, '甲'), INPUT);
    const entries = log.drain();
    expect(entries).toHaveLength(2);
    expect(Y.decodeSnapshot(provenance(entries[0]).beforeSnapshot).sv.size).toBe(0);
    expect(provenance(entries[1]).beforeSnapshot).toEqual(observerBasis);
    expect(Y.decodeSnapshot(provenance(entries[1]).beforeSnapshot).sv.get(doc.clientID)).toBe(1);
    const replica = document(47002);
    Y.applyUpdate(replica, captured(entries[0]).update);
    // Actual Yjs cleanup encodes both inserts in the first event. The second
    // event remains independently captured; neither fact certifies intent.
    expect(replica.getText('body').toString()).toBe('甲乙');
    Y.applyUpdate(replica, captured(entries[1]).update);
    expect(replica.getText('body').toString()).toBe('甲乙');
    log.dispose();
  });

  it('records structural replacement deletes as neutral transaction facts', () => {
    const doc = document();
    const root = doc.getXmlFragment('prose');
    const paragraph = new Y.XmlElement('paragraph');
    const text = new Y.XmlText();
    text.insert(0, '保留正文');
    paragraph.insert(0, [text]);
    root.insert(0, [paragraph]);
    const before = Y.encodeSnapshot(Y.snapshot(doc));
    const log = captureYjsTransactionEvidence(doc, () => true);
    let actual: YjsTransactionDeleteRange[] = [];
    doc.on('update', (_bytes, _origin, _doc, transaction) => { actual = ranges(transaction); });
    doc.transact(() => {
      const copy = paragraph.clone();
      root.delete(0, 1);
      root.insert(0, [copy]);
    }, INPUT);
    expect(root.toString()).toBe('<paragraph>保留正文</paragraph>');
    const evidence = provenance(log.drain()[0]);
    expect(evidence.beforeSnapshot).toEqual(before);
    expect(evidence.transactionDeletes).toEqual(actual);
    expect(actual.length).toBeGreaterThan(0);
    expect(Object.keys(evidence).sort()).toEqual(['beforeSnapshot', 'kind', 'transactionDeletes', 'version']);
    log.dispose();
  });

  it('retains an explicit capture failure without throwing into Yjs or poisoning later cleanup', () => {
    const doc = document();
    const text = doc.getText('body');
    const failure = new Error('synthetic eligibility failure');
    let fail = true;
    const log = captureYjsTransactionEvidence(doc, () => {
      if (fail) throw failure;
      return true;
    });
    expect(() => text.insert(0, '甲')).not.toThrow();
    expect(doc._transaction).toBeNull();
    expect(doc._transactionCleanups).toEqual([]);
    const first = log.drain();
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ status: 'unavailable', error: failure });
    if (first[0].status !== 'unavailable') throw new Error('Expected unavailable evidence');
    const replica = document(47002);
    Y.applyUpdate(replica, first[0].update);
    expect(replica.getText('body').toString()).toBe('甲');
    fail = false;
    text.insert(1, '乙');
    const batch = log.drain();
    expect(captured(batch[0]).update).toBeInstanceOf(Uint8Array);
    // The consumer's durable handoff runs outside Yjs. Its failure is visible
    // to that caller, which still owns the drained bytes for retry.
    expect(() => { throw new Error('synthetic durable write failure'); }).toThrow('durable write failure');
    expect(doc._transactionCleanups).toEqual([]);
    text.insert(2, '丙');
    Y.applyUpdate(replica, captured(batch[0]).update);
    Y.applyUpdate(replica, captured(log.drain()[0]).update);
    expect(replica.getText('body').toString()).toBe('甲乙丙');
    log.dispose();

    const unreadable = 'Transaction evidence capture failed with an unreadable error';
    const thrownValues: [unknown, string][] = [
      ['synthetic non-Error failure', 'synthetic non-Error failure'],
      [{ toString() { throw new Error('toString failed'); } }, unreadable],
      [new Proxy({}, { getPrototypeOf() { throw new Error('prototype failed'); } }), unreadable],
    ];
    for (const [thrown, message] of thrownValues) {
      const failingDoc = document(47003);
      const failingLog = captureYjsTransactionEvidence(failingDoc, () => { throw thrown; });
      expect(() => failingDoc.getText('body').insert(0, '保留')).not.toThrow();
      const entry = failingLog.drain()[0];
      expect(entry.status).toBe('unavailable');
      if (entry.status !== 'unavailable') throw new Error('Expected explicit capture failure');
      expect(entry.error.message).toBe(message);
      expect(failingDoc._transaction).toBeNull();
      expect(failingDoc._transactionCleanups).toEqual([]);
      const recovered = document(47004);
      Y.applyUpdate(recovered, entry.update);
      expect(recovered.getText('body').toString()).toBe('保留');
      failingLog.dispose();
    }
  });

  it.each([
    ['earlier listener', 'insert', true],
    ['earlier listener', 'delete', true],
    ['predicate', 'insert', true],
    ['predicate', 'delete', true],
    ['predicate', 'insert', false],
    ['predicate', 'delete', false],
  ] as const)('refuses a contaminated basis from %s %s even when eligibility is %s', (source, operation, allowed) => {
    const doc = document();
    const text = doc.getText('body');
    text.insert(0, '甲乙');
    const seed = Y.encodeStateAsUpdate(doc);
    const originalSnapshot = Y.snapshot(doc);
    let change = true;
    const mutate = (): void => {
      if (!change) return;
      if (operation === 'insert') text.insert(0, '先');
      else text.delete(0, 1);
    };
    if (source === 'earlier listener') doc.on('beforeTransaction', mutate);
    const log = captureYjsTransactionEvidence(doc, () => {
      if (source === 'predicate') mutate();
      return change ? allowed : true;
    });
    let raw: Uint8Array | undefined;
    doc.on('update', (bytes) => { raw = new Uint8Array(bytes); });
    expect(() => doc.transact(() => text.insert(text.length, '后'), INPUT)).not.toThrow();
    const entries = log.drain();
    expect(entries).toHaveLength(1);
    const entry = entries[0];
    expect(entry.status).toBe('unavailable');
    if (entry.status !== 'unavailable') throw new Error('Contaminated basis was accepted');
    expect(entry.error.message).toContain(source === 'earlier listener'
      ? 'changed before evidence capture'
      : 'predicate must not modify');
    expect(entry.update).toEqual(raw);
    expect(entry).not.toHaveProperty('payload');
    const replica = document(47002);
    Y.applyUpdate(replica, seed);
    Y.applyUpdate(replica, entry.update);
    expect(replica.getText('body').toString()).toBe(operation === 'insert' ? '先甲乙后' : '乙后');
    expect(doc._transaction).toBeNull();
    expect(doc._transactionCleanups).toEqual([]);
    change = false;
    const nextBasis = Y.encodeSnapshot(Y.snapshot(doc));
    expect(nextBasis).not.toEqual(Y.encodeSnapshot(originalSnapshot));
    text.insert(text.length, '续');
    expect(provenance(log.drain()[0]).beforeSnapshot).toEqual(nextBasis);
    log.dispose();
  });

  it.each(['beforeTransaction', 'update'] as const)('keeps an unknown origin accessor failure at %s outside Yjs cleanup', (phase) => {
    const doc = document();
    const text = doc.getText('body');
    const log = captureYjsTransactionEvidence(doc, () => true);
    const origin = {};
    const poisonOrigin = (): void => {
      Object.defineProperty(origin, 'kind', {
        get() { throw new Error('synthetic origin accessor failure'); },
      });
    };
    if (phase === 'beforeTransaction') poisonOrigin();
    expect(() => doc.transact(() => {
      text.insert(0, '甲');
      if (phase === 'update') poisonOrigin();
    }, origin)).not.toThrow();
    const entries = log.drain();
    expect(entries).toHaveLength(1);
    expect(entries[0].status).toBe('unavailable');
    if (entries[0].status !== 'unavailable') throw new Error('Expected explicit origin failure');
    expect(entries[0].error.message).toBe('synthetic origin accessor failure');
    const replica = document(47002);
    Y.applyUpdate(replica, entries[0].update);
    expect(replica.getText('body').toString()).toBe('甲');
    expect(doc._transaction).toBeNull();
    expect(doc._transactionCleanups).toEqual([]);
    text.insert(1, '乙');
    expect(captured(log.drain()[0]).update).toBeInstanceOf(Uint8Array);
    log.dispose();
  });

  it('disposes idempotently without discarding queued records and automatically detaches on destroy', () => {
    const doc = document();
    const log = captureYjsTransactionEvidence(doc, () => true);
    doc.getText('body').insert(0, '甲');
    log.dispose();
    log.dispose();
    doc.getText('body').insert(1, '乙');
    expect(log.drain()).toHaveLength(1);
    expect(log.drain()).toEqual([]);
    expect(doc._observers.has('beforeTransaction')).toBe(false);
    expect(doc._observers.has('update')).toBe(false);
    const second = captureYjsTransactionEvidence(doc, () => true);
    doc.getText('body').insert(2, '丙');
    doc.destroy();
    expect(second.drain()).toHaveLength(1);
    expect(doc._observers.size).toBe(0);
    second.dispose();
  });
});
