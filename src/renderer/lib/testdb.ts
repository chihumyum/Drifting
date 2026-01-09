// Debug utility to check database content
import loglevel from 'loglevel';
const log = loglevel.getLogger("TestDbLib");
log.setLevel(loglevel.levels.ERROR);
import { query } from './db';

export async function debugDatabase() {
  log.debug('=== Checking database content ===');
  
  try {
    // Check storylines
    const storylines = await query('SELECT * FROM story_thread');
    log.debug('Storylines:', storylines);
    
    // Check chapters
    const chapters = await query('SELECT * FROM story_node WHERE type = "chapter"');
    log.debug('Chapters:', chapters);
    
    // Check node-storyline relationships
    const nodeThreads = await query('SELECT * FROM node_thread');
    log.debug('Node-Storyline relationships:', nodeThreads);
    
    return { storylines, chapters, nodeThreads };
  } catch (error) {
    log.error('Database check failed:', error);
    return null;
  }
}
