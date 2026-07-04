import "@/components/backdrop/effects.css";

/** GooeyNav's selection burst (React Bits), re-cut as a one-shot utility:
 * spawn token-colored bubble particles from an element the user just picked.
 * No-op without matchMedia (jsdom) or under prefers-reduced-motion. */

const COLOR_VARS = ["--primary", "--chart-2", "--chart-3"];

function noise(n = 1): number {
  return n / 2 - Math.random() * n;
}

export function burstFrom(el: HTMLElement, count = 12): void {
  if (
    typeof window === "undefined" ||
    typeof window.matchMedia !== "function" ||
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  ) {
    return;
  }
  const host = el;
  if (getComputedStyle(host).position === "static") {
    host.style.position = "relative";
  }
  for (let i = 0; i < count; i++) {
    const angle = (((360 + noise(8)) / count) * i * Math.PI) / 180;
    const start = 56 + noise(10);
    const end = 8 + noise(6);
    const time = 700 + Math.random() * 400;
    const rotate = noise(120);
    const colorVar = COLOR_VARS[Math.floor(Math.random() * COLOR_VARS.length)];

    const particle = document.createElement("span");
    particle.className = "gooey-particle";
    particle.setAttribute("aria-hidden", "true");
    particle.style.setProperty("--start-x", `${start * Math.cos(angle)}px`);
    particle.style.setProperty("--start-y", `${start * Math.sin(angle)}px`);
    particle.style.setProperty("--end-x", `${end * Math.cos(angle)}px`);
    particle.style.setProperty("--end-y", `${end * Math.sin(angle)}px`);
    particle.style.setProperty("--time", `${time}ms`);
    particle.style.setProperty("--scale", `${1 + noise(0.3)}`);
    particle.style.setProperty("--rotate", `${rotate}deg`);
    particle.style.setProperty("--color", `hsl(var(${colorVar}))`);

    const point = document.createElement("span");
    point.className = "gooey-point";
    particle.appendChild(point);
    host.appendChild(particle);
    window.setTimeout(() => particle.remove(), time + 80);
  }
}
