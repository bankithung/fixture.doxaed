import { useCallback, useEffect, useRef } from "react";

/** ClickSpark (React Bits), re-cut for the app shell: brand-violet spark
 * lines radiate from every click. TS port with two fixes — the rAF loop only
 * runs while sparks are alive (no idle frame burn on an ops tool), and the
 * canvas 2D context is guarded for jsdom. Color reads the --primary token at
 * click time so theme flips retint automatically. */

interface Spark {
  x: number;
  y: number;
  angle: number;
  startTime: number;
  color: string;
}

const SPARK_SIZE = 9;
const SPARK_RADIUS = 18;
const SPARK_COUNT = 8;
const DURATION = 420;

export function ClickSpark({
  children,
}: {
  children: React.ReactNode;
}): React.ReactElement {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sparksRef = useRef<Spark[]>([]);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const parent = canvas?.parentElement;
    if (!canvas || !parent || typeof ResizeObserver === "undefined") return;
    const resize = (): void => {
      const { width, height } = parent.getBoundingClientRect();
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(parent);
    return () => ro.disconnect();
  }, []);

  const drawLoop = useCallback((timestamp: number) => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) {
      rafRef.current = null;
      return;
    }
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    sparksRef.current = sparksRef.current.filter((spark) => {
      const elapsed = timestamp - spark.startTime;
      if (elapsed >= DURATION) return false;
      const p = elapsed / DURATION;
      const eased = p * (2 - p);
      const distance = eased * SPARK_RADIUS;
      const lineLength = SPARK_SIZE * (1 - eased);
      ctx.strokeStyle = spark.color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(
        spark.x + distance * Math.cos(spark.angle),
        spark.y + distance * Math.sin(spark.angle),
      );
      ctx.lineTo(
        spark.x + (distance + lineLength) * Math.cos(spark.angle),
        spark.y + (distance + lineLength) * Math.sin(spark.angle),
      );
      ctx.stroke();
      return true;
    });
    // Idle when the last spark fades; the next click re-arms the loop.
    rafRef.current =
      sparksRef.current.length > 0 ? requestAnimationFrame(drawLoop) : null;
  }, []);

  useEffect(() => {
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  const onClick = (e: React.MouseEvent<HTMLDivElement>): void => {
    const canvas = canvasRef.current;
    if (!canvas || !canvas.getContext("2d")) return;
    if (
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      return;
    }
    const rect = canvas.getBoundingClientRect();
    const raw = getComputedStyle(document.documentElement)
      .getPropertyValue("--primary")
      .trim();
    const color = raw ? `hsl(${raw.replace(/\s+/g, ", ")})` : "#6840dd";
    const now = performance.now();
    for (let i = 0; i < SPARK_COUNT; i++) {
      sparksRef.current.push({
        x: e.clientX - rect.left,
        y: e.clientY - rect.top,
        angle: (2 * Math.PI * i) / SPARK_COUNT,
        startTime: now,
      color,
      });
    }
    if (rafRef.current === null) rafRef.current = requestAnimationFrame(drawLoop);
  };

  return (
    <div className="relative flex min-h-0 w-full flex-1 flex-col" onClick={onClick}>
      <canvas
        ref={canvasRef}
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 z-30 h-full w-full select-none"
      />
      {children}
    </div>
  );
}
