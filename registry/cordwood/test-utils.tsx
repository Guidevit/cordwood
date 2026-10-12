import { act, type ReactNode } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach } from "vitest"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// Radix measures with these, and jsdom has neither.
class Observer {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver ??= Observer as unknown as typeof ResizeObserver
Element.prototype.scrollIntoView ??= () => {}
Element.prototype.hasPointerCapture ??= () => false

const roots: Root[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount())
  document.body.replaceChildren()
})

/** Renders into the page and answers a function that renders again. */
export async function render(node: ReactNode) {
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  roots.push(root)
  await act(async () => root.render(node))
  return async (next: ReactNode) => act(async () => root.render(next))
}

export async function click(element: Element | null | undefined) {
  if (!element) throw new Error("nothing to click")
  await act(async () => (element as HTMLElement).click())
}

export const button = (name: string) =>
  [...document.querySelectorAll("button")].find((b) => b.textContent === name) ?? null
