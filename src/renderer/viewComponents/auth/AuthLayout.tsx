import type { ReactNode } from 'react';
import { ArrowRight, PenLine, ShieldCheck, Sparkles, Users } from 'lucide-react';

export interface AuthFeatureItem {
  title: string;
  description: string;
  icon: ReactNode;
}

interface AuthLayoutProps {
  children: ReactNode;
  heroEyebrow: string;
  heroTitle: string;
  heroHighlight?: string;
  heroSubtitle: string;
  features?: AuthFeatureItem[];
}

const defaultFeatures: AuthFeatureItem[] = [
  {
    title: 'AI 灵感伴侣',
    description: '根据章节结构自动生成提示，帮助你在写作时保持灵感流动。',
    icon: <Sparkles className="h-5 w-5" />,
  },
  {
    title: '多人协作',
    description: '邀请合作者一起编辑故事线，让复杂的世界观更容易管理。',
    icon: <Users className="h-5 w-5" />,
  },
  {
    title: '版本守护',
    description: '自动保存与历史快照结合，让每一次修改都可追溯。',
    icon: <ShieldCheck className="h-5 w-5" />,
  },
];

export function AuthLayout({
  children,
  heroEyebrow,
  heroTitle,
  heroHighlight,
  heroSubtitle,
  features = defaultFeatures,
}: AuthLayoutProps) {
  return (
    <div className="relative min-h-screen overflow-hidden bg-slate-950 text-slate-100">
      {/* Background gradients */}
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute inset-0 bg-gradient-to-br from-slate-950 via-slate-900 to-black" />
        <div className="absolute -left-1/3 top-[-10%] h-[480px] w-[480px] rounded-full bg-[radial-gradient(circle_at_top,_rgba(184,153,104,0.35),_transparent_70%)] blur-3xl" />
        <div className="absolute right-[-25%] bottom-[-20%] h-[520px] w-[520px] rounded-full bg-[radial-gradient(circle_at_top,_rgba(92,72,38,0.35),_transparent_70%)] blur-3xl" />
        <div className="absolute inset-0 bg-[url('data:image/svg+xml,%3Csvg width=\'320\' height=\'320\' viewBox=\'0 0 320 320\' xmlns=\'http://www.w3.org/2000/svg\'%3E%3Cg fill=\'none\' stroke=\'rgba(148,163,184,0.12)\' stroke-width=\'1\'%3E%3Cpath d=\'M0 0h320v320H0z\'/%3E%3Cpath d=\'M64 0v320M128 0v320M192 0v320M256 0v320M0 64h320M0 128h320M0 192h320M0 256h320\'/%3E%3C/g%3E%3C/svg%3E')] opacity-40" />
      </div>

      <div className="relative z-10 grid min-h-screen items-center lg:grid-cols-[minmax(0,_1.1fr)_minmax(0,_0.9fr)]">
        <div className="flex h-full flex-col justify-between px-8 py-12 lg:px-16">
          <div className="flex items-center justify-between text-sm text-slate-300">
            <span className="font-serif text-lg tracking-wide text-slate-100">Drifting</span>
            <a
              href="https://drifting.cc"
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-2 rounded-full border border-slate-700/60 bg-white/5 px-4 py-2 font-medium text-slate-200 transition hover:border-slate-500 hover:bg-white/10"
            >
              了解产品
              <ArrowRight className="h-4 w-4" />
            </a>
          </div>

          <div className="mt-16 max-w-xl space-y-6">
            <div className="inline-flex items-center gap-2 rounded-full border border-slate-700/70 bg-white/5 px-4 py-2 text-xs uppercase tracking-[0.3em] text-slate-300">
              <PenLine className="h-4 w-4 text-[#b89968]" />
              {heroEyebrow}
            </div>
            <h1 className="text-4xl font-serif font-semibold leading-tight text-slate-50 sm:text-5xl">
              {heroTitle}
              {heroHighlight ? (
                <span className="ml-2 bg-gradient-to-r from-[#b89968] via-[#d9c3a0] to-[#b89968] bg-clip-text text-transparent">
                  {heroHighlight}
                </span>
              ) : null}
            </h1>
            <p className="text-lg leading-relaxed text-slate-300">{heroSubtitle}</p>
            <div className="flex flex-wrap items-center gap-3 text-sm text-slate-300">
              <ShieldCheck className="h-4 w-4 text-[#b89968]" />
              云端数据加密存储
              <span className="h-1 w-1 rounded-full bg-slate-600" />
              <Users className="h-4 w-4 text-[#b89968]" />
              支持团队协作
              <span className="h-1 w-1 rounded-full bg-slate-600" />
              <Sparkles className="h-4 w-4 text-[#b89968]" />
              AI 章节建议
            </div>
          </div>

          <div className="mt-16 grid gap-4 sm:grid-cols-2">
            {features.map((feature) => (
              <div
                key={feature.title}
                className="rounded-2xl border border-white/10 bg-white/5 p-5 backdrop-blur transition hover:border-[#b89968]/40 hover:bg-white/10"
              >
                <div className="mb-3 inline-flex h-9 w-9 items-center justify-center rounded-full border border-[#b89968]/40 bg-white/10 text-[#f5e9d7]">
                  {feature.icon}
                </div>
                <h3 className="text-base font-semibold text-slate-100">{feature.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-slate-300">{feature.description}</p>
              </div>
            ))}
          </div>
        </div>

        <div className="flex h-full items-center justify-center px-6 py-16 lg:px-12">
          <div className="w-full max-w-md rounded-3xl border border-white/10 bg-white/90 p-10 text-slate-900 shadow-[0_20px_50px_rgba(15,23,42,0.35)] backdrop-blur">
            {children}
          </div>
        </div>
      </div>
    </div>
  );
}
