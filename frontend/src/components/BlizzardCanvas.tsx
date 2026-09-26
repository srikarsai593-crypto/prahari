'use client';
import { useEffect, useRef, useState } from 'react';

/**
 * Katabatic drift behind the dashboard hero.
 *
 * Scoped to its own element, not the viewport: the previous version was a
 * `position: fixed` canvas over the whole console at z-index 15, so it snowed
 * over the inventory table and every dialog. This one sizes itself to the
 * element it is mounted in and only exists while that hero is on screen.
 *
 * Three things keep it cheap: the particle count scales with the hero's own
 * area (and is capped), the loop stops when the hero scrolls out of view or the
 * tab is hidden, and it renders nothing at all under `prefers-reduced-motion`.
 */

// Light ice on deep navy. The hero background is --bg-command (#0f172a), so the
// palette runs from mid-cerulean to white; the darkest entry still sits well
// above the surface luminance, and total canvas alpha stays low enough that the
// white hero copy holds far above the WCAG AA 4.5:1 contrast floor.
const ICE_PALETTE = [
  { r: 56, g: 189, b: 248 },   // sky blue
  { r: 125, g: 211, b: 252 },  // light sky
  { r: 186, g: 230, b: 253 },  // powder blue
  { r: 224, g: 242, b: 254 },  // faint ice
  { r: 255, g: 255, b: 255 },  // pure white
];

type ParticleType = 'streak' | 'flake' | 'micro' | 'mist';

interface Particle {
  type: ParticleType;
  x: number; y: number;
  vx: number; vy: number;
  r: number; g: number; b: number;
  baseAlpha: number;
  len?: number; width?: number;
  size?: number; wobble?: number; wobbleSpeed?: number; isCrystal?: boolean;
  twinkle?: number;
  radius?: number;
}

/** One particle per ~2600 px² of hero, clamped so a tablet stays light. */
const MIN_PARTICLES = 28;
const MAX_PARTICLES = 90;
const AREA_PER_PARTICLE = 2600;

function particleCount(w: number, h: number): number {
  return Math.max(MIN_PARTICLES, Math.min(MAX_PARTICLES, Math.round((w * h) / AREA_PER_PARTICLE)));
}

function createParticle(w: number, h: number, initial: boolean): Particle {
  const rand = Math.random();
  const type: ParticleType =
    rand < 0.32 ? 'streak' : rand < 0.72 ? 'flake' : rand < 0.90 ? 'micro' : 'mist';

  const col = ICE_PALETTE[Math.floor(Math.random() * ICE_PALETTE.length)];
  const p: Particle = {
    type, x: 0, y: 0, vx: 0, vy: 0,
    r: col.r, g: col.g, b: col.b, baseAlpha: 0,
  };

  if (type === 'streak') {
    p.vx = Math.random() * 5 + 5;
    p.vy = p.vx * (Math.random() * 0.35 + 0.55);
    p.len = Math.random() * 22 + 12;
    p.width = Math.random() * 1.2 + 0.7;
    p.baseAlpha = Math.random() * 0.3 + 0.2;
  } else if (type === 'flake') {
    p.vx = Math.random() * 3 + 2;
    p.vy = p.vx * (Math.random() * 0.4 + 0.5) + (Math.random() * 0.8 - 0.2);
    p.size = Math.random() * 2.2 + 1.2;
    p.baseAlpha = Math.random() * 0.4 + 0.25;
    p.wobble = Math.random() * Math.PI * 2;
    p.wobbleSpeed = Math.random() * 0.05 + 0.02;
    p.isCrystal = Math.random() > 0.45;
  } else if (type === 'micro') {
    p.vx = Math.random() * 2.2 + 1.4;
    p.vy = p.vx * 0.65;
    p.size = Math.random() * 1.1 + 0.5;
    p.baseAlpha = Math.random() * 0.45 + 0.2;
    p.twinkle = Math.random() * Math.PI * 2;
  } else {
    p.vx = Math.random() * 1.4 + 1.0;
    p.vy = p.vx * 0.55;
    p.radius = Math.random() * 30 + 16;
    p.baseAlpha = Math.random() * 0.07 + 0.03;
  }

  if (initial) {
    p.x = Math.random() * w;
    p.y = Math.random() * h;
  } else if (Math.random() < 0.6) {
    p.x = Math.random() * (w + 200) - 200;
    p.y = -35;
  } else {
    p.x = -40;
    p.y = Math.random() * h * 0.85;
  }
  return p;
}

function updateParticle(p: Particle): void {
  if (p.type === 'flake') {
    p.wobble! += p.wobbleSpeed!;
    p.x += p.vx + Math.sin(p.wobble!) * 1.1;
    p.y += p.vy + Math.cos(p.wobble!) * 0.6;
  } else if (p.type === 'micro') {
    p.twinkle! += 0.08;
    p.x += p.vx;
    p.y += p.vy;
  } else {
    p.x += p.vx;
    p.y += p.vy;
  }
}

