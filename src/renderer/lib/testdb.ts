// Debug utility to check database content
import { query } from './db';

export async function debugDatabase() {
  console.log('=== Checking database content ===');
  
  try {
    // Check storylines
    const storylines = await query('SELECT * FROM story_thread');
    console.log('Storylines:', storylines);
    
    // Check chapters
    const chapters = await query('SELECT * FROM story_node WHERE type = "chapter"');
    console.log('Chapters:', chapters);
    
    // Check node-storyline relationships
    const nodeThreads = await query('SELECT * FROM node_thread');
    console.log('Node-Storyline relationships:', nodeThreads);
    
    return { storylines, chapters, nodeThreads };
  } catch (error) {
    console.error('Database check failed:', error);
    return null;
  }
}
