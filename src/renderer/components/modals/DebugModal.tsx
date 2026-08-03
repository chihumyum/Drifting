/**
 * Debug Modal Component
 *
 * 显示服务器端和 SQLite 端的所有用户数据
 */

import { useState } from 'react';
import { X, Database, Server, RefreshCw, Copy, Check } from 'lucide-react';
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
      return <div className="text-center py-8 text-gray-500">点击"刷新"按钮加载数据</div>;
    }

    return (
      <div className="space-y-4">
        <div className="flex items-center justify-between mb-2">
          <h3 className="font-medium text-gray-900">{title}</h3>
          <button
            onClick={() => copyToClipboard(data)}
            className="flex items-center gap-1 rounded-[1px] bg-gray-100 px-2 py-1 text-xs transition-colors hover:bg-gray-200"
          >
            {copied ? <Check size={14} /> : <Copy size={14} />}
            {copied ? '已复制' : '复制'}
          </button>
        </div>

        <div className="max-h-96 overflow-auto rounded-[2px] bg-gray-50 p-4">
          <pre className="text-xs text-gray-800 whitespace-pre-wrap break-words">
            {JSON.stringify(data, null, 2)}
          </pre>
        </div>

        {/* 数据统计 */}
        <div className="grid grid-cols-2 md:grid-cols-3 gap-2 text-sm">
          <div className="rounded-[1px] bg-blue-50 p-2">
            <div className="text-blue-600 font-medium">项目</div>
            <div className="text-blue-900">
              {Array.isArray((data as LocalDebugData).projects)
                ? (data as LocalDebugData).projects.length
                : 0}{' '}
              个
            </div>
          </div>
          <div className="rounded-[1px] bg-green-50 p-2">
            <div className="text-green-600 font-medium">节点</div>
            <div className="text-green-900">
              {Array.isArray((data as LocalDebugData).nodes)
                ? (data as LocalDebugData).nodes.length
                : 0}{' '}
              个
            </div>
          </div>
          <div className="rounded-[1px] bg-purple-50 p-2">
            <div className="text-purple-600 font-medium">故事线</div>
            <div className="text-purple-900">
              {Array.isArray((data as LocalDebugData).storylines)
                ? (data as LocalDebugData).storylines.length
                : 0}{' '}
              个
            </div>
          </div>
          <div className="rounded-[1px] bg-yellow-50 p-2">
            <div className="text-yellow-600 font-medium">元素</div>
            <div className="text-yellow-900">
              {Array.isArray((data as LocalDebugData).elements)
                ? (data as LocalDebugData).elements.length
                : 0}{' '}
              个
            </div>
          </div>
          <div className="rounded-[1px] bg-pink-50 p-2">
            <div className="text-pink-600 font-medium">分类</div>
            <div className="text-pink-900">
              {Array.isArray((data as LocalDebugData).categories)
                ? (data as LocalDebugData).categories.length
                : 0}{' '}
              个
            </div>
          </div>
          <div className="rounded-[1px] bg-indigo-50 p-2">
            <div className="text-indigo-600 font-medium">用户</div>
            <div className="text-indigo-900">{user?.email || 'N/A'}</div>
          </div>
        </div>
      </div>
    );
  };

  // 对比视图
  const renderComparison = () => {
    if (!serverData || !sqliteData) {
      return <div className="text-center py-8 text-gray-500">请先加载服务器和 SQLite 数据</div>;
    }

    const compareCount = (serverCount: number, sqliteCount: number) => {
      if (serverCount === sqliteCount) {
        return <span className="text-green-600">✓ 一致</span>;
      }
      return (
        <span className="text-red-600">✗ 不一致 (差异: {Math.abs(serverCount - sqliteCount)})</span>
      );
    };

    return (
      <div className="space-y-4">
        <h3 className="font-medium text-gray-900 mb-4">数据对比</h3>

        <div className="space-y-2">
          <div className="grid grid-cols-4 gap-2 text-sm font-medium text-gray-700 border-b pb-2">
            <div>类型</div>
            <div className="text-right">服务器</div>
            <div className="text-right">SQLite</div>
            <div>状态</div>
          </div>

          {[
            { label: '项目', key: 'projects' as const },
            { label: '节点', key: 'nodes' as const },
            { label: '故事线', key: 'storylines' as const },
            { label: '元素', key: 'elements' as const },
            { label: '分类', key: 'categories' as const },
          ].map(({ label, key }) => {
            const serverCount = (serverData?.[key] as unknown[])?.length || 0;
            const sqliteCount = (sqliteData?.[key] as unknown[])?.length || 0;

            return (
              <div key={key} className="grid grid-cols-4 gap-2 text-sm py-2 border-b">
                <div className="font-medium">{label}</div>
                <div className="text-right">{serverCount}</div>
                <div className="text-right">{sqliteCount}</div>
                <div className="text-sm">{compareCount(serverCount, sqliteCount)}</div>
              </div>
            );
          })}
        </div>

        {/* 详细差异 */}
        <div className="mt-4 rounded-[2px] border border-yellow-200 bg-yellow-50 p-4">
          <h4 className="font-medium text-yellow-800 mb-2">⚠️ 同步建议</h4>
          <ul className="text-sm text-yellow-700 space-y-1">
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
                <li className="text-green-700">✓ 数据已同步</li>
              )}
          </ul>
        </div>
      </div>
    );
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="flex max-h-[90vh] w-full max-w-4xl flex-col rounded-[2px] bg-white shadow-lg">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b">
          <div className="flex items-center gap-2">
            <Database className="text-blue-600" size={24} />
            <h2 className="text-lg font-semibold text-gray-900">Debug 数据查看器</h2>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={loadAllData}
              disabled={loading}
              className="flex items-center gap-1 rounded-[1px] bg-blue-600 px-3 py-1.5 text-sm text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
              {loading ? '加载中...' : '刷新数据'}
            </button>
            <button onClick={onClose} className="rounded-[1px] p-1 transition-colors hover:bg-gray-100">
              <X size={20} />
            </button>
          </div>
        </div>

        {/* Tabs */}
        <div className="flex border-b">
          <button
            onClick={() => setActiveTab('server')}
            className={`flex items-center gap-2 px-4 py-3 font-medium transition-colors ${
              activeTab === 'server'
                ? 'text-blue-600 border-b-2 border-blue-600'
                : 'text-gray-600 hover:text-gray-900'
            }`}
          >
            <Server size={18} />
            服务器数据
          </button>
          <button
            onClick={() => setActiveTab('sqlite')}
            className={`flex items-center gap-2 px-4 py-3 font-medium transition-colors ${
              activeTab === 'sqlite'
                ? 'text-blue-600 border-b-2 border-blue-600'
                : 'text-gray-600 hover:text-gray-900'
            }`}
          >
            <Database size={18} />
            SQLite 数据
          </button>
          <button
            onClick={() => setActiveTab('compare')}
            className={`flex items-center gap-2 px-4 py-3 font-medium transition-colors ${
              activeTab === 'compare'
                ? 'text-blue-600 border-b-2 border-blue-600'
                : 'text-gray-600 hover:text-gray-900'
            }`}
          >
            对比分析
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-auto p-4">
          {activeTab === 'server' && renderData(serverData, '服务器端数据')}
          {activeTab === 'sqlite' && renderData(sqliteData, 'SQLite 本地数据')}
          {activeTab === 'compare' && renderComparison()}
        </div>

        {/* Footer */}
        <div className="border-t p-4 bg-gray-50 text-xs text-gray-500">
          <div className="flex items-center justify-between">
            <div>
              当前用户: <span className="font-medium text-gray-700">{user?.email || '未登录'}</span>
            </div>
            <div>
              数据刷新时间:{' '}
              {serverData || sqliteData ? new Date().toLocaleString('zh-CN') : '未加载'}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
