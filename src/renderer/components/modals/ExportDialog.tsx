/**
 * ExportDialog — modal launched from Settings → 同步 → 配置导出.
 *
 * Owns:
 *   - format choice
 *   - destination choice (local file / cloud archive)
 *   - book assembly (pulling chapter docs from the local stores)
 *   - progress + error UI
 *
 * Does NOT own:
 *   - format-specific byte generation (delegated to ./services/export)
 *   - server-side job state (./services/export wraps that)
 */
import { useEffect, useMemo, useState } from 'react';
import { X } from 'lucide-react';
import { useParams } from 'react-router-dom';
import { Node as PMNode, Schema } from '@tiptap/pm/model';
import {
  buildExport,
  getExportCloudStatus,
  saveBlobLocally,
  uploadToCloud,
  type ExportFormat,
} from '../../services/export';
import { useDataStore } from '../../store/data-store';
import { useProjectStore } from '../../store/project-store';
import { createBookContentRepository } from '../../sqlite-repo/content-repo';
import type { EntityKind } from '../../lib/extensions/entity-link';

interface ExportDialogProps {
  open: boolean;
  onClose: () => void;
}

const FORMATS: { value: ExportFormat; label: string; sub: string }[] = [
  { value: 'markdown', label: 'Markdown', sub: '.md · 适合静态站点 / GitHub' },
  { value: 'docx', label: 'Word', sub: '.docx · 投稿与编辑通用' },
  { value: 'epub', label: 'EPUB', sub: '.epub · 移动阅读器与 Kindle' },
];

type Destination = 'local' | 'cloud';

