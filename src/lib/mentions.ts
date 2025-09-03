import { query, run } from './db';
import { events } from './events';
import type { Entry, EntryAppearance } from './schema';

export interface TextSpan {
  start: number;
  end: number;
  text: string;
  entryId?: string;
}

export interface MentionMatch {
  entryId: string;
  entryName: string;
  spans: TextSpan[];
  confidence: 'explicit' | 'alias' | 'ner';
}

export async function detectMentions(
  text: string, 
  nodeId: string, 
  blockId: string
): Promise<MentionMatch[]> {
  try {
    const entries = await query<Entry>('SELECT * FROM entry');
    const matches: MentionMatch[] = [];

    for (const entry of entries) {
      const entryMatches = findEntryMentions(text, entry);
      if (entryMatches.spans.length > 0) {
        matches.push(entryMatches);
        
        // Store appearances in database
        await storeAppearance(entry.id, nodeId, blockId, entryMatches.spans);
      }
    }

    return matches.sort((a, b) => b.spans.length - a.spans.length);
  } catch (error) {
    console.error('Failed to detect mentions:', error);
    return [];
  }
}

function findEntryMentions(text: string, entry: Entry): MentionMatch {
  const spans: TextSpan[] = [];
  const aliases = JSON.parse(entry.aliases_json) as string[];
  
  // Explicit [[Entry]] mentions
  const explicitRegex = new RegExp(`\\[\\[\\s*${escapeRegex(entry.name)}\\s*\\]\\]`, 'gi');
  let match;
  while ((match = explicitRegex.exec(text)) !== null) {
    spans.push({
      start: match.index,
      end: match.index + match[0].length,
      text: match[0],
      entryId: entry.id
    });
  }

  // @mentions
  const atMentionRegex = new RegExp(`@${escapeRegex(entry.name)}\\b`, 'gi');
  while ((match = atMentionRegex.exec(text)) !== null) {
    spans.push({
      start: match.index,
      end: match.index + match[0].length,
      text: match[0],
      entryId: entry.id
    });
  }

  // Alias matches
  for (const alias of aliases) {
    const aliasRegex = new RegExp(`\\b${escapeRegex(alias)}\\b`, 'gi');
    while ((match = aliasRegex.exec(text)) !== null) {
      // Avoid overlaps with existing spans
      const overlaps = spans.some(span => 
        (match!.index >= span.start && match!.index < span.end) ||
        (match!.index + match![0].length > span.start && match!.index + match![0].length <= span.end)
      );
      
      if (!overlaps) {
        spans.push({
          start: match.index,
          end: match.index + match[0].length,
          text: match[0],
          entryId: entry.id
        });
      }
    }
  }

  // Direct name matches (as fallback)
  if (spans.length === 0) {
    const nameRegex = new RegExp(`\\b${escapeRegex(entry.name)}\\b`, 'gi');
    while ((match = nameRegex.exec(text)) !== null) {
      spans.push({
        start: match.index,
        end: match.index + match[0].length,
        text: match[0],
        entryId: entry.id
      });
    }
  }

  const confidence: MentionMatch['confidence'] = 
    spans.some(s => s.text.includes('[[') || s.text.includes('@')) ? 'explicit' :
    spans.some(s => aliases.some(alias => alias.toLowerCase() === s.text.toLowerCase())) ? 'alias' :
    'ner';

  return {
    entryId: entry.id,
    entryName: entry.name,
    spans: spans.sort((a, b) => a.start - b.start),
    confidence
  };
}

async function storeAppearance(
  entryId: string, 
  nodeId: string, 
  blockId: string, 
  spans: TextSpan[]
): Promise<void> {
  try {
    // Remove existing appearances for this block/entry combination
    await run(`
      DELETE FROM entry_appearance 
      WHERE entry_id = '${entryId}' AND node_id = '${nodeId}' AND block_id = '${blockId}'
    `);

    if (spans.length > 0) {
      const appearanceId = `appearance_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      const appearance: EntryAppearance = {
        id: appearanceId,
        entry_id: entryId,
        node_id: nodeId,
        block_id: blockId,
        spans_json: JSON.stringify(spans),
        count: spans.length,
        created_at: new Date().toISOString()
      };

      await run(`
        INSERT INTO entry_appearance (id, entry_id, node_id, block_id, spans_json, count, created_at)
        VALUES ('${appearance.id}', '${appearance.entry_id}', '${appearance.node_id}', '${appearance.block_id}', '${appearance.spans_json.replaceAll("'", "''")}', ${appearance.count}, '${appearance.created_at}')
      `);

      events.emit('codex:appearance-detected', { entryId, nodeId, blockId });
    }
  } catch (error) {
    console.error('Failed to store appearance:', error);
  }
}

export async function updateAppearancesForBlock(
  nodeId: string, 
  blockId: string, 
  newText: string
): Promise<void> {
  try {
    // Clear existing appearances for this block
    await run(`DELETE FROM entry_appearance WHERE node_id = '${nodeId}' AND block_id = '${blockId}'`);
    
    // Detect new mentions
    const mentions = await detectMentions(newText, nodeId, blockId);
    
    if (mentions.length > 0) {
      const mentionList = mentions.map(m => m.entryName).join(', ');
      events.emit('editor:mention-detected', { blockId, mentions: [mentionList] });
    }
  } catch (error) {
    console.error('Failed to update appearances:', error);
  }
}

export async function getEntryAppearances(entryId: string): Promise<EntryAppearance[]> {
  try {
    return await query<EntryAppearance>(`
      SELECT ea.*, sn.title as node_title, sn.type as node_type
      FROM entry_appearance ea
      JOIN story_node sn ON sn.id = ea.node_id
      WHERE ea.entry_id = '${entryId}'
      ORDER BY sn.order_key
    `);
  } catch (error) {
    console.error('Failed to get entry appearances:', error);
    return [];
  }
}

function escapeRegex(string: string): string {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}