'use client';
import { useEffect, useRef } from 'react';

// Katabatic ice palette matching the reference design
const ICE_PALETTE = [
  { r: 0,   g: 136, b: 204 }, // glacial cerulean
  { r: 56,  g: 189, b: 248 }, // sky blue
  { r: 125, g: 211, b: 252 }, // light sky
  { r: 186, g: 230, b: 253 }, // powder blue
  { r: 224, g: 242, b: 254 }, // faint ice
  { r: 255, g: 255, b: 255 }, // pure white
];

type ParticleType = 'streak' | 'flake' | 'micro' | 'mist';

interface Particle {
  type: ParticleType;
  x: number; y: number;
  vx: number; vy: number;
  r: number; g: number; b: number;
  baseAlpha: number;
  // streak
  len?: number; width?: number;
  // flake
  size?: number; wobble?: number; wobbleSpeed?: number; isCrystal?: boolean;
  // micro
  twinkle?: number;
  // mist
  radius?: number;
}

function createParticle(w: number, h: number, initial: boolean): Particle {
  const rand = Math.random();
  const type: ParticleType =
    rand < 0.32 ? 'streak' : rand < 0.72 ? 'flake' : rand < 0.90 ? 'micro' : 'mist';

  const col = ICE_PALETTE[Math.floor(Math.random() * ICE_PALETTE.length)];
  const p: Particle = {
    type, x: 0, y: 0,
    vx: 0, vy: 0,
    r: col.r, g: col.g, b: col.b,
    baseAlpha: 0,
  };

  if (type === 'streak') {
    p.vx = Math.random() * 8 + 9;
    p.vy = p.vx * (Math.random() * 0.35 + 0.55);
    p.len = Math.random() * 26 + 14;
    p.width = Math.random() * 1.5 + 0.9;
    p.baseAlpha = Math.random() * 0.45 + 0.35;
  } else if (type === 'flake') {
    p.vx = Math.random() * 4.2 + 2.8;
    p.vy = p.vx * (Math.random() * 0.4 + 0.5) + (Math.random() * 0.8 - 0.2);
    p.size = Math.random() * 2.8 + 1.6;
    p.baseAlpha = Math.random() * 0.55 + 0.38;
    p.wobble = Math.random() * Math.PI * 2;
    p.wobbleSpeed = Math.random() * 0.05 + 0.02;
    p.isCrystal = Math.random() > 0.45;
  } else if (type === 'micro') {
    p.vx = Math.random() * 3.0 + 2.0;
    p.vy = p.vx * 0.65;
    p.size = Math.random() * 1.2 + 0.6;
    p.baseAlpha = Math.random() * 0.6 + 0.3;
    p.twinkle = Math.random() * Math.PI * 2;
  } else {
    p.vx = Math.random() * 2.0 + 1.5;
    p.vy = p.vx * 0.55;
    p.radius = Math.random() * 36 + 18;
    p.baseAlpha = Math.random() * 0.12 + 0.06;
  }

  if (initial) {
    p.x = Math.random() * w;
    p.y = Math.random() * h;
  } else if (Math.random() < 0.6) {
    p.x = Math.random() * (w + 300) - 300;
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
    const tailX = p.x - p.vx! * (p.len! / 12);
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
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let animId: number;
    let width = window.innerWidth;
    let height = window.innerHeight;
    canvas.width = width;
    canvas.height = height;

    const TOTAL = 195;
    let particles: Particle[] = Array.from({ length: TOTAL }, () =>
      createParticle(width, height, true)
    );

    const onResize = () => {
      width = window.innerWidth;
      height = window.innerHeight;
      canvas.width = width;
      canvas.height = height;
    };
    window.addEventListener('resize', onResize);

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
    render();

    return () => {
      cancelAnimationFrame(animId);
      window.removeEventListener('resize', onResize);
    };
  }, []);

  return (
    <canvas
      id="blizzard-canvas"
      ref={canvasRef}
      aria-hidden="true"
    />
  );
}
