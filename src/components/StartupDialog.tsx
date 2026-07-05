import { useEffect, useRef } from "react";
import { useTranslation } from "../i18n";
import type { StartupDialogKind } from "../lib/startupDialog";

interface Props {
  kind: StartupDialogKind;
  version: string;
  onClose: () => void;
}

interface FireworkParticle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  delay: number;
  life: number;
  size: number;
  color: string;
}

function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

function createBurst(cx: number, cy: number, seed: number, delay: number, colors: string[]): FireworkParticle[] {
  const particles: FireworkParticle[] = [];
  for (let i = 0; i < 24; i += 1) {
    const angle = ((i * 137.5 + seed * 31) * Math.PI) / 180;
    const speed = 1.15 + ((i + seed) % 7) * 0.14;
    particles.push({
      x: cx,
      y: cy,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed - 0.35 - ((i + seed) % 3) * 0.05,
      delay: delay + (i % 4) * 2,
      life: 42 + ((i + seed) % 8),
      size: 1.4 + (i % 3) * 0.35,
      color: colors[(i + seed) % colors.length],
    });
  }
  return particles;
}

function createFireworkParticles(kind: StartupDialogKind): FireworkParticle[] {
  const colors = ["#70e1ff", "#ffd166", "#ff6b8a", "#8cffb4", "#c8a5ff"];
  const bursts =
    kind === "welcome"
      ? [
          { x: 92, y: 92, seed: 1, delay: 0 },
          { x: 222, y: 52, seed: 4, delay: 18 },
          { x: 355, y: 82, seed: 7, delay: 34 },
          { x: 448, y: 48, seed: 10, delay: 52 },
        ]
      : [
          { x: 112, y: 58, seed: 2, delay: 0 },
          { x: 278, y: 82, seed: 6, delay: 22 },
          { x: 430, y: 54, seed: 9, delay: 44 },
        ];
  return bursts.flatMap((burst) => createBurst(burst.x, burst.y, burst.seed, burst.delay, colors));
}

export default function StartupDialog({ kind, version, onClose }: Props) {
  const { t } = useTranslation();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const showFireworks = !prefersReducedMotion();
  const title = kind === "welcome" ? t("startupDialog.welcomeTitle") : t("startupDialog.updateTitle", { version });
  const items =
    kind === "welcome"
      ? ["startupDialog.welcomeItemConnections", "startupDialog.welcomeItemCompare", "startupDialog.welcomeItemSnapshots"]
      : [
          "startupDialog.updateItemSnapshots",
          "startupDialog.updateItemSnapshotDiff",
          "startupDialog.updateItemHistory",
          "startupDialog.updateItemPolish",
        ];
  const actionLabel = kind === "welcome" ? t("startupDialog.start") : t("startupDialog.gotIt");

  useEffect(() => {
    if (!showFireworks) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    let ctx: CanvasRenderingContext2D | null = null;
    try {
      ctx = canvas.getContext("2d");
    } catch {
      return;
    }
    if (!ctx) return;

    const width = 520;
    const height = 160;
    canvas.width = width;
    canvas.height = height;
    const particles = createFireworkParticles(kind);
    const maxFrame = Math.max(...particles.map((particle) => particle.delay + particle.life)) + 12;
    let frame = 0;
    let raf = 0;

    const clearCanvas = () => {
      ctx.globalAlpha = 1;
      ctx.clearRect(0, 0, width, height);
    };

    const draw = () => {
      frame += 1;
      ctx.clearRect(0, 0, width, height);

      for (const particle of particles) {
        const age = frame - particle.delay;
        if (age <= 0 || age > particle.life) continue;
        const progress = age / particle.life;
        const gravity = 0.035 * age * age;
        const x = particle.x + particle.vx * age;
        const y = particle.y + particle.vy * age + gravity;
        const previousX = particle.x + particle.vx * Math.max(0, age - 5);
        const previousY = particle.y + particle.vy * Math.max(0, age - 5) + 0.035 * Math.max(0, age - 5) * Math.max(0, age - 5);
        const alpha = Math.pow(1 - progress, 1.45);

        ctx.globalAlpha = alpha;
        ctx.strokeStyle = particle.color;
        ctx.lineWidth = Math.max(0.4, particle.size * (1 - progress));
        ctx.lineCap = "round";
        ctx.beginPath();
        ctx.moveTo(previousX, previousY);
        ctx.lineTo(x, y);
        ctx.stroke();

        ctx.fillStyle = particle.color;
        ctx.beginPath();
        ctx.arc(x, y, Math.max(0.6, particle.size * (1 - progress * 0.55)), 0, Math.PI * 2);
        ctx.fill();
      }

      ctx.globalAlpha = 1;
      if (frame < maxFrame) {
        raf = window.requestAnimationFrame(draw);
      } else {
        clearCanvas();
      }
    };

    raf = window.requestAnimationFrame(draw);
    return () => {
      if (raf) window.cancelAnimationFrame(raf);
      clearCanvas();
    };
  }, [kind, showFireworks]);

  return (
    <div className="startup-overlay">
      <section className={`startup-dialog ${kind}`} role="dialog" aria-modal="true" aria-labelledby="startup-dialog-title">
        {showFireworks && <canvas ref={canvasRef} className="startup-fireworks" data-testid="startup-fireworks" aria-hidden="true" />}
        <div className="startup-dialog-body">
          <div className="startup-dialog-kicker">{t("startupDialog.kicker")}</div>
          <h2 id="startup-dialog-title">{title}</h2>
          <ul className="startup-dialog-list">
            {items.map((key) => (
              <li key={key}>{t(key)}</li>
            ))}
          </ul>
          <div className="startup-dialog-actions">
            <button className="btn btn-primary" onClick={onClose}>
              {actionLabel}
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
