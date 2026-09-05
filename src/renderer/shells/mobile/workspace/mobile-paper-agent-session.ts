/** Paper/session affinity is local presentation state, never Agent context. */
export interface PaperAgentEntry { conversationId: string | null }
const STORAGE_KEY = 'drifting.mobile.paper-agent.v1';
const drafts = new Map<string, string>();

export function paperAgentKey(projectId: string, paperKey: string): string {
  return JSON.stringify([projectId, paperKey]);
}
export function readPaperAgentEntry(key: string): PaperAgentEntry {
  try {
    const id: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}')[key];
    return { conversationId: typeof id === 'string' ? id : null };
  } catch { return { conversationId: null }; }
}
export function writePaperAgentEntry(key: string, conversationId: string | null): void {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    const entries = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    const next = Object.entries(entries).filter(([entry]) => entry !== key).slice(-99);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries([...next, [key, conversationId]])));
  } catch { /* Storage unavailable: the current mounted session still works. */ }
}

interface ChatSnapshot { boundProjectId: string | null; activeConvId: string | null; prompt: string }
export interface PaperAgentChatPort {
  getState(): ChatSnapshot & {
    bindProject(projectId: string, options?: { restoreLastConversation?: boolean }): void;
    newConversation(): void;
    loadConversation(id: string): Promise<void>;
    setPrompt(prompt: string): void;
  };
  subscribe(listener: () => void): () => void;
}
export interface MobilePaperAgentBinding {
  loading: boolean;
  error: boolean;
  select(id: string | null): Promise<void>;
  setPrompt(prompt: string): void;
}

/** Owns only the displayed conversation and drafts. No runtime start/abort API. */
export class MobilePaperAgentSession {
  private generation = 0;
  private disposed = false;
  private unsubscribe?: () => void;
  private listeners = new Set<() => void>();
  private loadingPrompt: string | undefined;
  private hydrationInFlight = false;
  private requestedId: string | null = null;
  private currentId: string | null = null;
  private snapshot: MobilePaperAgentBinding;
  private readonly key: string;
  constructor(
    private projectId: string,
    paperKey: string,
    private chat: PaperAgentChatPort,
    private exists: (id: string, projectId: string) => Promise<boolean>,
  ) {
    this.key = paperAgentKey(projectId, paperKey);
    this.snapshot = { loading: true, error: false, select: (id) => this.select(id), setPrompt: (prompt) => {
      if (this.snapshot.loading) {
        this.loadingPrompt = prompt;
        drafts.set(this.draftKey(this.requestedId), prompt);
      }
      this.chat.getState().setPrompt(prompt);
    } };
  }
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(loading: boolean, error = false) {
    this.snapshot = { ...this.snapshot, loading, error };
    this.listeners.forEach((listener) => listener());
  }
  private draftKey(id: string | null) { return JSON.stringify([this.key, id]); }
  private capture = () => {
    const state = this.chat.getState();
    if (this.disposed || this.snapshot.loading || state.boundProjectId !== this.projectId) return;
    if (state.activeConvId !== this.currentId) {
      // A first Send (or a canonical fork) assigns the shared conversation ID.
      drafts.delete(this.draftKey(this.currentId));
      this.currentId = state.activeConvId;
      writePaperAgentEntry(this.key, this.currentId);
    }
    drafts.set(this.draftKey(this.currentId), state.prompt);
  };
  async open() {
    this.disposed = false;
    this.chat.getState().bindProject(this.projectId, { restoreLastConversation: false });
    this.unsubscribe = this.chat.subscribe(this.capture);
    await this.select(readPaperAgentEntry(this.key).conversationId);
  }
  async select(id: string | null) {
    this.capture();
    const generation = ++this.generation;
    this.loadingPrompt = undefined;
    this.requestedId = id;
    this.hydrationInFlight = false;
    this.publish(true);
    // Invalidate any earlier hydration and clear the previous surface's draft.
    if (!id || this.chat.getState().activeConvId !== id) this.chat.getState().newConversation();
    const current = () => !this.disposed && generation === this.generation && this.chat.getState().boundProjectId === this.projectId;
    try {
      const valid = id ? await this.exists(id, this.projectId) : false;
      if (!current()) return;
      if (id && valid && this.chat.getState().activeConvId !== id) {
        this.hydrationInFlight = true;
        try { await this.chat.getState().loadConversation(id); }
        finally { if (current()) this.hydrationInFlight = false; }
      }
      if (id && !valid) this.chat.getState().newConversation();
      if (!current()) return;
      this.currentId = this.chat.getState().activeConvId;
      writePaperAgentEntry(this.key, this.currentId);
      this.chat.getState().setPrompt(this.loadingPrompt ?? drafts.get(this.draftKey(this.currentId)) ?? '');
      this.publish(false);
      this.capture();
    } catch {
      if (!current()) return;
      this.chat.getState().newConversation();
      this.currentId = null;
      this.chat.getState().setPrompt(this.loadingPrompt ?? drafts.get(this.draftKey(null)) ?? '');
      this.publish(false, true);
    }
  }
  dispose() {
    this.capture();
    this.disposed = true;
    ++this.generation;
    this.unsubscribe?.();
    if (this.hydrationInFlight && this.chat.getState().boundProjectId === this.projectId) this.chat.getState().newConversation();
  }
}
