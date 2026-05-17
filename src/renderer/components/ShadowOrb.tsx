import { useRef, useState } from 'react';
import { useUiStore } from '../store/ui-store';

export function ShadowOrb() {
  const active = useUiStore((s) => s.shadowMode);
  const toggle = useUiStore((s) => s.toggleShadowMode);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [wave, setWave] = useState<{ x: number; y: number } | null>(null);

  const handleClick = () => {
    const rect = wrapRef.current?.getBoundingClientRect();
    if (rect) {
      const x = ((rect.left + rect.width / 2) / window.innerWidth) * 100;
      const y = ((rect.top + rect.height / 2) / window.innerHeight) * 100;
      setWave({ x, y });
      window.setTimeout(() => setWave(null), 850);
    }
    toggle();
  };

  return (
    <>
      <style>{`
        @keyframes shadow-orb-breath {
          0%, 100% { transform: scale(1); }
          50%      { transform: scale(1.02); }
        }
        @keyframes shadow-orb-ink-drift {
          0%, 100% { transform: translate(0%, 0%) scale(1); }
          25%      { transform: translate(8%, -6%) scale(1.08); }
          50%      { transform: translate(-4%, 10%) scale(0.94); }
          75%      { transform: translate(-10%, 0%) scale(1.04); }
        }
        @keyframes shadow-orb-wave {
          0%   { opacity: 0; transform: scale(0.4); }
          50%  { opacity: 1; }
          100% { opacity: 0; transform: scale(2.4); }
        }
        .shadow-orb-wrap { pointer-events: none; }
        .shadow-orb {
          position: relative; width: 40px; height: 40px;
          border-radius: 50%;
          cursor: pointer; pointer-events: auto;
          overflow: hidden; isolation: isolate;
          background:
            radial-gradient(circle at 30% 22%, rgba(255,255,255,0.55) 0%, rgba(255,255,255,0.18) 14%, transparent 32%),
            radial-gradient(circle at 65% 78%, rgba(255,255,255,0.10) 0%, transparent 40%),
            radial-gradient(circle at 50% 50%, rgba(220,228,238,0.55) 0%, rgba(170,184,206,0.55) 65%, rgba(130,148,176,0.7) 100%);
          filter: drop-shadow(0 6px 12px rgba(20,25,40,0.35)) drop-shadow(0 2px 3px rgba(20,25,40,0.25));
          transition: transform 200ms ease, filter 400ms ease;
          animation: shadow-orb-breath 7s ease-in-out infinite;
        }
        .shadow-orb:hover { transform: scale(1.08); }
        .shadow-orb__ink { position: absolute; inset: 4%; border-radius: 50%; pointer-events: none; z-index: 2; }
        .shadow-orb__drop {
          position: absolute;
          width: 46%; height: 46%;
          left: 22%; top: 38%;
          background: radial-gradient(circle at 40% 45%, rgba(8,5,25,0.85) 0%, rgba(20,15,45,0.55) 40%, rgba(35,30,75,0.18) 70%, transparent 90%);
          filter: blur(2px);
          border-radius: 50%;
          animation: shadow-orb-ink-drift 11s ease-in-out infinite;
          mix-blend-mode: multiply;
        }
        .shadow-orb__drop--b {
          width: 30%; height: 30%; left: 48%; top: 22%; opacity: 0.55;
          animation-duration: 14s; animation-direction: reverse; animation-delay: -3s;
        }
        .shadow-orb__rim {
          position: absolute; inset: 0; border-radius: 50%; pointer-events: none; z-index: 3;
          box-shadow: inset 0 0 0 0.5px rgba(255,255,255,0.45), inset 0 -3px 6px rgba(40,55,80,0.35);
        }
        .shadow-orb--active {
          background:
            radial-gradient(circle at 30% 22%, rgba(220,210,255,0.4) 0%, rgba(220,210,255,0.1) 14%, transparent 30%),
            radial-gradient(circle at 65% 78%, rgba(180,168,224,0.18) 0%, transparent 40%),
            radial-gradient(circle at 50% 55%, rgba(70,55,110,0.85) 0%, rgba(35,25,70,0.92) 50%, rgba(15,8,30,0.95) 100%);
          filter: drop-shadow(0 6px 16px rgba(80,60,140,0.5)) drop-shadow(0 2px 3px rgba(20,15,35,0.4));
        }
        .shadow-orb--active .shadow-orb__drop {
          background: radial-gradient(circle at 40% 45%, rgba(0,0,0,0.92) 0%, rgba(20,10,45,0.7) 35%, rgba(60,40,110,0.35) 70%, transparent 90%);
          inset: -10%; width: 80%; height: 80%; left: 10%; top: 10%;
          filter: blur(3px); animation-duration: 6s;
        }
        .shadow-orb--active .shadow-orb__drop--b {
          width: 50%; height: 50%; left: 35%; top: 25%; opacity: 0.7; animation-duration: 8s;
        }
        .shadow-orb--active .shadow-orb__rim {
          box-shadow: inset 0 0 0 0.5px rgba(181,168,224,0.55), inset 0 0 12px rgba(181,168,224,0.3), inset 0 -3px 6px rgba(20,15,35,0.5);
        }
        .shadow-orb__label {
          position: absolute; top: 50%; right: 100%; transform: translateY(-50%);
          margin-right: 12px;
          font-family: var(--font-mono); font-size: 9.5px;
          text-transform: uppercase; letter-spacing: 0.16em;
          color: hsl(var(--ink-3));
          white-space: nowrap; opacity: 0;
          transition: opacity 0.2s; pointer-events: none;
        }
        .shadow-orb-wrap:hover .shadow-orb__label { opacity: 0.85; }
        .shadow-orb--active ~ .shadow-orb__label,
        .shadow-orb-wrap--active .shadow-orb__label { color: hsl(var(--accent)); opacity: 0.9; }

        .shadow-orb-wave {
          position: fixed; inset: 0; pointer-events: none; z-index: 150;
          opacity: 0;
          background: radial-gradient(circle at var(--orb-x, 95%) var(--orb-y, 92%),
            rgba(20, 15, 45, 0.55) 0%, rgba(20, 15, 45, 0.32) 30%, rgba(20, 15, 45, 0) 65%);
          animation: shadow-orb-wave 850ms ease forwards;
        }
        .shadow-vignette {
          position: fixed; inset: 0; pointer-events: none; z-index: 1;
          opacity: 0; transition: opacity 700ms ease 200ms;
          mix-blend-mode: multiply;
        }
        html:not(.dark) .shadow-vignette--on {
          background: radial-gradient(ellipse at center, transparent 70%, rgba(80,90,140,0.06) 100%);
          opacity: 1;
        }
        html.dark .shadow-vignette--on {
          background: radial-gradient(ellipse at center, transparent 60%, rgba(0,0,0,0.22) 100%);
          opacity: 1;
        }
      `}</style>

      <div
        ref={wrapRef}
        className={`shadow-orb-wrap${active ? ' shadow-orb-wrap--active' : ''}`}
        style={
          {
            position: 'fixed',
            right: 18,
            bottom: 38,
            width: 40,
            height: 40,
            zIndex: 200,
          } as React.CSSProperties
        }
      >
        <div
          className={`shadow-orb${active ? ' shadow-orb--active' : ''}`}
          onClick={handleClick}
          title={active ? '退回 Shadow' : '唤起 Shadow'}
        >
          <div className="shadow-orb__ink">
            <span className="shadow-orb__drop" />
            <span className="shadow-orb__drop shadow-orb__drop--b" />
          </div>
          <div className="shadow-orb__rim" />
        </div>
        <span className="shadow-orb__label">
          {active ? '退回 · DISMISS' : '唤起 · INVOKE'}
        </span>
      </div>

      {wave && (
        <div
          className="shadow-orb-wave"
          style={
            {
              '--orb-x': `${wave.x}%`,
              '--orb-y': `${wave.y}%`,
            } as React.CSSProperties
          }
        />
      )}
      <div className={`shadow-vignette${active ? ' shadow-vignette--on' : ''}`} />
    </>
  );
}
