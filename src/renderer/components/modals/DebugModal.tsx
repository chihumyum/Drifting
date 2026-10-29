/**
 * Debug Modal Component
 *
 * 显示服务器端和 SQLite 端的所有用户数据
 */

import { useState } from 'react';
import { debugApi, type DebugData } from '../../services/api/debug-api';
import { useAuthStore } from '../../store/auth';
import loglevel from 'loglevel';

const log = loglevel.getLogger('DebugModal');
log.setLevel(loglevel.levels.ERROR);
import { getDb } from '../../lib/db';
import {
  BookNodeTable,
  StorylineTable,
  BookElementTable,
  ElementCategoryTable,
} from '../../schema/drizzle';
import { Button } from '../ui/Button';
import { GlassSlider } from '../ui/GlassSlider';
import { ModalActions, ModalBody, ModalCard, ModalHeader, ModalRoot } from '../ui/Modal';

interface DebugModalProps {
  isOpen: boolean;
  onClose: () => void;
}

interface LocalDebugData {
  user: unknown;
  projects: unknown[];
  nodes: unknown[];
  storylines: unknown[];
  elements: unknown[];
  categories: unknown[];
  stages?: unknown[];
}

export function DebugModal({ isOpen, onClose }: DebugModalProps) {
  const { user } = useAuthStore();
  const [serverData, setServerData] = useState<DebugData['serverData'] | null>(null);
  const [sqliteData, setSqliteData] = useState<LocalDebugData | null>(null);
  const [loading, setLoading] = useState(false);
  const [activeTab, setActiveTab] = useState<'server' | 'sqlite' | 'compare'>('server');
  const [copied, setCopied] = useState(false);

  if (!isOpen) return null;

  // 加载服务器端数据
  const loadServerData = async () => {
    setLoading(true);
    try {
      const data = await debugApi.getServerData();
      setServerData(data);
      log.debug('[Debug] Server data loaded:', data);
    } catch (error) {
      log.error('[Debug] Failed to load server data:', error);
      alert('加载服务器数据失败');
    } finally {
      setLoading(false);
    }
  };

  // 加载 SQLite 端数据
  const loadSQLiteData = async () => {
    setLoading(true);
    try {
      // 直接查询所有表，使用 Promise.allSettled 避免单个表失败导致整体失败
      const results = await Promise.allSettled([
        getDb().select().from(BookNodeTable),
        getDb().select().from(StorylineTable),
        getDb().select().from(BookElementTable),
        getDb().select().from(ElementCategoryTable),
      ]);

      const data = {
        user: user,
        projects: [], // SQLite 没有存储 projects
        nodes: results[0].status === 'fulfilled' ? results[0].value : [],
        storylines: results[1].status === 'fulfilled' ? results[1].value : [],
        elements: results[2].status === 'fulfilled' ? results[2].value : [],
        categories: results[3].status === 'fulfilled' ? results[3].value : [],
      };

      setSqliteData(data);
      log.debug('[Debug] SQLite data loaded:', data);
    } catch (error) {
      log.error('[Debug] Failed to load SQLite data:', error);
      alert('加载 SQLite 数据失败: ' + (error as Error).message);
    } finally {
      setLoading(false);
    }
  };

  // 加载所有数据
  const loadAllData = async () => {
    await Promise.all([loadServerData(), loadSQLiteData()]);
  };

  // 复制数据到剪贴板
  const copyToClipboard = (data: unknown) => {
    const json = JSON.stringify(data, null, 2);
    navigator.clipboard.writeText(json);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // 渲染 JSON 数据
  const renderData = (data: LocalDebugData | DebugData['serverData'] | null, title: string) => {
    if (!data) {
      return <div className="debug-modal__muted">点击"刷新"按钮加载数据</div>;
    }

    return (
      <div className="space-y-4">
        <div className="flex items-center justify-between mb-2">
          <h3 className="debug-modal__title">{title}</h3>
          <Button variant="ghost" size="sm" onClick={() => copyToClipboard(data)}>
            {copied ? '已复制' : '复制'}
          </Button>
        </div>

        <div className="debug-modal__pre">
          <pre>
            {JSON.stringify(data, null, 2)}
          </pre>
        </div>

        {/* 数据统计 */}
        <div className="debug-modal__stats">
          <div className="debug-modal__stat">
            <div className="debug-modal__stat-label">项目</div>
            <div className="debug-modal__stat-value">
              {Array.isArray((data as LocalDebugData).projects)
                ? (data as LocalDebugData).projects.length
                : 0}{' '}
              个
            </div>
          </div>
          <div className="debug-modal__stat">
            <div className="debug-modal__stat-label">节点</div>
            <div className="debug-modal__stat-value">
              {Array.isArray((data as LocalDebugData).nodes)
                ? (data as LocalDebugData).nodes.length
                : 0}{' '}
              个
            </div>
          </div>
          <div className="debug-modal__stat">
            <div className="debug-modal__stat-label">故事线</div>
            <div className="debug-modal__stat-value">
              {Array.isArray((data as LocalDebugData).storylines)
                ? (data as LocalDebugData).storylines.length
                : 0}{' '}
              个
            </div>
          </div>
          <div className="debug-modal__stat">
            <div className="debug-modal__stat-label">要素</div>
            <div className="debug-modal__stat-value">
              {Array.isArray((data as LocalDebugData).elements)
                ? (data as LocalDebugData).elements.length
                : 0}{' '}
              个
            </div>
          </div>
          <div className="debug-modal__stat">
            <div className="debug-modal__stat-label">分类</div>
            <div className="debug-modal__stat-value">
              {Array.isArray((data as LocalDebugData).categories)
                ? (data as LocalDebugData).categories.length
                : 0}{' '}
              个
            </div>
          </div>
          <div className="debug-modal__stat">
            <div className="debug-modal__stat-label">用户</div>
            <div className="debug-modal__stat-value">{user?.email || 'N/A'}</div>
          </div>
        </div>
      </div>
    );
  };

  // 对比视图
  const renderComparison = () => {
    if (!serverData || !sqliteData) {
      return <div className="debug-modal__muted">请先加载服务器和 SQLite 数据</div>;
    }

    const compareCount = (serverCount: number, sqliteCount: number) => {
      if (serverCount === sqliteCount) {
        return <span className="debug-modal__ok">一致</span>;
      }
      return (
        <span className="debug-modal__bad">不一致 (差异: {Math.abs(serverCount - sqliteCount)})</span>
      );
    };

    return (
      <div className="space-y-4">
        <h3 className="debug-modal__title">数据对比</h3>

        <div className="space-y-2">
          <div className="debug-modal__compare debug-modal__compare--head">
            <div>类型</div>
            <div className="debug-modal__num">服务器</div>
            <div className="debug-modal__num">SQLite</div>
            <div>状态</div>
          </div>

          {[
            { label: '项目', key: 'projects' as const },
            { label: '节点', key: 'nodes' as const },
            { label: '故事线', key: 'storylines' as const },
            { label: '要素', key: 'elements' as const },
            { label: '分类', key: 'categories' as const },
          ].map(({ label, key }) => {
            const serverCount = (serverData?.[key] as unknown[])?.length || 0;
            const sqliteCount = (sqliteData?.[key] as unknown[])?.length || 0;

            return (
              <div key={key} className="debug-modal__compare">
                <div>{label}</div>
                <div className="debug-modal__num">{serverCount}</div>
                <div className="debug-modal__num">{sqliteCount}</div>
                <div>{compareCount(serverCount, sqliteCount)}</div>
              </div>
            );
          })}
        </div>

        {/* 详细差异 */}
        <div className="debug-modal__note">
          <h4 className="debug-modal__title">同步建议</h4>
          <ul className="debug-modal__list">
            {serverData.projects?.length > sqliteData.projects?.length && (
              <li>
                • SQLite 缺少 {serverData.projects.length - sqliteData.projects.length}{' '}
                个项目，建议执行同步拉取
              </li>
            )}
            {sqliteData.projects?.length > serverData.projects?.length && (
              <li>
                • 服务器缺少 {sqliteData.projects.length - serverData.projects.length}{' '}
                个项目，建议执行同步推送
              </li>
            )}
            {serverData.nodes?.length > sqliteData.nodes?.length && (
              <li>• SQLite 缺少 {serverData.nodes.length - sqliteData.nodes.length} 个节点</li>
            )}
            {sqliteData.nodes?.length > serverData.nodes?.length && (
              <li>• 服务器缺少 {sqliteData.nodes.length - serverData.nodes.length} 个节点</li>
            )}
            {serverData.projects?.length === sqliteData.projects?.length &&
              serverData.nodes?.length === sqliteData.nodes?.length && (
                <li className="debug-modal__ok">数据已同步</li>
              )}
          </ul>
        </div>
      </div>
    );
  };

  // The shared dialog shell; tabs are a GlassSlider. The Debug panel carries no icons.
  return (
    <ModalRoot onClose={onClose} ariaLabel="Debug 数据查看器">
      <ModalCard className="debug-modal" width={900}>
        <ModalHeader title="Debug 数据查看器" onClose={onClose} closeLabel="关闭" />
        <div className="debug-modal__tabs">
          <GlassSlider
            ariaLabel="数据来源"
            value={activeTab}
            onChange={setActiveTab}
            options={[
              { value: 'server', label: '服务器数据' },
              { value: 'sqlite', label: 'SQLite 数据' },
              { value: 'compare', label: '对比分析' },
            ]}
          />
        </div>
        <ModalBody>
          {activeTab === 'server' && renderData(serverData, '服务器端数据')}
          {activeTab === 'sqlite' && renderData(sqliteData, 'SQLite 本地数据')}
          {activeTab === 'compare' && renderComparison()}
        </ModalBody>
        <ModalActions className="debug-modal__footer">
          <span className="debug-modal__meta">
            当前用户: {user?.email || '未登录'} · 数据刷新时间:{' '}
            {serverData || sqliteData ? new Date().toLocaleString('zh-CN') : '未加载'}
          </span>
          <Button variant="primary" onClick={loadAllData} disabled={loading}>
            {loading ? '加载中...' : '刷新数据'}
          </Button>
        </ModalActions>
      </ModalCard>
    </ModalRoot>
  );
}
