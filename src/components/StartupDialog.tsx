import { useEffect, useRef } from "react";
import { useTranslation } from "../i18n";
import type { StartupDialogKind } from "../lib/startupDialog";

interface Props {
  kind: StartupDialogKind;
  version: string;
  onClose: () => void;
}

function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

export default function StartupDialog({ kind, version, onClose }: Props) {
  const { t } = useTranslation();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const showFireworks = kind === "welcome" && !prefersReducedMotion();
  const title = kind === "welcome" ? t("startupDialog.welcomeTitle") : t("startupDialog.updateTitle", { version });
  const items =
    kind === "welcome"
      ? ["startupDialog.welcomeItemConnections", "startupDialog.welcomeItemCompare", "startupDialog.welcomeItemSnapshots"]
      : ["startupDialog.updateItemSnapshots", "startupDialog.updateItemSnapshotDiff", "startupDialog.updateItemHistory", "startupDialog.updateItemPolish"];
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
    const height = 150;
    canvas.width = width;
    canvas.height = height;
    const colors = ["#56d6ff", "#ffc857", "#ef476f", "#7bd88f"];
    let frame = 0;
    let raf = 0;

    const draw = () => {
      frame += 1;
      ctx.clearRect(0, 0, width, height);
      ctx.fillStyle = "rgba(12, 18, 28, 0.18)";
      ctx.fillRect(0, 0, width, height);

      for (let burst = 0; burst < 3; burst += 1) {
        const cx = 110 + burst * 155;
        const cy = 58 + Math.sin((frame + burst * 18) / 18) * 18;
        const radius = 16 + ((frame + burst * 14) % 46);
        for (let i = 0; i < 14; i += 1) {
          const angle = (Math.PI * 2 * i) / 14;
          const x = cx + Math.cos(angle) * radius;
          const y = cy + Math.sin(angle) * radius;
          ctx.beginPath();
          ctx.fillStyle = colors[(i + burst) % colors.length];
          ctx.arc(x, y, 2.2, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      if (frame < 150) {
        raf = window.requestAnimationFrame(draw);
      }
    };

    raf = window.requestAnimationFrame(draw);
    return () => {
      if (raf) window.cancelAnimationFrame(raf);
    };
  }, [showFireworks]);

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
