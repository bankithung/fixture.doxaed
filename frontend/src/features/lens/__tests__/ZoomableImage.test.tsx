import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ZoomableImage } from "../ZoomableImage";

/** Two taps within a beat, in the same place. */
function doubleTap(el: HTMLElement, x = 10, y = 10): void {
  for (let i = 0; i < 2; i += 1) {
    fireEvent.pointerDown(el, { pointerId: 1, clientX: x, clientY: y });
    fireEvent.pointerUp(el, { pointerId: 1, clientX: x, clientY: y });
  }
}

/** The gestures every phone gallery taught people: wheel and double-click
 * get closer, a pinch too, and a sideways swipe at rest turns the page. */
describe("ZoomableImage", () => {
  it("starts at 1x and zooms in on wheel / double-tap, reset on the next double-tap", () => {
    render(<ZoomableImage src="/a.jpg" alt="A" />);
    const box = screen.getByTestId("zoomable-image");
    expect(box).toHaveAttribute("data-scale", "1.00");

    fireEvent.wheel(box, { deltaY: -300, clientX: 10, clientY: 10 });
    expect(Number(box.getAttribute("data-scale"))).toBeGreaterThan(1);

    doubleTap(box);
    expect(box).toHaveAttribute("data-scale", "1.00");
    doubleTap(box);
    expect(box).toHaveAttribute("data-scale", "2.50");
  });

  it("pinches: two pointers spreading apart scale the picture up", () => {
    render(<ZoomableImage src="/a.jpg" alt="A" />);
    const box = screen.getByTestId("zoomable-image");
    fireEvent.pointerDown(box, { pointerId: 1, clientX: 100, clientY: 100 });
    fireEvent.pointerDown(box, { pointerId: 2, clientX: 140, clientY: 100 });
    fireEvent.pointerMove(box, { pointerId: 2, clientX: 220, clientY: 100 });
    expect(Number(box.getAttribute("data-scale"))).toBeCloseTo(3, 1);
    fireEvent.pointerUp(box, { pointerId: 2, clientX: 220, clientY: 100 });
    fireEvent.pointerUp(box, { pointerId: 1, clientX: 100, clientY: 100 });
    // Lifting the fingers keeps the zoom.
    expect(Number(box.getAttribute("data-scale"))).toBeCloseTo(3, 1);
  });

  it("a sideways swipe at 1x turns the page; while zoomed it pans instead", () => {
    const onSwipe = vi.fn();
    render(<ZoomableImage src="/a.jpg" alt="A" onSwipe={onSwipe} />);
    const box = screen.getByTestId("zoomable-image");
    fireEvent.pointerDown(box, { pointerId: 1, clientX: 300, clientY: 100 });
    fireEvent.pointerMove(box, { pointerId: 1, clientX: 150, clientY: 104 });
    fireEvent.pointerUp(box, { pointerId: 1, clientX: 150, clientY: 104 });
    expect(onSwipe).toHaveBeenCalledWith(1);

    fireEvent.pointerDown(box, { pointerId: 1, clientX: 150, clientY: 100 });
    fireEvent.pointerMove(box, { pointerId: 1, clientX: 300, clientY: 100 });
    fireEvent.pointerUp(box, { pointerId: 1, clientX: 300, clientY: 100 });
    expect(onSwipe).toHaveBeenLastCalledWith(-1);

    onSwipe.mockClear();
    fireEvent.wheel(box, { deltaY: -600, clientX: 0, clientY: 0 });
    fireEvent.pointerDown(box, { pointerId: 1, clientX: 300, clientY: 100 });
    fireEvent.pointerMove(box, { pointerId: 1, clientX: 150, clientY: 100 });
    fireEvent.pointerUp(box, { pointerId: 1, clientX: 150, clientY: 100 });
    expect(onSwipe).not.toHaveBeenCalled();
  });

  it("resets to 1x when the picture changes", () => {
    const { rerender } = render(<ZoomableImage src="/a.jpg" alt="A" />);
    const box = screen.getByTestId("zoomable-image");
    doubleTap(box, 0, 0);
    expect(box).toHaveAttribute("data-scale", "2.50");
    rerender(<ZoomableImage src="/b.jpg" alt="B" />);
    expect(box).toHaveAttribute("data-scale", "1.00");
  });
});
