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


  terminate(): void {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    this.pendingJobs.clear();
  }
}

export const jobsManager = new JobsManager();



export default jobsManager;