import { events } from './events';

export type JobType = 'summarize' | 'update-codex' | 'suggest-stages' | 'analyze-mentions';

interface JobOptions {
  id?: string;
  type: JobType;
  payload: Record<string, unknown>;
}

interface JobResult {
  id: string;
  type: 'completed' | 'error' | 'progress';
  payload?: Record<string, unknown>;
  error?: string;
}

class JobsManager {
  private worker: Worker | null = null;
  private pendingJobs = new Map<string, {
    resolve: (result: Record<string, unknown>) => void;
    reject: (error: Error) => void;
  }>();

  private getWorker(): Worker {
    if (!this.worker) {
      this.worker = new Worker(new URL('../workers/jobs.worker.ts', import.meta.url), { type: 'module' });
      this.worker.addEventListener('message', this.handleWorkerMessage.bind(this));
    }
    return this.worker;
  }

  private handleWorkerMessage(ev: MessageEvent) {
    const { id, type, payload, error }: JobResult = ev.data;
    const pending = this.pendingJobs.get(id);
    
    if (!pending) return;

    if (type === 'completed') {
      pending.resolve(payload || {});
      events.emit('jobs:completed', { jobId: id, result: payload });
    } else if (type === 'error') {
      pending.reject(new Error(error || 'Job failed'));
      events.emit('jobs:failed', { jobId: id, error: error || 'Job failed' });
    }

    this.pendingJobs.delete(id);
  }

  async runJob(options: JobOptions): Promise<Record<string, unknown>> {
    const jobId = options.id || `job_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const worker = this.getWorker();

    return new Promise((resolve, reject) => {
      this.pendingJobs.set(jobId, { resolve, reject });
      
      events.emit('jobs:started', { jobId, type: options.type });
      
      worker.postMessage({
        id: jobId,
        type: options.type,
        payload: options.payload
      });

      // Timeout after 30 seconds
      setTimeout(() => {
        if (this.pendingJobs.has(jobId)) {
          this.pendingJobs.delete(jobId);
          reject(new Error('Job timeout'));
          events.emit('jobs:failed', { jobId, error: 'Job timeout' });
        }
      }, 30000);
    });
  }

  async summarizeText(text: string, maxLength = 140): Promise<string> {
    const result = await this.runJob({
      type: 'summarize',
      payload: { text, maxLength }
    });
    return result.summary as string;
  }

  async updateCodexEntry(entryId: string, context: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.runJob({
      type: 'update-codex',
      payload: { entryId, updates: context }
    });
  }

  async suggestStages(entryId: string, timeline: Record<string, unknown>[]): Promise<Record<string, unknown>> {
    return this.runJob({
      type: 'suggest-stages',
      payload: { entryId, timeline }
    });
  }

  async analyzeMentions(text: string, existingEntries: Record<string, unknown>[]): Promise<Record<string, unknown>> {
    return this.runJob({
      type: 'analyze-mentions',
      payload: { text, existingEntries }
    });
  }

  terminate(): void {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    this.pendingJobs.clear();
  }
}

export const jobsManager = new JobsManager();

// Auto-summarization when content is saved
events.on('editor:saved', async ({ nodeId, content }) => {
  if (content.length > 200) {
    try {
      const summary = await jobsManager.summarizeText(content);
      // Update node summary in database
      const { run } = await import('./db');
      await run(`
        UPDATE story_node 
        SET summary = '${summary.replaceAll("'", "''")}', updated_at = '${new Date().toISOString()}'
        WHERE id = '${nodeId}'
      `);
      events.emit('nodes:changed');
    } catch (error) {
      console.error('Failed to auto-summarize:', error);
    }
  }
});

// Auto-mention analysis when mentions are detected
events.on('editor:mention-detected', async ({ mentions }) => {
  try {
    const { query } = await import('./db');
    const existingEntries = await query('SELECT * FROM entry');
    
    const suggestions = await jobsManager.analyzeMentions(mentions.join(' '), existingEntries);
    console.log('Mention suggestions:', suggestions);
  } catch (error) {
    console.error('Failed to analyze mentions:', error);
  }
});

export default jobsManager;