export function ExportDialog({ open, onClose }: ExportDialogProps) {
  const { projectId } = useParams<{ projectId: string }>();
  const [format, setFormat] = useState<ExportFormat>('markdown');
  const [destination, setDestination] = useState<Destination>('local');
  const [cloudConfigured, setCloudConfigured] = useState<boolean | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [doneMessage, setDoneMessage] = useState<string | null>(null);

  // Pull data needed to assemble the book.
  const nodes = useDataStore((s) => s.bookNodes);
  const elements = useDataStore((s) => s.bookElements);
  const project = useProjectStore((s) =>
    projectId ? s.projects.find((p) => p.id === projectId) ?? null : null,
  );

  useEffect(() => {
    if (!open) return;
    void getExportCloudStatus().then((s) => setCloudConfigured(s.configured));
  }, [open]);

  // Stable label resolver for entity links in body text.
  const resolveLabel = useMemo(() => {
    return (kind: EntityKind, id: string): string => {
      if (kind === 'element') {
        const el = elements.find((e) => e.id === id);
        return el?.name ?? '[元素已删除]';
      }
      if (kind === 'node') {
        const n = nodes.find((b) => b.id === id);
        return n?.title ?? '[章节已删除]';
      }
      return '[未知引用]';
    };
  }, [elements, nodes]);

  if (!open) return null;

  const run = async () => {
    setRunning(true);
    setError(null);
    setDoneMessage(null);
    try {
      if (!project || !projectId) throw new Error('Project not loaded');

      // Assemble chapters from the node store. We pull stored content
      // JSON and turn it into ProseMirror nodes via the editor schema.
      // The schema instance is reused from a temporary parser — pulling
      // it from a live editor would couple us to a mount; we instead
      // import the StarterKit on demand to build a transient schema.
      const { getBookSchema } = await import('../../lib/extensions/book-schema');
      const schema: Schema = getBookSchema();

      // Drift nodes (mainStorylineId === null) are inspiration fragments,
      // not chapters in the manuscript — exclude them from book export.
      // The remaining are ordered by their timeline `start` so the book
      // reads in story-time order, matching the timeline rail.
      const bookNodes = nodes
        .filter((n) => n.projectId === projectId && n.mainStorylineId !== null)
        .sort((a, b) => (a.start ?? 0) - (b.start ?? 0));

      const repo = createBookContentRepository();
      const chapters = await Promise.all(
        bookNodes.map(async (n) => {
          const content = await repo.findByNodeId(n.id);
          const raw = content?.contentJson ?? '{}';
          let json: unknown;
          try {
            json = JSON.parse(raw);
            if (!json || typeof json !== 'object' || !('type' in (json as object))) {
              json = { type: 'doc', content: [] };
            }
          } catch {
            json = { type: 'doc', content: [] };
          }
          const doc = PMNode.fromJSON(schema, json as Parameters<typeof PMNode.fromJSON>[1]);
          return { id: n.id, title: n.title || '未命名章节', doc };
        }),
      );

      const book = {
        title: project.name ?? '未命名',
        author: undefined,
        language: 'zh-CN',
        chapters,
      };

      const result = await buildExport(book, format, { resolveLabel });

      if (destination === 'local') {
        saveBlobLocally(result);
        setDoneMessage(`已保存为 ${result.filename}`);
      } else {
        const { jobId } = await uploadToCloud(projectId, result, format);
        setDoneMessage(`已归档到云端 · 任务 #${jobId.slice(0, 8)}`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  };

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.4)',
        backdropFilter: 'blur(4px)',
        display: 'grid',
        placeItems: 'center',
        zIndex: 10000,
      }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 560,
          maxWidth: 'calc(100vw - 48px)',
          background: 'hsl(var(--surface))',
          border: '1px solid hsl(var(--rule))',
          borderRadius: 8,
          padding: 24,
          fontFamily: 'var(--font-sans)',
          color: 'hsl(var(--ink-1))',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h2
            style={{
              fontFamily: 'var(--font-serif)',
              fontSize: 22,
              fontWeight: 400,
              margin: 0,
            }}
          >
            导出整本
          </h2>
          <button
            onClick={onClose}
            style={{
              background: 'transparent',
              border: 0,
              cursor: 'pointer',
              color: 'hsl(var(--ink-3))',
            }}
          >
            <X size={18} />
          </button>
        </div>

        <p style={{ fontSize: 13, color: 'hsl(var(--ink-3))', marginTop: 8, marginBottom: 20 }}>
          挑一个格式与去处。Drifting 不会把稿件代理过 API 服务器：本地是浏览器下载，云端是
          预签名直传 R2。
        </p>

        <section style={{ marginBottom: 18 }}>
          <div className="set-sec__title" style={{ marginBottom: 10 }}>格式 · FORMAT</div>
          <div style={{ display: 'flex', gap: 8 }}>
            {FORMATS.map((f) => (
              <button
                key={f.value}
                onClick={() => setFormat(f.value)}
                className={'set-tier' + (format === f.value ? ' set-tier--active' : '')}
                style={{ flex: 1, textAlign: 'left' }}
              >
                <div className="set-tier__name">{f.label}</div>
                <div className="set-tier__desc">{f.sub}</div>
              </button>
            ))}
          </div>
        </section>

        <section style={{ marginBottom: 18 }}>
          <div className="set-sec__title" style={{ marginBottom: 10 }}>去处 · DESTINATION</div>
          <div className="seg" style={{ width: '100%' }}>
            <button
              className={'seg__btn' + (destination === 'local' ? ' seg__btn--active' : '')}
              onClick={() => setDestination('local')}
              style={{ flex: 1 }}
            >
              本地文件
            </button>
            <button
              className={'seg__btn' + (destination === 'cloud' ? ' seg__btn--active' : '')}
              onClick={() => setDestination('cloud')}
              style={{ flex: 1 }}
              disabled={cloudConfigured === false}
              title={
                cloudConfigured === false
                  ? '后台未配置 R2 凭证。填入 R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY 后即可启用。'
                  : '上传到 Cloudflare R2 桶，跨设备可下载'
              }
            >
              云端归档{cloudConfigured === false ? ' · 未配置' : ''}
            </button>
          </div>
        </section>

        {error && (
          <div
            style={{
              padding: 10,
              background: 'hsl(var(--accent) / 0.08)',
              border: '1px solid hsl(var(--accent) / 0.3)',
              borderRadius: 4,
              fontSize: 12,
              color: 'hsl(var(--accent))',
              marginBottom: 12,
            }}
          >
            {error}
          </div>
        )}
        {doneMessage && (
          <div
            style={{
              padding: 10,
              background: 'hsl(var(--paper-deep))',
              borderRadius: 4,
              fontSize: 12,
              color: 'hsl(var(--ink-2))',
              marginBottom: 12,
            }}
          >
            {doneMessage}
          </div>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6 }}>
          <button className="set-btn" onClick={onClose}>
            关闭
          </button>
          <button
            className="set-btn set-btn--primary"
            onClick={run}
            disabled={running || (destination === 'cloud' && cloudConfigured === false)}
          >
            {running ? '导出中…' : '开始导出'}
          </button>
        </div>
      </div>
    </div>
  );
}
