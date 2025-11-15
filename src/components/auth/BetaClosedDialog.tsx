import { Sparkles } from 'lucide-react';

interface BetaClosedDialogProps {
  open: boolean;
  onClose: () => void;
}

export function BetaClosedDialog({ open, onClose }: BetaClosedDialogProps) {
  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 px-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="beta-dialog-title"
      aria-describedby="beta-dialog-description"
      onClick={onClose}
    >
      <div
        className="w-full max-w-sm rounded-3xl border border-slate-200 bg-white p-6 text-center shadow-2xl shadow-[#8b6f47]/20"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-[#f2e7d7] text-[#8b6f47]">
          <Sparkles className="h-6 w-6" aria-hidden="true" />
        </div>
        <div className="space-y-2">
          <h3 id="beta-dialog-title" className="text-lg font-semibold text-slate-900">
            Drifting 正在内测
          </h3>
          <p id="beta-dialog-description" className="text-sm leading-relaxed text-slate-500">
            我们尚未开放新的注册与登录。请留下您的信息或关注后续通知，感谢您的期待与支持。
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="mt-6 inline-flex w-full items-center justify-center rounded-2xl bg-[#b89968] px-4 py-2 text-sm font-semibold text-white transition hover:bg-[#a68858]"
        >
          我知道了
        </button>
      </div>
    </div>
  );
}
