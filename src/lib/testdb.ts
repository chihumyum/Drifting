// Debug utility to check database content
import { query } from './db';

export async function debugDatabase() {
  console.log('=== Checking database content ===');
  
  try {
    // Check threads
    const threads = await query('SELECT * FROM story_thread');
    console.log('Threads:', threads);
    
    // Check chapters
    const chapters = await query('SELECT * FROM story_node WHERE type = "chapter"');
    console.log('Chapters:', chapters);
    
    // Check node-thread relationships
    const nodeThreads = await query('SELECT * FROM node_thread');
    console.log('Node-Thread relationships:', nodeThreads);
    
    return { threads, chapters, nodeThreads };
  } catch (error) {
    console.error('Database check failed:', error);
    return null;
  }
}