function drawParticle(ctx: CanvasRenderingContext2D, p: Particle): void {
  ctx.save();
  const { r, g, b } = p;
  if (p.type === 'streak') {
    const tailX = p.x - p.vx * (p.len! / 12);
    const tailY = p.y - p.vy * (p.len! / 12);
    const grad = ctx.createLinearGradient(p.x, p.y, tailX, tailY);
    grad.addColorStop(0, `rgba(${r},${g},${b},${p.baseAlpha})`);
    grad.addColorStop(1, `rgba(${r},${g},${b},0)`);
    ctx.beginPath();
    ctx.strokeStyle = grad;
    ctx.lineWidth = p.width!;
    ctx.lineCap = 'round';
    ctx.moveTo(p.x, p.y);
    ctx.lineTo(tailX, tailY);
    ctx.stroke();
  } else if (p.type === 'flake') {
    if (p.isCrystal) {
      const s = p.size!;
      ctx.strokeStyle = `rgba(${r},${g},${b},${p.baseAlpha})`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(p.x - s, p.y); ctx.lineTo(p.x + s, p.y);
      ctx.moveTo(p.x, p.y - s); ctx.lineTo(p.x, p.y + s);
      ctx.stroke();
    } else {
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size!, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(${r},${g},${b},${p.baseAlpha})`;
      ctx.shadowColor = 'rgba(56,189,248,0.4)';
      ctx.shadowBlur = 4;
      ctx.fill();
    }
  } else if (p.type === 'micro') {
    const alpha = p.baseAlpha * (0.6 + 0.4 * Math.sin(p.twinkle!));
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.size!, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(${r},${g},${b},${alpha})`;
    ctx.fill();
  } else {
    const radGrad = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.radius!);
    radGrad.addColorStop(0, `rgba(186,230,253,${p.baseAlpha})`);
    radGrad.addColorStop(0.5, `rgba(224,242,254,${p.baseAlpha * 0.4})`);
    radGrad.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.beginPath();
    ctx.fillStyle = radGrad;
    ctx.arc(p.x, p.y, p.radius!, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

export default function BlizzardCanvas() {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // Someone who asks for reduced motion gets nothing rendered at all — a
  // frozen frame of ice is still visual noise behind the copy. Resolved on the
  // client (this component is ssr: false) and kept live, so toggling the OS
  // setting takes effect without a reload.
  const [reducedMotion, setReducedMotion] = useState(false);

  useEffect(() => {
    const q = window.matchMedia('(prefers-reduced-motion: reduce)');
    const sync = () => setReducedMotion(q.matches);
    sync();
    q.addEventListener('change', sync);
    return () => q.removeEventListener('change', sync);
  }, []);

  useEffect(() => {
    if (reducedMotion) return;
    const host = hostRef.current;
    const canvas = canvasRef.current;
    if (!host || !canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let animId = 0;
    let running = false;
    let visible = false;
    let width = host.clientWidth || 1;
    let height = host.clientHeight || 1;
    let particles: Particle[] = [];

    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    const resize = () => {
      width = host.clientWidth || 1;
      height = host.clientHeight || 1;
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      const target = particleCount(width, height);
      if (particles.length === 0) {
        particles = Array.from({ length: target }, () => createParticle(width, height, true));
      } else if (target > particles.length) {
        particles.push(...Array.from({ length: target - particles.length },
          () => createParticle(width, height, true)));
      } else if (target < particles.length) {
        particles.length = target;
      }
    };

    const render = () => {
      ctx.clearRect(0, 0, width, height);
      for (const p of particles) {
        updateParticle(p);
        if (p.x > width + 60 || p.y > height + 60) {
          Object.assign(p, createParticle(width, height, false));
        }
        drawParticle(ctx, p);
      }
      animId = requestAnimationFrame(render);
    };

    const start = () => {
      if (running) return;
      running = true;
      animId = requestAnimationFrame(render);
    };
    const stop = () => {
      if (!running) return;
      running = false;
      cancelAnimationFrame(animId);
    };
    // Off-screen or backgrounded, the loop is pure battery cost.
    const sync = () => { (visible && !document.hidden) ? start() : stop(); };

    resize();

    const observer = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
      sync();
    }, { threshold: 0 });
    observer.observe(host);

    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(host);

    document.addEventListener('visibilitychange', sync);

    return () => {
      stop();
      observer.disconnect();
      resizeObserver.disconnect();
      document.removeEventListener('visibilitychange', sync);
    };
  }, [reducedMotion]);

  if (reducedMotion) return null;

  return (
    <div ref={hostRef} className="hero-blizzard" aria-hidden="true">
      <canvas ref={canvasRef} className="hero-blizzard-canvas" />
      <div className="blizzard-wind-layer">
        <div className="wind-drift" />
        <div className="wind-drift-fast" />
      </div>
    </div>
  );
}
