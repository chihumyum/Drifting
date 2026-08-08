import { ArrowLeft } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';

/**
 * Explicit mobile boundary while the product-level workspace design remains
 * intentionally deferred. It prevents a mobile target from falling through
 * to DesktopAppShell when a shelf item is opened.
 */
export function MobileWorkspaceDeferredView() {
  const { i18n } = useTranslation();
  const navigate = useNavigate();
  const isZh = i18n.language.startsWith('zh');

  return (
    <main className="m-workspace-deferred">
      <header>
        <button
          type="button"
          onClick={() => navigate('/', { replace: true })}
          aria-label={isZh ? '返回书架' : 'Back to shelf'}
        >
          <ArrowLeft size={20} aria-hidden="true" />
        </button>
        <strong>Drifting</strong>
      </header>
      <section>
        <span>{isZh ? '移动工作区' : 'Mobile workspace'}</span>
        <h1>{isZh ? '这部分会使用新的工作区方案' : 'This area will use the new workspace design'}</h1>
        <p>
          {isZh
            ? '登录、书架与设置可以独立使用；章节编辑和工作区暂时保持未接入状态。'
            : 'Authentication, shelf and settings remain available while the mobile writing workspace is intentionally deferred.'}
        </p>
        <button type="button" onClick={() => navigate('/', { replace: true })}>
          {isZh ? '返回书架' : 'Back to shelf'}
        </button>
      </section>
    </main>
  );
}
