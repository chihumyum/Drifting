// Read actual native anchor records with the unchanged renderer's parsers.
// This does not claim that the renderer rewrites CRDT anchor extensions.
import { readFileSync } from 'node:fs';
import { commentBlockIds, getBlockSnapshotsFromAnchor, getSelectedTextFromAnchor,
  getTextAnchorFromAnchor, type Comment } from '../src/renderer/domain/comment';

const records: Pick<Comment, 'id' | 'anchorJson' | 'targetBlockId' | 'targetBlockIdsJson'>[] = JSON.parse(readFileSync(0, 'utf8'));
console.log(JSON.stringify(records.map(record => ({
  id: record.id,
  textAnchor: getTextAnchorFromAnchor(record.anchorJson),
  quote: getSelectedTextFromAnchor(record.anchorJson),
  snapshots: getBlockSnapshotsFromAnchor(record.anchorJson),
  blockIds: commentBlockIds(record as Comment),
}))));
